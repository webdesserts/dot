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
 *     {"event": "init",   "busy": bool, "mode": "legacy"|"continuation"|"paused",
 *      "idleDelayMs": n, "context": "...", "remaining": n, "generation": n}
 *     {"event": "enable", "idleDelayMs": n, "context": "...", "remaining": n,
 *      "busy": bool, "generation": n}
 *     {"event": "budget", "remaining": n}
 *     {"event": "pause",  "generation": n}
 *   stdout (to supervisor):  JSON lines
 *     {"kind": "wake", "message": "..."}
 *     {"kind": "heartbeat", "message": "...", "generation": n}
 *
 * HEARTBEAT MODES (session-local; the supervisor owns the wake budget):
 *   legacy        — default. Original behavior: a 10s fallback arms the idle
 *                   heartbeat (AUTONOMY_HEARTBEAT_MS, default 30min, fixed
 *                   canned text) and every agent_end re-arms it. Kept for
 *                   sessions that never enable continuation.
 *   continuation  — bounded continuation: the timer is armed on every idle
 *                   transition — agent_end, an enable issued while already
 *                   idle, or a crash replay (init) while idle — while budget
 *                   remains. The 10s fallback NEVER runs in this mode; the
 *                   busy/idle snapshot comes from the supervisor (init/enable
 *                   "busy" field), so a heartbeat cannot arm mid-turn.
 *   paused        — all heartbeat wakes silenced (legacy included) until the
 *                   supervisor enables again.
 *
 * GENERATION: the supervisor bumps a control/lifecycle generation on enable,
 * pause, agent_start and agent_end and sends it with each event; every
 * heartbeat response echoes the generation it was armed under. The supervisor
 * rejects mismatched generations, fencing stale output (e.g. a legacy beat
 * queued before an enable, or a prior idle cycle's line) from consuming the
 * new budget.
 *
 * The supervisor re-checks generation/busy/idleness/paused/budget at delivery
 * time, so a heartbeat emitted here can still be dropped there. Arming NEVER
 * fires immediately: wakes only happen after the full idle delay, so no
 * zero-delay prompt loop is possible.
 *
 * The supervisor delivers stdout messages via pi.sendUserMessage with
 * { deliverAs: "steer" } — never bare (bare calls are refused and
 * dropped while the agent is busy).
 *
 * Config via env: AUTONOMY_BASE (default http://127.0.0.1:4600),
 * AUTONOMY_ACTOR (default "iris" — rhea sets "rhea"; used only for the
 * auth header), AUTONOMY_TOKEN (optional bearer for proxied daemons),
 * AUTONOMY_HEARTBEAT_MS (default 1800000, 0 disables; legacy mode only),
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
let mode = "legacy";
let heartbeatArmed = false; // legacy-only gate: set once by the 10s fallback
let continuationDelayMs = 0;
let continuationContext = "";
let continuationRemaining = 0;
let generation = 0;
let busy = false; // supervisor-provided snapshot + agent events

const clearIdleTimer = () => {
	if (idleTimer) {
		clearTimeout(idleTimer);
		idleTimer = null;
	}
};

const legacyHeartbeat = () =>
	emitHeartbeat(
		"[heartbeat] 30-minute inactivity check: run queue-watch, compare against the plan, " +
			"do the next unblocked step or dispatch/report on a worker. If everything is truly " +
			"blocked and there is genuinely nothing to plan, end this turn immediately — do not pad.",
	);

const continuationHeartbeat = () =>
	emitHeartbeat(
		`[heartbeat] continuation check: ${continuationContext}\n` +
			"Advisory: inspect the current approved work and continue one safe, unblocked step. " +
			"If genuinely blocked, waiting on a human, or finished, pause the heartbeat " +
			"(heartbeat_control pause or /hb pause) and report the blocker — never invent work or authority.",
	);

const armLegacy = () => {
	if (HEARTBEAT_MS <= 0) return;
	clearIdleTimer();
	idleTimer = setTimeout(() => {
		idleTimer = null;
		legacyHeartbeat();
	}, HEARTBEAT_MS);
};

// Arm the single continuation timer only when the session is idle and budget
// remains. Called on agent_end, on enable while idle, and on crash replay
// (init) while idle — a crash while idle must not leave the net inert.
const armContinuationIfIdle = () => {
	if (busy || !(continuationDelayMs > 0) || continuationRemaining <= 0) return;
	if (continuationDelayMs > MAX_IDLE_DELAY_MS) return; // never schedule a clamped-to-1ms timer
	clearIdleTimer();
	idleTimer = setTimeout(() => {
		idleTimer = null;
		continuationHeartbeat();
	}, continuationDelayMs);
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
				// Legacy keeps its old gate: re-arm only after the fallback armed once.
				if (mode === "legacy") {
					if (heartbeatArmed) armLegacy();
				} else if (mode === "continuation") {
					armContinuationIfIdle();
				}
			} else if (parsed.event === "init") {
				// Crash-replay / startup snapshot from the supervisor. Consumes the
				// busy snapshot: an idle replay arms the timer (the parent may
				// never turn again), a busy replay waits for the next agent_end.
				mode = parsed.mode === "continuation" || parsed.mode === "paused" ? parsed.mode : "legacy";
				const delay = asNumber(parsed.idleDelayMs);
				continuationDelayMs = delay !== null && delay > 0 ? Math.min(delay, MAX_IDLE_DELAY_MS) : 0;
				continuationContext = typeof parsed.context === "string" ? parsed.context : "";
				const remaining = asNumber(parsed.remaining);
				continuationRemaining = remaining !== null && remaining > 0 ? remaining : 0;
				if (gen !== null) generation = gen;
				busy = parsed.busy === true;
				clearIdleTimer();
				if (mode === "continuation") armContinuationIfIdle();
			} else if (parsed.event === "enable") {
				mode = "continuation";
				const delay = asNumber(parsed.idleDelayMs);
				continuationDelayMs = delay !== null && delay > 0 ? Math.min(delay, MAX_IDLE_DELAY_MS) : 0;
				continuationContext = typeof parsed.context === "string" ? parsed.context : "";
				const remaining = asNumber(parsed.remaining);
				continuationRemaining = remaining !== null && remaining > 0 ? remaining : 0;
				if (gen !== null) generation = gen;
				busy = parsed.busy === true;
				clearIdleTimer(); // cancels any pending legacy/stale timer
				armContinuationIfIdle(); // arms now when the session is already idle
			} else if (parsed.event === "heartbeat_defer") {
				if (gen === generation && mode === "continuation") armContinuationIfIdle();
			} else if (parsed.event === "budget") {
				const remaining = asNumber(parsed.remaining);
				continuationRemaining = remaining !== null && remaining > 0 ? remaining : 0;
				if (continuationRemaining <= 0) clearIdleTimer(); // stop pointless pending fires
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
// covers supervisors that don't forward lifecycle events. LEGACY MODE ONLY:
// a continuation-enabled session gets its busy/idle truth from the
// supervisor's init/enable events, never from this unconditional timer.
setTimeout(() => {
	if (mode === "legacy" && !heartbeatArmed) {
		heartbeatArmed = true;
		armLegacy();
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
