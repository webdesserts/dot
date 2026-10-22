import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture, answer, GOAL, LITERAL, inventory, fauxToolCall } from "./fixture.mjs";

const user = (manager, text) => manager.appendMessage({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });

test("native branch summaries clean inherited inputs and provider views without rewriting raw branch inventories", async (t) => {
	const { session, manager, faux } = await fixture(t, { seed: false });
	const root = manager.appendMessage(answer("Common ancestor."));
	const kept = user(manager, LITERAL);
	manager.appendCompaction(GOAL + inventory(["BRANCH_OLD_COMPACT.ts"]), kept, 10_000,
		{ readFiles: ["BRANCH_OLD_COMPACT.ts"], modifiedFiles: [] }, false);
	manager.branchWithSummary(manager.getLeafId(), GOAL + inventory(["BRANCH_OLD.ts"]),
		{ readFiles: ["BRANCH_OLD.ts"], modifiedFiles: [], usefulMetadata: "keep" }, false);
	manager.appendMessage(answer([fauxToolCall("read", { path: "FRESH_BRANCH_FILE.ts" }, { id: "branch-read" })]));
	manager.appendMessage({ role: "toolResult", toolCallId: "branch-read", toolName: "read", content: [{ type: "text", text: "fixture" }], isError: false, timestamp: Date.now() });
	const archived = structuredClone(manager.getEntries());
	const captured = [];
	faux.setResponses(Array.from({ length: 4 }, () => (context) => { captured.push(context); return answer(); }));
	const first = await session.navigateTree(root, { summarize: true });
	assert.equal(first.cancelled, false);
	const firstInput = JSON.stringify(captured[0]);
	assert.ok(!firstInput.includes("BRANCH_OLD"), "native tree summarizer receives cleaned legacy summaries");
	assert.match(firstInput, /FRESH_BRANCH_FILE/);
	assert.match(firstInput, /USER_LITERAL/);
	// Accepted qualification: native extraction still records selected raw tool calls.
	assert.deepEqual(first.summaryEntry.details.readFiles, ["FRESH_BRANCH_FILE.ts"]);
	assert.match(first.summaryEntry.summary, /<read-files>\nFRESH_BRANCH_FILE/);
	await session.prompt("Continue ACTIVE_GOAL.");
	assert.ok(!JSON.stringify(captured[1]).includes("FRESH_BRANCH_FILE"), "restored normal provider request omits the generated branch inventory");
	assert.match(JSON.stringify(captured[1]), /src\/current\.ts/);
	user(manager, "intermediate ".repeat(500));
	user(manager, "recent ".repeat(500));
	const compact = await session.compact();
	assert.ok(!JSON.stringify(captured[2]).includes("FRESH_BRANCH_FILE"), "subsequent compactor does not re-ingest branch inventory");
	assert.deepEqual(compact.details, { readFiles: [], modifiedFiles: [] });
	const second = await session.navigateTree(root, { summarize: true });
	assert.equal(second.cancelled, false);
	assert.ok(!JSON.stringify(captured[3]).includes("FRESH_BRANCH_FILE"));
	assert.deepEqual(second.summaryEntry.details, { readFiles: [], modifiedFiles: [] }, "inherited branch details do not regrow inventories on the next tree");
	for (const entry of archived) assert.deepEqual(manager.getEntry(entry.id), entry, "abandoned raw history is untouched");
	assert.equal(faux.state.callCount, 4);
});
