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
const MAX_IDLE_DELAY_MS = 3_600_000;
// Fixed ambient window used only when the supervisor has not sent one yet
// (e.g. a standalone worker that never receives init). Bounded either way.
const AMBIENT_LIFETIME_MS = 2 * 3_600_000;

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

poll();
