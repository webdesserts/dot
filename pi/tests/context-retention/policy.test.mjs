import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanEntry, cleanMessage, supportedPreparation } from "../../extensions/context-retention/policy.ts";
import { registerRetention } from "../../extensions/context-retention/hooks.ts";
import { inventory, GOAL, LITERAL } from "./fixture.mjs";

const native = () => ({ type: "compaction", id: "native", summary: GOAL + inventory(["old.ts"]),
	details: { readFiles: ["old.ts"], modifiedFiles: [], useful: "metadata" } });
const preparation = () => ({ firstKeptEntryId: "kept", tokensBefore: 1_000, isSplitTurn: false,
	previousSummary: native().summary, messagesToSummarize: [], turnPrefixMessages: [],
	fileOps: { read: new Set(["old.ts"]), edited: new Set(), written: new Set() },
	settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 } });

test("recognition removes only a provenance-backed exact native suffix", () => {
	const entry = native();
	const before = structuredClone(entry);
	assert.deepEqual(cleanEntry(entry), { ...entry, summary: GOAL, details: { useful: "metadata" } });
	assert.deepEqual(entry, before);
	for (const ambiguous of [
		{ ...entry, fromHook: true }, { ...entry, details: undefined },
		{ ...entry, summary: `${entry.summary}\nmore narrative` },
		{ ...entry, details: { readFiles: ["z.ts", "a.ts"], modifiedFiles: [] } },
		{ ...entry, details: { readFiles: ["embedded\nnewline"], modifiedFiles: [] } },
		{ ...entry, summary: `${GOAL}\n${LITERAL}` },
	]) assert.equal(cleanEntry(ambiguous), ambiguous, "unproven/custom/malformed entries stay untouched");
	for (const role of ["user", "assistant", "custom"]) {
		const message = { role, summary: entry.summary, content: LITERAL };
		assert.equal(cleanMessage(message, [entry]), message);
	}
	assert.equal(cleanMessage({ role: "compactionSummary", summary: entry.summary }, [entry]).summary, GOAL);
	assert.equal(cleanMessage({ role: "branchSummary", fromId: "other", summary: entry.summary }, [{ ...entry, type: "branch_summary", fromId: "origin" }]).summary, entry.summary);
});

function registered(t) {
	const handlers = new Map();
	const warnings = [];
	t.mock.method(console, "warn", (text) => warnings.push(text));
	registerRetention({ on: (event, handler) => handlers.set(event, handler) });
	return { handlers, warnings, ctx: { hasUI: false, sessionManager: { getBranch: () => [native()] } } };
}

test("any SDK version runs cleanup; unsupported shapes skip with warning, not cancel", (t) => {
	const { handlers, warnings, ctx } = registered(t);
	// context hook always cleans on any version
	const cleaned = handlers.get("context")({ messages: [{ role: "compactionSummary", summary: native().summary }] }, ctx);
	assert.ok(cleaned, "context returns cleaned messages");
	assert.equal(cleaned.messages[0].summary, GOAL);
	// session_before_compact with supported shape mutates and returns undefined
	const p = preparation();
	assert.equal(handlers.get("session_before_compact")({ preparation: p, branchEntries: [native()] }, ctx), undefined);
	assert.equal(p.previousSummary, GOAL, "previousSummary cleaned");
	// session_before_compact with unsupported shape: skip, warn once, no cancel
	const bad = { ...preparation(), fileOps: {} };
	const before = structuredClone(bad);
	assert.equal(handlers.get("session_before_compact")({ preparation: bad, branchEntries: [native()] }, ctx), undefined);
	assert.equal(handlers.get("session_before_compact")({ preparation: bad, branchEntries: [native()] }, ctx), undefined);
	assert.equal(warnings.length, 1, "warning emitted once");
	assert.match(warnings[0], /cleanup skipped/);
	assert.deepEqual(bad, before, "unsupported preparation not mutated");
	// session_before_tree: userWantsSummary:false still skips cleanly
	assert.equal(handlers.get("session_before_tree")({ preparation: { userWantsSummary: false } }, ctx), undefined);
	// session_before_tree with unsupported shape: skip, no cancel
	assert.equal(handlers.get("session_before_tree")({ preparation: { targetId: "t", userWantsSummary: true, entriesToSummarize: Object.freeze([native()]) } }, ctx), undefined);
});

test("unsupported preparation shapes skip cleanly without cancel; supported aliases mutate atomically", (t) => {
	const { handlers, warnings, ctx } = registered(t);
	for (const p of [{ ...preparation(), fileOps: {} }, Object.freeze(preparation())]) {
		const before = structuredClone(p);
		assert.equal(supportedPreparation(p), false);
		// fail open: no cancel, cleanup skipped
		assert.equal(handlers.get("session_before_compact")({ preparation: p, branchEntries: [native()] }, ctx), undefined);
		assert.deepEqual(p, before, "unsupported preparation not mutated");
	}
	const p = preparation();
	assert.equal(handlers.get("session_before_compact")({ preparation: p, branchEntries: [native()] }, ctx), undefined);
	assert.equal(p.firstKeptEntryId, "kept");
	assert.equal(p.tokensBefore, 1_000);
	assert.equal(p.previousSummary, GOAL);
	assert.deepEqual(p.fileOps, { read: new Set(), written: new Set(), edited: new Set() });
	const entry = native();
	const entries = [entry];
	assert.equal(handlers.get("session_before_tree")({ preparation: { targetId: "target", userWantsSummary: true, entriesToSummarize: entries } }, ctx), undefined);
	assert.notEqual(entries[0], entry);
	assert.equal(entry.summary, native().summary);
	assert.equal(entries[0].summary, GOAL);
	// frozen entries array: supportedTree returns false → skip, no cancel
	assert.equal(handlers.get("session_before_tree")({ preparation: { targetId: "target", userWantsSummary: true, entriesToSummarize: Object.freeze([entry]) } }, ctx), undefined);
	assert.equal(warnings.length, 2, "each unsupported shape diagnostic is delivered once");
});
