import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture, answer, GOAL, LITERAL, inventory, fauxToolCall } from "./fixture.mjs";

const user = (manager, text) => manager.appendMessage({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
const clean = (context) => {
	const text = JSON.stringify(context);
	assert.ok(!text.includes("LEGACY_INVENTORY"));
	assert.ok(!text.includes("LEGACY_MODIFIED"));
	assert.match(text, /ACTIVE_GOAL/);
};

test("repeated native manual compactions discard inventories, not serialized current tool pointers", async (t) => {
	const { session, manager, faux, legacy } = await fixture(t);
	const snapshot = JSON.stringify(manager.getEntries());
	const captured = [];
	faux.setResponses(Array.from({ length: 2 }, () => (context) => { captured.push(context); return answer(); }));
	for (let i = 0; i < 2; i++) {
		manager.appendMessage(answer([fauxToolCall("read", { path: "CURRENT_MANUAL_FILE.ts" }, { id: `read-${i}` })]));
		manager.appendMessage({ role: "toolResult", toolCallId: `read-${i}`, toolName: "read", content: [{ type: "text", text: "owned fixture" }], isError: false, timestamp: Date.now() });
		user(manager, "recent ".repeat(500));
		const result = await session.compact();
		assert.deepEqual(result.details, { readFiles: [], modifiedFiles: [] });
		assert.equal(result.summary, GOAL);
		assert.ok(result.usage.totalTokens > 0);
	}
	captured.forEach(clean);
	assert.match(JSON.stringify(captured), /CURRENT_MANUAL_FILE/);
	assert.deepEqual(manager.getEntry(legacy.id), legacy);
	assert.equal(JSON.stringify(manager.getEntries().slice(0, JSON.parse(snapshot).length)), snapshot);
	assert.equal(faux.state.callCount, 2);
});

test("repeated native automatic threshold compactions clean input and preserve reported summary usage", async (t) => {
	const { session, manager, faux, legacy } = await fixture(t, { settings: {
		compaction: { enabled: true, keepRecentTokens: 200, reserveTokens: 198_000 },
	} });
	const contexts = [];
	// Faux estimates usage from the actual request, rather than trusting a
	// scripted usage field. Real input crosses the 2k threshold each time.
	const completePortion = () => {
		const response = answer("Finished this portion of ACTIVE_GOAL.");
		// Scripted responses must postdate the latest checkpoint. Preparing
		// them all up front makes native correctly ignore stale usage timestamps.
		const checkpoint = manager.getBranch().filter((entry) => entry.type === "compaction").at(-1);
		response.timestamp = Math.max(Date.now(), new Date(checkpoint.timestamp).getTime() + 1);
		return response;
	};
	faux.setResponses([
		completePortion, (context) => { contexts.push(context); return answer(); },
		completePortion, (context) => { contexts.push(context); return answer(); },
	]);
	const reasons = [];
	session.subscribe((event) => { if (event.type === "compaction_start") reasons.push(event.reason); });
	await session.prompt("Finish this portion. " + "owned context ".repeat(600));
	await session.prompt("Finish the next portion. " + "new owned context ".repeat(600));
	assert.deepEqual(reasons, ["threshold", "threshold"]);
	assert.equal(contexts.length, 2);
	contexts.forEach(clean);
	const newEntries = manager.getBranch().filter((entry) => entry.type === "compaction" && entry.id !== legacy.id);
	assert.equal(newEntries.length, 2);
	for (const entry of newEntries) {
		assert.deepEqual(entry.details, { readFiles: [], modifiedFiles: [] });
		assert.ok(entry.usage.totalTokens > 0);
	}
	assert.deepEqual(manager.getEntry(legacy.id), legacy);
	assert.equal(faux.state.callCount, 4);
});

test("split turn with no history messages cleans the directly reused previous summary", async (t) => {
	let preparation;
	const { session, manager, faux } = await fixture(t, { seed: false, settings: {
		compaction: { enabled: false, keepRecentTokens: 50, reserveTokens: 1_000 },
	}, extensionFactories: [(pi) => { pi.on("session_before_compact", (event) => {
		preparation = { split: event.preparation.isSplitTurn, history: event.preparation.messagesToSummarize.length };
	}); }] });
	const kept = user(manager, `SPLIT_USER ${LITERAL}\n${"prefix ".repeat(500)}`);
	manager.appendCompaction(GOAL + inventory(["LEGACY_INVENTORY/split.ts"]), kept, 10_000,
		{ readFiles: ["LEGACY_INVENTORY/split.ts"], modifiedFiles: [] }, false);
	const original = structuredClone(manager.getBranch().at(-1));
	const boundary = manager.appendMessage(answer("later assistant ".repeat(100)));
	let prefixContext;
	let restored;
	faux.setResponses([
		(context) => { prefixContext = context; return answer("Preserve SPLIT_USER and its progress."); },
		(context) => { restored = context; return answer("Continued."); },
	]);
	const result = await session.compact();
	assert.deepEqual(preparation, { split: true, history: 0 });
	assert.equal(result.firstKeptEntryId, boundary);
	assert.match(JSON.stringify(prefixContext), /SPLIT_USER/);
	assert.ok(result.summary.startsWith(GOAL));
	assert.ok(!result.summary.includes("LEGACY_INVENTORY"));
	assert.deepEqual(result.details, { readFiles: [], modifiedFiles: [] });
	await session.prompt("Continue.");
	clean(restored);
	assert.deepEqual(manager.getEntry(original.id), original);
	assert.equal(faux.state.callCount, 2, "no history-summary call is invented for the no-history split path");
});

