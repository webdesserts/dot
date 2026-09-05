/**
 * Behavioral tests for the goal-heartbeat supervisor
 * (pi/extensions/notifications.ts).
 *
 * Runs the TypeScript source in a VM sandbox with a fake pi double, fake
 * timers, a fake clock and fake child processes — no real worker, no real
 * minutes of waiting. Covers the transport regressions plus the goal
 * heartbeat control state machine: enable (no wake-count expiry), hold
 * (absolute deadline), complete (bounded ambient fallback), pause, truthful
 * status, generation fences, live-idle delivery checks, session-owned
 * persistence and fork/resume restore rules.
 *
 * Clock bookkeeping: tests control `Date.now()` via f.setNow(ms). All
 * deadlines asserted here are absolute epoch ms, matching the persisted
 * shape.
 *
 * Run: node --test tests/heartbeat/supervisor.test.mjs   (from the repo root)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const T0 = 1_700_000_000_000;
const AMBIENT_LIFETIME_MS = 2 * 3_600_000;

function fixture(env = {}) {
	const handlers = new Map(), children = [], timers = new Map(), messages = [], writes = [];
	const appended = [];
	const clock = { now: T0 };
	class FakeDate extends Date { }
	FakeDate.now = () => clock.now;
	let nextTimer = 1;
	const tool = { def: null };
	const commands = new Map();
	const pi = {
		on: (name, fn) => { assert.ok(!handlers.has(name), 'one handler per lifecycle event'); handlers.set(name, fn); },
		sendUserMessage: (message, options) => messages.push({ message, options }),
		registerTool: (def) => { tool.def = def; },
		registerCommand: (name, opts) => commands.set(name, opts),
		appendEntry: (customType, data) => appended.push({ customType, data }),
	};
	const source = fs.readFileSync(new URL('../../extensions/notifications.ts', import.meta.url), 'utf8')
		.replace(/^import .*;\n/gm, '')
		.replace(/ as const/g, '')
		.replace('fileURLToPath(import.meta.url)', '"/fixture/notifications.ts"')
		.replace('export default function (pi)', 'function setup(pi)');
	vm.runInNewContext(source + '\nsetup(pi);', {
		pi, process: { env, execPath: '/fake/node' }, path, realpathSync: value => value,
		console: { error() {} },
		Date: FakeDate,
		// typebox / pi-ai stubs — only used to build the tool schema
		Type: { Object: v => v, String: v => v, Integer: v => v, Optional: v => v },
		StringEnum: v => v,
		setTimeout: fn => { const id = nextTimer++; timers.set(id, fn); return id; },
		clearTimeout: id => timers.delete(id),
		spawn: () => {
			const child = new EventEmitter();
			child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
			child.stdin = { writable: true, write(s) { writes.push({ child, s }); } };
			child.killed = false; child.kill = () => { child.killed = true; };
			children.push(child); return child;
		},
	});
	const stdinLines = (child = children.at(-1)) =>
		writes.filter(w => w.child === child).map(w => w.s).join('').split('\n').filter(Boolean).map(JSON.parse);
	const heartbeat = (message, gen, child = children.at(-1)) =>
		child.stdout.emit('data', `${JSON.stringify({ kind: 'heartbeat', message, generation: gen })}\n`);
	return {
		handlers, children, timers, messages, writes, tool, commands, stdinLines, heartbeat, appended, clock,
		setNow: (ms) => { clock.now = ms; },
		event: (name, arg, ctx) => handlers.get(name)?.(arg, ctx),
		tick: () => { const pending = [...timers.values()]; timers.clear(); pending.forEach(fn => fn()); },
		delivered: () => messages.filter(m => m.options?.deliverAs === 'steer').map(m => m.message),
	};
}

const SESSION_ID = 'sess-1';
const start = (f, isIdle = () => true, entries = null, reason = 'startup') =>
	f.event('session_start', { reason }, {
		isIdle,
		...(entries === null ? {} : { sessionManager: { getEntries: () => entries, getSessionId: () => SESSION_ID } }),
	});

async function enable(f, params = {}) {
	return f.tool.def.execute('id', { action: 'enable', nextAction: 'finish the acceptance report', ...params });
}

async function runCommand(f, name, args, ctx) {
	const captured = [];
	await f.commands.get(name).handler(args, ctx ?? { ui: { notify: (msg) => captured.push(msg) } });
	return captured;
}

const controlEntry = (data) => ({
	type: 'custom',
	customType: 'heartbeat-control',
	data: { owner: data.owner ?? SESSION_ID, ...data },
});

// ── transport regressions (unchanged behavior) ────────────────────────────

test('native child registers no polling lifecycle', () => {
	const f = fixture({ PI_SUBAGENT_CHILD: '1' });
	assert.equal(f.handlers.size, 0);
	assert.equal(f.children.length, 0);
});
test('repeated session_start keeps one worker', () => {
	const f = fixture(); start(f); start(f);
	assert.equal(f.children.length, 1);
});
test('old exit cannot clear replacement or respawn another worker', () => {
	const f = fixture(); start(f); const old = f.children[0];
	f.event('session_shutdown'); start(f);
	old.emit('exit', 0); f.tick();
	assert.equal(f.children.length, 2);
	assert.ok(old.killed);
	old.stdout.emit('data', '{"kind":"wake","message":"stale"}\n');
	assert.equal(f.messages.length, 0);
	f.children[1].stdout.emit('data', '{"kind":"wake","message":"current"}\n');
	assert.equal(f.messages.length, 1);
	assert.equal(f.messages[0].options.deliverAs, 'steer');
});
test('error followed by exit schedules one replacement', () => {
	const f = fixture(); start(f); const child = f.children[0];
	child.emit('error', new Error('fixture')); child.emit('exit', 1);
	assert.equal(f.timers.size, 1); f.tick(); assert.equal(f.children.length, 2);
});
test('shutdown cancels a pending restart', () => {
	const f = fixture(); start(f); f.children[0].emit('exit', 1);
	f.event('session_shutdown'); f.tick(); assert.equal(f.children.length, 1);
});
test('notification (wake) delivery is unaffected by heartbeat state', async () => {
	const f = fixture(); start(f);
	await enable(f);
	f.children[0].stdout.emit('data', '{"kind":"wake","message":"autonomy notifications: ..."}\n');
	assert.deepEqual(f.delivered(), ['autonomy notifications: ...']);
});
test('heartbeat after shutdown is never forwarded', () => {
	const f = fixture(); start(f); f.event('session_shutdown');
	f.heartbeat('ghost', 0);
	assert.equal(f.delivered().length, 0);
	assert.equal(f.timers.size, 0, 'no pending respawn after shutdown');
});

// ── startup snapshot and fresh-session default ────────────────────────────

test('session_start sends an init snapshot from ctx.isIdle, not a worker fallback', () => {
	const f = fixture(); start(f, () => true);
	const [init] = f.stdinLines();
	assert.equal(init.event, 'init');
	assert.equal(init.mode, 'ambient'); // fresh session: bounded ambient fallback
	assert.equal(init.busy, false);
	assert.equal(init.generation, 0);
	assert.ok(init.ambientExpiresAt > f.clock.now, 'fresh ambient window is bounded');
	const f2 = fixture(); start(f2, () => false); // mid-turn session_start
	assert.equal(f2.stdinLines()[0].busy, true);
});

// ── enable: one active goal, no wake-count expiry ─────────────────────────

test('enable switches to goal, persists the transition and sends one fenced enable', async () => {
	const f = fixture(); start(f, () => true, []); // ctx carries a session id
	const res = await enable(f, { idleDelaySeconds: 5 });
	assert.equal(res.details.state.mode, 'goal');
	assert.equal(res.details.state.idleDelayMs, 5000);
	assert.equal(res.details.state.generation, 1);
	const lines = f.stdinLines();
	assert.deepEqual(lines.map(l => l.event), ['init', 'enable'], 'enable sends a single fenced event');
	assert.equal(lines[1].goal, 'finish the acceptance report');
	assert.equal(lines[1].busy, false, 'idle session: the worker may arm without a further turn');
	// One fresh-ambient baseline at session_start + the enable transition.
	assert.deepEqual(f.appended.map(a => a.customType), ['heartbeat-control', 'heartbeat-control']);
	assert.equal(f.appended[0].data.mode, 'ambient', 'fresh baseline persisted at start');
	assert.equal(f.appended[0].data.owner, SESSION_ID, 'baseline is owner-bound');
	assert.equal(f.appended[1].data.mode, 'goal');
	assert.equal(f.appended[1].data.goal, 'finish the acceptance report');
});

test('enable without a meaningful goal pointer is rejected and changes nothing', async () => {
	const f = fixture(); start(f);
	for (const bad of ['', '   ', '   \n  ', undefined]) {
		const res = await f.tool.def.execute('id', { action: 'enable', nextAction: bad });
		assert.equal(res.details.ok, false, `empty pointer ${JSON.stringify(bad)} rejected`);
		assert.match(res.details.error, /non-empty nextAction/);
	}
	assert.equal(f.stdinLines().length, 1, 'only init was sent — no enable event');
	assert.deepEqual(f.appended.map(a => a.data.mode), ['ambient'], 'only the startup baseline is persisted');
	const status = await f.tool.def.execute('id', { action: 'status' });
	assert.equal(status.details.state.mode, 'ambient', 'state untouched');
});

test('idleDelaySeconds defaults to 30s and is bounded (Node 1ms clamp guard)', async () => {
	const f = fixture(); start(f);
	const defaulted = await enable(f, { idleDelaySeconds: 'soon' });
	assert.equal(defaulted.details.state.idleDelayMs, 30_000, 'non-numeric delay falls back to 30s');
	const huge = await enable(f, { idleDelaySeconds: 10 ** 9 });
	assert.equal(huge.details.state.idleDelayMs, 3_600_000, 'overlarge delay clamps to 1 hour');
	const tiny = await enable(f, { idleDelaySeconds: 0.001 });
	assert.equal(tiny.details.state.idleDelayMs, 5_000, 'sub-minimum delay clamps up to 5s');
});

test('the retired wake-budget concept fails explicitly, never silently unlimited', async () => {
	const f = fixture(); start(f);
	const res = await enable(f, { wakeBudget: 5 });
	assert.equal(res.details.ok, false, 'an old finite-budget request is rejected outright');
	assert.match(res.details.error, /wakeBudget is retired/);
	assert.equal(f.stdinLines().length, 1, 'no enable event reached the worker');
	assert.deepEqual(f.appended.map(a => a.data.mode), ['ambient'], 'only the startup baseline is persisted');
	const status = await f.tool.def.execute('id', { action: 'status' });
	assert.equal('remainingWakes' in status.details.state, false);
	assert.doesNotMatch(status.content[0].text, /remaining|budget/i);
});

test('twelve idle goal cycles deliver twelve wakes with no exhaustion (no count expiry)', async () => {
	const f = fixture(); start(f);
	await enable(f); // gen 1
	let gen = 1;
	for (let cycle = 1; cycle <= 12; cycle++) {
		f.event('agent_start'); gen += 1; // the wake triggers a turn
		f.event('agent_end'); gen += 1;   // idle again, worker re-arms
		f.heartbeat(`wake ${cycle}`, gen);
		assert.equal(f.delivered().length, cycle, `cycle ${cycle} delivered`);
	}
	const status = await f.tool.def.execute('id', { action: 'status' });
	assert.equal(status.details.state.mode, 'goal', 'still active after 12 wakes — no count expiry');
});

// ── no busy wake; compaction deferral ─────────────────────────────────────

test('no busy wake: startup busy snapshot and the agent_start race both drop late output', async () => {
	const f = fixture();
	let idle = false;
	const ctx = { isIdle: () => idle };
	start(f, () => false); // session_start mid-turn
	await enable(f); // control sees tracked busy
	assert.equal(f.stdinLines().at(-1).busy, true, 'enable reports busy so the worker does not arm');
	f.heartbeat('fired during the turn', 1);
	assert.equal(f.delivered().length, 0);
	idle = true;
	f.event('agent_end', {}, ctx); // gen 2
	f.heartbeat('after agent_end', 2);
	assert.equal(f.delivered().length, 1);
	idle = false;
	f.event('agent_start', {}, ctx); // gen 3 — timer fired just before a new turn began
	f.heartbeat('race with agent_start', 2);
	assert.equal(f.delivered().length, 1);
	idle = true;
	f.event('agent_end', {}, ctx); // gen 4
	f.heartbeat('delivered again', 4);
	assert.equal(f.delivered().length, 2);
});

test('delivery re-checks isIdle, fails closed when unavailable, and defers compaction', async () => {
	const f = fixture();
	let idle = true;
	const ctx = { isIdle: () => idle };
	start(f, () => true);
	await enable(f); // gen 1
	f.event('agent_end', {}, ctx); // gen 2
	idle = false;
	f.heartbeat('transient busy', 2);
	assert.equal(f.delivered().length, 0);
	assert.equal(f.stdinLines().at(-1).event, 'heartbeat_defer', 'busy check defers through the worker timer');
	assert.equal(f.stdinLines().at(-1).generation, 2);
	// Eventual wake is preserved by the documented lifecycle transition.
	idle = true;
	f.event('agent_start', {}, ctx); // gen 3
	f.event('agent_end', {}, ctx); // gen 4
	f.heartbeat('after transient busy', 4);
	assert.deepEqual(f.delivered(), ['after transient busy']);
	// Fail closed: without a usable isIdle, never deliver.
	const f2 = fixture();
	start(f2);
	await enable(f2);
	f2.event('agent_end', {}, {}); // ctx without isIdle, gen 2
	f2.heartbeat('unknown idleness', 2);
	assert.equal(f2.delivered().length, 0);
});

// ── complete: goal → bounded ambient fallback ─────────────────────────────

test('complete ends the goal, starts a fixed 2h ambient window and carries the handoff prompt', async () => {
	const f = fixture(); start(f);
	await enable(f); // gen 1
	f.event('agent_end'); // gen 2
	const res = await f.tool.def.execute('id', { action: 'complete' });
	assert.equal(res.details.state.mode, 'ambient');
	assert.equal(res.details.state.ambientExpiresAt, T0 + AMBIENT_LIFETIME_MS, 'fixed 2h expiry from entering ambient');
	const last = f.stdinLines().at(-1);
	assert.equal(last.event, 'complete');
	assert.equal(last.ambientExpiresAt, T0 + AMBIENT_LIFETIME_MS);
	// The handoff lives in the tool result, not in a second self-triggering message.
	assert.match(res.content[0].text, /Goal complete\. Is there another authorized goal you can work on\?/);
	assert.match(res.content[0].text, /pause all wakes for a human wait/);
	assert.equal(f.delivered().length, 0, 'no second self-triggering message');
	assert.equal(f.appended.at(-1).data.mode, 'ambient', 'transition persisted');
});

test('repeated complete while ambient never renews the window', async () => {
	const f = fixture(); start(f);
	await enable(f);
	await f.tool.def.execute('id', { action: 'complete' });
	const before = f.stdinLines().length;
	f.setNow(T0 + 3_600_000); // an hour of ambient passes (its own wakes happened)
	const again = await f.tool.def.execute('id', { action: 'complete' });
	assert.equal(again.details.state.mode, 'ambient');
	assert.equal(again.details.state.ambientExpiresAt, T0 + AMBIENT_LIFETIME_MS, 'expiry unchanged');
	assert.match(again.content[0].text, /not renewed/);
	assert.equal(f.stdinLines().length, before, 'no worker event on an empty completion');
});

test('complete while paused never re-enables ambient', async () => {
	const f = fixture(); start(f);
	await enable(f);
	await f.tool.def.execute('id', { action: 'pause' }); // gen 2
	f.setNow(T0 + 3_600_000); // an hour passes — a sneaky re-enable would move the deadline
	const res = await f.tool.def.execute('id', { action: 'complete' });
	assert.equal(res.details.state.mode, 'paused', 'stays paused');
	assert.equal(res.details.state.ambientExpiresAt, T0 + AMBIENT_LIFETIME_MS, 'ambient expiry untouched — no fresh window');
	const last = f.stdinLines().at(-1);
	assert.equal(last.event, 'pause', 'no complete event reached the worker');
	assert.match(res.content[0].text, /paused/);
});

// ── ambient fallback: fixed expiry, own wakes cannot extend it ────────────

test('ambient heartbeats deliver while inside the window and drop once past it', async () => {
	const f = fixture(); start(f); // fresh ambient, gen 0
	f.heartbeat('fallback beat', 0);
	assert.equal(f.delivered().length, 1, 'in-window ambient beat delivered');
	f.setNow(T0 + AMBIENT_LIFETIME_MS + 1);
	f.heartbeat('beat past expiry', 0);
	assert.equal(f.delivered().length, 1, 'delivery past the fixed expiry is dropped');
	const status = await f.tool.def.execute('id', { action: 'status' });
	assert.equal(status.details.state.ambientExpired, true);
	assert.match(status.content[0].text, /EXPIRED/);
});

test('ambient mode defers on busy and delivers when idle again', async () => {
	const f = fixture();
	let idle = true;
	const ctx = { isIdle: () => idle };
	start(f, () => idle);
	f.heartbeat('ambient beat', 0);
	assert.equal(f.delivered().length, 1);
	idle = false;
	f.event('agent_end', {}, ctx); // gen 1 (worker re-arms ambient)
	f.heartbeat('during compaction', 1);
	assert.equal(f.delivered().length, 1);
	assert.equal(f.stdinLines().at(-1).event, 'heartbeat_defer', 'ambient defers through the worker timer too');
	idle = true;
	f.heartbeat('after compaction', 1);
	assert.equal(f.delivered().length, 2);
});

// ── hold: absolute deadline, heartbeat-only ───────────────────────────────

test('hold records an absolute deadline derived from holdSeconds and fences stale beats', async () => {
	const f = fixture(); start(f);
	await enable(f, { idleDelaySeconds: 30 }); // gen 1
	const res = await f.tool.def.execute('id', { action: 'hold', holdSeconds: 300 }); // gen 2
	assert.equal(res.details.state.mode, 'goal', 'hold preserves the goal');
	assert.equal(res.details.state.holdUntil, T0 + 300_000, 'absolute deadline = now + 300s');
	const last = f.stdinLines().at(-1);
	assert.equal(last.event, 'hold');
	assert.equal(last.holdUntil, T0 + 300_000);
	assert.equal(f.appended.at(-1).data.holdUntil, T0 + 300_000, 'hold transition persisted');
	// A beat queued before the hold is fenced by the generation bump.
	f.event('agent_end'); // gen 3
	f.heartbeat('pre-hold beat', 2);
	assert.equal(f.delivered().length, 0, 'stale pre-hold output rejected');
});

test('hold is rejected while paused and requires a positive finite delay', async () => {
	const f = fixture(); start(f);
	for (const bad of [0, -5, 'soon', undefined]) {
		const res = await f.tool.def.execute('id', { action: 'hold', holdSeconds: bad });
		assert.equal(res.details.ok, false, `holdSeconds ${JSON.stringify(bad)} rejected`);
		assert.match(res.details.error, /positive finite holdSeconds/);
	}
	await enable(f);
	await f.tool.def.execute('id', { action: 'pause' });
	const paused = await f.tool.def.execute('id', { action: 'hold', holdSeconds: 300 });
	assert.equal(paused.details.ok, false);
	assert.match(paused.details.error, /paused/);
	assert.equal(paused.details.state.mode, 'paused', 'hold never un-pauses');
	assert.equal(f.stdinLines().at(-1).event, 'pause', 'no hold event while paused');
});

test('hold preserves mode and ordinary notification delivery', async () => {
	const f = fixture(); start(f);
	await enable(f);
	await f.tool.def.execute('id', { action: 'hold', holdSeconds: 300 });
	f.children[0].stdout.emit('data', '{"kind":"wake","message":"human notification"}\n');
	assert.deepEqual(f.delivered(), ['human notification'], 'hold never blocks ordinary notifications');
});

test('delivery re-checks the hold deadline: current-generation early output defers, not bypasses', async () => {
	const f = fixture(); start(f);
	await enable(f); // gen 1
	await f.tool.def.execute('id', { action: 'hold', holdSeconds: 300 }); // gen 2
	f.event('agent_end'); // gen 3, idle
	f.heartbeat('early current-generation output', 3);
	assert.equal(f.delivered().length, 0, 'hold is honored at delivery time');
	assert.equal(f.stdinLines().at(-1).event, 'heartbeat_defer');
	assert.equal(f.stdinLines().at(-1).generation, 3);
	f.setNow(T0 + 301_000); // the hold deadline passes
	f.heartbeat('after the hold', 3);
	assert.deepEqual(f.delivered(), ['after the hold']);
});

// ── pause ─────────────────────────────────────────────────────────────────

test('pause silences heartbeat wakes — ambient included — until enabled again', async () => {
	const f = fixture(); start(f);
	await runCommand(f, 'hb', 'pause'); // gen 1
	f.heartbeat('ambient while paused', 1);
	assert.equal(f.delivered().length, 0);
	await enable(f); // gen 2
	await runCommand(f, 'hb', 'pause'); // gen 3
	f.heartbeat('goal while paused', 3);
	assert.equal(f.delivered().length, 0);
	await enable(f, { nextAction: 'resume the goal' }); // gen 4 — explicit resume
	f.heartbeat('back', 4);
	assert.equal(f.delivered().length, 1);
});

// ── truthful status ───────────────────────────────────────────────────────

test('ambient status shows an active hold and busy suppression in the model-visible text', async () => {
	const f = fixture(); start(f);
	await enable(f); // gen 1
	await f.tool.def.execute('id', { action: 'complete' }); // gen 2 → ambient
	await f.tool.def.execute('id', { action: 'hold', holdSeconds: 300 }); // gen 3: hold during ambient
	const done = await f.tool.def.execute('id', { action: 'status' });
	const text = done.content[0].text;
	assert.match(text, /heartbeat ambient/);
	assert.match(text, /held until/, 'ambient hold is model-visible, not details-only');
	const f2 = fixture();
	let idle = false;
	start(f2, () => idle);
	const busyStatus = await f2.tool.def.execute('id', { action: 'status' });
	assert.match(busyStatus.content[0].text, /\(busy/, 'ambient busy suppression is model-visible');
});

test('status is truthful: no next-due claim while busy, none while paused, hold and expiry shown', async () => {
	const f = fixture();
	let idle = false;
	const ctx = { isIdle: () => idle };
	start(f, () => idle);
	await enable(f, { idleDelaySeconds: 30 });
	let status = await f.tool.def.execute('id', { action: 'status' });
	assert.match(status.content[0].text, /\(busy/, 'busy is reported');
	assert.doesNotMatch(status.content[0].text, /next wake/, 'no next-due claim while busy');
	await f.tool.def.execute('id', { action: 'hold', holdSeconds: 300 });
	status = await f.tool.def.execute('id', { action: 'status' });
	assert.match(status.content[0].text, /held until/, 'hold deadline shown');
	idle = true;
	f.event('agent_end', {}, ctx); // lifecycle transition clears the tracked busy flag
	f.setNow(T0 + 301_000); // hold deadline passes → the normal idle-delay claim returns
	status = await f.tool.def.execute('id', { action: 'status' });
	assert.match(status.content[0].text, /next wake: after 30s idle/, 'idle goal claims its delay');
	await f.tool.def.execute('id', { action: 'pause' });
	status = await f.tool.def.execute('id', { action: 'status' });
	assert.doesNotMatch(status.content[0].text, /next wake/, 'no next-due while paused');
	assert.match(status.content[0].text, /paused/);
});

// ── generation fences ─────────────────────────────────────────────────────

test('fence: beats queued before an enable cannot deliver after it', async () => {
	const f = fixture(); start(f);
	f.heartbeat('ambient before enable', 0); // gen 0 == 0: delivered
	assert.equal(f.delivered().length, 1);
	await enable(f); // gen 1
	f.heartbeat('beat queued before enable', 0); // stale era
	assert.equal(f.delivered().length, 1, 'stale output rejected after enable');
	f.heartbeat('goal beat', 1);
	assert.equal(f.delivered().length, 2, 'current-generation wake still delivered');
});

test('fence: stale output after a re-enable is rejected before delivery', async () => {
	const f = fixture(); start(f);
	await enable(f, { nextAction: 'plan the board fix' }); // gen 1
	f.heartbeat('wake for plan the board fix', 1);
	assert.equal(f.delivered().length, 1);
	await enable(f, { nextAction: 'write the report' }); // gen 2 — re-enable
	f.heartbeat('stale wake for plan the board fix', 1);
	assert.equal(f.delivered().length, 1, 'stale goal text never delivered after re-enable');
	f.heartbeat('wake for write the report', 2);
	assert.deepEqual(f.delivered()[1], 'wake for write the report');
});

test("fence: a prior idle cycle's output arriving after a newer cycle is rejected", async () => {
	const f = fixture(); start(f);
	await enable(f); // gen 1
	f.heartbeat('cycle 1 wake', 1);
	assert.equal(f.delivered().length, 1);
	f.event('agent_start', {}, { isIdle: () => false }); // gen 2
	f.event('agent_end', {}, { isIdle: () => true }); // gen 3 — worker re-arms cycle 2
	f.heartbeat('cycle 2 wake', 3);
	assert.equal(f.delivered().length, 2);
	f.heartbeat('cycle 1 duplicate', 1);
	f.heartbeat('pre-turn duplicate', 2);
	assert.equal(f.delivered().length, 2, 'older-generation output never delivers after a newer cycle');
});

// ── lifecycle hygiene: crash replay, shutdown ─────────────────────────────

test('crash respawn replays control state — mode, goal, delay, deadlines and generation', async () => {
	const f = fixture(); start(f, () => true);
	await enable(f, { idleDelaySeconds: 30 }); // gen 1
	await f.tool.def.execute('id', { action: 'hold', holdSeconds: 60 }); // gen 2
	f.event('agent_end'); // gen 3
	// The hold is honored at delivery time even for current-generation output.
	f.heartbeat('wake one while held', 3);
	assert.equal(f.delivered().length, 0, 'hold deadline re-checked at delivery');
	assert.equal(f.stdinLines().at(-1).event, 'heartbeat_defer');
	f.setNow(T0 + 61_000); // the hold deadline passes
	f.heartbeat('wake one after hold', 3);
	assert.equal(f.delivered().length, 1);
	f.children[0].emit('exit', 1);
	f.tick(); // respawn
	assert.equal(f.children.length, 2);
	const [init] = f.stdinLines(f.children[1]);
	assert.equal(init.event, 'init');
	assert.equal(init.mode, 'goal');
	assert.equal(init.goal, 'finish the acceptance report');
	assert.equal(init.idleDelayMs, 30_000);
	assert.equal(init.holdUntil, T0 + 60_000, 'absolute hold deadline survives the crash');
	assert.equal(init.generation, 3, 'generation survives the crash so old output stays fenced');
	// the replacement continues the same goal, not a fresh one
	f.heartbeat('wake two', 3, f.children[1]);
	assert.equal(f.delivered().length, 2);
});

test('session shutdown resets in-memory state; persistence decides the next start', async () => {
	const f = fixture(); start(f);
	await enable(f);
	f.event('session_shutdown');
	start(f, () => true, []); // no persisted entries in this fixture
	const [init] = f.stdinLines(f.children[1]);
	assert.equal(init.mode, 'ambient', 'no entries: fresh bounded ambient');
	assert.equal(init.generation, 0);
	const status = await f.tool.def.execute('id', { action: 'status' });
	assert.equal(status.details.state.mode, 'ambient');
	assert.match(status.content[0].text, /30-minute fallback/);
});

// ── session-owned persistence and restore ─────────────────────────────────

test('persisted goal is restored on resume and sent to the worker with deadlines intact', () => {
	const f = fixture();
	const entries = [controlEntry({ mode: 'goal', goal: 'ship the heartbeat', idleDelayMs: 45_000, holdUntil: T0 + 120_000, ambientExpiresAt: 0, at: T0 })];
	start(f, () => true, entries, 'resume');
	const [init] = f.stdinLines();
	assert.equal(init.mode, 'goal');
	assert.equal(init.goal, 'ship the heartbeat');
	assert.equal(init.idleDelayMs, 45_000);
	assert.equal(init.holdUntil, T0 + 120_000, 'hold deadline survives reload without renewal');
	assert.equal(init.generation, 0, 'fresh worker, fresh fence era');
});

test('restored ambient past its expiry is reported as expired and stays silent', async () => {
	const f = fixture();
	const entries = [controlEntry({ mode: 'ambient', goal: '', idleDelayMs: 30_000, holdUntil: 0, ambientExpiresAt: T0 - 1_000, at: T0 - 2_000 })];
	start(f, () => true, entries, 'resume');
	const status = await f.tool.def.execute('id', { action: 'status' });
	assert.equal(status.details.state.ambientExpired, true);
	f.heartbeat('late ambient beat', 0);
	assert.equal(f.delivered().length, 0, 'expired fallback never wakes');
});

test('restore takes the latest VALID control entry across all entries, not the current branch', () => {
	const f = fixture();
	const entries = [
		controlEntry({ mode: 'goal', goal: 'old goal', idleDelayMs: 30_000, holdUntil: 0, ambientExpiresAt: 0, at: 1 }),
		{ type: 'message', id: 'x' }, // unrelated entries are skipped
		controlEntry({ mode: 'paused', goal: '', idleDelayMs: 30_000, holdUntil: 0, ambientExpiresAt: 0, at: 2 }),
		controlEntry({ mode: 'goal', goal: '   ', idleDelayMs: 30_000, holdUntil: 0, ambientExpiresAt: 0, at: 3 }), // invalid: empty goal
		controlEntry({ mode: 'banana', at: 4 }), // invalid: unknown mode
	];
	start(f, () => true, entries, 'resume');
	const [init] = f.stdinLines();
	assert.equal(init.mode, 'paused', 'a newer pause can never be resurrected into a goal by tree navigation');
	assert.equal(init.goal, '');
});

test('fork and new sessions never inherit the old owner’s active goal', () => {
	for (const reason of ['fork', 'new']) {
		const f = fixture();
		const entries = [controlEntry({ mode: 'goal', goal: 'parent goal', idleDelayMs: 30_000, holdUntil: 0, ambientExpiresAt: 0, at: 1 })];
		start(f, () => true, entries, reason);
		const [init] = f.stdinLines();
		assert.equal(init.mode, 'ambient', `${reason}: no goal inheritance`);
		assert.equal(init.goal, '');
		assert.ok(init.ambientExpiresAt > f.clock.now, `${reason}: fresh bounded ambient window instead`);
	}
});

test('fork then reload: old-owner entries stay inert; the fresh baseline wins and never renews', () => {
	// Step 1: fork — old-owner goal entries are skipped, fresh ambient baseline persisted.
	const f = fixture();
	const oldOwner = [controlEntry({ owner: 'parent-session', mode: 'goal', goal: 'parent goal', idleDelayMs: 30_000, holdUntil: 0, ambientExpiresAt: 0, at: 1 })];
	start(f, () => true, oldOwner, 'fork');
	const [init] = f.stdinLines();
	assert.equal(init.mode, 'ambient', 'fork starts fresh ambient');
	const baseline = f.appended.at(-1).data;
	assert.equal(baseline.owner, SESSION_ID, 'baseline is bound to the NEW session');
	// Step 2: reload of the forked session — copied old-owner goal + new baseline.
	const f2 = fixture();
	const reloaded = [...oldOwner, controlEntry(baseline)];
	start(f2, () => true, reloaded, 'resume');
	const [init2] = f2.stdinLines();
	assert.equal(init2.mode, 'ambient', 'old-owner goal never restores into the fork');
	assert.equal(init2.goal, '');
	assert.equal(init2.ambientExpiresAt, baseline.ambientExpiresAt, 'reload restores the SAME expiry — not renewed');
});

test('ambient startup then reload: the bounded window survives without renewal', () => {
	const f = fixture(); start(f, () => true, [], 'startup'); // no history → baseline persisted
	const baseline = f.appended.at(-1).data;
	assert.equal(baseline.mode, 'ambient');
	const f2 = fixture();
	start(f2, () => true, [controlEntry(baseline)], 'resume');
	const [init2] = f2.stdinLines();
	assert.equal(init2.mode, 'ambient');
	assert.equal(init2.ambientExpiresAt, baseline.ambientExpiresAt, 'expiry is absolute — reload does not restart the 2h clock');
});

test('foreign-owner goal entries are skipped even when they are the newest entries', () => {
	const f = fixture();
	const entries = [
		controlEntry({ mode: 'paused', goal: '', idleDelayMs: 30_000, holdUntil: 0, ambientExpiresAt: 0, at: 1 }),
		controlEntry({ owner: 'other-session', mode: 'goal', goal: 'someone else’s goal', idleDelayMs: 30_000, holdUntil: 0, ambientExpiresAt: 0, at: 2 }),
	];
	start(f, () => true, entries, 'resume');
	const [init] = f.stdinLines();
	assert.equal(init.mode, 'paused', 'a foreign session’s goal can never resurrect over our own pause');
});

test('ephemeral sessions without a sessionManager still start (bounded ambient)', () => {
	const f = fixture();
	start(f, () => true, undefined, 'startup'); // ctx without sessionManager
	const [init] = f.stdinLines();
	assert.equal(init.mode, 'ambient');
	assert.ok(init.ambientExpiresAt > f.clock.now);
});

test('status does not persist; only transitions and the startup baseline do', async () => {
	const f = fixture(); start(f);
	assert.equal(f.appended.length, 1, 'exactly the fresh-ambient baseline at start');
	const before = f.appended.length;
	await f.tool.def.execute('id', { action: 'status' });
	assert.equal(f.appended.length, before, 'status is not a transition');
	await f.tool.def.execute('id', { action: 'complete' }); // ambient, no goal — no transition
	assert.equal(f.appended.length, before, 'empty completion is not persisted');
});

// ── shared control path: model tool and human command ─────────────────────

test('model tool and human command share the same supervisor-owned state', async () => {
	const f = fixture(); start(f);
	await enable(f, { idleDelaySeconds: 30 }); // via the MODEL tool
	const notes = await runCommand(f, 'hb', 'status'); // via the HUMAN command
	assert.match(notes[0], /heartbeat goal/);
	assert.match(notes[0], /finish the acceptance report/);
	await runCommand(f, 'hb', 'complete'); // human complete
	const toolStatus = await f.tool.def.execute('id', { action: 'status' });
	assert.equal(toolStatus.details.state.mode, 'ambient');
	// human enable resumes goal work
	await runCommand(f, 'hb', 'enable check the acceptance report'); // gen bump
	f.event('agent_end'); // idle again at the current generation
	const after = await f.tool.def.execute('id', { action: 'status' });
	assert.equal(after.details.state.mode, 'goal');
	assert.equal(after.details.state.goal, 'check the acceptance report');
	f.heartbeat('human-armed wake', after.details.state.generation);
	assert.equal(f.delivered().length, 1);
});

test('/hb usage and unknown verbs report without crashing', async () => {
	const f = fixture(); start(f);
	const notes = await runCommand(f, 'hb', 'bogus');
	assert.match(notes[0], /usage: \/hb enable/);
});
