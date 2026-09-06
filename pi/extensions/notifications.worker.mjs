#!/usr/bin/env node
/**
 * notifications.worker.mjs — the autonomy-daemon wake bridge (worker process).
 *
 * Spawned by notifications.ts (the supervisor shim, loaded as a pi extension).
 * Read fresh on each spawn; use /reload or restart/resume after updates.
 * This adapter currently:
 *
 *   - long-polls the daemon's notification endpoint (20s server hold)
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
 * AUTONOMY_ACTOR (default "iris" — rhea sets "rhea"; used only for the
 * auth header), AUTONOMY_TOKEN (optional bearer for proxied daemons),
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
import { readFileSync } from "node:fs";
import {
	ACK_PATH,
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
// ── opt-in SSE presentation mode (autonomy/t:276 initial guest slice) ──
// ═════════════════════════════════════════════════════════════════
//
// Disabled by default. With AUTONOMY_SSE_MODE=1 the worker consumes
// POST /notifications/presentation/stream (fetch streaming — NEVER
// EventSource, no readiness-only redesign, no prepare polling pump)
// instead of the legacy long-poll. There is NO fallback to legacy
// consumption: missing config, auth refusal or transport failure is a
// visible static-class prerequisite failure, and the goal-heartbeat
// machinery above keeps working unchanged. Everything HTTP/lease/
// reconnect lives HERE, in the worker, independently of model busy time.
//
// Explicit operator configuration (all required — no defaults are
// invented, and SSE mode never defaults the recipient to Iris):
//   AUTONOMY_SSE_MODE                  "1" to opt in
//   AUTONOMY_BASE                      trusted base origin (http(s), no
//                                      path, no embedded credentials)
//   AUTONOMY_ACTOR                     recipient actor handle (identity header)
//   AUTONOMY_SSE_EXPECTED_ACTOR_ID     registry actor uuid that /whoami's
//                                      actor_id MUST equal (null or
//                                      mismatched is a visible
//                                      prerequisite failure)
//   AUTONOMY_SSE_SCOPE                 backend/store scope for receipt
//                                      metadata (never derived from cwd)
//   AUTONOMY_SSE_RENEW_INTERVAL_MS     lease renewal interval (explicit;
//                                      not copied fixture policy)
//   AUTONOMY_TOKEN                     optional bearer token, OR
//   AUTONOMY_SESSION_COOKIE_FILE       path to a private session-cookie file
//   AUTONOMY_SSE_RECONNECT_BACKOFF_MS  optional reconnect backoff base
//                                      (default 5000, clamped 50..60000)
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

const clampNumber = (value, min, max) => Math.min(max, Math.max(min, value));

/**
 * Load and validate the SSE configuration. Returns null when the mode is
 * not opted into (legacy long-poll remains the default), a config object
 * when everything required is present, or {invalid: [static reasons]}
 * when opted in but incomplete — which is a VISIBLE prerequisite failure,
 * never a silent fallback to legacy consumption.
 */
