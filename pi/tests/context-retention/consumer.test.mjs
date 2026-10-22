import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture, answer, GOAL, LITERAL } from "./fixture.mjs";

function assertSemanticContext(context) {
	const text = JSON.stringify(context);
	assert.match(text, /ACTIVE_GOAL/);
	assert.match(text, /ACTIVE_CONSTRAINT/);
	assert.match(text, /src\/current\.ts/);
	assert.ok(!text.includes("LEGACY_INVENTORY"), "native generated inventory must not dominate actual provider input");
	assert.ok(!text.includes("LEGACY_MODIFIED"));
}

test("legacy native inventory is cleaned in the ordinary restored provider request", async (t) => {
	const { session, faux, manager, legacy } = await fixture(t);
	let captured;
	faux.setResponses([(context) => { captured = context; return answer("Continuing ACTIVE_GOAL."); }]);
	await session.prompt("Continue the existing task.");
	assertSemanticContext(captured);
	assert.ok(JSON.stringify(captured).includes("USER_LITERAL"), "user code quoting tags is preserved");
	assert.deepEqual(manager.getEntry(legacy.id), legacy, "archived summary and details remain recoverable");
	assert.equal(faux.state.callCount, 1);
});

test("native compactor receives a cleaned previous summary and persists no inventory arrays", async (t) => {
	const { session, faux, manager, legacy, settingsManager } = await fixture(t);
	let captured;
	const beforeId = manager.getSessionId();
	// Ensure the session is not already at a compaction leaf.
	manager.appendMessage({ role: "user", content: [{ type: "text", text: LITERAL }], timestamp: Date.now() });
	// The short final literal is below the 200-token budget, so native keeps
	// the preceding large recent user message too (not merely the last entry).
	const expectedBoundary = manager.getBranch().find((entry) => entry.message?.content?.[0]?.text?.startsWith("recent ")).id;
	faux.setResponses([(context) => { captured = context; return answer(); }]);
	const result = await session.compact();
	assertSemanticContext(captured);
	assert.ok(JSON.stringify(captured).includes("USER_LITERAL"));
	assert.equal(result.firstKeptEntryId, expectedBoundary, "native recent-message boundary is retained");
	assert.deepEqual(result.details, { readFiles: [], modifiedFiles: [] });
	assert.equal(result.summary, GOAL);
	assert.ok(result.usage.totalTokens > 0);
	assert.equal(manager.getSessionId(), beforeId);
	assert.deepEqual(manager.getEntry(legacy.id), legacy);
	assert.equal(faux.state.callCount, 1, "no duplicate/custom summarization call");
});
