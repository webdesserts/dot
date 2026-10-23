/**
 * notifications.sse.protocol.mjs — pure protocol helpers for the opt-in
 * presentation-SSE client (autonomy/t:276 initial guest slice).
 *
 * Dependency-free and side-effect-free: numeric gate validators, an SSE
 * frame parser, trusted-origin parsing and the disk-receipt reader used
 * for acknowledgment authority. The worker (notifications.worker.mjs)
 * owns all HTTP, lease, reconnect and timing activity; this module owns
 * none of it.
 *
 * SOURCE PROVENANCE (carried forward narrowly, not automatically
 * tracking upstream): the numeric-gate validators and receipt reader are
 * adapted from the ACCEPTED SDK-composition pilot helpers —
 * crates/prime/tests/notification-sdk-composition/helpers/gate.mjs
 * (response validators) and helpers/adapter.mjs (readQualifyingReceipts)
 * — at backend 20f23ac0314b63bd14ce63637298f862e91058f0. Only the pure
 * validated logic was carried; the pilot's test pump, debug counters,
 * stub-model code and TEST_CADENCE were deliberately NOT copied. This
 * copy does not track upstream changes; drift is reviewed by hand.
 *
 * Gate discipline (from the accepted pilot, unchanged): JSON.parse FIRST,
 * then exact used-DTO type / nonnegative Number.isSafeInteger checks
 * BEFORE ANY EFFECT. Trusted-server integer DTOs refuse unsafe u64 values
 * (> Number.MAX_SAFE_INTEGER), negatives, fractional values and
 * string-encoded numbers, failing closed. Typed-optional part references
 * keep null vs 0 distinct. Every validator THROWS GateError on the first
 * failing field, and a GateError carries ONLY the static endpoint, field,
 * reason and a coarse observed-type label — never the offending raw
 * value, its length or any prefix. Unsafe data means NO delivery, NO ack,
 * NO adoption of proof, NO sequence advancement.
 */

import crypto from "node:crypto";
import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";

export const CUSTOM_TYPE = "autonomy-notification-presentation";
export const METADATA_SCHEMA_VERSION = 1;
/** This initial client pins render_version exactly 1; no future-version claim. */
export const SUPPORTED_RENDER_VERSION = 1;

// Explicit provisional availability limits, not archive truncation policies.
// The total archive has no fixed size cap; each reconciliation validates a
// single initial-size snapshot before returning any receipt authority.
export const RECEIPT_READ_CHUNK_BYTES = 64 * 1024;
export const MAX_SESSION_RECORD_BYTES = 64 * 1024 * 1024; // excludes LF
export const MAX_SESSION_RECEIPTS = 100_000;

/** The one wire endpoint this client consumes (POST — never EventSource). */
export const STREAM_PATH = "/notifications/presentation/stream";
export const LEASE_STATUS_PATH = "/notifications/lease/status";
export const LEASE_CLAIM_PATH = "/notifications/lease/claim";
export const LEASE_RENEW_PATH = "/notifications/lease/renew";
export const ACK_PATH = "/notifications/presentation/acknowledge";
export const WHOAMI_PATH = "/whoami";

const sha256Hex = (text) =>
	crypto.createHash("sha256").update(text, "utf8").digest("hex");

// ── gate primitives (adapted from the accepted pilot's gate.mjs) ─────────

/** Coarse, credential-free type label — never the value, its length, or a prefix. */
export function observedTypeOf(value) {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	return typeof value;
}

/** Rejected at the parsed boundary. Carries NO dynamic raw value. */
export class GateError extends Error {
	constructor(endpoint, field, reason, observedType) {
		super(
			`gate: ${endpoint} field ${field} ${reason} — refusing before any effect ` +
				`(observed: ${observedType})`,
		);
		this.name = "GateError";
		this.endpoint = endpoint;
		this.field = field;
		this.reason = reason;
		this.observedType = observedType;
	}
}

