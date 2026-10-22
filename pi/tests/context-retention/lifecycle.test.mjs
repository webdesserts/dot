import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture, answer, fauxAssistantMessage } from "./fixture.mjs";

const append = (manager) => manager.appendMessage({ role: "user", content: [{ type: "text", text: "Request an owned checkpoint." }], timestamp: Date.now() });

test("native transient summary retry keeps provider dispatch, usage and retry lifecycle", async (t) => {
	const { session, manager, faux } = await fixture(t);
	append(manager);
	const optionsSeen = [];
	faux.setResponses([
		(_context, options) => { optionsSeen.push(options); return fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" }); },
		(_context, options, _state, model) => { optionsSeen.push(options); assert.equal(model.id, "retention-owned"); assert.equal(model.provider, "faux"); return answer(); },
	]);
	const events = [];
	session.subscribe((event) => { if (event.type.startsWith("summarization_retry")) events.push(event.type); });
	const result = await session.compact();
	assert.equal(faux.state.callCount, 2);
	assert.deepEqual(events, ["summarization_retry_scheduled", "summarization_retry_attempt_start", "summarization_retry_finished"]);
	assert.ok(result.usage.totalTokens > 0);
	assert.deepEqual(result.details, { readFiles: [], modifiedFiles: [] });
	for (const options of optionsSeen) {
		assert.equal(options.cacheRetention, "none");
		assert.equal(options.apiKey, "owned-fixture-not-a-secret", "only the explicit synthetic credential reaches the in-process faux stream");
		assert.equal(options.headers["x-retention-fixture"], "owned");
		assert.equal(options.env.RETENTION_FIXTURE, "owned");
		assert.ok(options.signal instanceof AbortSignal);
		assert.notEqual(options.sessionId, manager.getSessionId(), "native summary routing ID does not replace the conversation ID");
	}
	assert.equal(optionsSeen[0].sessionId, optionsSeen[1].sessionId, "native retry reuses its summary routing ID");
});

test("native failed summary keeps archive and emits failure without a continuation", async (t) => {
	const { session, manager, faux } = await fixture(t);
	append(manager);
	const before = structuredClone(manager.getEntries());
	faux.setResponses([fauxAssistantMessage("partial checkpoint", { stopReason: "length" })]);
	const endings = [];
	session.subscribe((event) => { if (event.type === "compaction_end") endings.push(event); });
	await assert.rejects(session.compact(), /summary is incomplete/);
	assert.equal(faux.state.callCount, 1);
	assert.deepEqual(manager.getEntries(), before);
	assert.equal(endings.length, 1);
	assert.equal(endings[0].result, undefined);
	assert.equal(endings[0].aborted, false);
	assert.equal(session.pendingMessageCount, 0);
});

test("native compaction cancellation at an owned gate never writes a checkpoint or resumes", { timeout: 10_000 }, async (t) => {
	let enter;
	let release;
	const entered = new Promise((resolve) => { enter = resolve; });
	const gate = new Promise((resolve) => { release = resolve; });
	t.after(() => release());
	const { session, manager, faux } = await fixture(t, { extensionFactories: [(pi) => {
		pi.on("session_before_compact", async () => { enter(); await gate; });
	}] });
	append(manager);
	const before = structuredClone(manager.getEntries());
	const running = session.compact();
	const rejected = assert.rejects(running, /abort|cancel/i);
	await entered;
	session.abortCompaction();
	release();
	await rejected;
	assert.deepEqual(manager.getEntries(), before);
	assert.equal(faux.state.callCount, 0);
	assert.equal(session.pendingMessageCount, 0);
});
