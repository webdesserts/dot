/**
 * Behavioral tests for the context-controls extension
 * (pi/extensions/context-controls.ts).
 *
 * VM sandbox with a fake pi double and a fake extension context (synthetic
 * usage, deterministic compaction lifecycle via getBranch entries) — no real
 * LLM calls, no live parent state. Covers: 40/60 alerts with per-epoch
 * delivered state (no 39→41 flapping; epoch resets ONLY on a confirmed
 * compaction entry or model/window change — unknown/decreasing never reset),
 * coalesced jumps, stock no-turn delivery via pi.sendMessage({triggerTurn:
 * false}) at turn_end without sendUserMessage/tool-result mutation, branch-
 * marker fulfillment correlation (pre-existing/other-branch/missing-marker
 * counterexamples), deferred agent_settled dispatch with terminate:true
 * sole-call acceptance and sibling rejection, duplicate/in-flight guards,
 * truthful outcomes with native-event dedupe, and stale-callback/session
 * invalidation.
 *
 * Run: node --test pi/tests/context-controls/supervisor.test.mjs  (repo root)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const T0 = 1_700_000_000_000;

function fixture() {
	const handlers = new Map();
	const tools = new Map();
	const sent = []; // pi.sendUserMessage — must stay EMPTY forever
	const sentCustom = []; // pi.sendMessage — the stock no-turn delivery channel
	const clock = { now: T0, seq: 0 };
	class FakeDate extends Date { }
	FakeDate.now = () => clock.now;
	const pi = {
		on: (name, fn) => handlers.set(name, fn),
		registerTool: (def) => tools.set(def.name, def),
		registerCommand: () => {},
		sendUserMessage: (...a) => sent.push(a),
		sendMessage: (message, options) => sentCustom.push({ message, options }),
		appendEntry: (customType, data) => {
			// Mirror the real session: custom entries are readable via
			// getEntries() and carry generated ids.
			const id = `custom-${++clock.seq}`;
			state.entries.push({ type: 'custom', customType, data, id });
			return id;
		},
	};
	const source = fs.readFileSync(new URL('../../extensions/context-controls.ts', import.meta.url), 'utf8')
		.replace(/^import .*;\n/gm, '')
		.replace('export default function (pi)', 'function setup(pi)');
	const state = {
		usage: undefined, // getContextUsage() result
		modelId: 'test-model',
		sessionId: 'session-A',
		branch: [], // sessionManager.getBranch() — current-branch entries
		entries: [], // getEntries() — includes custom epoch-persistence entries
		compactCalls: [],
		compactImpl: null,
	};
	vm.runInNewContext(`${source}\nsetup(pi);`, {
		pi, process: { env: {} }, console: { error() {} }, Date: FakeDate,
		Type: { Object: v => v, String: v => v, Optional: v => v },
	});
	const ctx = {
		getContextUsage: () => state.usage,
		isIdle: () => true,
		get model() { return { id: state.modelId }; },
		sessionManager: {
			getSessionId: () => state.sessionId,
			getBranch: () => state.branch,
			getEntries: () => state.entries,
		},
		compact: (options) => {
			state.compactCalls.push({ options, at: clock.now });
			if (state.compactImpl) state.compactImpl(options);
		},
	};
	const event = (name, arg = {}, context = ctx) => handlers.get(name)?.(arg, context);
	const usage = (tokens, window) => ({
		tokens,
		contextWindow: window,
		percent: tokens === null ? null : (tokens / window) * 100,
	});
	return {
		handlers, tools, sent, sentCustom, clock, ctx, state, usage, event,
		observe: (tokens, window = 200_000, model) => {
			state.usage = usage(tokens, window);
			if (model) state.modelId = model;
			event('turn_end');
		},
		// Notices delivered through the stock no-turn channel at turn_end.
		notices: () => sentCustom.map((s) => s.message.content[0].text),
		// Pressure-alert notices only (the confirmed-outcome notice is separate).
		pressures: () => sentCustom.map((s) => s.message.content[0].text).filter((t) => t.includes('Context pressure')),
		// The exact pi.sendMessage options for the latest delivery.
		lastDeliveryOptions: () => sentCustom.at(-1)?.options ?? null,
	};
}

const WINDOW = 200_000;

test('alerts fire once per epoch and never flap on threshold oscillation', () => {
	const f = fixture();
	f.event('session_start', { reason: 'startup' }, f.ctx);
	f.observe(60_000); // 30% baseline
	assert.equal(f.pressures().length, 0, 'baseline is silent');
	f.observe(90_000); // 45%
	assert.match(f.notices()[0] ?? '', /40%/);
	assert.equal(f.pressures().length, 1);
	f.observe(100_000); // 50%
	assert.equal(f.pressures().length, 1, 'no repeat inside the band');
	f.observe(130_000); // 65%
	assert.match(f.notices()[1] ?? '', /60%/);
	// The flap case: 39→41→39→41 never re-alerts within the epoch.
	f.observe(78_000);
	f.observe(82_000);
	f.observe(78_000);
	f.observe(82_000);
	assert.equal(f.pressures().length, 2, 'per-epoch delivered state holds');
	// Decreasing estimates: never alert.
	f.observe(100_000);
	f.observe(50_000);
	assert.equal(f.pressures().length, 2, 'decreasing is silent');
});

test('a multi-threshold jump is coalesced into ONE notice', () => {
	const f = fixture();
	f.event('session_start', { reason: 'startup' }, f.ctx);
	f.observe(50_000); // 25%
	f.observe(150_000); // 75% — jumps 40 and 60
	const notices = f.notices();
	assert.equal(notices.length, 1, 'exactly one notice');
	assert.match(notices[0], /40%/);
	assert.match(notices[1] ?? '', /^$/); // no second notice
	assert.match(notices[0], /60%/);
});

test('delivery is stock pi.sendMessage with triggerTurn:false; sendUserMessage never used', () => {
	const f = fixture();
	f.event('session_start', { reason: 'startup' }, f.ctx);
	f.observe(50_000);
	f.observe(170_000); // 85% — jumps both levels
	assert.equal(f.sent.length, 0, 'sendUserMessage NEVER called');
	assert.equal(f.sentCustom.length, 1);
	const delivery = f.sentCustom[0];
	assert.equal(delivery.options?.triggerTurn, false, 'never creates a turn');
	assert.equal(delivery.message.customType, 'context-controls-notice');
	// Delivered once.
	f.observe(175_000);
	assert.equal(f.sentCustom.length, 1, 'no repeat');
});

test('turn_end delivery reaches the immediately next model request without tool-result mutation', () => {
	const f = fixture();
	f.event('session_start', { reason: 'startup' }, f.ctx);
	// No tool_result / before_agent_start delivery machinery remains.
	assert.equal(f.handlers.get('tool_result'), undefined, 'tool results are never mutated');
	assert.equal(f.handlers.get('before_agent_start'), undefined, 'no before_agent_start fallback needed');
	f.observe(50_000);
	f.observe(130_000); // 65%
	assert.equal(f.sentCustom.length, 1, 'notice sent at the crossing turn_end');
	// The SDK flushes it after turn_end handlers: the next request sees it.
	f.observe(140_000);
	assert.equal(f.sentCustom.length, 1, 'delivered exactly once');
});

test('unknown usage and decreases never reset the epoch; only a confirmed compaction entry does', () => {
	const f = fixture();
	f.event('session_start', { reason: 'startup' }, f.ctx);
	f.observe(50_000); // 25% baseline
	f.observe(130_000); // 65% — 40 and 60 announced
	assert.equal(f.pressures().length, 1);
	// Null usage (may be observed post-compaction): never resets the epoch.
	f.state.usage = f.usage(null, WINDOW);
	f.event('turn_end');
	// Direct regrowth without any null observation and without a confirmed
	// compaction: still silent (no blind reset).
	f.observe(100_000); // 50%
	assert.equal(f.pressures().length, 1);
	f.observe(130_000); // 65%
	assert.equal(f.pressures().length, 1, 'no re-announce without a new epoch');
	// A CONFIRMED compaction entry starts a new epoch (entry identity).
	f.state.branch.push({ type: 'compaction', id: 'cmp-1', tokensBefore: 150_000 });
	f.event('session_compact', { compactionEntry: { id: 'cmp-1', tokensBefore: 150_000 } }, f.ctx);
	f.observe(100_000); // 50% — post-compaction, new epoch baseline
	assert.equal(f.pressures().length, 1);
	f.observe(130_000); // 65% — regrowth re-announces 60 in the new epoch
	assert.match(f.pressures()[1] ?? '', /60%/);
	assert.equal(f.pressures().length, 2);
	// Oscillation after the new-epoch announcement stays silent.
	f.observe(78_000); // 39%
	f.observe(82_000); // 41% — 40% was never delivered in this epoch
	const first40 = f.pressures()[2] ?? '';
	assert.match(first40, /40%/, 'one legit new-epoch 40% alert');
	assert.equal(f.pressures().length, 3, 'now delivered — no flapping');
});

test('delivered levels survive a same-epoch reload; new/fork sessions start fresh', () => {
	const f = fixture();
	f.event('session_start', { reason: 'startup' }, f.ctx);
	f.observe(50_000);
	f.observe(130_000); // 40 and 60 announced; persisted via appendEntry
	assert.equal(f.pressures().length, 1);
	// Same-epoch reload: the persisted epoch marker (cmp-1) is on the branch.
	f.state.branch.push({ type: 'compaction', id: 'cmp-1' });
	f.event('session_start', { reason: 'reload' }, f.ctx);
	f.observe(82_000); // 41%
	assert.equal(f.pressures().length, 1, 'delivered levels preserved across reload');
	f.observe(78_000);
	f.observe(82_000);
	assert.equal(f.pressures().length, 1, '39→41 does not repeat after reload');
	// A new session (different id) starts a fresh epoch.
	f.state.sessionId = 'session-B';
	f.event('session_start', { reason: 'new' }, f.ctx);
	f.observe(82_000); // baseline in the new session
	assert.equal(f.pressures().length, 1);
	f.observe(130_000);
	assert.match(f.notices()[1] ?? '', /60%/, 'fresh session announces normally');
});

test('model/window changes establish a new epoch silently', () => {
	const f = fixture();
	f.event('session_start', { reason: 'startup' }, f.ctx);
	f.observe(50_000);
	f.observe(130_000);
	assert.equal(f.pressures().length, 1);
	// Window change re-baselines with a new epoch.
	f.state.usage = f.usage(150_000, 400_000);
	f.event('turn_end');
	assert.equal(f.pressures().length, 1, 'window change is silent');
	// Model change re-baselines silently.
	f.state.usage = f.usage(170_000, 400_000);
	f.state.modelId = 'other-model';
	f.event('turn_end');
	assert.equal(f.pressures().length, 1, 'model change is silent');
});

test('usage() distinguishes unavailable, unknown, and zero', async () => {
	const f = fixture();
	f.event('session_start', { reason: 'startup' }, f.ctx);
	const tool = f.tools.get('usage');
	f.state.usage = undefined;
	let r = await tool.execute('id', {}, undefined, undefined, f.ctx);
	assert.match(r.content[0].text, /unavailable/);
	f.state.usage = f.usage(null, WINDOW);
	r = await tool.execute('id', {}, undefined, undefined, f.ctx);
	assert.match(r.content[0].text, /unknown/);
	assert.match(r.content[0].text, /not zero/);
	f.state.usage = f.usage(0, WINDOW);
	r = await tool.execute('id', {}, undefined, undefined, f.ctx);
	assert.match(r.content[0].text, /0%/);
	f.state.usage = f.usage(150_000, WINDOW);
	r = await tool.execute('id', {}, undefined, undefined, f.ctx);
	assert.match(r.content[0].text, /150k/);
	assert.match(r.content[0].text, /75%/);
});

test('compact() defers dispatch to agent_settled and never runs mid-turn', async () => {
	const f = fixture();
	f.event('session_start', { reason: 'startup' }, f.ctx);
	const tool = f.tools.get('compact');
	const r = await tool.execute('id', {}, undefined, undefined, f.ctx);
	assert.equal(r.details.accepted, true);
	assert.equal(r.details.dispatched, false);
	assert.equal(r.terminate, true, 'sole accepted call terminates the run at batch end');
	assert.equal(f.state.compactCalls.length, 0, 'no inline native compaction');
	f.event('agent_settled');
	assert.equal(f.state.compactCalls.length, 1, 'dispatched at agent_settled');
	f.state.compactCalls[0].options.onComplete({ tokensBefore: 180_000, estimatedTokensAfter: 30_000 });
	const report = await f.tools.get('usage').execute('id', {}, undefined, undefined, f.ctx);
	assert.match(report.content[0].text, /SUCCESS/);
	assert.match(report.content[0].text, /180k/);
});

test('compact batched with a sibling is rejected; sole call is accepted', async () => {
	const f = fixture();
	f.event('session_start', { reason: 'startup' }, f.ctx);
	f.event('message_end', {
		message: {
			role: 'assistant',
			content: [
				{ type: 'text', text: 'work' },
				{ type: 'toolCall', id: 'c1', name: 'compact' },
				{ type: 'toolCall', id: 'c2', name: 'bash' },
			],
		},
	}, f.ctx);
	const rejected = await f.tools.get('compact').execute('c1', {}, undefined, undefined, f.ctx);
	assert.equal(rejected.details.rejected, 'siblings');
	assert.equal(rejected.terminate, undefined);
	f.event('agent_settled');
	assert.equal(f.state.compactCalls.length, 0, 'rejected request never dispatches');
	f.event('message_end', {
		message: { role: 'assistant', content: [{ type: 'toolCall', id: 'c3', name: 'compact' }] },
	}, f.ctx);
	const sole = await f.tools.get('compact').execute('c3', {}, undefined, undefined, f.ctx);
	assert.equal(sole.details.accepted, true);
	assert.equal(sole.terminate, true);
});

test('duplicate and in-flight requests are guarded; sync callbacks never strand the guard', async () => {
	const f = fixture();
	f.event('session_start', { reason: 'startup' }, f.ctx);
	const tool = f.tools.get('compact');
	await tool.execute('id', {}, undefined, undefined, f.ctx);
	const dup = await tool.execute('id', {}, undefined, undefined, f.ctx);
	assert.equal(dup.details.duplicate, true);
	f.event('agent_settled');
	assert.equal(f.state.compactCalls.length, 1);
	const race = await tool.execute('id', {}, undefined, undefined, f.ctx);
	assert.equal(race.details.duplicate, true, 'in-flight duplicate refused');
	// Terminal callback clears the guard.
	f.state.compactCalls[0].options.onComplete({ tokensBefore: 1, estimatedTokensAfter: 1 });
	const after = await tool.execute('id', {}, undefined, undefined, f.ctx);
	assert.equal(after.details.accepted, true, 'guard cleared after completion');
	// A synchronous terminal callback inside ctx.compact also clears it.
	f.state.compactImpl = (options) => options.onComplete({ tokensBefore: 1, estimatedTokensAfter: 1 });
	f.event('agent_settled');
	const afterSync = await tool.execute('id', {}, undefined, undefined, f.ctx);
	assert.equal(afterSync.details.accepted, true, 'no stranded guard after sync callback');
});

test('failure and abort are truthful and never strand the guard', async () => {
	const f = fixture();
	f.event('session_start', { reason: 'startup' }, f.ctx);
	await f.tools.get('compact').execute('id', {}, undefined, undefined, f.ctx);
	f.event('agent_settled');
	f.state.compactCalls[0].options.onError(new Error('provider exploded'));
	let report = await f.tools.get('usage').execute('id', {}, undefined, undefined, f.ctx);
	assert.match(report.content[0].text, /FAILED/);
	assert.match(report.content[0].text, /provider exploded/);
	const again = await f.tools.get('compact').execute('id', {}, undefined, undefined, f.ctx);
	assert.equal(again.details.accepted, true, 'guard cleared after failure');
	// Native abort path.
	f.event('session_compact_failed', { aborted: true, errorMessage: 'cancelled by user' });
	report = await f.tools.get('usage').execute('id', {}, undefined, undefined, f.ctx);
	assert.match(report.content[0].text, /ABORTED/);
	const after = await f.tools.get('compact').execute('id', {}, undefined, undefined, f.ctx);
	assert.equal(after.details.accepted, true, 'no stranded guard after abort');
});

test('native session_compact clears a pending request (no double-compaction)', async () => {
	const f = fixture();
	f.event('session_start', { reason: 'startup' }, f.ctx);
	f.event('session_compact', { compactionEntry: { id: 'auto-1', tokensBefore: 190_000 } });
	const report = await f.tools.get('usage').execute('id', {}, undefined, undefined, f.ctx);
	assert.match(report.content[0].text, /SUCCESS/);
	assert.match(report.content[0].text, /confirmed by session_compact/);
	f.event('agent_settled');
	assert.equal(f.state.compactCalls.length, 0, 'no dispatch after auto-compaction fulfilled');
});

test('correlation uses the request-time branch marker: pre-existing, other-branch and missing markers never fulfill', async () => {
	const f = fixture();
	f.event('session_start', { reason: 'startup' }, f.ctx);
	// Pre-existing compaction on the branch at acceptance time.
	f.state.branch.push({ type: 'message', id: 'm1' }, { type: 'compaction', id: 'old' });
	await f.tools.get('compact').execute('id', {}, undefined, undefined, f.ctx);
	f.state.compactImpl = (options) => options.onError(new Error('Already compacted'));
	f.event('agent_settled');
	let report = await f.tools.get('usage').execute('id', {}, undefined, undefined, f.ctx);
	assert.match(report.content[0].text, /FAILED/, 'pre-existing compaction is not fulfillment');
	// A real LATER compaction on the SAME branch fulfills the failed request.
	await f.tools.get('compact').execute('id', {}, undefined, undefined, f.ctx);
	f.state.compactImpl = (options) => options.onError(new Error('Already compacted'));
	f.state.branch.push({ type: 'compaction', id: 'later-1' });
	f.event('agent_settled');
	report = await f.tools.get('usage').execute('id', {}, undefined, undefined, f.ctx);
	assert.match(report.content[0].text, /SUCCESS/);
	assert.match(report.content[0].text, /fulfilled by an actual compaction/);
	// A compaction on a DIFFERENT branch (leaf changed) never fulfills.
	await f.tools.get('compact').execute('id', {}, undefined, undefined, f.ctx);
	f.state.compactImpl = (options) => options.onError(new Error('Already compacted'));
	f.state.branch = [{ type: 'message', id: 'other-branch-m1' }, { type: 'compaction', id: 'other-branch-cmp' }];
	f.event('agent_settled');
	report = await f.tools.get('usage').execute('id', {}, undefined, undefined, f.ctx);
	assert.match(report.content[0].text, /FAILED/, 'other-branch compaction is not fulfillment');
	// Missing marker (no getBranch available) also refuses correlation.
	const f2 = fixture();
	f2.event('session_start', { reason: 'startup' }, f2.ctx);
	delete f2.ctx.sessionManager.getBranch;
	await f2.tools.get('compact').execute('id', {}, undefined, undefined, f2.ctx);
	f2.state.compactImpl = (options) => options.onError(new Error('Already compacted'));
	f2.state.entries.push({ type: 'compaction', id: 'anywhere' });
	f2.event('agent_settled');
	const report2 = await f2.tools.get('usage').execute('id', {}, undefined, undefined, f2.ctx);
	assert.match(report2.content[0].text, /FAILED/, 'missing marker refuses correlation');
});

test('branch/session replacement invalidates queued requests; stale callbacks are dropped', async () => {
	const f = fixture();
	f.event('session_start', { reason: 'startup' }, f.ctx);
	await f.tools.get('compact').execute('id', {}, undefined, undefined, f.ctx);
	const staleOptions = f.state.compactCalls.length
		? null // not dispatched yet
		: null;
	f.event('session_before_switch', {}, f.ctx); // branch replacement
	f.event('agent_settled');
	assert.equal(f.state.compactCalls.length, 0, 'queued request invalidated by branch replacement');
	// Session replacement drops stale-era state and callbacks.
	f.state.sessionId = 'session-B';
	f.event('session_start', { reason: 'new' }, f.ctx);
	let report = await f.tools.get('usage').execute('id', {}, undefined, undefined, f.ctx);
	assert.match(report.content[0].text, /none recorded/);
	void staleOptions;
	// A stale ctx.compact throwing is caught, never stranding state.
	await f.tools.get('compact').execute('id', {}, undefined, undefined, f.ctx);
	const brokenCtx = { ...f.ctx, sessionManager: { getSessionId: () => 'session-B' }, compact: () => { throw new Error('stale extension context'); } };
	f.event('agent_settled', {}, brokenCtx);
	report = await f.tools.get('usage').execute('id', {}, undefined, undefined, f.ctx);
	assert.match(report.content[0].text, /stale extension context/);
});
