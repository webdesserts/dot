import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
import { execFileSync } from 'node:child_process';

const sdkRoot = process.env.PI_SDK_ROOT ?? join(
  execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(),
  '@earendil-works/pi-coding-agent',
);
const { createAgentSession, SessionManager, SettingsManager, DefaultResourceLoader, ModelRuntime } =
  await import(pathToFileURL(join(sdkRoot, 'dist/index.js')).href);
const { fauxProvider, fauxAssistantMessage, fauxToolCall } =
  await import(pathToFileURL(join(sdkRoot, 'node_modules/@earendil-works/pi-ai/dist/providers/faux.js')).href);

async function fixture(t, automatic) {
  const home = mkdtempSync(join(tmpdir(), 'memory-native-'));
  const previous = Object.fromEntries(['HOME', 'AUTONOMY_AGENT_ID', 'PI_SUBAGENT_CHILD'].map(key => [key, process.env[key]]));
  process.env.HOME = home;
  process.env.AUTONOMY_AGENT_ID = 'iris';
  delete process.env.PI_SUBAGENT_CHILD;
  const note = join(home, 'notes/agents/iris/Working Memory — iris.md');
  mkdirSync(join(home, 'notes/agents/iris'), { recursive: true });
  writeFileSync(note, 'OLD-PUBLIC-STATE');
  const source = readFileSync(new URL('../../extensions/harness-context.ts', import.meta.url), 'utf8');
  const module = await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}#${encodeURIComponent(home)}`);
  const agentDir = join(home, 'agent');
  mkdirSync(agentDir);
  const faux = fauxProvider({ models: [{ id: 'memory-fixture', contextWindow: 20_000, maxTokens: 1_000 }] });
  const captured = [];
  const settingsManager = SettingsManager.inMemory({ compaction: {
    enabled: automatic, reserveTokens: 16_000, keepRecentTokens: 0,
  } });
  let compactCount = 0;
  const toolFile = join(home, 'public-fixture.txt');
  writeFileSync(toolFile, automatic ? 'PUBLIC FILLER '.repeat(1_600) : 'fixture result');
  const resourceLoader = new DefaultResourceLoader({
    cwd: home, agentDir, settingsManager, noSkills: true, noPromptTemplates: true,
    noThemes: true, noContextFiles: true,
    extensionFactories: [module.default, pi => {
      pi.on('session_before_compact', event => {
        compactCount++;
        return { compaction: {
          summary: 'Public fixture summary',
          firstKeptEntryId: event.preparation.firstKeptEntryId,
          tokensBefore: event.preparation.tokensBefore,
        } };
      });
    }],
  });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  const modelRuntime = await ModelRuntime.create({ agentDir, refreshOnCreate: false, modelNetworkEnabled: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const { session } = await createAgentSession({ cwd: home, agentDir, model: faux.getModel(), thinkingLevel: 'off',
    modelRuntime, resourceLoader, settingsManager, sessionManager: SessionManager.inMemory(home), tools: ['read'],
  });
  t.after(async () => {
    try {
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      session.dispose();
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      rmSync(home, { recursive: true, force: true });
    }
  });
  await session.bindExtensions({});
  assert.ok(session.getActiveToolNames().includes('read'));
  const snapshotEntries = () => session.sessionManager.getBranch().filter(entry =>
    entry.type === 'custom_message' && entry.customType === 'working-memory-snapshot');
  const capture = context => {
    captured.push(context.messages);
    return fauxAssistantMessage('Fixture completed.');
  };
  return { session, faux, note, toolFile, snapshotEntries, captured, capture, get compactions() { return compactCount; } };
}

function text(messages) {
  return messages.map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).join('\n');
}

test('manual compaction persists fresh memory without a new model run; custom wake retains it', async t => {
  const f = await fixture(t, false);
  assert.equal(f.snapshotEntries().length, 1);
  f.faux.setResponses([f.capture]);
  await f.session.prompt('Public initial request.');
  writeFileSync(f.note, 'NEW-PUBLIC-STATE');
  await f.session.compact();
  assert.equal(f.compactions, 1);
  assert.equal(f.captured.length, 1, 'manual snapshot must not start another model run');
  const snapshots = f.snapshotEntries();
  assert.equal(snapshots.length, 2);
  assert.ok(snapshots[0].content.includes('OLD-PUBLIC-STATE'));
  assert.ok(snapshots[1].content.includes('NEW-PUBLIC-STATE'));
  assert.ok(snapshots[1].content.includes('Please load Nu and codemode'));
  const compact = f.session.sessionManager.getBranch().findLast(entry => entry.type === 'compaction');
  assert.equal(snapshots[1].details.checkpointId, compact.id);
  await f.session.extensionRunner.emit({ type: 'session_start', reason: 'reload' });
  assert.equal(f.snapshotEntries().length, 2, 'ordinary reload must not duplicate the snapshot');
  writeFileSync(f.note, 'REPEATED-SUMMARY-PUBLIC-STATE');
  await f.session.compact();
  assert.equal(f.compactions, 2);
  const latestCheckpoint = f.session.sessionManager.getBranch().findLast(entry => entry.type === 'compaction');
  assert.equal(f.snapshotEntries().length, 3);
  assert.equal(f.snapshotEntries().at(-1).details.checkpointId, latestCheckpoint.id);
  assert.ok(f.snapshotEntries().at(-1).content.includes('REPEATED-SUMMARY-PUBLIC-STATE'));
  f.faux.setResponses([fauxAssistantMessage([fauxToolCall('read', { path: f.toolFile })]), f.capture]);
  await f.session.sendCustomMessage({ customType: 'public-notification', content: 'Public wake', display: false },
    { triggerTurn: true, deliverAs: 'steer' });
  assert.ok(text(f.captured.at(-1)).includes('REPEATED-SUMMARY-PUBLIC-STATE'));
  for (const messages of f.captured) {
    const system = text(messages.filter(message => message.role === 'system'));
    for (const marker of ['OLD-PUBLIC-STATE', 'NEW-PUBLIC-STATE', 'REPEATED-SUMMARY-PUBLIC-STATE']) {
      assert.ok(!system.includes(marker));
    }
  }
});

test('between-tool automatic compaction delivers fresh snapshot before the next model response', async t => {
  const f = await fixture(t, true);
  writeFileSync(f.note, 'AUTO-PUBLIC-STATE');
  f.faux.setResponses([fauxAssistantMessage([fauxToolCall('read', { path: f.toolFile })]), f.capture]);
  await f.session.prompt('Public request with a large tool result.');
  assert.ok(f.compactions >= 1);
  assert.ok(text(f.captured.at(-1)).includes('AUTO-PUBLIC-STATE'));
  // A kept tool exchange can still exceed this fixture's small threshold.
  // Each successful checkpoint must receive exactly one chronological snapshot.
  assert.equal(f.snapshotEntries().length, f.compactions + 1);
  const checkpoints = f.session.sessionManager.getBranch().filter(entry => entry.type === 'compaction');
  assert.deepEqual(f.snapshotEntries().slice(1).map(entry => entry.details.checkpointId), checkpoints.map(entry => entry.id));
});
