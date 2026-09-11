#!/usr/bin/env node
/**
 * notifications.worker.mjs — the autonomy-daemon wake bridge (worker process).
 *
 * Spawned by notifications.ts (the supervisor shim, loaded as a pi extension).
 * Read fresh on each spawn; use /reload or restart/resume after updates.
 * This adapter currently:
 *
 *   - consumes the daemon's presentation-SSE stream by DEFAULT (the
 *     legacy long-poll below now needs an explicit AUTONOMY_SSE_MODE=0)
 *   - legacy mode long-polls the daemon's notification endpoint (20s hold)
 *   - transport pacing: a small floor between HTTP requests. Undismissed
 *     persistent rows make /notifications return IMMEDIATELY on every
 *     request, so repeat suppression alone would turn the poll loop into
 *     a hot loop. Pacing bounds the request rate only — it is NOT a
 *     delivery cooldown: it never buffers, withholds, or drops a
 *     message, and it adds at most one interval of latency to the poll
 *     AFTER the one being handled.
 *   - suppresses only REPEATED PRESENTATION: a state signature (per-row
 *     handle + text + resource_key, summary places/counts, total) is
 *     compared against the last wake; an unchanged signature is silence.
 *     The signature resets on a genuinely empty response, so a persistent
 *     row that reappears after going away is emitted again. Server-side
 *     sender suppression / summary throttling / persistent-row re-offer
 *     are the daemon's job (crates/prime/src/routes/notifications.rs).
 *   - idle heartbeat driven by lifecycle events forwarded on stdin
 *
 * HIGH vs LOW is ONLY "rendered automatically" vs "requires a deliberate
 * notifications/list read" — no urgency labels are shown to the agent.
 * This worker never dismisses and never reads the feed; it renders what
 * the long-poll returns and stops.
 *
 * PROTOCOL:
 *   stdin  (from supervisor): JSON lines
 *     {"event": "agent_start"|"agent_end", "generation": n}
 *     {"event": "init", "busy": bool, "mode": "goal"|"ambient"|"paused",
 *      "idleDelayMs": n, "goal": "...", "holdUntil": epochMs,
 *      "ambientExpiresAt": epochMs, "generation": n}
 *     {"event": "enable", "idleDelayMs": n, "goal": "...", "busy": bool,
 *      "generation": n}
 *     {"event": "hold", "holdUntil": epochMs, "generation": n}
 *     {"event": "complete", "ambientExpiresAt": epochMs, "generation": n}
 *     {"event": "pause",  "generation": n}
 *   stdout (to supervisor):  JSON lines
 *     {"kind": "wake", "message": "..."}
 *     {"kind": "heartbeat", "message": "...", "generation": n}
 *
 * HEARTBEAT MODES (session-local; the supervisor owns control state):
 *   goal     — active goal: the timer is armed on every idle transition —
 *              agent_end, an enable issued while already idle, or a crash
 *              replay (init) while idle. No wake-count expiry: the goal
 *              wakes until explicitly completed or paused. The busy/idle
 *              snapshot comes from the supervisor (init/enable "busy"
 *              field), so a heartbeat cannot arm mid-turn.
 *   ambient  — bounded fallback: 30-minute idle checks (AUTONOMY_HEARTBEAT_MS)
 *              that NEVER fire past the fixed ambientExpiresAt deadline. Its
 *              own wakes, replies, holds and worker crashes cannot extend the
 *              expiry; once past it, no timer is scheduled and beats stop.
 *   paused   — all heartbeat wakes silenced until the supervisor enables
 *              again.
 *
 * HOLD: a heartbeat-only deferral. While holdUntil (absolute epoch ms) is in
 * the future, a pending goal timer is re-armed so it fires no earlier than
 * BOTH the normal idle delay and the hold deadline; a busy run is never
 * interrupted — the post-agent_end arm applies the same floor. Hold never
 * creates a wake and resumes automatically without a re-enable.
 *
 * GENERATION: the supervisor bumps a control/lifecycle generation on enable,
 * hold, complete, pause, agent_start and agent_end and sends it with each
 * event; every heartbeat response echoes the generation it was armed under.
 * The supervisor rejects mismatched generations, fencing stale output (e.g. a
 * beat queued before a transition, or a prior idle cycle's line).
 *
 * The supervisor re-checks generation/busy/idleness/paused/expiry at delivery
 * time, so a heartbeat emitted here can still be dropped there. Arming NEVER
 * fires immediately: wakes only happen after the full delay, so no zero-delay
 * prompt loop is possible.
 *
 * The supervisor delivers stdout messages via pi.sendUserMessage with
 * { deliverAs: "steer" } — never bare (bare calls are refused and
 * dropped while the agent is busy).
 *
 * Config via env: AUTONOMY_BASE (default http://127.0.0.1:4600),
 * AUTONOMY_ACTOR (default "iris" — rhea sets "rhea"; LEGACY long-poll
 * auth header only: SSE identity comes from authenticated /whoami),
 * AUTONOMY_TOKEN (optional bearer for proxied daemons),
 * AUTONOMY_HEARTBEAT_MS (default 1800000, 0 disables; ambient mode only),
 * AUTONOMY_ERROR_BACKOFF_MS (default 5000), AUTONOMY_FETCH_TIMEOUT_MS
 * (default 30000 — must exceed the 20s server hold so a hung response
 * can never wedge the loop and shutdown/error paths stay reachable),
 * AUTONOMY_POLL_INTERVAL_MS (default 1000 — transport pacing floor
 * between requests, see above).
 *
 * HACK: presentation repeat suppression and request pacing compensate for
 * the current endpoint's immediate persistent-row replay. Remove them when
 * Autonomy owns reconnect/replay delivery; they are not a second policy layer.
 */

import { stdin, stdout } from "node:process";
import crypto from "node:crypto";
import { chmodSync, closeSync, openSync, readFileSync, writeSync } from "node:fs";
import {
	ACK_PATH,
	ConfigError,
	CUSTOM_TYPE,
	GateError,
	LEASE_CLAIM_PATH,
	LEASE_RENEW_PATH,
	LEASE_STATUS_PATH,
	METADATA_SCHEMA_VERSION,
	SUPPORTED_RENDER_VERSION,
	SseFrameError,
	STREAM_PATH,
	WHOAMI_PATH,
	createSseParser,
	isSafeNonNegativeInteger,
	isUuidShape,
	parseTrustedOrigin,
	readQualifyingReceipts,
	validateAckResponse,
	validateClaimResponse,
	validatePresentationOffer,
	validateRenewResponse,
	validateStatusResponse,
	validateWhoami,
	verifyOfferDigest,
} from "./notifications.sse.protocol.mjs";

const BASE = process.env.AUTONOMY_BASE ?? "http://127.0.0.1:4600";
const ACTOR = process.env.AUTONOMY_ACTOR ?? "iris";
const TOKEN = process.env.AUTONOMY_TOKEN ?? "";
const POLL_HOLD_SECONDS = 20;
const ERROR_BACKOFF_MS = Number(process.env.AUTONOMY_ERROR_BACKOFF_MS ?? 5_000);
const FETCH_TIMEOUT_MS = Number(process.env.AUTONOMY_FETCH_TIMEOUT_MS ?? 30_000);
const POLL_INTERVAL_MS = Number(process.env.AUTONOMY_POLL_INTERVAL_MS ?? 1_000);
const HEARTBEAT_MS = Number(process.env.AUTONOMY_HEARTBEAT_MS ?? 1_800_000);
// Mirror of the supervisor's clamp: Node clamps setTimeout above 2^31-1ms
// to 1ms, so anything larger is rejected rather than mis-scheduled.
const MAX_IDLE_DELAY_MS = 3_600_000;// Fixed ambient window used only when the supervisor has not sent one yet
// (e.g. a standalone worker that never receives init). Bounded either way.
const AMBIENT_LIFETIME_MS = 2 * 3_600_000;

// ── SSE-mode module state (referenced by the stdin handler above) ──
// Supervisor-supplied session identity for receipt reconciliation, and
// the reconcile queue hook — both no-ops in legacy mode, assigned by the
// SSE section below when that mode is active.
let sseSessionId = null;
let sseSessionFile = null;
let queueReconcile = () => {};

const emit = (kind, message) => {
	stdout.write(`${JSON.stringify({ kind, message })}\n`);
};

