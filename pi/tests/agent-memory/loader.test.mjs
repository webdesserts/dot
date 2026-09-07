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
  const source = readFileSync(new URL('../../extensions/harness-context.ts', import.meta.url), 'utf8');
  const js = stripTypeScriptTypes(source);
  const module = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}#${encodeURIComponent(home)}`);
  let hook;
  module.default({ on(name, handler) { assert.equal(name, 'before_agent_start'); hook = handler; } });
  return { home, run: () => hook({ systemPrompt: 'base', cwd: '/same-cwd' }) };
}

test('explicit identities select separate notes and reread current content', async t => {
  const f = await fixture(t);
  process.env.AUTONOMY_AGENT_ID = 'iris';
  const iris = (await f.run()).systemPrompt;
  assert.ok(iris.includes('iris-private-marker'));
  assert.ok(!iris.includes('rhea-private-marker') && !iris.includes('POOLED-POISON'));
  process.env.AUTONOMY_AGENT_ID = 'rhea';
  const rhea = (await f.run()).systemPrompt;
  assert.ok(rhea.includes('rhea-private-marker') && !rhea.includes('iris-private-marker'));
  writeFileSync(join(f.home, 'notes/agents/rhea/Working Memory — rhea.md'), 'rhea-updated-marker');
  assert.ok((await f.run()).systemPrompt.includes('rhea-updated-marker'));
});

test('absent, invalid and missing-note selections never use pooled memory', async t => {
  const f = await fixture(t);
  for (const id of [undefined, '', 'Iris', '../iris', 'iris\n', 'a'.repeat(65)]) {
    if (id === undefined) delete process.env.AUTONOMY_AGENT_ID;
    else process.env.AUTONOMY_AGENT_ID = id;
    const prompt = (await f.run()).systemPrompt;
    assert.ok(prompt.includes('Agent memory unavailable'));
    assert.ok(!prompt.includes('private-marker') && !prompt.includes('POOLED-POISON'));
  }
  process.env.AUTONOMY_AGENT_ID = 'missing';
  assert.ok((await f.run()).systemPrompt.includes('No other Working Memory'));
  process.env.AUTONOMY_AGENT_ID = 'a'.repeat(64);
  assert.ok((await f.run()).systemPrompt.includes('Agent ID:'));
});

test('native children do not inherit private memory from the parent environment', async t => {
  const f = await fixture(t);
  process.env.AUTONOMY_AGENT_ID = 'iris';
  process.env.PI_SUBAGENT_CHILD = '1';
  assert.equal(await f.run(), undefined);
});
