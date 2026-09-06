/**
 * Unit tests for the SSE protocol module
 * (pi/extensions/notifications.sse.protocol.mjs) — pure functions only:
 * the numeric gate validators, the bounded SSE frame parser, the trusted
 * origin parser and the disk-receipt reader. No HTTP, no worker process.
 *
 * Run: node --test pi/tests/notifications-sse/protocol.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import crypto from "node:crypto";

import {
	CUSTOM_TYPE,
	METADATA_SCHEMA_VERSION,
	SUPPORTED_RENDER_VERSION,
	GateError,
	SseFrameError,
	createSseParser,
	parseTrustedOrigin,
	readQualifyingReceipts,
	validateAckResponse,
	validateClaimResponse,
	validatePresentationOffer,
	validateStatusResponse,
	validateWhoami,
	verifyOfferDigest,
} from "../../extensions/notifications.sse.protocol.mjs";

const sha256Hex = (text) => crypto.createHash("sha256").update(text, "utf8").digest("hex");

// ── whoami ────────────────────────────────────────────────────────────────

test("whoami accepts the exact used shape and nothing else", () => {
	assert.deepEqual(validateWhoami({ user: "rhea", actor_id: "uuid-1" }), {
		user: "rhea",
		actor_id: "uuid-1",
	});
	assert.deepEqual(validateWhoami({ user: null, actor_id: null }), { user: null, actor_id: null });
	assert.throws(() => validateWhoami({ user: 7, actor_id: null }), GateError);
	assert.throws(() => validateWhoami({ user: null, actor_id: ["x"] }), GateError);
	assert.throws(() => validateWhoami("nope"), GateError);
});

// ── lease status/claim/renew gates ────────────────────────────────────────

test("status gate keeps typed-optional epoch semantics", () => {
	assert.deepEqual(validateStatusResponse({ epoch: null, owner: null }), { epoch: null, owner: null });
	assert.deepEqual(
		validateStatusResponse({ epoch: 0, owner: { runtime_id: "w", deadline_remaining_ms: 10 } }),
		{ epoch: 0, owner: { runtime_id: "w", deadline_remaining_ms: 10 } },
	);
	// Unsafe u64 epoch refuses closed.
	assert.throws(() => validateStatusResponse({ epoch: 2 ** 53 + 1, owner: null }), GateError);
	// String-encoded numbers refuse.
	assert.throws(() => validateStatusResponse({ epoch: "0", owner: null }), GateError);
	assert.throws(() => validateStatusResponse({ epoch: 1, owner: { runtime_id: "w" } }), GateError);
});

test("claim gate refuses another runtime's proof and malformed secrets", () => {
	const grant = {
		outcome: "granted",
		epoch: 1,
		runtime_id: "w-1",
		grant_secret: "ab".repeat(32),
		deadline_remaining_ms: 3000,
	};
	assert.deepEqual(validateClaimResponse(grant, "w-1").runtime_id, "w-1");
	assert.throws(() => validateClaimResponse(grant, "w-other"), /own runtime's own id|own id|runtime_id/);
	assert.throws(
		() => validateClaimResponse({ ...grant, grant_secret: "AB".repeat(32) }, "w-1"),
		GateError,
	);
	assert.throws(() => validateClaimResponse({ ...grant, outcome: "taken" }, "w-1"), GateError);
	// The refusal never echoes the malformed secret material.
	try {
		validateClaimResponse({ ...grant, grant_secret: "zz" }, "w-1");
		assert.fail("expected GateError");
	} catch (err) {
		assert.equal(err instanceof GateError, true);
		assert.equal(err.message.includes("zz"), false);
	}
});

// ── presentation offer gate + digest verification ────────────────────────

test("presentation offer gate enforces safe integers, part refs, body and digest", () => {
	const valid = {
		presentation_id: 7,
		content_offer_id: null,
		summary_offer_id: 0,
		body: "the body",
		render_version: 1,
		digest: sha256Hex("the body"),
	};
	const offer = validatePresentationOffer(valid);
	assert.equal(offer.summary_offer_id, 0); // 0 stays distinct from null
	assert.equal(verifyOfferDigest(offer), true);
	assert.equal(verifyOfferDigest({ ...offer, body: "tampered" }), false);

	// Unsafe u64 presentation id refuses closed (no coercion).
	assert.throws(
		() => validatePresentationOffer({ ...valid, presentation_id: 2 ** 53 + 3 }),
		GateError,
	);
	assert.throws(() => validatePresentationOffer({ ...valid, presentation_id: "7" }), GateError);
	assert.throws(() => validatePresentationOffer({ ...valid, presentation_id: 1.5 }), GateError);
	assert.throws(() => validatePresentationOffer({ ...valid, presentation_id: -1 }), GateError);
	// Missing part-reference key refuses (typed-optional: never zero-substituted).
	assert.throws(() => validatePresentationOffer({ ...valid, content_offer_id: undefined }), GateError);
	assert.throws(() => validatePresentationOffer({ ...valid, body: "" }), GateError);
	assert.throws(() => validatePresentationOffer({ ...valid, digest: "ab" }), GateError);
	// A refusal never quotes the offending raw value.
	try {
		validatePresentationOffer({ ...valid, digest: "in-fact-not-hex" });
		assert.fail("expected GateError");
	} catch (err) {
		assert.equal(err.message.includes("in-fact-not-hex"), false);
	}
});

// ── ack gate ──────────────────────────────────────────────────────────────

test("ack gate accepts only the two outcomes", () => {
	assert.deepEqual(validateAckResponse({ outcome: "acknowledged" }).outcome, "acknowledged");
	assert.deepEqual(validateAckResponse({ outcome: "already_acknowledged" }).outcome, "already_acknowledged");
	assert.throws(() => validateAckResponse({ outcome: "queued" }), GateError);
	assert.throws(() => validateAckResponse(null), GateError);
});

// ── trusted origin ────────────────────────────────────────────────────────

test("trusted origin refuses non-http(s), credentials, paths and queries", () => {
	assert.equal(parseTrustedOrigin("http://127.0.0.1:4600"), "http://127.0.0.1:4600");
	assert.equal(parseTrustedOrigin("https://autonomy.example.com/"), "https://autonomy.example.com");
	assert.throws(() => parseTrustedOrigin(""), ConfigErrorMessage);
	assert.throws(() => parseTrustedOrigin("ftp://x"), ConfigErrorMessage);
	assert.throws(() => parseTrustedOrigin("http://user:pass@h"), ConfigErrorMessage);
	assert.throws(() => parseTrustedOrigin("http://h/base"), ConfigErrorMessage);
	assert.throws(() => parseTrustedOrigin("http://h/?x=1"), ConfigErrorMessage);
	assert.throws(() => parseTrustedOrigin("not a url"), ConfigErrorMessage);
});

const ConfigErrorMessage = (err) => err instanceof Error && err.name === "ConfigError";

// ── SSE frame parser ──────────────────────────────────────────────────────

test("sse parser assembles events and ignores id fields entirely", () => {
	const parser = createSseParser();
	const events = parser.feed(
		': keepalive comment\n\n' +
			"event: presentation\n" +
			"id: 12\n" +
			'data: {"a":1}\n\n' +
			"event: stream_error\n" +
			"data: static class\n\n",
	);
	assert.equal(events.length, 2);
	assert.deepEqual(events[0], { event: "presentation", data: '{"a":1}' });
	assert.deepEqual(events[1], { event: "stream_error", data: "static class" });
	// The id was captured nowhere: the parser exposes nothing to send back.
	const tail = parser.end();
	assert.equal(tail.refused, null);
});

test("sse parser joins multi-line data and refuses an incomplete trailing frame", () => {
	const parser = createSseParser();
	const events = parser.feed("data: one\ndata: two\n\n");
	assert.deepEqual(events, [{ event: "message", data: "one\ntwo" }]);
	const partial = parser.feed("event: presentation\ndata: {\"cut\":");
	assert.equal(partial.length, 0);
	const end = parser.end();
	assert.ok(end.refused, "a mid-frame EOF must be refused, never delivered");
});

test("sse parser bounds line and event sizes", () => {
	const small = createSseParser({ maxLineBytes: 8, maxEventBytes: 1024 });
	assert.throws(() => small.feed("data: 1234567890\n\n"), SseFrameError);
	// The event bound catches UNTERMINATED buffered data above the cap —
	// a fully-framed oversized event is refused by the LINE bound instead.
	const bounded = createSseParser({ maxLineBytes: 64, maxEventBytes: 16 });
	assert.throws(() => bounded.feed("data: " + "x".repeat(30)), SseFrameError);
	// A fully-framed event whose single line is under the line bound but
	// whose whole size exceeds the event cap still refuses (buffer check
	// runs when the event stays unterminated across chunks).
	const mid = createSseParser({ maxLineBytes: 64, maxEventBytes: 16 });
	assert.throws(() => mid.feed("data: " + "x".repeat(30) + "\n"), SseFrameError);
});

// ── disk receipt reader (the ONLY ack authority) ─────────────────────────

const sessionWith = (entries) => {
	const dir = mkdtempSync(join(tmpdir(), "sse-receipt-"));
	const file = join(dir, "session.jsonl");
	writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
	return file;
};

const detailsFor = (body, overrides = {}) => ({
	schema: METADATA_SCHEMA_VERSION,
	scope: "scope-1",
	recipient: "rhea",
	actorId: "uuid-1",
	sessionId: "sess-1",
	presentationId: 7,
	renderVersion: SUPPORTED_RENDER_VERSION,
	digest: sha256Hex(body),
	contentOfferId: null,
	summaryOfferId: null,
	...overrides,
});

const headerEntry = { type: "session", id: "sess-1", version: 1 };
const customMessage = (body, details) => ({
	type: "custom_message",
	id: "m1",
	customType: CUSTOM_TYPE,
	content: body,
	display: true,
	details,
});

test("receipt reader authorizes only full qualifying disk bytes", () => {
	const body = "exact server body";
	const file = sessionWith([
		headerEntry,
		{ type: "custom", customType: "other", data: {} }, // metadata-only noise: ignored
		customMessage(body, detailsFor(body)),
	]);
	const read = readQualifyingReceipts(file, "sess-1", "scope-1", "rhea", "uuid-1");
	assert.equal(read.ok, true);
	assert.equal(read.receipts.length, 1);
	assert.equal(read.receipts[0].refused, undefined);
	assert.deepEqual(read.receipts[0], {
		presentationId: 7,
		digest: sha256Hex(body),
		contentOfferId: null,
		summaryOfferId: null,
	});
});

test("receipt reader refuses wrong scope, recipient, actor id, session, version and digest", () => {
	const body = "b";
	const entry = customMessage(body, detailsFor(body));
	const mismatch = (detailsOverride, ...args) => {
		const file = sessionWith([headerEntry, customMessage(body, detailsFor(body, detailsOverride))]);
		return readQualifyingReceipts(file, ...args);
	};
	assert.equal(mismatch({ scope: "other" }, "sess-1", "scope-1", "rhea", "uuid-1").receipts[0].refused, true);
	assert.equal(mismatch({ recipient: "iris" }, "sess-1", "scope-1", "rhea", "uuid-1").receipts[0].refused, true);
	// The stable actor id is bound TOO — a handle alone never qualifies.
	assert.equal(mismatch({ actorId: "uuid-other" }, "sess-1", "scope-1", "rhea", "uuid-1").receipts[0].refused, true);
	assert.equal(mismatch({ actorId: undefined }, "sess-1", "scope-1", "rhea", "uuid-1").receipts[0].refused, true);
	const wrongSession = sessionWith([headerEntry, customMessage(body, detailsFor(body, { sessionId: "sess-2" }))]);
	assert.equal(
		readQualifyingReceipts(wrongSession, "sess-1", "scope-1", "rhea", "uuid-1").receipts[0].refused,
		true,
	);
	const wrongVersion = sessionWith([
		headerEntry,
		customMessage(body, detailsFor(body, { renderVersion: 2 })),
	]);
	assert.equal(
		readQualifyingReceipts(wrongVersion, "sess-1", "scope-1", "rhea", "uuid-1").receipts[0].refused,
		true,
	);
	const tampered = customMessage("tampered body", detailsFor(body));
	const tamperedFile = sessionWith([headerEntry, tampered]);
	const tamperedRead = readQualifyingReceipts(tamperedFile, "sess-1", "scope-1", "rhea", "uuid-1");
	assert.equal(tamperedRead.receipts[0].refused, true);
	assert.match(tamperedRead.receipts[0].reason, /digest/);
});

test("receipt reader refuses unreadable, header-less, foreign and partial files", () => {
	const body = "b";
	const read = readQualifyingReceipts(join(tmpdir(), "nope-does-not-exist.jsonl"), "sess-1", "s", "r", "u");
	assert.equal(read.ok, false);

	const noHeader = sessionWith([customMessage(body, detailsFor(body))]);
	assert.match(readQualifyingReceipts(noHeader, "sess-1", "scope-1", "rhea", "uuid-1").reason, /header/);

	const foreignHeader = sessionWith([{ type: "session", id: "other" }, customMessage(body, detailsFor(body))]);
	assert.match(readQualifyingReceipts(foreignHeader, "sess-1", "scope-1", "rhea", "uuid-1").reason, /mismatch/);

	const dir = mkdtempSync(join(tmpdir(), "sse-receipt-partial-"));
	const partialFile = join(dir, "partial.jsonl");
	writeFileSync(
		partialFile,
		JSON.stringify(headerEntry) + "\n" + JSON.stringify(customMessage(body, detailsFor(body))).slice(0, 20),
	);
	const partialRead = readQualifyingReceipts(partialFile, "sess-1", "scope-1", "rhea", "uuid-1");
	assert.equal(partialRead.ok, true);
	assert.equal(partialRead.receipts.length, 0, "a trailing partial line authorizes nothing");
});