/** typeof number && Number.isSafeInteger && >= 0 — the only accepted numeric shape. */
export function isSafeNonNegativeInteger(value) {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Exactly 64 lowercase hex characters — a shape check, never a credential echo. */
export function isDigestShape(value) {
	return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

/**
 * Any canonical UUID shape (8-4-4-4-12 lowercase hex) — NO version
 * restriction. A shape check for registry-issued ActorIds; never echoes
 * or transforms the value.
 */
export function isUuidShape(value) {
	return (
		typeof value === "string" &&
		/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
	);
}

function requireString(endpoint, object, field) {
	const value = object?.[field];
	if (typeof value !== "string" || value.length === 0) {
		throw new GateError(endpoint, field, "must be a nonempty string", observedTypeOf(value));
	}
	return value;
}

function requireSafeNonNegative(endpoint, object, field) {
	const value = object?.[field];
	if (!isSafeNonNegativeInteger(value)) {
		throw new GateError(
			endpoint,
			field,
			"must be a nonnegative safe integer (no coercion, no rounding, no u64 past 2^53-1)",
			observedTypeOf(value),
		);
	}
	return value;
}

/**
 * Typed-optional part reference: explicit `null` (no part of that kind) is
 * distinct from `0` (a real first offer). Missing keys, strings and numeric
 * strings refuse — never zero-substituted.
 */
function partRef(endpoint, object, field) {
	const value = object?.[field];
	if (value === null) return null;
	if (isSafeNonNegativeInteger(value)) return value;
	throw new GateError(
		endpoint,
		field,
		"must be null or a nonnegative safe integer (typed-optional: null vs 0 stay distinct)",
		observedTypeOf(value),
	);
}

function requireHexShape(endpoint, object, field) {
	const value = object?.[field];
	if (!isDigestShape(value)) {
		throw new GateError(
			endpoint,
			field,
			"must be exactly 64 lowercase hex characters",
			observedTypeOf(value),
		);
	}
	return value;
}

function requireObject(endpoint, parsed) {
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new GateError(endpoint, "$", "must be a JSON object", observedTypeOf(parsed));
	}
	return parsed;
}

// ── endpoint response validators (exact used DTO shapes only) ────────────

/** GET /whoami → {user: string|null, actor_id: string|null} */
export function validateWhoami(parsed) {
	const endpoint = "whoami";
	requireObject(endpoint, parsed);
	const user = parsed.user;
	if (user !== null && typeof user !== "string") {
		throw new GateError(endpoint, "user", "must be a string or null", observedTypeOf(user));
	}
	const actorId = parsed.actor_id;
	if (actorId !== null && typeof actorId !== "string") {
		throw new GateError(endpoint, "actor_id", "must be a string or null", observedTypeOf(actorId));
	}
	return { user, actor_id: actorId };
}

/** POST /notifications/lease/status → {epoch: null|int>=0, owner: null|{runtime_id, deadline_remaining_ms}} */
export function validateStatusResponse(parsed) {
	const endpoint = "lease/status";
	requireObject(endpoint, parsed);
	let epoch = parsed.epoch;
	if (epoch !== null && !isSafeNonNegativeInteger(epoch)) {
		throw new GateError(
			endpoint,
			"epoch",
			"must be null (no grant ever folded) or a nonnegative safe integer (null vs 0 stay distinct)",
			observedTypeOf(epoch),
		);
	}
	let owner = parsed.owner;
	if (owner !== null && owner !== undefined) {
		requireObject(endpoint, owner);
		owner = {
			runtime_id: requireString(endpoint, owner, "runtime_id"),
			deadline_remaining_ms: requireSafeNonNegative(endpoint, owner, "deadline_remaining_ms"),
		};
	} else {
		owner = null;
	}
	return { epoch, owner };
}

/** POST /notifications/lease/claim → {outcome, epoch, runtime_id, grant_secret, deadline_remaining_ms} */
export function validateClaimResponse(parsed, expectedRuntimeId) {
	const endpoint = "lease/claim";
	requireObject(endpoint, parsed);
	const outcome = parsed.outcome;
	if (outcome !== "granted" && outcome !== "recovered") {
		throw new GateError(endpoint, "outcome", "must be 'granted' or 'recovered'", observedTypeOf(outcome));
	}
	const epoch = requireSafeNonNegative(endpoint, parsed, "epoch");
	const runtimeId = requireString(endpoint, parsed, "runtime_id");
	if (expectedRuntimeId !== undefined && runtimeId !== expectedRuntimeId) {
		// No dynamic id echo — static reason/type only (sanitization contract).
		throw new GateError(
			endpoint,
			"runtime_id",
			"must match this runtime's own id — adopting another runtime's proof is refused",
			observedTypeOf(runtimeId),
		);
	}
	const grantSecret = requireHexShape(endpoint, parsed, "grant_secret");
	const deadlineRemainingMs = requireSafeNonNegative(endpoint, parsed, "deadline_remaining_ms");
	return { outcome, epoch, runtime_id: runtimeId, grant_secret: grantSecret, deadline_remaining_ms: deadlineRemainingMs };
}

/** POST /notifications/lease/renew → {outcome: 'renewed'|'duplicate', deadline_remaining_ms} */
export function validateRenewResponse(parsed) {
	const endpoint = "lease/renew";
	requireObject(endpoint, parsed);
	const outcome = parsed.outcome;
	if (outcome !== "renewed" && outcome !== "duplicate") {
		throw new GateError(endpoint, "outcome", "must be 'renewed' or 'duplicate'", observedTypeOf(outcome));
	}
	const deadlineRemainingMs = requireSafeNonNegative(endpoint, parsed, "deadline_remaining_ms");
	return { outcome, deadline_remaining_ms: deadlineRemainingMs };
}

/**
 * The full PresentationOfferDto carried by `event: presentation` on
 * POST /notifications/presentation/stream (the same DTO the prepare route
 * returns). Every numeric identity/counter must be a safe nonnegative
 * integer, part references keep typed-optional semantics, and the body/
 * digest pair is verified here — validation BEFORE any delivery effect.
 */
export function validatePresentationOffer(parsed) {
	const endpoint = "presentation/stream";
	requireObject(endpoint, parsed);
	const offer = {
		presentation_id: requireSafeNonNegative(endpoint, parsed, "presentation_id"),
		content_offer_id: partRef(endpoint, parsed, "content_offer_id"),
		summary_offer_id: partRef(endpoint, parsed, "summary_offer_id"),
		body: requireString(endpoint, parsed, "body"),
		render_version: requireSafeNonNegative(endpoint, parsed, "render_version"),
		digest: requireHexShape(endpoint, parsed, "digest"),
	};
	return offer;
}

/**
 * The offer's byte-correspondence check: the recomputed UTF-8 SHA-256 of
 * the exact server-rendered body must equal the received digest before
 * the body may be delivered anywhere.
 */
export function verifyOfferDigest(offer) {
	return sha256Hex(offer.body) === offer.digest;
}

/** POST /notifications/presentation/acknowledge → {outcome: 'acknowledged'|'already_acknowledged'} */
export function validateAckResponse(parsed) {
	const endpoint = "presentation/acknowledge";
	requireObject(endpoint, parsed);
	const outcome = parsed.outcome;
	if (outcome !== "acknowledged" && outcome !== "already_acknowledged") {
		throw new GateError(
			endpoint,
			"outcome",
			"must be 'acknowledged' or 'already_acknowledged'",
			observedTypeOf(outcome),
		);
	}
	return { outcome };
}

// ── trusted-origin parsing (explicit operator configuration) ─────────────

/** A static configuration failure — no configured value is ever echoed. */
export class ConfigError extends Error {
	constructor(reason) {
		super(`configuration refused: ${reason}`);
		this.name = "ConfigError";
	}
}

/**
 * Validate the EXPLICITLY configured trusted base origin. Returns the
 * normalized origin (scheme://host[:port]) that every endpoint URL is
 * built from. Refuses non-http(s) schemes, embedded credentials, and
 * path/query/hash components — credentials never travel in URLs and the
 * client never follows a redirect carrying them elsewhere (fetch uses
 * redirect:"error" at the call sites).
 */
export function parseTrustedOrigin(raw) {
	if (typeof raw !== "string" || raw.length === 0) {
		throw new ConfigError("the trusted base origin must be explicitly configured");
	}
	let url;
	try {
		url = new URL(raw);
	} catch {
		throw new ConfigError("the trusted base origin is not a valid URL");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new ConfigError("the trusted base origin must be http or https");
	}
	if (url.username || url.password) {
		throw new ConfigError("the trusted base origin must not carry embedded credentials");
	}
	if (url.pathname !== "/" && url.pathname !== "") {
		throw new ConfigError("the trusted base origin must not include a path component");
	}
	if (url.search || url.hash) {
		throw new ConfigError("the trusted base origin must not include a query or fragment");
	}
	return url.origin;
}

// ── SSE frame parser (bounded) ───────────────────────────────────────────

/** A framing refusal — static reason only, never the offending bytes. */
export class SseFrameError extends Error {
	constructor(reason) {
		super(`sse framing refused: ${reason}`);
		this.name = "SseFrameError";
	}
}

/**
 * Incremental text/event-stream parser. `feed(chunk)` returns the complete
 * events in that chunk: {event, data}. The event `id:` field is captured
 * nowhere — Last-Event-ID is deliberately NOT an authority and is never
 * sent back by this client. Framing is bounded: a single line larger than
 * maxLineBytes, or a buffered (unterminated) event larger than
 * maxEventBytes, throws SseFrameError and resets the parser. Comments
 * (keepalive `:` lines) are ignored. `end()` flushes stream end: a
 * trailing partial frame without its terminating blank line is REFUSED
 * (returned as {refused}), never delivered.
 */
export function createSseParser({ maxEventBytes = 1_048_576, maxLineBytes = 131_072 } = {}) {
	let buffer = "";
	let eventName = "message";
	let dataLines = [];

	const reset = () => {
		eventName = "message";
		dataLines = [];
	};

	const dispatch = () => {
		const name = eventName;
		const data = dataLines.join("\n");
		reset();
		if (name === "message" && data === "") return null; // empty dispatch
		return { event: name, data };
	};

	return {
		feed(chunk) {
			buffer += chunk;
			const events = [];
			let idx;
			while ((idx = buffer.indexOf("\n")) !== -1) {
				let line = buffer.slice(0, idx);
				buffer = buffer.slice(idx + 1);
				if (line.endsWith("\r")) line = line.slice(0, -1);
				if (line.length > maxLineBytes) {
					reset();
					buffer = "";
					throw new SseFrameError("a frame line exceeds the bounded line size");
				}
				if (line === "") {
					const event = dispatch();
					if (event) events.push(event);
					continue;
				}
				if (line.startsWith(":")) continue; // comment / keepalive
				const colon = line.indexOf(":");
				const field = colon === -1 ? line : line.slice(0, colon);
				let value = colon === -1 ? "" : line.slice(colon + 1);
				if (value.startsWith(" ")) value = value.slice(1);
				if (field === "event") eventName = value === "" ? "message" : value;
				else if (field === "data") {
					dataLines.push(value);
					// The event bound also covers ACCUMULATED multi-line data: many
					// individually-legal lines must not accumulate unboundedly.
					let dataTotal = 0;
					for (const d of dataLines) dataTotal += d.length;
					if (dataTotal > maxEventBytes) {
						reset();
						buffer = "";
						throw new SseFrameError("a buffered event exceeds the bounded event size");
					}
				}
				// `id:` is deliberately ignored (never receipt/replay authority);
				// `retry:` and unknown fields are ignored.
			}
			if (buffer.length > maxEventBytes) {
				reset();
				buffer = "";
				throw new SseFrameError("a buffered event exceeds the bounded event size");
			}
			return events;
		},
		end() {
			if (buffer !== "" || dataLines.length > 0 || eventName !== "message") {
				const hadPending = buffer !== "" || dataLines.length > 0;
				reset();
				if (hadPending) return { refused: "the stream ended mid-frame; the partial event is refused" };
			}
			return { refused: null };
		},
	};
}

// ── disk receipt reader (the ONLY ack authority; adapted from adapter.mjs) ──

/**
 * Read the intended session JSONL from disk (LF framing), check the REAL
 * header id equals the current sessionId, and return every FULL qualifying
 * custom_message entry: this client's customType, display:true, string
 * content, supported typed metadata (schema version, scope, recipient
 * handle, VALIDATED STABLE actor id, session, presentationId,
 * renderVersion 1, digest, optional part refs), and a recomputed UTF-8
 * SHA256 equal to the recorded digest. One regular-file FD is scanned only
 * through its initial size, in bounded byte chunks. Complete LF records are
 * strict UTF8/JSON objects; a partial tail waits for the next pass. The first
 * nonblank complete object must be the matching header; duplicates refuse.
 * Malformed complete records, IO failures, detected replacement/truncation/mutation or
 * safety-limit exhaustion discard ALL receipts, including a valid prefix.
 * Metadata-only custom entries, wrong body/digest/session/recipient/actor-id/
 * version refuse. Existing missing-part-reference -> null semantics remain.
 *
 * 64 MiB/record and 100000 candidates are explicit provisional availability
 * limits, not pruning/suppression policies. Exceeding either requires review,
 * never skipping data. Total archive size is not capped; scan time is linear.
 * Appends beyond the snapshot are deferred. Metadata detects observable races,
 * not an atomic transaction with a writer/HTTP ACK or truncate-and-regrow proof.
 */
export function readQualifyingReceipts(sessionFile, sessionId, scopeId, recipientActor, recipientActorId) {
	let fd;
	let result;
	try {
		fd = openSync(sessionFile, "r");
		const snapshot = fstatSync(fd, { bigint: true });
		const size = Number(snapshot.size);
		if (!snapshot.isFile() || !isSafeNonNegativeInteger(size) || BigInt(size) !== snapshot.size) {
			result = refuseFile("session file is not a supported regular file");
		} else {
			result = scanReceiptSnapshot(fd, size, sessionId, scopeId, recipientActor, recipientActorId);
			// The FD pins the scanned inode. Refuse observed replacement,
			// truncation or same-size mutation; pure append waits for next pass.
			if (result.ok && (!sameSnapshot(snapshot, fstatSync(fd, { bigint: true })) || !sameSnapshot(snapshot, statSync(sessionFile, { bigint: true })))) {
				result = refuseFile("session file changed during receipt scan — retry reconciliation");
			}
		}
	} catch (error) {
		result = refuseFile(error?.code === "ENOENT" ? "session file absent" : "session file unreadable");
	} finally {
		if (fd !== undefined) {
			try { closeSync(fd); }
			catch { result = refuseFile("session file unreadable"); }
		}
	}
	return result;
}

const refuseFile = (reason) => ({ ok: false, reason, receipts: [] });
const sameSnapshot = (before, after) => before.dev === after.dev && before.ino === after.ino &&
	after.size >= before.size && (after.size > before.size ||
		(before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs));

function scanReceiptSnapshot(fd, size, sessionId, scopeId, recipientActor, recipientActorId) {
	const chunk = Buffer.allocUnsafe(RECEIPT_READ_CHUNK_BYTES);
	const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
	let pieces = [];
	let recordBytes = 0;
	let headerSeen = false;
	const receipts = [];
	const consume = (bytes) => {
		let entry;
		try {
			const line = decoder.decode(bytes);
			if (!line.trim()) return;
			entry = JSON.parse(line);
			if (entry === null || typeof entry !== "object" || Array.isArray(entry) ||
				typeof entry.type !== "string" || entry.type.length === 0) throw new Error("not an entry");
		} catch { return refuseFile("unparseable line (refusing the whole file)"); }
		if (!headerSeen) {
			if (entry.type !== "session") return refuseFile("session header is not the first complete entry on disk");
			if (entry.id !== sessionId) return refuseFile("header id does not match the current session id (static mismatch class)");
			headerSeen = true;
			return;
		}
		if (entry.type === "session") return refuseFile("multiple session headers on disk (refusing the whole file)");
		if (entry.type !== "custom_message" || entry.customType !== CUSTOM_TYPE) return;
		if (receipts.length === MAX_SESSION_RECEIPTS) {
			return refuseFile("session exceeds 100000 receipt candidates — review receipt-reader safety limit; nothing acknowledged");
		}
		const verdict = qualify(entry, sessionId, scopeId, recipientActor, recipientActorId);
		if (verdict.ok) receipts.push(verdict.receipt);
		else receipts.push({ refused: true, reason: verdict.reason,
			presentationId: isSafeNonNegativeInteger(verdict.presentationId) ? verdict.presentationId : null });
	};
	for (let position = 0; position < size;) {
		const count = readSync(fd, chunk, 0, Math.min(chunk.length, size - position), position);
		if (count === 0) return refuseFile("session file truncated during receipt scan — retry reconciliation");
		position += count;
		let start = 0;
		while (start < count) {
			const lf = chunk.indexOf(0x0a, start);
			const complete = lf !== -1 && lf < count;
			const end = complete ? lf : count;
			const part = chunk.subarray(start, end);
			if (recordBytes + part.length > MAX_SESSION_RECORD_BYTES) {
				return refuseFile("session JSONL record exceeds 64 MiB — review receipt-reader safety limit; nothing acknowledged");
			}
			if (complete) {
				const bytes = recordBytes ? Buffer.concat([...pieces, part], recordBytes + part.length) : part;
				const refused = consume(bytes);
				if (refused) return refused;
				pieces = [];
				recordBytes = 0;
			} else if (part.length) {
				// readSync reuses chunk: only the bounded unfinished record is copied.
				pieces.push(Buffer.from(part));
				recordBytes += part.length;
			}
			start = end + (complete ? 1 : 0);
		}
	}
	// No final LF means no receipt, even when the bytes form valid JSON.
	if (!headerSeen) return refuseFile("no session header on disk");
	return { ok: true, receipts };
}

function qualify(entry, sessionId, scopeId, recipientActor, recipientActorId) {
	if (entry.display !== true) return { ok: false, reason: "display is not true" };
	if (typeof entry.content !== "string") return { ok: false, reason: "content is not a string" };
	const details = entry.details;
	if (details === null || typeof details !== "object" || Array.isArray(details)) {
		return { ok: false, reason: "details missing (metadata-only or untyped)" };
	}
	if (details.schema !== METADATA_SCHEMA_VERSION) {
		return { ok: false, reason: "unsupported metadata schema" };
	}
	if (details.scope !== scopeId) {
		return { ok: false, reason: "scope mismatch", presentationId: details.presentationId ?? null };
	}
	if (details.recipient !== recipientActor) {
		return { ok: false, reason: "recipient mismatch", presentationId: details.presentationId ?? null };
	}
	if (details.actorId !== recipientActorId) {
		// The stable registry actor id is bound TOO: a handle alone is
		// mutable and never sufficient to qualify a receipt.
		return { ok: false, reason: "actor id mismatch", presentationId: details.presentationId ?? null };
	}
	if (details.sessionId !== sessionId) {
		return { ok: false, reason: "session mismatch", presentationId: details.presentationId ?? null };
	}
	if (!isSafeNonNegativeInteger(details.presentationId)) {
		return { ok: false, reason: "presentationId is not a safe nonnegative integer" };
	}
	if (details.renderVersion !== SUPPORTED_RENDER_VERSION) {
		return {
			ok: false,
			reason: "unsupported renderVersion",
			presentationId: details.presentationId ?? null,
		};
	}
	if (typeof details.digest !== "string" || !isDigestShape(details.digest)) {
		return { ok: false, reason: "digest shape invalid", presentationId: details.presentationId ?? null };
	}
	for (const field of ["contentOfferId", "summaryOfferId"]) {
		const value = details[field];
		if (value !== null && value !== undefined) {
			if (!isSafeNonNegativeInteger(value)) {
				return { ok: false, reason: `${field} is neither null nor a safe nonnegative integer` };
			}
		}
	}
	const recomputed = sha256Hex(entry.content);
	if (recomputed !== details.digest) {
		return {
			ok: false,
			reason: "recomputed SHA256 != recorded digest",
			presentationId: details.presentationId ?? null,
		};
	}
	return {
		ok: true,
		receipt: {
			presentationId: details.presentationId,
			digest: details.digest,
			contentOfferId: details.contentOfferId ?? null,
			summaryOfferId: details.summaryOfferId ?? null,
		},
	};
}
