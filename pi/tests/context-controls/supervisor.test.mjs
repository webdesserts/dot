/**
 * Behavioral tests for the context-controls extension
 * (pi/extensions/context-controls.ts).
 *
 * Runs the TypeScript source in a VM sandbox with a fake pi double and a fake
 * extension context (synthetic usage, deterministic compaction lifecycle) —
 * no real LLM calls, no live parent state. Covers: 40/60 threshold alerts with
 * per-epoch delivered state (no 39→41 flapping), multi-threshold coalescing,
 * dual-channel turn-free delivery (tool_result append mid-run +
 * before_agent_start fallback) without sendUserMessage, null/post-compaction
 * and decreasing usage anti-chatter, model/window changes, compact() deferred
 * dispatch to agent_settled with terminate:true sole-call acceptance,
 * sibling-batch rejection, duplicate/concurrent request guards, truthful
 * success/failure/abort including correlated fulfillment, and stale callbacks
 * after session replacement.
 *
 * Run: node --test pi/tests/context-controls/supervisor.test.mjs  (repo root)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const T0 = 1_700_000_000_000;

function fixture() {
	const handlers = new Map();
	const tools = new Map();
	const sent = []; // pi.sendUserMessage — must stay EMPTY forever
	const sentMessages = []; // pi.sendMessage
	const appended = [];
	const clock = { now: T0 };
	class FakeDate extends Date { }
	FakeDate.now = () => clock.now;
	const pi = {
		on: (name, fn) => handlers.set(name, fn),
		registerTool: (def) => tools.set(def.name, def),
		registerCommand: () => {},
		sendUserMessage: (...a) => sent.push(a),
		sendMessage: (...a) => sentMessages.push(a),
		appendEntry: (customType, data) => appended.push({ customType, data }),
	};
	const source = fs.readFileSync(new URL('../../extensions/context-controls.ts', import.meta.url), 'utf8')
		.replace(/^import .*;\n/gm, '')
		.replace('export default function (pi)', 'function setup(pi)');
	const state = {
		usage: undefined, // getContextUsage() result
		modelId: 'test-model',
		sessionId: 'session-A',
		entries: [], // sessionManager.getEntries() — compaction correlation evidence
		compactCalls: [],
		compactImpl: null, // (options) => void; default records only
	};
	vm.runInNewContext(`${source}\nsetup(pi);`, {
		pi, process: { env: {} }, console: { error() {} }, Date: FakeDate,
		Type: { Object: v => v, String: v => v, Optional: v => v },
		StringEnum: v => v,
	});
	const ctx = {
		getContextUsage: () => state.usage,
		isIdle: () => true,
		cwd: '/fixture/project',
		isProjectTrusted: () => true,
		get model() { return { id: state.modelId }; },
		sessionManager: { getSessionId: () => state.sessionId, getEntries: () => state.entries },
		compact: (options) => {
			const call = { options, at: clock.now };
			state.compactCalls.push(call);
			if (state.compactImpl) state.compactImpl(options, call);
		},
	};
	const event = (name, arg = {}, context = ctx) => handlers.get(name)?.(arg, context);
	const usage = (tokens, window) => ({
		tokens,
		contextWindow: window,
		percent: tokens === null ? null : (tokens / window) * 100,
	});
	return {
		handlers, tools, sent, sentMessages, appended, clock, ctx, state, usage, event,
		setNow: (ms) => { clock.now = ms; },
		// Run one alert observation at a given percent of the window.
		observe: (tokens, window = 200_000, model) => {
			state.usage = usage(tokens, window);
			if (model) state.modelId = model;
			event('turn_end');
			return handlers;
		},
		// The pending notice (if any) as it would be delivered next turn.
		peekNotice: () => {
			const result = handlers.get('before_agent_start')?.({}, ctx);
			return result?.message ?? null;
		},
		// Mid-run delivery: what the next tool result would carry.
		deliverViaToolResult: (content = []) => {
			const result = handlers.get('tool_result')?.({ type: 'tool_result', content }, ctx);
			return result?.content ?? null;
		},
	};
}

const WINDOW = 200_000;

test('alerts fire once per epoch and never flap on threshold oscillation', () => {
	const f = fixture();
	f.event('session_start', { reason: 'startup' }, f.ctx);
	// Baseline observation never alerts.
	f.observe(60_000); // 30%
	assert.equal(f.peekNotice(), null, 'baseline is silent');
	// Crossing 40%.
	f.observe(90_000); // 45%
	assert.match(f.peekNotice()?.content?.[0]?.text ?? '', /40%/);
	assert.doesNotMatch(f.peekNotice()?.content?.[0]?.text ?? '', /60%/, 'single notice after delivery');
	// Staying between levels: quiet.
	f.observe(100_000); // 50%
	assert.equal(f.peekNotice(), null, 'no repeat inside the band');
	// 60% crossing.
	f.observe(130_000); // 65%
	assert.match(f.peekNotice()?.content?.[0]?.text ?? '', /60%/);
	// THE FLAP CASE: 39→41→39→41 must NOT re-alert — delivered state is
	// per-epoch, not consecutive-observation.
	f.observe(78_000); // 39%
	assert.equal(f.peekNotice(), null);
	f.observe(82_000); // 41%
	assert.equal(f.peekNotice(), null, 're-crossing in the same epoch stays silent');
	f.observe(78_000);
	f.observe(82_000);
	assert.equal(f.peekNotice(), null, 'still silent — per-epoch delivered state');
	// Decreasing estimates: never alert.
	f.observe(100_000);
	f.observe(50_000);
	assert.equal(f.peekNotice(), null, 'decreasing is silent');
});

test('a multi-threshold jump is coalesced into ONE notice', () => {
	const f = fixture();
	f.event('session_start', { reason: 'startup' }, f.ctx);
	f.observe(50_000); // 25% baseline
	f.observe(150_000); // 75% — jumps 40 and 60
	const notice = f.peekNotice();
	assert.ok(notice, 'notice exists');
	const text = notice.content[0].text;
	assert.match(text, /40%/);
	assert.match(text, /60%/);
	// Delivered exactly once, then cleared; never accumulated.
	assert.equal(f.peekNotice(), null);
});

test('alerts are model-visible without sendUserMessage or extra turns', () => {
	const f = fixture();
	f.event('session_start', { reason: 'startup' }, f.ctx);
	f.observe(50_000);
	f.observe(170_000); // 85% — jumps both levels
	const notice = f.peekNotice(); // consumes via before_agent_start
	assert.ok(notice, 'notice pending');
	assert.equal(notice.customType, 'context-controls-notice');
	assert.equal(f.sent.length, 0, 'sendUserMessage NEVER called');
	assert.equal(f.sentMessages.length, 0, 'sendMessage NEVER called');
	assert.equal(f.peekNotice(), null, 'delivered exactly once');
});

test('the pending notice rides on the next tool result DURING an ongoing run', () => {
	const f = fixture();
	f.event('session_start', { reason: 'startup' }, f.ctx);
	f.observe(50_000);
	f.observe(130_000); // 65% — threshold crossed mid-run
	// The next tool result in the same/next turn carries the notice appended
	// to its original content — model-visible without any turn trigger.
	const carried = f.deliverViaToolResult([{ type: 'text', text: 'tool output' }]);
	assert.ok(Array.isArray(carried) && carried.length === 2, 'notice appended to tool result');
	assert.equal(carried[0].text, 'tool output', 'original content preserved');
	assert.match(carried[1].text, /40%/);
	// Delivered once; subsequent tool results are untouched (the handler
	// returns undefined once no notice is pending, so the SDK keeps the
	// original content).
	const again = f.deliverViaToolResult([{ type: 'text', text: 'more output' }]);
	assert.equal(again, null, 'no accumulation, no repeat');
	assert.equal(f.sent.length, 0);
	// before_agent_start fallback: nothing left to deliver.
	assert.equal(f.peekNotice(), null);
});

test('null usage (right after compaction) starts a new silent epoch', () => {
	const f = fixture();
	f.event('session_start', { reason: 'startup' }, f.ctx);
	f.observe(50_000);
	f.observe(130_000); // alert 60
	assert.ok(f.peekNotice());
	// Post-compaction null: silent.
	f.state.usage = f.usage(null, WINDOW);
	f.event('turn_end');
	assert.equal(f.peekNotice(), null);
	// First observation after the unknown window re-baselines into a NEW
	// epoch — 40/60 do NOT re-emit even when regrowth recrosses them.
	f.observe(100_000); // 50%
	assert.equal(f.peekNotice(), null, 'post-null re-baseline is silent');
	f.observe(130_000); // 65% — new epoch, genuine crossing
	assert.match(f.peekNotice()?.content?.[0]?.text ?? '', /60%/, 'new-epoch crossing alerts once');
	// Oscillation after delivery stays silent again.
	f.observe(78_000); // 39%
	assert.equal(f.peekNotice(), null, 'dropping below is silent');
	f.observe(82_000); // 41% — 40% was never delivered in this epoch: one legit alert
	const first40 = f.peekNotice();
	assert.match(first40?.content?.[0]?.text ?? '', /40%/);
	f.observe(78_000);
	f.observe(82_000);
	assert.equal(f.peekNotice(), null, 'now delivered — no flapping');
	f.observe(78_000);
	f.observe(82_000);
	assert.equal(f.peekNotice(), null, 'still silent — per-epoch delivered state');
	f.observe(78_000);
	f.observe(82_000);
	assert.equal(f.peekNotice(), null, 'still silent — per-epoch delivered state');
	// A crossing spanning an unknown gap stays silent.
	f.state.usage = f.usage(null, WINDOW);
	f.event('turn_end');
	f.observe(150_000); // 75%
	assert.equal(f.peekNotice(), null, 'crossing through an unknown gap stays silent');
	// Window change re-baselines silently.
	f.state.usage = f.usage(150_000, 400_000);
	f.event('turn_end');
	assert.equal(f.peekNotice(), null, 'window change is silent');
	// Model change re-baselines silently.
	f.state.usage = f.usage(170_000, 400_000);
	f.state.modelId = 'other-model';
	f.event('turn_end');
	assert.equal(f.peekNotice(), null, 'model change is silent');
	// Reload resets to a silent fresh baseline.
	f.event('session_start', { reason: 'reload' }, f.ctx);
	assert.equal(f.peekNotice(), null);
	f.observe(170_000);
	assert.equal(f.peekNotice(), null, 'first observation after reload is baseline');
});

test('usage() distinguishes unavailable, unknown, and zero', async () => {
	const f = fixture();
	f.event('session_start', { reason: 'startup' }, f.ctx);
	const tool = f.tools.get('usage');
	// No active context.
	f.state.usage = undefined;
	let r = await tool.execute('id', {}, undefined, undefined, f.ctx);
	assert.match(r.content[0].text, /unavailable/);
	// Post-compaction null tokens: unknown, explicitly not zero.
	f.state.usage = f.usage(null, WINDOW);
	r = await tool.execute('id', {}, undefined, undefined, f.ctx);
	assert.match(r.content[0].text, /unknown/);
	assert.match(r.content[0].text, /not zero/);
	// Genuine zero stays zero.
	f.state.usage = f.usage(0, WINDOW);
	r = await tool.execute('id', {}, undefined, undefined, f.ctx);
	assert.match(r.content[0].text, /0%/);
	// Concrete numbers.
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
	assert.equal(r.details.dispatched, false, 'request only — not dispatched inline');
	assert.equal(r.terminate, true, 'sole accepted call terminates the run at batch end');
	assert.equal(f.state.compactCalls.length, 0, 'AgentSession.compact NOT called from the tool');
	assert.match(r.content[0].text, /acceptance is not success/i);
	// Dispatch happens only at settle.
	f.event('agent_settled');
	assert.equal(f.state.compactCalls.length, 1, 'dispatched at agent_settled');
	const options = f.state.compactCalls[0].options;
	assert.equal(typeof options.onComplete, 'function');
	assert.equal(typeof options.onError, 'function');
	// Success records truth with token accounting (even after a synchronous
	// onComplete inside ctx.compact — no stranded in-flight guard).
	options.onComplete({ tokensBefore: 180_000, estimatedTokensAfter: 30_000 });
	const usageTool = f.tools.get('usage');
	f.state.usage = f.usage(30_000, WINDOW);
	const report = await usageTool.execute('id', {}, undefined, undefined, f.ctx);
	assert.match(report.content[0].text, /SUCCESS/);
	assert.match(report.content[0].text, /180k/);
	// A synchronous terminal callback inside ctx.compact clears the guard.
	await tool.execute('id', {}, undefined, undefined, f.ctx);
	f.state.compactImpl = (options) => options.onComplete({ tokensBefore: 1, estimatedTokensAfter: 1 });
	f.event('agent_settled');
	const afterSync = await tool.execute('id', {}, undefined, undefined, f.ctx);
	assert.equal(afterSync.details.accepted, true, 'sync-callback dispatch does not strand the guard');
});

test('compact() passes summary-focus instructions', async () => {
	const f = fixture();
	f.event('session_start', { reason: 'startup' }, f.ctx);
	await f.tools.get('compact').execute('id', { summaryFocus: 'preserve the migration plan' }, undefined, undefined, f.ctx);
	f.event('agent_settled');
	assert.equal(f.state.compactCalls[0].options.customInstructions, 'preserve the migration plan');
});

test('compact batched with sibling tool calls is rejected with a retry-alone message', async () => {
	const f = fixture();
	f.event('session_start', { reason: 'startup' }, f.ctx);
	// Assistant message containing two tool calls (compact + a sibling).
	f.event('message_end', {
		message: {
			role: 'assistant',
			content: [
				{ type: 'text', text: 'doing things' },
				{ type: 'toolCall', id: 'call-1', name: 'compact' },
				{ type: 'toolCall', id: 'call-2', name: 'bash' },
			],
		},
	}, f.ctx);
	const r = await f.tools.get('compact').execute('call-1', {}, undefined, undefined, f.ctx);
	assert.equal(r.details.ok, false);
	assert.equal(r.details.rejected, 'siblings');
	assert.equal(r.details.batchSize, 2);
	assert.equal(r.terminate, undefined, 'no terminate hint on rejection');
	assert.match(r.content[0].text, /REJECTED/);
	assert.match(r.content[0].text, /ONLY tool call/);
	// Nothing was queued: no dispatch at settle, no native call ever.
	f.event('agent_settled');
	assert.equal(f.state.compactCalls.length, 0, 'rejected request never dispatches');
	// A later sole call is accepted again.
	f.event('message_end', {
		message: { role: 'assistant', content: [{ type: 'toolCall', id: 'call-3', name: 'compact' }] },
	}, f.ctx);
	const sole = await f.tools.get('compact').execute('call-3', {}, undefined, undefined, f.ctx);
	assert.equal(sole.details.accepted, true);
	assert.equal(sole.terminate, true);
});

test('missing batch snapshot degrades safely: accept with terminate, dispatch at settle', async () => {
	const f = fixture();
	f.event('session_start', { reason: 'startup' }, f.ctx);
	// No message_end snapshot was delivered (defensive runtime path).
	const r = await f.tools.get('compact').execute('id', {}, undefined, undefined, f.ctx);
	assert.equal(r.details.accepted, true);
	assert.equal(r.terminate, true, 'terminate hint still ends the run for a sole call');
	f.event('agent_settled');
	assert.equal(f.state.compactCalls.length, 1);
});

test('duplicate and concurrent compaction requests are guarded', async () => {
	const f = fixture();
	f.event('session_start', { reason: 'startup' }, f.ctx);
	const tool = f.tools.get('compact');
	await tool.execute('id', {}, undefined, undefined, f.ctx);
	const dup = await tool.execute('id', {}, undefined, undefined, f.ctx);
	assert.equal(dup.details.duplicate, true, 'pending duplicate refused');
	assert.equal(f.state.compactCalls.length, 0);
	f.event('agent_settled');
	assert.equal(f.state.compactCalls.length, 1);
	// While the compaction operation is in flight (before terminal callback),
	// a racing request is still refused.
	const race = await tool.execute('id', {}, undefined, undefined, f.ctx);
	assert.equal(race.details.duplicate, true, 'in-flight duplicate refused');
	assert.equal(f.state.compactCalls.length, 1, 'no second native request');
	// Terminal callback clears the guard.
	f.state.compactCalls[0].options.onComplete({ tokensBefore: 1, estimatedTokensAfter: 1 });
	const after = await tool.execute('id', {}, undefined, undefined, f.ctx);
	assert.equal(after.details.accepted, true, 'guard cleared after confirmed completion');
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
	// Guard cleared: a new request is possible.
	const again = await f.tools.get('compact').execute('id', {}, undefined, undefined, f.ctx);
	assert.equal(again.details.accepted, true);
	// Native abort path (session_compact_failed with aborted=true).
	f.event('session_compact_failed', { aborted: true });
	report = await f.tools.get('usage').execute('id', {}, undefined, undefined, f.ctx);
	assert.match(report.content[0].text, /ABORTED/);
	const after = await f.tools.get('compact').execute('id', {}, undefined, undefined, f.ctx);
	assert.equal(after.details.accepted, true, 'no stranded guard after abort');
});

test('native session_compact clears a pending request to avoid double-compacting', async () => {
	const f = fixture();
	f.event('session_start', { reason: 'startup' }, f.ctx);
	// Auto-compaction fulfills before the queued dispatch runs.
	f.event('session_compact', { compactionEntry: { tokensBefore: 190_000 } });
	const report = await f.tools.get('usage').execute('id', {}, undefined, undefined, f.ctx);
	assert.match(report.content[0].text, /SUCCESS/);
	assert.match(report.content[0].text, /confirmed by session_compact/);
	// A late request dispatched now must not fire a second compaction: the
	// session is already compacted; the pending queue is empty.
	f.event('agent_settled');
	assert.equal(f.state.compactCalls.length, 0, 'no dispatch after auto-compaction fulfilled');
});

test('an Already-compacted-style error is only success when an actual compaction landed after the request', async () => {
	const f = fixture();
	f.event('session_start', { reason: 'startup' }, f.ctx);
	await f.tools.get('compact').execute('id', {}, undefined, undefined, f.ctx);
	const requestAt = f.clock.now;
	// The native request fails at dispatch time; no actual compaction entry
	// exists → the error is the truth.
	f.state.compactImpl = (options) => options.onError(new Error('Already compacted'));
	f.event('agent_settled');
	let report = await f.tools.get('usage').execute('id', {}, undefined, undefined, f.ctx);
	assert.match(report.content[0].text, /FAILED/);
	assert.match(report.content[0].text, /Already compacted/);
	// With a REAL compaction entry appended after the request in this same
	// session (it lands AFTER acceptance, so the entry-count snapshot taken
	// at acceptance excludes it), the error is correlated to that fulfillment,
	// not reported raw.
	f.state.compactImpl = (options) => options.onError(new Error('Already compacted'));
	await f.tools.get('compact').execute('id', {}, undefined, undefined, f.ctx);
	f.state.entries = [{ type: 'compaction', timestamp: requestAt + 5, summary: 'auto' }];
	f.event('agent_settled');
	report = await f.tools.get('usage').execute('id', {}, undefined, undefined, f.ctx);
	assert.match(report.content[0].text, /SUCCESS/);
	assert.match(report.content[0].text, /fulfilled by an actual compaction/);
	// A compaction entry present ALREADY at acceptance (before the request)
	// never counts as fulfillment.
	f.state.compactImpl = (options) => options.onError(new Error('Already compacted'));
	f.state.entries = [{ type: 'compaction', timestamp: requestAt - 5, summary: 'old' }, { type: 'compaction', timestamp: requestAt - 4, summary: 'old2' }];
	await f.tools.get('compact').execute('id', {}, undefined, undefined, f.ctx);
	f.event('agent_settled');
	report = await f.tools.get('usage').execute('id', {}, undefined, undefined, f.ctx);
	assert.match(report.content[0].text, /FAILED/, 'pre-request compaction is not fulfillment');
});

test('stale callbacks after session replacement are dropped', async () => {
	const f = fixture();
	f.event('session_start', { reason: 'startup' }, f.ctx);
	await f.tools.get('compact').execute('id', {}, undefined, undefined, f.ctx);
	f.event('agent_settled');
	const staleOptions = f.state.compactCalls[0].options;
	// Session replaced (reload/new): state resets, old era generation is gone.
	f.state.sessionId = 'session-B';
	f.event('session_start', { reason: 'new' }, f.ctx);
	let report = await f.tools.get('usage').execute('id', {}, undefined, undefined, f.ctx);
	assert.match(report.content[0].text, /none recorded/);
	// The stale completion arrives late: it must NOT be recorded as this
	// session's truth.
	staleOptions.onComplete({ tokensBefore: 5, estimatedTokensAfter: 2 });
	report = await f.tools.get('usage').execute('id', {}, undefined, undefined, f.ctx);
	assert.match(report.content[0].text, /none recorded/, 'stale callback dropped');
	// A stale ctx.compact throwing (assertActive on a replaced runner) is also
	// caught and recorded as an error, never crashing or stranding state.
	await f.tools.get('compact').execute('id', {}, undefined, undefined, f.ctx);
	const brokenCtx = { ...f.ctx, sessionManager: { getSessionId: () => 'session-B' }, compact: () => { throw new Error('stale extension context'); } };
	f.event('agent_settled', {}, brokenCtx);
	report = await f.tools.get('usage').execute('id', {}, undefined, undefined, f.ctx);
	assert.match(report.content[0].text, /stale extension context/);
});
