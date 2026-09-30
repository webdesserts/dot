import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';

async function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'agent-memory-'));
  const keys = ['HOME', 'AUTONOMY_AGENT_ID', 'PI_SUBAGENT_CHILD'];
  const before = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  t.after(() => {
    for (const key of keys) {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    }
    rmSync(home, { recursive: true, force: true });
  });
  process.env.HOME = home;
  delete process.env.PI_SUBAGENT_CHILD;
  for (const id of ['iris', 'rhea']) {
    mkdirSync(join(home, 'notes', 'agents', id), { recursive: true });
    writeFileSync(join(home, 'notes', 'agents', id, `Working Memory — ${id}.md`), `${id}-private-marker`);
  }
  writeFileSync(join(home, 'notes', 'Working Memory.md'), 'POOLED-POISON');
  for (const skill of ['nushell', 'codemode']) {
    const directory = join(home, '.config', 'agents', 'skills', skill);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'SKILL.md'), `${skill}-workflow-marker`);
  }
  const source = readFileSync(new URL('../../extensions/harness-context.ts', import.meta.url), 'utf8');
  const js = stripTypeScriptTypes(source);
  const module = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}#${encodeURIComponent(home)}`);
  const hooks = new Map();
  const branch = [];
  const messages = [];
  module.default({
    on(name, handler) { hooks.set(name, handler); },
    sendMessage(message, options) {
      messages.push({ message, options });
      branch.push({ type: 'custom_message', id: `snapshot-${messages.length}`, ...message });
    },
  });
  const context = { sessionManager: { getBranch: () => branch.slice() } };
  const emit = async (name, event = {}) => hooks.get(name)?.(event, context);
  return { home, branch, messages, emit, run: async () => {
    const options = { sections: { mcp_servers: 'MCP-DISCOVERY-MARKER' } };
    await emit('before_agent_start', { systemPrompt: 'base', cwd: '/same-cwd', systemPromptOptions: options });
    if (!('harness_context' in options.sections)) return undefined;
    return { systemPrompt: ['base', ...Object.values(options.sections)].join('\n'), systemPromptOptions: options };
  } };
}

test('explicit identities select separate chronological snapshots, never pooled memory', async t => {
  const f = await fixture(t);
  process.env.AUTONOMY_AGENT_ID = 'iris';
  await f.emit('session_start');
  assert.ok(f.messages[0].message.content.includes('iris-private-marker'));
  assert.ok(!f.messages[0].message.content.includes('rhea-private-marker'));
  assert.equal(f.messages[0].options.triggerTurn, false);
  process.env.AUTONOMY_AGENT_ID = 'rhea';
  await f.emit('session_start');
  assert.ok(f.messages[1].message.content.includes('rhea-private-marker'));
  assert.ok(!f.messages[1].message.content.includes('iris-private-marker'));
  assert.ok(f.messages.every(row => !row.message.content.includes('POOLED-POISON')));
});

test('absent, invalid and missing-note selections produce message warnings without fallback', async t => {
  const f = await fixture(t);
  for (const id of [undefined, '', 'Iris', '../iris', 'iris\n', 'a'.repeat(65), 'missing', 'a'.repeat(64)]) {
    f.branch.length = 0;
    if (id === undefined) delete process.env.AUTONOMY_AGENT_ID;
    else process.env.AUTONOMY_AGENT_ID = id;
    await f.emit('session_start');
    const body = f.messages.at(-1).message.content;
    assert.ok(body.includes('Agent memory unavailable'));
    assert.ok(!body.includes('private-marker') && !body.includes('POOLED-POISON'));
  }
});

test('system guidance composes with MCP and excludes memory and manually copied skill bodies', async t => {
  const f = await fixture(t);
  process.env.AUTONOMY_AGENT_ID = 'iris';
  await f.emit('session_start');
  const result = await f.run();
  assert.equal(result.systemPromptOptions.forceSystemPrompt, undefined);
  assert.equal(result.systemPromptOptions.sections.mcp_servers, 'MCP-DISCOVERY-MARKER');
  assert.ok(!result.systemPrompt.includes('private-marker'));
  assert.ok(!result.systemPrompt.includes('nushell-workflow-marker'));
  assert.ok(!result.systemPrompt.includes('codemode-workflow-marker'));
  assert.ok(result.systemPrompt.includes('Agent ID: iris'));
});

test('restart preserves snapshots and successful compaction appends current state chronologically', async t => {
  const f = await fixture(t);
  process.env.AUTONOMY_AGENT_ID = 'iris';
  await f.emit('session_start');
  writeFileSync(join(f.home, 'notes/agents/iris/Working Memory — iris.md'), 'iris-updated-marker');
  await f.emit('session_start');
  assert.equal(f.messages.length, 1);
  assert.ok(f.messages[0].message.content.includes('iris-private-marker'));
  await f.emit('session_compact_failed');
  assert.equal(f.messages.length, 1);
  f.branch.push({ type: 'compaction', id: 'compact-1' });
  await f.emit('session_compact', { compactionEntry: { id: 'compact-1' }, willRetry: false });
  assert.equal(f.messages.length, 2);
  assert.ok(f.messages[1].message.content.includes('iris-updated-marker'));
  assert.equal(f.messages[1].message.details.checkpointId, 'compact-1');
  assert.equal(f.messages[1].options.triggerTurn, false);
  assert.equal(f.branch.at(-2).type, 'compaction');
  await f.emit('session_start');
  assert.equal(f.messages.length, 2);
});

test('active compaction/retry uses native steering and startup repairs an undelivered checkpoint', async t => {
  const f = await fixture(t);
  process.env.AUTONOMY_AGENT_ID = 'iris';
  await f.emit('agent_start');
  f.branch.push({ type: 'compaction', id: 'active-compact' });
  await f.emit('session_compact', { compactionEntry: { id: 'active-compact' }, willRetry: false });
  assert.equal(f.messages[0].options.triggerTurn, true);
  assert.equal(f.messages[0].options.deliverAs, 'steer');
  await f.emit('agent_end');
  f.branch.push({ type: 'compaction', id: 'retry-compact' });
  await f.emit('session_compact', { compactionEntry: { id: 'retry-compact' }, willRetry: true });
  assert.equal(f.messages[1].options.triggerTurn, true);
  f.branch.push({ type: 'compaction', id: 'interrupted-compact' });
  await f.emit('session_start');
  assert.equal(f.messages[2].message.details.checkpointId, 'interrupted-compact');
  assert.equal(f.messages[2].options.triggerTurn, false);
});

test('native children inherit neither private snapshots nor parent system guidance', async t => {
  const f = await fixture(t);
  process.env.AUTONOMY_AGENT_ID = 'iris';
  process.env.PI_SUBAGENT_CHILD = '1';
  await f.emit('session_start');
  await f.emit('agent_start');
  await f.emit('session_compact', { compactionEntry: { id: 'child-compact' }, willRetry: true });
  assert.equal(f.messages.length, 0);
  assert.equal(await f.run(), undefined);
});