const loadSseConfig = (env) => {
	if (env.AUTONOMY_SSE_MODE !== "1") return null;
	const reasons = [];
	let origin = null;
	try {
		origin = parseTrustedOrigin(env.AUTONOMY_BASE ?? "");
	} catch (err) {
		reasons.push(err instanceof ConfigError ? err.message : "trusted base origin invalid");
	}
	const actor = typeof env.AUTONOMY_ACTOR === "string" ? env.AUTONOMY_ACTOR.trim() : "";
	if (!actor) reasons.push("the recipient actor must be explicitly configured");
	const expectedActorId =
		typeof env.AUTONOMY_SSE_EXPECTED_ACTOR_ID === "string"
			? env.AUTONOMY_SSE_EXPECTED_ACTOR_ID.trim()
			: "";
	if (!expectedActorId) reasons.push("the expected registry actor id must be explicitly configured");
	const scope = typeof env.AUTONOMY_SSE_SCOPE === "string" ? env.AUTONOMY_SSE_SCOPE.trim() : "";
	if (!scope) reasons.push("the backend scope must be explicitly configured");
	const renewMs = Number(env.AUTONOMY_SSE_RENEW_INTERVAL_MS ?? Number.NaN);
	if (!Number.isSafeInteger(renewMs) || renewMs <= 0 || renewMs > 2 ** 31 - 1) {
		reasons.push("the lease renewal interval must be explicitly configured as a positive integer ms");
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
	return { origin, actor, expectedActorId, scope, renewMs, token, cookie };
};

/**
 * The SSE main loop. Identity prerequisite → bounded ownership
 * acquisition → one bounded stream connection; any refusal/EOF is a
 * static-class visible failure with bounded reconnect backoff under
 * VALID ownership — never legacy fallback, never takeover.
 */
const sseMain = async (config) => {
	let lease = null; // {runtimeId, epoch, grantSecret, sequence} — process memory only
	let renewalTimer = null;
	let lastFailureClass = null;
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

	const dropLease = () => {
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
		// SERIALIZED renewal: the next timer is armed only AFTER the current
		// renewal completes, so two renewals can never overlap or double-
		// handle the same next sequence.
		renewalTimer = setTimeout(async () => {
			renewalTimer = null;
			try {
				await renewLease();
			} catch {
				// renewLease handles its own failures (including dropping the
				// lease); an unexpected throw must not break the chain.
			}
			scheduleRenewal();
		}, config.renewMs);
		renewalTimer.unref?.();
	};

	const identityHeaders = () => {
		const headers = { "X-Auth-User": config.actor, "content-type": "application/json" };
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
			const uncertain = new Error(`transport uncertainty on ${urlPath}`);
			uncertain.uncertain = true;
			throw uncertain;
		}
		if (!response.ok) {
			const refused = new Error(`HTTP ${response.status} refused on ${urlPath} (static class)`);
			refused.httpStatus = response.status;
			throw refused;
		}
		let parsed;
		try {
			parsed = await response.json();
		} catch {
			throw new GateError(urlPath, "$", "response was not parseable JSON", "non-JSON");
		}
		return validate(parsed);
	};

	/**
	 * GET /whoami actor_id MUST equal the configured expected actor.
	 * A null or mismatched id is a visible prerequisite failure — never an
	 * invitation to infer or mint an actor.
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
		if (whoami.actor_id === null || whoami.actor_id !== config.expectedActorId) {
			const failure = new Error(
				"identity prerequisite FAILED: the resolved actor_id is null or does not match the " +
					"configured expected actor — refusing to infer or mint an identity",
			);
			failure.identityMismatch = true;
			throw failure;
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
		let pendingClaimRequest = null;
		for (let attempt = 1; attempt <= SSE_OWNERSHIP_ATTEMPTS; attempt++) {
			if (pendingClaimRequest) {
				// Lost response recovery: retry the IDENTICAL claim request —
				// never a status recheck in between.
				try {
					const grant = await gatedPost(LEASE_CLAIM_PATH, pendingClaimRequest, (parsed) =>
						validateClaimResponse(parsed, pendingClaimRequest.runtime_id),
					);
					const recovered = pendingClaimRequest;
					pendingClaimRequest = null;
					lease = {
						runtimeId: grant.runtime_id,
						epoch: grant.epoch,
						grantSecret: grant.grant_secret,
						sequence: 0,
					};
					scheduleRenewal();
					return lease;
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
				lease = {
					runtimeId: grant.runtime_id,
					epoch: grant.epoch,
					grantSecret: grant.grant_secret,
					sequence: 0,
				};
				scheduleRenewal();
				return lease;
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
			dropLease();
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
				await gatedPost(LEASE_RENEW_PATH, body, validateRenewResponse);
				if (lease === current) current.sequence = next; // validated success only
				return;
			} catch (err) {
				if (err instanceof GateError) {
					dropLease();
					return;
				}
				if (err.httpStatus === 410 || err.httpStatus === 404 || err.httpStatus === 409) {
					dropLease();
					return;
				}
				if (err.uncertain && attempt < SSE_UNCERTAIN_RETRIES) {
					await sleep(SSE_UNCERTAIN_BACKOFF_MS);
					continue; // SAME sequence on the uncertain retry
				}
				// Unconfirmable: stop using the proof and re-acquire honestly.
				dropLease();
				return;
			}
		}
	};

	const emitOncePerClass = (failureClass) => {
		if (failureClass === lastFailureClass) return;
		lastFailureClass = failureClass;
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
	queueReconcile = () => {
		ackQueue = ackQueue.then(reconcileNow).catch(() => {});
	};

	/**
	 * Acknowledge ONLY qualifying disk-recorded custom-message bytes read
	 * against the bound session, explicit scope and recipient. Send returns,
	 * socket delivery and in-memory state never authorize an ack.
	 */
	const reconcileNow = async () => {
		if (!sseSessionFile || !sseSessionId) return;
		const read = readQualifyingReceipts(
				sseSessionFile,
				sseSessionId,
				config.scope,
				config.actor,
				config.expectedActorId,
			);
		if (!read.ok) {
			emitOncePerClass(`disk receipts unreadable (${read.reason}) — nothing acknowledged`);
			return;
		}
		for (const receipt of read.receipts) {
			if (receipt.refused) {
				// Unknown/foreign/digest refusals retire nothing and are never
				// reported as success.
				emit("ack", { presentationId: receipt.presentationId, outcome: "refused" });
				continue;
			}
			await acknowledgeReceipt(receipt, 1);
		}
	};

	const acknowledgeReceipt = async (receipt, attempt) => {
		try {
			const response = await gatedPost(
				ACK_PATH,
				{ presentation_id: receipt.presentationId, expected_digest: receipt.digest },
				validateAckResponse,
			);
			emit("ack", { presentationId: receipt.presentationId, outcome: response.outcome });
		} catch (err) {
			if (err instanceof GateError || err.httpStatus === 403 || err.httpStatus === 404 || err.httpStatus === 409) {
				emit("ack", { presentationId: receipt.presentationId, outcome: "refused" });
				return;
			}
			// Uncertain: bounded retry of the EXACT qualifying receipt after
			// re-reading the disk bytes — never a resend of the body.
			if (err.uncertain && attempt < SSE_UNCERTAIN_RETRIES) {
				await sleep(SSE_UNCERTAIN_BACKOFF_MS * attempt);
				const read = readQualifyingReceipts(
				sseSessionFile,
				sseSessionId,
				config.scope,
				config.actor,
				config.expectedActorId,
			);
				const stillThere =
					read.ok &&
					read.receipts.some(
						(r) => !r.refused && r.presentationId === receipt.presentationId && r.digest === receipt.digest,
					);
				if (!stillThere) {
					emitOncePerClass("ack retry aborted: qualifying disk bytes no longer present");
					return;
				}
				return acknowledgeReceipt(receipt, attempt + 1);
			}
			emitOncePerClass(`ack retries exhausted (uncertain) for presentation ${receipt.presentationId}`);
		}
	};

	/** One validated presentation event → supervisor delivery request. */
	const handlePresentationEvent = (data) => {
		let parsed;
		try {
			parsed = JSON.parse(data);
		} catch {
			emitOncePerClass("malformed presentation frame refused (non-JSON) — no delivery");
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
				`presentation offer refused by the validation gate (${err?.field ?? "unknown field"}) — no delivery`,
			);
			return;
		}
		if (offer.render_version !== SUPPORTED_RENDER_VERSION) {
			emitOncePerClass("unsupported render version refused — no delivery");
			return;
		}
		if (!verifyOfferDigest(offer)) {
			emitOncePerClass("presentation body hash mismatch refused — no delivery");
			return;
		}
		emit("deliver", {
			customType: CUSTOM_TYPE,
			// The EXACT server-rendered body — never rerendered, never reconstructed.
			content: offer.body,
			display: true,
			details: {
				schema: METADATA_SCHEMA_VERSION,
				scope: config.scope,
				recipient: config.actor,
				// The VALIDATED STABLE registry actor id (/whoami actor_id was
				// checked against the configured expected value), not only the
				// mutable handle. Receipt qualification binds BOTH.
				actorId: config.expectedActorId,
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
	 * Last-Event-ID is never sent. Any EOF/refusal simply returns — the main
	 * loop reconnects under valid ownership with bounded backoff.
	 */
	const connectStream = async () => {
		const current = lease;
		if (!current) throw new Error("connectStream requires current ownership");
		const controller = new AbortController();
		streamController = controller;
		const lifetime = setTimeout(() => controller.abort(), SSE_MAX_CONNECTION_MS);
		lifetime.unref?.();
		let response;
		try {
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
			const uncertain = new Error("transport uncertainty opening the presentation stream");
			uncertain.uncertain = true;
			throw uncertain;
		}
		if (!response.ok) {
			clearTimeout(lifetime);
			const refused = new Error(`presentation stream refused (HTTP ${response.status}, static class)`);
			refused.httpStatus = response.status;
			throw refused;
		}
		if (!response.body) {
			clearTimeout(lifetime);
			throw new Error("presentation stream returned no body (static class)");
		}
		const parser = createSseParser({ maxEventBytes: SSE_MAX_EVENT_BYTES, maxLineBytes: SSE_MAX_LINE_BYTES });
		const decoder = new TextDecoder();
		try {
			for await (const chunk of response.body) {
				const events = parser.feed(decoder.decode(chunk, { stream: true }));
				for (const event of events) {
					if (event.event === "presentation") {
						handlePresentationEvent(event.data);
					} else if (event.event === "stream_error") {
						// Static failure class, stream ends. The reconnect path
						// re-verifies ownership honestly (status → claim, never
						// takeover); if the proof is dead it is dropped there.
						emitOncePerClass("stream_error received — the stream is ending");
						return;
					}
					// Unknown event types are ignored (bounded, no effect).
				}
			}
			const tail = parser.end();
			if (tail.refused) emitOncePerClass("stream ended mid-frame — the partial event is refused");
		} catch (err) {
			if (err instanceof SseFrameError) {
				emitOncePerClass("oversized SSE frame refused — reconnecting");
			} else if (controller.ownershipDropped) {
				// Ownership was dropped while this stream was active: the abort
				// is LOCAL and deliberate, not transport uncertainty.
				emitOncePerClass("ownership dropped — the active stream was aborted (static class)");
			} else {
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
			await verifyIdentity();
			await ensureOwnership();
			await connectStream();
			lastFailureClass = null; // recovery clears the quiet-until-changed rule
			consecutiveFailures = 0;
			await sleep(reconnectBackoff);
		} catch (err) {
			emitOncePerClass(`${staticFailureClass(err)}; reconnecting with bounded backoff — no legacy fallback`);
			if (err instanceof GateError) dropLease(); // no further authority use from that response
			if (err?.httpStatus === 404 || err?.httpStatus === 410) dropLease(); // stop using lost ownership
			// Exponential, capped reconnect backoff: bounded rate, honest
			// steady-state retry, never legacy consumption.
			consecutiveFailures = Math.min(consecutiveFailures + 1, 8);
			await sleep(clampNumber(reconnectBackoff * 2 ** (consecutiveFailures - 1), 50, 60_000));
		}
	}
	stopRenewal();
};

// ── mode dispatch: legacy long-poll remains the DEFAULT; SSE only when ──
// explicitly opted in. Invalid SSE configuration is heartbeat-only with a
// visible prerequisite failure — never silent legacy fallback.
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