const emitHeartbeat = (message) => {
	stdout.write(`${JSON.stringify({ kind: "heartbeat", message, generation })}\n`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const asNumber = (value) => {
	const n = Number(value);
	return Number.isFinite(n) ? n : null;
};

const asGeneration = (value) => {
	const n = Number(value);
	return Number.isFinite(n) && n >= 0 ? n : null;
};

function authHeaders() {
	const headers = { "X-Auth-User": ACTOR };
	if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
	return headers;
}

// Temporary repeat guard for the current long-poll contract. Include row
// identity and every rendered field so a changed presentation is not lost.
function stateSignature(data, priority) {
	const handles = priority
		.map((i) => JSON.stringify([i.handle ?? "", i.sender ?? "", i.place ?? "", i.text ?? "", i.resource_key ?? ""]))
		.sort();
	const summary = Object.entries(data.summary ?? {})
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([place, count]) => `${place}:${count}`);
	return JSON.stringify({ h: handles, s: summary, t: data.total ?? null });
}

function renderItem(item) {
	const place = item.place ? ` @ ${item.place}` : "";
	const key = item.resource_key ? ` (${item.resource_key})` : "";
	return `- ${item.sender ?? "?"}${place}${key}: ${item.text ?? "(no text)"}`;
}

function render(data, priority, summary) {
	const lines = [];
	for (const item of priority) lines.push(renderItem(item));
	for (const [place, count] of Object.entries(summary ?? {})) {
		lines.push(`- ${place}: ${count} (use notifications/list for items)`);
	}
	if (data.total !== undefined) lines.push(`total unattended: ${data.total}`);
	if (lines.length === 0) {
		return `autonomy notifications: response shape not recognized — inspecting raw:\n${JSON.stringify(data).slice(0, 2000)}`;
	}
	const head = "Autonomy notifications:";
	return `${head}\n${lines.join("\n")}`;
}

// ── heartbeat: idle self-wake, driven by supervisor events on stdin ──
// Exactly ONE idle timer exists at any time; every arm clears any pending one.
let idleTimer = null;
let mode = "ambient";
let goalDelayMs = 0;
let goalText = "";
// Absolute deadlines (epoch ms). Absolute, never relative, so a crash replay
// or respawn cannot silently renew a hold or the ambient window.
let holdUntil = 0;
let ambientExpiresAt = Date.now() + AMBIENT_LIFETIME_MS;
let generation = 0;
let busy = false; // supervisor-provided snapshot + agent events
// Ambient-only gate: set once by the 10s fallback so a supervisor that never
// forwards lifecycle events still gets its fallback check. Explicit ambient
// entry points (complete) set it too.
let ambientFallbackArmed = false;

const clearIdleTimer = () => {
	if (idleTimer) {
		clearTimeout(idleTimer);
		idleTimer = null;
	}
};

const ambientHeartbeat = () =>
	emitHeartbeat(
		"[heartbeat] 30-minute inactivity check: run queue-watch, compare against the plan, " +
			"do the next unblocked step or dispatch/report on a worker. If everything is truly " +
			"blocked and there is genuinely nothing to plan, end this turn immediately — do not pad.",
	);

const goalHeartbeat = () =>
	emitHeartbeat(
		`[heartbeat] goal check: ${goalText}\n` +
			"Advisory: inspect the current approved goal and keep the authorized work moving — do not " +
			"routinely stop after a single step. Use hold (heartbeat_control hold) for a known finite " +
			"wait; if genuinely blocked on a human, pause (heartbeat_control pause or /hb pause) and " +
			"report the blocker; when the goal is done, complete it (heartbeat_control complete) — " +
			"never invent work or authority.",
	);

// Arm the single goal timer only when the session is idle. The fire time is
// no earlier than BOTH the configured idle delay and any hold deadline.
const armGoalIfIdle = () => {
	if (busy || mode !== "goal" || !(goalDelayMs > 0)) return;
	if (goalDelayMs > MAX_IDLE_DELAY_MS) return; // never schedule a clamped-to-1ms timer
	const now = Date.now();
	const delay = holdUntil > now ? Math.max(goalDelayMs, holdUntil - now) : goalDelayMs;
	clearIdleTimer();
	idleTimer = setTimeout(() => {
		idleTimer = null;
		goalHeartbeat();
	}, delay);
};

// Arm the single ambient timer. The due time is no earlier than BOTH the
// normal 30-minute interval and any hold deadline; when that due time would
// reach or pass the fixed ambient expiry the arm is REFUSED outright — the
// wake is never pulled earlier to fit inside the window, and nothing fires
// past the expiry.
const armAmbientIfIdle = () => {
	if (busy || mode !== "ambient" || HEARTBEAT_MS <= 0) return;
	const now = Date.now();
	if (!Number.isFinite(ambientExpiresAt) || ambientExpiresAt <= 0) return;
	let due = now + HEARTBEAT_MS;
	if (holdUntil > now) due = Math.max(due, holdUntil);
	if (due > ambientExpiresAt) return; // next due time is past the window: refuse
	clearIdleTimer();
	idleTimer = setTimeout(() => {
		idleTimer = null;
		if (mode !== "ambient" || Date.now() > ambientExpiresAt) return;
		ambientHeartbeat();
	}, due - now);
};

stdin.setEncoding("utf8");
let stdinBuf = "";
stdin.on("data", (chunk) => {
	stdinBuf += chunk;
	let idx;
	while ((idx = stdinBuf.indexOf("\n")) !== -1) {
		const line = stdinBuf.slice(0, idx);
		stdinBuf = stdinBuf.slice(idx + 1);
		if (!line) continue;
		try {
			const parsed = JSON.parse(line);
			const gen = asGeneration(parsed.generation);
			if (parsed.event === "agent_start") {
				if (gen !== null) generation = gen;
				busy = true;
				clearIdleTimer();
			} else if (parsed.event === "agent_end") {
				if (gen !== null) generation = gen;
				busy = false;
				if (mode === "goal") {
					armGoalIfIdle();
				} else if (mode === "ambient") {
					if (ambientFallbackArmed) armAmbientIfIdle();
				}
			} else if (parsed.event === "init") {
				// Crash-replay / startup snapshot from the supervisor. Consumes the
				// busy snapshot: an idle goal replay arms the timer (the parent may
				// never turn again), a busy replay waits for the next agent_end.
				mode = parsed.mode === "goal" || parsed.mode === "paused" ? parsed.mode : "ambient";
				const delay = asNumber(parsed.idleDelayMs);
				goalDelayMs = delay !== null && delay > 0 ? Math.min(delay, MAX_IDLE_DELAY_MS) : 0;
				goalText = typeof parsed.goal === "string" ? parsed.goal : "";
				const expiry = asNumber(parsed.ambientExpiresAt);
				ambientExpiresAt = expiry !== null && expiry > 0 ? expiry : 0;
				const hold = asNumber(parsed.holdUntil);
				holdUntil = hold !== null && hold > 0 ? hold : 0;
				if (gen !== null) generation = gen;
				busy = parsed.busy === true;
				clearIdleTimer();
				if (mode === "goal") armGoalIfIdle();
				// Ambient waits for its own gate (the 10s fallback) — the same
				// startup contract the legacy fallback always had.
			} else if (parsed.event === "enable") {
				mode = "goal";
				const delay = asNumber(parsed.idleDelayMs);
				goalDelayMs = delay !== null && delay > 0 ? Math.min(delay, MAX_IDLE_DELAY_MS) : 0;
				goalText = typeof parsed.goal === "string" ? parsed.goal : "";
				holdUntil = 0; // a fresh goal starts unheld
				if (gen !== null) generation = gen;
				busy = parsed.busy === true;
				clearIdleTimer(); // cancels any pending ambient/stale timer
				armGoalIfIdle(); // arms now when the session is already idle
			} else if (parsed.event === "complete") {
				mode = "ambient";
				goalText = "";
				holdUntil = 0;
				const expiry = asNumber(parsed.ambientExpiresAt);
				ambientExpiresAt = expiry !== null && expiry > 0 ? expiry : 0;
				if (gen !== null) generation = gen;
				clearIdleTimer();
				ambientFallbackArmed = true;
				armAmbientIfIdle(); // arms (clamped to the deadline) when idle
			} else if (parsed.event === "hold") {
				const hold = asNumber(parsed.holdUntil);
				if (hold !== null && hold > 0) holdUntil = hold;
				if (gen !== null) generation = gen;
				// Liveness: hold (re)schedules from the CURRENT idle state even
				// when no timer is pending — a beat may have been emitted just
				// before the hold, leaving no timer and no future agent_end.
				// Never arms while busy (a busy run arms on agent_end with the
				// same delay/hold floors); holding never fires immediately.
				if (!busy && (mode === "goal" || mode === "ambient")) {
					clearIdleTimer();
					if (mode === "goal") armGoalIfIdle();
					else armAmbientIfIdle();
				}
			} else if (parsed.event === "heartbeat_defer") {
				if (gen !== generation) continue;
				if (mode === "goal") armGoalIfIdle();
				else if (mode === "ambient") armAmbientIfIdle();
			} else if (parsed.event === "pause") {
				mode = "paused";
				if (gen !== null) generation = gen;
				clearIdleTimer();
			} else if (parsed.event === "session") {
				// Supervisor-supplied session identity, used ONLY to bind disk-receipt
				// reconciliation to the exact session that received deliveries.
				sseSessionId = typeof parsed.sessionId === "string" && parsed.sessionId ? parsed.sessionId : null;
				sseSessionFile = typeof parsed.sessionFile === "string" && parsed.sessionFile ? parsed.sessionFile : null;
			} else if (parsed.event === "reconcile") {
				// Hook/startup-driven receipt reconciliation (session_start,
				// agent_settled). Serialized so two reconciles never double-ack.
				queueReconcile();
			}
		} catch {
			// ignore malformed supervisor lines
		}
	}
});
stdin.on("end", () => {
	// supervisor gone — exit; it respawns us if it's still alive
	process.exit(0);
});

// Fallback: arm after the first poll cycle even if no events arrived yet —
// covers supervisors that don't forward lifecycle events. AMBIENT MODE ONLY
// (bounded by ambientExpiresAt): a goal-enabled session gets its busy/idle
// truth from the supervisor's init/enable events, never from this
// unconditional timer.
setTimeout(() => {
	if (mode === "ambient" && !ambientFallbackArmed) {
		ambientFallbackArmed = true;
		armAmbientIfIdle();
	}
}, 10_000);

// ── main poll loop ──
let lastSig = null;
let lastErrorText = null;
let running = true;

const cleanup = () => {
	running = false;
	clearIdleTimer();
	stdout.end?.();
	process.exit(0);
};
process.on("SIGTERM", cleanup);
process.on("SIGINT", cleanup);

const poll = async () => {
	while (running) {
		try {
			const res = await fetch(`${BASE}/notifications?timeout=${POLL_HOLD_SECONDS}`, {
				headers: authHeaders(),
				signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = await res.json();
			lastErrorText = null;
			const priority = data.priority_notifications ?? [];
			const summary = data.summary ?? {};

			// A genuinely empty response clears the signature: a persistent
			// row that reappears after this point is new presentation again,
			// not a repeat of something already shown.
			const empty =
				priority.length === 0 &&
				Object.keys(summary).length === 0 &&
				(data.total === undefined || data.total === 0);
			if (empty) {
				lastSig = null;
			} else {

				const sig = stateSignature(data, priority);
				if (sig !== lastSig) {
					lastSig = sig;
					emit("wake", render(data, priority, summary));
				}
			}
		} catch (err) {
			const errText = String(err);
			// First failure wakes; the SAME error on retries stays quiet
			// (the retry continues regardless); a changed error or a
			// recovery followed by a new failure wakes again.
			if (errText !== lastErrorText) {
				lastErrorText = errText;
				emit("wake", `[notifications] poll failed: ${err}; retrying in ${ERROR_BACKOFF_MS}ms`);
			}
			await sleep(ERROR_BACKOFF_MS);
		}
		// Transport pacing (NOT a delivery cooldown): bounds the request
		// rate on EVERY iteration — including unchanged-signature and empty
		// responses, which are exactly the immediate-return persistent-row
		// case. Nothing is buffered or withheld; the NEXT poll simply
		// waits out this floor.
		await sleep(POLL_INTERVAL_MS);
	}
};

// ═════════════════════════════════════════════════════════════════
// ── default presentation-SSE mode (autonomy/t:276) ────────────────
// ═════════════════════════════════════════════════════════════════
//
// The worker consumes POST /notifications/presentation/stream (fetch
// streaming — NEVER EventSource, no readiness-only redesign, no prepare
// polling pump) instead of the legacy long-poll, which now requires an
// explicit AUTONOMY_SSE_MODE=0 opt-out and is preserved unchanged for
// now. There is NO fallback to legacy consumption: invalid setup,
// missing identity, auth refusal or transport failure is a visible
// static-class prerequisite failure, and the goal-heartbeat machinery
// above keeps working unchanged. Everything HTTP/lease/reconnect lives
// HERE, in the worker, independently of model busy time.
//
// Normal setup needs exactly the trusted base/auth connection the caller
// already owns — the base origin is REQUIRED (never implicit), and no separately configured display handle, copied UUID,
// scope or renewal interval is mandatory:
//   AUTONOMY_SSE_MODE                  "0" opts out into the legacy
//                                      long-poll (default: SSE on)
//   AUTONOMY_BASE                      REQUIRED trusted base origin
//                                      (http(s), no path, no embedded
//                                      credentials; never implicit — a
//                                      credential is never sent to an
//                                      under-specified origin)
//   AUTONOMY_SSE_EXPECTED_ACTOR_ID     OPTIONAL pin: /whoami's actor_id
//                                      MUST equal it (null or mismatched
//                                      is a visible prerequisite failure)
//   AUTONOMY_SSE_SCOPE                 OPTIONAL receipt-scope override;
//                                      defaults to the trusted origin —
//                                      a consistency namespace for
//                                      receipt metadata only, never
//                                      routing/authorization or a
//                                      server-issued store id
//   AUTONOMY_SSE_RENEW_INTERVAL_MS     OPTIONAL explicit positive lease
//                                      renewal interval; by default the
//                                      delay derives from the server's
//                                      remaining lease budget (one
//                                      third, floored and capped)
//   AUTONOMY_TOKEN                     optional bearer token, OR
//   AUTONOMY_SESSION_COOKIE_FILE       path to a private session-cookie file
//   AUTONOMY_SSE_RECONNECT_BACKOFF_MS  optional reconnect backoff base
//                                      (default 5000, clamped 50..60000)
//   AUTONOMY_SSE_TRACE_FILE            OPTIONAL opt-in diagnostics: a local
//                                      file path. When set, bounded JSONL
//                                      phase-trace records are appended
//                                      there (disabled by default; see the
//                                      trace section below for the exact
//                                      record contract and bounds).
// Identity: the authoritative ActorId and the display/receipt handle
// are resolved from authenticated GET /whoami — carried by the ACTUAL
// credential, never a fabricated actor header — and FROZEN for the
// worker lifetime; a missing/null/malformed identity refuses. Explicit
// credentials remain required (bearer token or session-cookie file).
// Credentials stay in process memory: never in URLs, argv or logs.
// Grant/recovery secrets also stay in process memory — after a process
// replacement the worker visibly waits/reacquires WITHOUT takeover
// (takeover:false always; a live foreign owner is waited out, never
// displaced).

const SSE_MAX_CONNECTION_MS = 600_000; // client-side connection lifetime cap (documented bound)
const SSE_MAX_EVENT_BYTES = 1_048_576; // bounded incoming event buffer
const SSE_MAX_LINE_BYTES = 131_072; // bounded framing line
const SSE_UNCERTAIN_RETRIES = 3; // identical-request retries for uncertain claim/renew/ack
const SSE_UNCERTAIN_BACKOFF_MS = 300; // base wait between uncertain retries (documented bound)
const SSE_OWNERSHIP_ATTEMPTS = 6; // bounded status/claim attempts per acquisition pass
const RENEW_MIN_DELAY_MS = 50; // busy-loop bound only: short budgets still renew BEFORE expiry
const RENEW_MAX_DELAY_MS = 600_000; // reasonable maximum renewal delay

const clampNumber = (value, min, max) => Math.min(max, Math.max(min, value));

// ── opt-in bounded phase trace (diagnostics only; DISABLED by default) ──
// ONE explicit setting enables it: AUTONOMY_SSE_TRACE_FILE, a local file
// path. While set, small JSONL records are appended there: monotonic
// elapsed ms (t), phase/event enums, and public correlation only — NEVER
// credentials, headers, bodies, dynamic error text or private content.
// Bounds: at most 2000 records AND 1MB per process lifetime; reaching a
// bound silently stops tracing for the process lifetime. ANY tracing
// failure (unreadable path, full disk, closed fd) disables tracing and
// NEVER affects ownership or delivery.
//
// Record fields (the complete allowed set):
//   t                  monotonic elapsed ms since worker start
//   phase              sseMain | ensureOwnership | scheduleRenewal |
//                      renewLease | gatedPost | connectStream | dropLease |
//                      reconcile
//   event              phase-specific enum (see traceEvent call sites)
//   pid                process correlation
//   runtimeId/epoch/actorId  PUBLIC grant/identity correlation (never the
//                      grant secret, never the credential)
//   route              whoami | lease_status | lease_claim | lease_renew |
//                      ack | stream
//   httpStatus         returned status (public static class)
//   outcome            validated DTO outcome enum (renewed/duplicate/…)
//   failureClass       static failure enum (never a dynamic message)
//   sequence           renewal sequence number
//   budgetRemainingMs  server-returned remaining lease budget
//   scheduledDelayMs / fireLatenessMs  timer scheduled vs actually fired
//   durationMs         stream connection lifetime
//   presentationEvents count of presentation frames on a stream
//   reason             dropLease reason enum
const TRACE_MAX_RECORDS = 2000;
const TRACE_MAX_BYTES = 1_000_000;
const TRACE_EPOCH = process.hrtime.bigint();

const traceOpen = () => {
	const file = process.env.AUTONOMY_SSE_TRACE_FILE;
	if (typeof file !== "string" || file === "") return null;
	try {
		const fd = openSync(file, "a", 0o600);
		chmodSync(file, 0o600); // restrictive permissions even if the file pre-existed
		return { fd, records: 0, bytes: 0 };
	} catch {
		return null; // tracing is optional diagnostics — never required
	}
};
let traceState = traceOpen();
let traceRuntimeId = null;
let traceEpoch = null;
let traceActorId = null;

const traceStop = () => {
	if (!traceState) return;
	try {
		closeSync(traceState.fd);
	} catch {}
	traceState = null;
};

// Every allowed field; the record builder rejects anything else by construction.
const traceEvent = (phase, event, fields = {}) => {
	if (!traceState) return;
	try {
		if (traceState.records >= TRACE_MAX_RECORDS) {
			traceStop();
			return;
		}
		const record = { t: Number(process.hrtime.bigint() - TRACE_EPOCH) / 1e6, phase, event, pid: process.pid };
		if (traceRuntimeId !== null) record.runtimeId = traceRuntimeId;
		if (traceEpoch !== null) record.epoch = traceEpoch;
		if (traceActorId !== null) record.actorId = traceActorId;
		for (const [key, value] of Object.entries(fields)) {
			if (value !== undefined && value !== null) record[key] = value;
		}
		const line = `${JSON.stringify(record)}\n`;
		if (traceState.bytes + line.length > TRACE_MAX_BYTES) {
			traceStop();
			return;
		}
		writeSync(traceState.fd, line);
		traceState.records += 1;
		traceState.bytes += line.length;
	} catch {
		traceStop(); // a tracing failure never affects ownership/delivery
	}
};

/** Static failure ENUM for traces — never a dynamic error message. */
const traceFailureClass = (err) => {
	if (err?.identityMismatch) return "identity_mismatch";
	if (err instanceof GateError) return "gate_refusal";
	if (err?.uncertain) return "transport_uncertain";
	if (err?.httpStatus === 401 || err?.httpStatus === 403) return "auth_refused";
	if (err?.httpStatus === 404 || err?.httpStatus === 410) return "ownership_gone";
	if (err?.httpStatus === 409) return "conflict";
	if (err?.httpStatus) return "http_refused";
	return "connection_failed";
};

const TRACE_ROUTES = new Map([
	[WHOAMI_PATH, "whoami"],
	[LEASE_STATUS_PATH, "lease_status"],
	[LEASE_CLAIM_PATH, "lease_claim"],
	[LEASE_RENEW_PATH, "lease_renew"],
	[ACK_PATH, "ack"],
]);

/** A static identity-prerequisite refusal — no dynamic value is ever echoed. */
const identityRefusal = (reason) => {
	const failure = new Error(
		`identity prerequisite FAILED: ${reason} — refusing to infer or mint an identity`,
	);
	failure.identityMismatch = true;
	return failure;
};

/**
 * Load and validate the SSE configuration. SSE is the DEFAULT; an
 * explicit AUTONOMY_SSE_MODE=0 opts out (legacy long-poll). Returns a
 * config object when everything required (trusted origin, credentials)
 * is present, or {invalid: [static reasons]} — a VISIBLE prerequisite
 * failure, never a silent fallback to legacy consumption. Identity,
 * scope and renewal are resolved at runtime, not here.
 */
const loadSseConfig = (env) => {
	if (env.AUTONOMY_SSE_MODE === "0") return null;
	const reasons = [];
	let origin = null;
	try {
		// REQUIRED for SSE — the trusted base/auth boundary is explicit; the
		// implicit localhost default belongs to the legacy long-poll only.
		origin = parseTrustedOrigin(env.AUTONOMY_BASE ?? "");
	} catch (err) {
		reasons.push(err instanceof ConfigError ? err.message : "trusted base origin invalid");
	}
	// Optional pin only: the authoritative ActorId comes from /whoami.
	const expectedActorId =
		typeof env.AUTONOMY_SSE_EXPECTED_ACTOR_ID === "string"
			? env.AUTONOMY_SSE_EXPECTED_ACTOR_ID.trim()
			: "";
	// Scope defaults to the canonical trusted origin — a consistency
	// namespace for receipt metadata, NOT routing/authorization or a
	// server-issued store id. The explicit override remains for isolated
	// tests / unusual store resets.
	const scopeOverride = typeof env.AUTONOMY_SSE_SCOPE === "string" ? env.AUTONOMY_SSE_SCOPE.trim() : "";
	const scope = scopeOverride || origin;
	// Renewal defaults from the server's remaining lease budget; an
	// explicit positive interval override replaces that derivation.
	let renewMs = null;
	const renewRaw = env.AUTONOMY_SSE_RENEW_INTERVAL_MS;
	if (renewRaw !== undefined && renewRaw !== "") {
		const renewParsed = Number(renewRaw ?? Number.NaN);
		if (!Number.isSafeInteger(renewParsed) || renewParsed <= 0 || renewParsed > 2 ** 31 - 1) {
			reasons.push("the lease renewal interval override must be a positive integer ms");
		} else {
			renewMs = renewParsed;
		}
	}
	const token = typeof env.AUTONOMY_TOKEN === "string" ? env.AUTONOMY_TOKEN : "";
	const cookieFilePath =
		typeof env.AUTONOMY_SESSION_COOKIE_FILE === "string" ? env.AUTONOMY_SESSION_COOKIE_FILE : "";
	let cookie = "";
	if (cookieFilePath) {
		try {
			// Read ONCE into process memory; never logged, never sent anywhere
			// but the configured origin's Cookie header.
			cookie = readFileSync(cookieFilePath, "utf8").trim();
		} catch {
			reasons.push("the configured session-cookie file is unreadable");
		}
	} else if (!token) {
		reasons.push("explicit credentials are required (bearer token or session-cookie file)");
	}
	if (reasons.length > 0) return { invalid: reasons };
	return { origin, expectedActorId, scope, renewMs, token, cookie };
};

/**
 * The SSE main loop. Identity prerequisite → bounded ownership
 * acquisition → one bounded stream connection; any refusal/EOF is a
 * static-class visible failure with bounded reconnect backoff under
 * VALID ownership — never legacy fallback, never takeover.
 */
const sseMain = async (config) => {
	let lease = null; // {runtimeId, epoch, grantSecret, sequence, renewDelayMs} — process memory only
	let identity = null; // {actorId, actor} — FROZEN for the worker lifetime once validated
	let renewalTimer = null;
	let consecutiveFailures = 0;
	const reconnectBackoff = clampNumber(
		Number(process.env.AUTONOMY_SSE_RECONNECT_BACKOFF_MS ?? 5_000) || 5_000,
		50,
		60_000,
	);

	const stopRenewal = () => {
		if (renewalTimer) {
			clearTimeout(renewalTimer);
			renewalTimer = null;
		}
	};

	// The ONE active stream controller, aborted promptly whenever ownership
	// is dropped so a connection never keeps reading under a dead proof.
	let streamController = null;

	const dropLease = (reason) => {
		traceEvent("dropLease", "lease_dropped", { reason });
		// Stop using ownership IMMEDIATELY: no further proof use, no
		// sequence advancement, renewal stopped — and the active stream is
		// aborted so it cannot keep consuming under the dead proof.
		lease = null;
		stopRenewal();
		if (streamController) {
			streamController.ownershipDropped = true;
			streamController.abort();
		}
	};

	const scheduleRenewal = () => {
		stopRenewal();
		if (!lease) return;
		// A non-positive/unknown delay never schedules: renewal must never
		// become a zero-delay busy loop.
		if (!Number.isSafeInteger(lease.renewDelayMs) || lease.renewDelayMs <= 0) {
			traceEvent("scheduleRenewal", "renew_timer_refused", { scheduledDelayMs: lease.renewDelayMs });
			return;
		}
		// SERIALIZED renewal: the next timer is armed only AFTER the current
		// renewal completes (renewLease re-arms from ITS validated response
		// via the trailing scheduleRenewal below), so two renewals can never
		// overlap or double-handle the same next sequence.
		const scheduledSequence = lease.sequence + 1;
		const scheduledDelayMs = lease.renewDelayMs;
		const scheduledAt = Date.now();
		renewalTimer = setTimeout(async () => {
			renewalTimer = null;
			// timer-scheduled vs fired (with lateness) keeps server-side
			// queueing/waiting distinguishable from local timer delay.
			traceEvent("renewLease", "renew_timer_fired", {
				sequence: scheduledSequence,
				scheduledDelayMs,
				fireLatenessMs: Date.now() - (scheduledAt + scheduledDelayMs),
			});
			try {
				await renewLease();
			} catch {
				// renewLease handles its own failures (including dropping the
				// lease); an unexpected throw must not break the chain.
			}
			scheduleRenewal(); // re-arms ONLY while the lease is still held
		}, scheduledDelayMs);
		traceEvent("scheduleRenewal", "renew_timer_scheduled", {
			sequence: scheduledSequence,
			scheduledDelayMs,
		});
		renewalTimer.unref?.();
	};

	/**
	 * Aim to renew after one third of the remaining budget. The positive
	 * floor avoids busy loops; budgets at or below that floor can expire
	 * before renewal and must recover through normal lease acquisition.
	 * An explicit interval override replaces this derivation.
	 */
	const renewalDelayFor = (deadlineRemainingMs) => {
		if (config.renewMs !== null) return config.renewMs;
		if (!isSafeNonNegativeInteger(deadlineRemainingMs)) return null;
		const third = Math.floor(deadlineRemainingMs / 3);
		return clampNumber(third > 0 ? third : RENEW_MIN_DELAY_MS, RENEW_MIN_DELAY_MS, RENEW_MAX_DELAY_MS);
	};

	const identityHeaders = () => {
		// The VALIDATED handle (never a fabricated one) plus the credential.
		const headers = { "X-Auth-User": identity.actor, "content-type": "application/json" };
		if (config.token) headers.Authorization = `Bearer ${config.token}`;
		if (config.cookie) headers.Cookie = config.cookie;
		return headers;
	};

	const credentialHeaders = () => {
		// The INITIAL whoami relies on the actual credential alone — never
		// a fabricated actor header.
		const headers = { "content-type": "application/json" };
		if (config.token) headers.Authorization = `Bearer ${config.token}`;
		if (config.cookie) headers.Cookie = config.cookie;
		return headers;
	};

	/**
	 * One gated POST: bounded timeout, redirect REFUSED (credentials never
	 * travel elsewhere), JSON.parse, then the exact DTO gate BEFORE any
	 * effect. 4xx/5xx throw a static class carrying the public status only —
	 * the raw body is never echoed or stored.
	 */
	const gatedPost = async (urlPath, body, validate) => {
		const route = TRACE_ROUTES.get(urlPath) ?? "other";
		traceEvent("gatedPost", "fetch_start", { route });
		let response;
		try {
			response = await fetch(`${config.origin}${urlPath}`, {
				method: "POST",
				headers: identityHeaders(),
				body: JSON.stringify(body),
				redirect: "error",
				signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			});
		} catch (err) {
			traceEvent("gatedPost", "failure", { route, failureClass: "transport_uncertain" });
			const uncertain = new Error(`transport uncertainty on ${urlPath}`);
			uncertain.uncertain = true;
			throw uncertain;
		}
		traceEvent("gatedPost", "response_headers", { route, httpStatus: response.status });
		if (!response.ok) {
			traceEvent("gatedPost", "failure", { route, httpStatus: response.status, failureClass: "http_refused" });
			const refused = new Error(`HTTP ${response.status} refused on ${urlPath} (static class)`);
			refused.httpStatus = response.status;
			throw refused;
		}
		let parsed;
		try {
			parsed = await response.json();
		} catch {
			traceEvent("gatedPost", "failure", { route, failureClass: "gate_refusal" });
			throw new GateError(urlPath, "$", "response was not parseable JSON", "non-JSON");
		}
		let validated;
		try {
			validated = validate(parsed);
		} catch (err) {
			traceEvent("gatedPost", "failure", { route, failureClass: "gate_refusal" });
			throw err;
		}
		traceEvent("gatedPost", "validated_outcome", { route, outcome: validated.outcome });
		return validated;
	};

	/**
	 * Authoritative identity: GET /whoami carried by the ACTUAL credential
	 * only. The ActorId and the display/receipt handle are derived from
	 * the validated response; a missing/null/malformed identity refuses —
	 * never an invitation to infer or mint an actor. The optional explicit
	 * pin must match when configured.
	 */
	const resolveIdentity = async () => {
		let response;
		try {
			response = await fetch(`${config.origin}${WHOAMI_PATH}`, {
				headers: credentialHeaders(),
				redirect: "error",
				signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			});
		} catch {
			const uncertain = new Error("transport uncertainty on the identity prerequisite");
			uncertain.uncertain = true;
			throw uncertain;
		}
		if (!response.ok) {
			const refused = new Error(`identity prerequisite refused (HTTP ${response.status}, static class)`);
			refused.httpStatus = response.status;
			throw refused;
		}
		const whoami = validateWhoami(await response.json());
		// ActorId boundary: the registry-issued UUID shape (any variant),
		// the optional pin, and a USABLE display handle — all checked here;
		// static refusals never reflect the offending values.
		if (!isUuidShape(whoami.actor_id)) {
			throw identityRefusal("the authenticated response carries no well-formed ActorId (UUID shape)");
		}
		if (config.expectedActorId && whoami.actor_id !== config.expectedActorId) {
			throw identityRefusal("the resolved actor_id does not match the configured expected actor");
		}
		const actor = typeof whoami.user === "string" ? whoami.user.trim() : "";
		if (!actor) {
			throw identityRefusal("the authenticated response carries no usable display handle");
		}
		return { actorId: whoami.actor_id, actor };
	};

	/**
	 * Re-verify the FROZEN identity on each reconnect: /whoami (now
	 * carried by the validated identity) must still return the same
	 * ActorId. A null or changed id refuses — the identity is never
	 * re-derived mid-lifetime.
	 */
	const verifyIdentity = async () => {
		let response;
		try {
			response = await fetch(`${config.origin}${WHOAMI_PATH}`, {
				headers: identityHeaders(),
				redirect: "error",
				signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			});
		} catch {
			const uncertain = new Error("transport uncertainty on the identity prerequisite");
			uncertain.uncertain = true;
			throw uncertain;
		}
		if (!response.ok) {
			const refused = new Error(`identity prerequisite refused (HTTP ${response.status}, static class)`);
			refused.httpStatus = response.status;
			throw refused;
		}
		const whoami = validateWhoami(await response.json());
		if (whoami.actor_id !== identity.actorId) {
			throw identityRefusal("the resolved actor_id no longer matches the frozen worker identity");
		}
	};

	/**
	 * Bounded ownership acquisition: status → eligible CAS claim
	 * (takeover:false, expected_epoch observed). A live conflict WAITS and
	 * rechecks — NEVER takeover. An uncertain claim response retries the
	 * PRESERVED IDENTICAL request DIRECTLY, without an intervening status
	 * check: a status poll after a lost claim response may now show OUR OWN
	 * just-created owner, and waiting on it would block recovery of our own
	 * grant forever (the identical retry is what lets the server answer
	 * `recovered` with the same grant for the same recovery secret).
	 */
	const ensureOwnership = async () => {
		if (lease) return lease;
		// One adoption path for both grant outcomes (recovered identical retry
		// and fresh claim) so tracing/correlation can never drift apart.
		const adoptGrant = (grant) => {
			lease = {
				runtimeId: grant.runtime_id,
				epoch: grant.epoch,
				grantSecret: grant.grant_secret,
				sequence: 0,
				renewDelayMs: renewalDelayFor(grant.deadline_remaining_ms),
			};
			// PUBLIC correlation only — never the grant secret.
			traceRuntimeId = grant.runtime_id;
			traceEpoch = grant.epoch;
			traceActorId = identity?.actorId ?? traceActorId;
			traceEvent("ensureOwnership", "ownership_granted", {
				runtimeId: grant.runtime_id,
				epoch: grant.epoch,
				budgetRemainingMs: grant.deadline_remaining_ms,
				outcome: grant.outcome,
			});
			scheduleRenewal();
			return lease;
		};
		let pendingClaimRequest = null;
		for (let attempt = 1; attempt <= SSE_OWNERSHIP_ATTEMPTS; attempt++) {
			if (pendingClaimRequest) {
				// Lost response recovery: retry the IDENTICAL claim request —
				// never a status recheck in between.
				try {
					const grant = await gatedPost(LEASE_CLAIM_PATH, pendingClaimRequest, (parsed) =>
						validateClaimResponse(parsed, pendingClaimRequest.runtime_id),
					);
					pendingClaimRequest = null;
					return adoptGrant(grant);
				} catch (err) {
					if (err instanceof GateError) {
						// No authority use from unsafe data.
						pendingClaimRequest = null;
						throw err;
					}
					if (err.uncertain) continue; // STILL uncertain: same identical retry
					pendingClaimRequest = null;
					// A definitive refusal (409/4xx) ends the recovery attempt;
					// fall through to a fresh status check on the next iteration.
					if (attempt >= SSE_OWNERSHIP_ATTEMPTS) throw err;
					continue;
				}
			}
			const status = await gatedPost(LEASE_STATUS_PATH, {}, validateStatusResponse);
			if (status.owner) {
				// Another live runtime owns the lease: wait it out, never take
				// over. (Our own just-created owner can only appear here when no
				// claim attempt is pending — recovery above handles that case.)
				await sleep(reconnectBackoff);
				continue;
			}
			pendingClaimRequest = {
				runtime_id: `notifications-pi-${crypto.randomUUID()}`,
				recovery_secret: crypto.randomBytes(32).toString("hex"),
				expected_epoch: status.epoch,
				takeover: false,
			};
			try {
				const grant = await gatedPost(LEASE_CLAIM_PATH, pendingClaimRequest, (parsed) =>
					validateClaimResponse(parsed, pendingClaimRequest.runtime_id),
				);
				pendingClaimRequest = null;
				return adoptGrant(grant);
			} catch (err) {
				if (err instanceof GateError) {
					// No authority use from unsafe data.
					pendingClaimRequest = null;
					throw err;
				}
				if (err.httpStatus === 409) {
					// Stale epoch / live conflict: the preserved request is stale.
					pendingClaimRequest = null;
					continue;
				}
				if (err.uncertain) continue; // preserved request retries identically above
				pendingClaimRequest = null;
				throw err;
			}
		}
		pendingClaimRequest = null;
		throw new Error("ownership acquisition attempts exhausted (static class)");
	};

	/**
	 * Renewal: EXACT next sequence; an uncertain response retries the SAME
	 * sequence; the sequence advances ONLY on validated success. Lost or
	 * unconfirmable ownership (410/404/409, gate refusal, exhausted
	 * uncertainty) stops all further use of the proof and returns to honest
	 * re-acquisition — never takeover.
	 */
	const renewLease = async () => {
		const current = lease;
		if (!current) return;
		const next = current.sequence + 1;
		if (!Number.isSafeInteger(next) || next < 0) {
			// Fail honestly: silently expiring ownership beats a wrapped sequence.
			dropLease("sequence_overflow");
			return;
		}
		const body = {
			runtime_id: current.runtimeId,
			epoch: current.epoch,
			grant_secret: current.grantSecret,
			sequence: next,
		};
		for (let attempt = 1; attempt <= SSE_UNCERTAIN_RETRIES; attempt++) {
			try {
				const renewed = await gatedPost(LEASE_RENEW_PATH, body, validateRenewResponse);
				if (lease === current) {
					current.sequence = next; // validated success only
					// Re-arm from the server's fresh remaining budget.
					current.renewDelayMs = renewalDelayFor(renewed.deadline_remaining_ms);
				}
				traceEvent("renewLease", "renew_result", {
					sequence: next,
					outcome: renewed.outcome,
					budgetRemainingMs: renewed.deadline_remaining_ms,
				});
				return;
			} catch (err) {
				if (err instanceof GateError) {
					dropLease("gate_refusal");
					return;
				}
				if (err.httpStatus === 410 || err.httpStatus === 404 || err.httpStatus === 409) {
					traceEvent("renewLease", "renew_failure", {
						sequence: next,
						failureClass: traceFailureClass(err),
						httpStatus: err.httpStatus,
					});
					dropLease("ownership_gone");
					return;
				}
				if (err.uncertain && attempt < SSE_UNCERTAIN_RETRIES) {
					await sleep(SSE_UNCERTAIN_BACKOFF_MS);
					continue; // SAME sequence on the uncertain retry
				}
				// Unconfirmable: stop using the proof and re-acquire honestly.
				traceEvent("renewLease", "renew_failure", {
					sequence: next,
					failureClass: traceFailureClass(err),
					httpStatus: err?.httpStatus,
				});
				dropLease("renew_unconfirmable");
				return;
			}
		}
	};

	// Failure suppression is isolated BY DOMAIN (stream consumption vs disk-
	// receipt acknowledgement): one subsystem's changed class must never
	// re-arm another subsystem's identical warning. Stream-domain classes
	// re-arm only on a REAL recovery (clean EOF); the ack domain re-arms
	// when a reconciliation pass settles without an uncertain outage.
	const lastFailureClass = { stream: null, ack: null };
	const emitOncePerClass = (domain, failureClass) => {
		if (failureClass === lastFailureClass[domain]) return;
		lastFailureClass[domain] = failureClass;
		emit("wake", `[notifications.sse] ${failureClass}`);
	};

	const staticFailureClass = (err) => {
		if (err?.identityMismatch) return "identity prerequisite failed — SSE consumption stays disabled";
		if (err instanceof GateError) return `response failed the validation gate (${err.endpoint}) — no effect was taken`;
		if (err?.uncertain) return "transport uncertainty";
		if (err?.httpStatus === 401 || err?.httpStatus === 403) return `identity/authorization refused (HTTP ${err.httpStatus})`;
		if (err?.httpStatus === 404 || err?.httpStatus === 410) return `ownership is gone (HTTP ${err.httpStatus})`;
		if (err?.httpStatus) return `request refused (HTTP ${err.httpStatus})`;
		return "stream connection failed";
	};

	// Serialize receipt reconciliation so two reconciles never double-ack.
	let ackQueue = Promise.resolve();

	/**
	 * Acknowledge ONLY qualifying disk-recorded custom-message bytes read
	 * against the bound session, explicit scope and recipient. Send returns,
	 * socket delivery and in-memory state never authorize an ack. Returns
	 * "uncertain" when the transport outage exhausted a receipt's bounded
	 * identical retries — the caller stops the WHOLE batch against the same
	 * outage instead of walking every later receipt into the same failure.
	 */
	const reconcileNow = async () => {
		if (!sseSessionFile || !sseSessionId) return;
		if (!identity) return; // the frozen identity is not resolved yet; a later reconcile qualifies
		const read = readQualifyingReceipts(
				sseSessionFile,
				sseSessionId,
				config.scope,
				identity.actor,
				identity.actorId,
			);
		if (!read.ok) {
			emitOncePerClass("ack", `disk receipts unreadable (${read.reason}) — nothing acknowledged`);
			// Liveness: an unreadable disk is not an outage the background
			// retry can fix — settle the outage state so external reconcile
			// events flow again (the warning class itself stays armed).
			ackOutage = false;
			ackRetryAttempt = 0;
			return;
		}
		for (const receipt of read.receipts) {
			if (receipt.refused) {
				// Unknown/foreign/digest refusals retire nothing and are never
				// reported as success.
				emit("ack", { presentationId: receipt.presentationId, outcome: "refused" });
				continue;
			}
			const outcome = await acknowledgeReceipt(receipt, 1);
			if (outcome === "uncertain") {
				// One uncertain exhaustion is evidence of a transport outage:
				// stop THIS batch immediately (later receipts would only repeat
				// the identical failure) and let the background backoff own the
				// next pass.
				ackOutage = true;
				scheduleAckRetry();
				return;
			}
		}
		// A settled pass (no uncertain exhaustion) is real acknowledgement
		// recovery: re-arm the ack warning for a future NEW outage and reset
		// the backoff ladder.
		ackOutage = false;
		ackRetryAttempt = 0;
		lastFailureClass.ack = null;
	};

	const acknowledgeReceipt = async (receipt, attempt) => {
		try {
			const response = await gatedPost(
				ACK_PATH,
				{ presentation_id: receipt.presentationId, expected_digest: receipt.digest },
				validateAckResponse,
			);
			emit("ack", { presentationId: receipt.presentationId, outcome: response.outcome });
			return "acknowledged";
		} catch (err) {
			if (err instanceof GateError || err.httpStatus === 403 || err.httpStatus === 404 || err.httpStatus === 409) {
				emit("ack", { presentationId: receipt.presentationId, outcome: "refused" });
				return "refused";
			}
			// Uncertain: bounded retry of the EXACT qualifying receipt after
			// re-reading the disk bytes — never a resend of the body.
			if (err.uncertain && attempt < SSE_UNCERTAIN_RETRIES) {
				await sleep(SSE_UNCERTAIN_BACKOFF_MS * attempt);
				const read = readQualifyingReceipts(
				sseSessionFile,
				sseSessionId,
				config.scope,
				identity.actor,
				identity.actorId,
			);
				const stillThere =
					read.ok &&
					read.receipts.some(
						(r) => !r.refused && r.presentationId === receipt.presentationId && r.digest === receipt.digest,
					);
				if (!stillThere) {
					emitOncePerClass("ack", "ack retry aborted: qualifying disk bytes no longer present");
					return "refused";
				}
				return acknowledgeReceipt(receipt, attempt + 1);
			}
			// ONE static, per-outage warning — never a per-receipt id (a whole
			// batch of receipts must not become a warning each). The batch has
			// already stopped; the queue retries in the background below.
			emitOncePerClass("ack", "ack retries exhausted (uncertain) — the batch stops and retries in the background");
			return "uncertain";
		}
	};

	// ── ack-outage background retry: ONE timer, bounded exponential backoff ──
	// After an uncertain exhaustion the queue retries the reconciliation in
	// the background; agent_settled/replay events arriving during that
	// backoff add NOTHING (no duplicate passes, no extra requests) because
	// the scheduled pass is the only next pass. Repeated exhaustions climb
	// the bounded ladder; a settled pass resets it. Triggers arriving while
	// a pass is IN FLIGHT coalesce into at most one trailing pass (a full
	// pass re-reads all disk receipts, so coalescing can never lose a
	// wakeup) — repeated settles against a black-holing edge must never
	// chain one hung pass after another.
	let ackOutage = false;
	let ackRetryAttempt = 0;
	let ackRetryTimer = null;
	let ackPassRunning = false;
	let ackPassDirty = false;

	const enqueueAckPass = () => {
		if (ackPassRunning) {
			ackPassDirty = true;
			return;
		}
		ackPassRunning = true;
		ackPassDirty = false;
		ackQueue = ackQueue
			.then(reconcileNow)
			.catch(() => {})
			.then(() => {
				ackPassRunning = false;
				if (ackPassDirty && !ackOutage) enqueueAckPass();
			});
	};

	queueReconcile = () => {
		if (ackOutage) return; // the scheduled background pass owns the next attempt
		enqueueAckPass();
	};

	const scheduleAckRetry = () => {
		if (ackRetryTimer) return; // single timer: repeated exhaustion never stacks passes
		ackRetryAttempt = Math.min(ackRetryAttempt + 1, 8);
		const delay = clampNumber(reconnectBackoff * 2 ** (ackRetryAttempt - 1), 50, 60_000);
		traceEvent("reconcile", "ack_retry_scheduled", { scheduledDelayMs: delay });
		ackRetryTimer = setTimeout(() => {
			ackRetryTimer = null;
			enqueueAckPass();
		}, delay);
		ackRetryTimer.unref?.();
	};

	/** One validated presentation event → supervisor delivery request. */
	const handlePresentationEvent = (data) => {
		let parsed;
		try {
			parsed = JSON.parse(data);
		} catch {
			emitOncePerClass("stream", "malformed presentation frame refused (non-JSON) — no delivery");
			return;
		}
		let offer;
		try {
			// Gate BEFORE any effect: framing/size are already bounded by the
			// parser; safe integers, typed-optional part refs, body, render
			// version and digest shape are checked here, then the body hash.
			offer = validatePresentationOffer(parsed);
		} catch (err) {
			emitOncePerClass(
				"stream",
				`presentation offer refused by the validation gate (${err?.field ?? "unknown field"}) — no delivery`,
			);
			return;
		}
		if (offer.render_version !== SUPPORTED_RENDER_VERSION) {
			emitOncePerClass("stream", "unsupported render version refused — no delivery");
			return;
		}
		if (!verifyOfferDigest(offer)) {
			emitOncePerClass("stream", "presentation body hash mismatch refused — no delivery");
			return;
		}
		// Recorded-receipt replay guard: a fully qualifying disk receipt with
		// the COMPLETE offer tuple (presentation id, digest, both part refs)
		// means this exact offer was already presented — a delayed/replayed
		// same frame is not re-delivered; serialized reconciliation acks it
		// instead. Unqualified or differing evidence, or an unreadable/absent
		// session binding, suppresses nothing (fail-open, as before).
		if (sseSessionFile && sseSessionId && identity) {
			const read = readQualifyingReceipts(
				sseSessionFile,
				sseSessionId,
				config.scope,
				identity.actor,
				identity.actorId,
			);
			if (read.ok) {
				const recorded = read.receipts.find(
					(r) =>
						!r.refused &&
						r.presentationId === offer.presentation_id &&
						r.digest === offer.digest &&
						r.contentOfferId === offer.content_offer_id &&
						r.summaryOfferId === offer.summary_offer_id,
				);
				if (recorded) {
					queueReconcile();
					return;
				}
				// Same id with differing evidence never matches (ids are
				// immutable) — it falls through and delivers as any other offer.
			}
		}
		emit("deliver", {
			customType: CUSTOM_TYPE,
			// The EXACT server-rendered body — never rerendered, never reconstructed.
			content: offer.body,
			display: true,
			details: {
				schema: METADATA_SCHEMA_VERSION,
				scope: config.scope,
				recipient: identity.actor,
				// The VALIDATED STABLE registry actor id resolved from
				// /whoami (checked against the optional pin when set), not
				// only the mutable handle. Receipt qualification binds BOTH.
				actorId: identity.actorId,
				renderVersion: SUPPORTED_RENDER_VERSION,
				digest: offer.digest,
				presentationId: offer.presentation_id,
				contentOfferId: offer.content_offer_id,
				summaryOfferId: offer.summary_offer_id,
			},
		});
	};

	/**
	 * One bounded stream connection under the CURRENT proof. The server
	 * validates ownership before headers; presentation events carry the full
	 * offer DTO; stream_error is a static class followed by stream end.
	 * Last-Event-ID is never sent. The stream's EXIT is classified and
	 * returned so the main loop can distinguish REAL recovery (a clean EOF
	 * with no failure class) from error exits (stream_error, framing
	 * refusal, ownership-drop abort) — an error exit must NEVER clear the
	 * failure state as if the stream had recovered. Transport uncertainty
	 * still throws into the loop's failure path.
	 *
	 * The stream is opened through plain native fetch — the SAME pooled
	 * path the control requests (gatedPost/whoami) use — so a held stream
	 * and lease renewals share one negotiated connection (native H2 when
	 * the server advertises it). Tested on Node 26.8.1 with its bundled
	 * Undici 8.10 (upstream H2-multiplexing fix landed in Undici 8.8):
	 * renewals flow underneath the held stream, so no dedicated HTTP/1.1
	 * side-channel is needed — and there is NO version-detection or
	 * fallback framework. The fetch call keeps exactly the guards this
	 * call site always had: redirects refused (credentials never travel
	 * elsewhere), the AbortSignal honored before AND after headers, and
	 * a rejection — never a clean end — on abort, so the ownership-drop
	 * classification below keeps working.
	 */
	const connectStream = async () => {
		const current = lease;
		if (!current) throw new Error("connectStream requires current ownership");
		const controller = new AbortController();
		streamController = controller;
		const lifetime = setTimeout(() => controller.abort(), SSE_MAX_CONNECTION_MS);
		lifetime.unref?.();
		const openedAt = Date.now();
		let presentationEvents = 0;
		const streamEnd = (outcome) => {
			traceEvent("connectStream", "stream_end", {
				outcome,
				durationMs: Date.now() - openedAt,
				presentationEvents,
			});
		};
		let response;
		try {
			traceEvent("connectStream", "stream_fetch_start", {});
			response = await fetch(`${config.origin}${STREAM_PATH}`, {
				method: "POST",
				headers: identityHeaders(),
				body: JSON.stringify({
					runtime_id: current.runtimeId,
					epoch: current.epoch,
					grant_secret: current.grantSecret,
				}),
				redirect: "error",
				signal: controller.signal,
			});
		} catch {
			clearTimeout(lifetime);
			traceEvent("connectStream", "stream_failure", { failureClass: "transport_uncertain" });
			const uncertain = new Error("transport uncertainty opening the presentation stream");
			uncertain.uncertain = true;
			throw uncertain;
		}
		traceEvent("connectStream", "stream_headers", { httpStatus: response.status });
		if (!response.ok) {
			// Release the un-consumed H2 stream slot (no-op if already gone).
			response.body?.cancel?.()?.catch?.(() => {});
			clearTimeout(lifetime);
			traceEvent("connectStream", "stream_failure", {
				failureClass: "http_refused",
				httpStatus: response.status,
			});
			const refused = new Error(`presentation stream refused (HTTP ${response.status}, static class)`);
			refused.httpStatus = response.status;
			throw refused;
		}
		if (!response.body) {
			clearTimeout(lifetime);
			traceEvent("connectStream", "stream_failure", { failureClass: "http_refused" });
			throw new Error("presentation stream returned no body (static class)");
		}
		traceEvent("connectStream", "stream_open", {});
		const parser = createSseParser({ maxEventBytes: SSE_MAX_EVENT_BYTES, maxLineBytes: SSE_MAX_LINE_BYTES });
		const decoder = new TextDecoder();
		try {
			for await (const chunk of response.body) {
				const events = parser.feed(decoder.decode(chunk, { stream: true }));
				for (const event of events) {
					if (event.event === "presentation") {
						presentationEvents += 1;
						if (presentationEvents === 1) traceEvent("connectStream", "first_presentation", {});
						handlePresentationEvent(event.data);
					} else if (event.event === "stream_error") {
						// Static failure class, stream ends. The reconnect path
						// re-verifies ownership honestly (status → claim, never
						// takeover); if the proof is dead it is dropped there.
						// This is an ERROR EXIT: the loop must NOT treat it as
						// recovery, so the identical class stays quiet instead of
						// waking the model once per reconnect.
						emitOncePerClass("stream", "stream_error received — the stream is ending");
						streamEnd("stream_error_event");
						return "stream_error";
					}
					// Unknown event types are ignored (bounded, no effect).
				}
			}
			const tail = parser.end();
			if (tail.refused) {
				emitOncePerClass("stream", "stream ended mid-frame — the partial event is refused");
				streamEnd("frame_refused");
				return "frame_refused";
			}
			// REAL recovery: a stream that reached a clean EOF with no failure
			// class — the only stream exit that re-arms the loop's
			// changed-failure rule.
			streamEnd("clean_eof");
			return "clean_end";
		} catch (err) {
			if (err instanceof SseFrameError) {
				emitOncePerClass("stream", "oversized SSE frame refused — reconnecting");
				streamEnd("frame_refused");
				return "frame_refused";
			} else if (controller.ownershipDropped) {
				// Ownership was dropped while this stream was active: the abort
				// is LOCAL and deliberate, not transport uncertainty.
				emitOncePerClass("stream", "ownership dropped — the active stream was aborted (static class)");
				streamEnd("ownership_dropped");
				return "ownership_dropped";
			} else {
				traceEvent("connectStream", "stream_failure", { failureClass: "transport_uncertain" });
				const uncertain = new Error("transport uncertainty reading the presentation stream");
				uncertain.uncertain = true;
				throw uncertain;
			}
		} finally {
			if (streamController === controller) streamController = null;
			clearTimeout(lifetime);
		}
	};

	// ── the loop ──
	while (running) {
		try {
			if (!identity) {
				// First resolution — the credential alone speaks; the result is
				// frozen for the worker lifetime.
				identity = await resolveIdentity();
				traceActorId = identity.actorId;
				traceEvent("sseMain", "identity_resolved", {});
			} else {
				// Re-verify the frozen identity before each reconnect.
				await verifyIdentity();
			}
			await ensureOwnership();
			const streamOutcome = await connectStream();
			if (streamOutcome === "clean_end") {
				// REAL recovery ONLY: a stream that ended with a clean EOF and
				// no failure class re-arms the STREAM domain's changed-failure
				// rule. An error exit (stream_error, framing refusal,
				// ownership-drop abort) must never masquerade as successful
				// recovery — repeated identical errors stay quiet instead of
				// waking the model once per reconnect, while a CHANGED failure
				// still wakes. The acknowledgement domain re-arms on its own
				// recovery (a settled reconciliation pass) — never here.
				lastFailureClass.stream = null;
				consecutiveFailures = 0;
				traceEvent("sseMain", "loop_recovery", {});
			}
			await sleep(reconnectBackoff);
		} catch (err) {
			traceEvent("sseMain", "loop_failure", {
				failureClass: traceFailureClass(err),
				httpStatus: err?.httpStatus,
			});
			emitOncePerClass("stream", `${staticFailureClass(err)}; reconnecting with bounded backoff — no legacy fallback`);
			if (err instanceof GateError) dropLease("gate_refusal"); // no further authority use from that response
			if (err?.httpStatus === 404 || err?.httpStatus === 410) dropLease("ownership_gone"); // stop using lost ownership
			// Exponential, capped reconnect backoff: bounded rate, honest
			// steady-state retry, never legacy consumption.
			consecutiveFailures = Math.min(consecutiveFailures + 1, 8);
			await sleep(clampNumber(reconnectBackoff * 2 ** (consecutiveFailures - 1), 50, 60_000));
		}
	}
	stopRenewal();
};

// ── mode dispatch: SSE is the DEFAULT; the legacy long-poll requires an ──
// explicit AUTONOMY_SSE_MODE=0 opt-out. Invalid SSE configuration is
// heartbeat-only with a visible prerequisite failure — never a silent
// legacy fallback.
const sseConfig = loadSseConfig(process.env);
if (sseConfig && sseConfig.invalid) {
	emit(
		"wake",
		`[notifications.sse] PREREQUISITE FAILURE — SSE mode stays disabled; ${sseConfig.invalid.join("; ")}`,
	);
	// Heartbeat machinery above stays armed; no poll loop, no SSE loop.
} else if (sseConfig) {
	sseMain(sseConfig);
} else {
	poll();
}
