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

function registered(t, version) {
	const handlers = new Map();
	const warnings = [];
	t.mock.method(console, "warn", (text) => warnings.push(text));
	registerRetention({ on: (event, handler) => handlers.set(event, handler) }, version);
	return { handlers, warnings, ctx: { hasUI: false, sessionManager: { getBranch: () => [native()] } } };
}

test("unqualified SDK cancels summary operations with bounded diagnostic, not ordinary navigation/projection", (t) => {
	const { handlers, warnings, ctx } = registered(t, "99.0.0");
	const p = preparation();
	const before = structuredClone(p);
	assert.deepEqual(handlers.get("session_before_compact")({ preparation: p, branchEntries: [native()] }, ctx), { cancel: true });
	assert.deepEqual(handlers.get("session_before_compact")({ preparation: p, branchEntries: [native()] }, ctx), { cancel: true });
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /Qualify context-retention/);
	assert.deepEqual(p, before);
	assert.equal(handlers.get("session_before_tree")({ preparation: { userWantsSummary: false } }, ctx), undefined);
	assert.deepEqual(handlers.get("session_before_tree")({ preparation: { userWantsSummary: true } }, ctx), { cancel: true });
	assert.equal(handlers.get("context")({ messages: [{ role: "compactionSummary", summary: native().summary }] }, ctx), undefined);
});

test("unsupported preparation shapes cancel atomically while supported aliases preserve boundaries", (t) => {
	const { handlers, warnings, ctx } = registered(t, "1.4.0");
	for (const p of [{ ...preparation(), fileOps: {} }, Object.freeze(preparation())]) {
		const before = structuredClone(p);
		assert.equal(supportedPreparation(p), false);
		assert.deepEqual(handlers.get("session_before_compact")({ preparation: p, branchEntries: [native()] }, ctx), { cancel: true });
		assert.deepEqual(p, before);
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
	assert.deepEqual(handlers.get("session_before_tree")({ preparation: { targetId: "target", userWantsSummary: true, entriesToSummarize: Object.freeze([entry]) } }, ctx), { cancel: true });
	assert.equal(warnings.length, 2, "each unsupported shape diagnostic is delivered once");
});
