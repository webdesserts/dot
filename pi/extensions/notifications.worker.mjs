#!/usr/bin/env node
/**
 * notifications.worker.mjs — the autonomy-daemon wake bridge (worker process).
 *
 * Spawned by notifications.ts (the supervisor shim, loaded as a pi extension).
 * Read fresh from disk at every spawn, so code updates apply without touching
 * the pi session. ALL bridge logic lives here:
 *
 *   - long-polls the daemon's notification endpoint (20s hold)
 *   - filters own-echo rows, computes the state signature, dedups wakes
 *   - cooldown + backlog so nothing is lost during wake storms
 *   - idle heartbeat driven by lifecycle events forwarded on stdin
 *
 * PROTOCOL:
 *   stdin  (from supervisor): JSON lines {"event": "agent_start"|"agent_end"|...}
 *   stdout (to supervisor):  JSON lines {"kind": "wake"|"heartbeat", "message": "..."}
 *
 * The supervisor delivers stdout messages via pi.sendUserMessage with
 * { streamingBehavior: "steer" } — never bare (bare calls are refused and
 * dropped while the agent is busy).
 *
 * Config via env: AUTONOMY_BASE (default http://127.0.0.1:4600),
 * AUTONOMY_ACTOR (default "iris" — rhea sets "rhea"), AUTONOMY_TOKEN
 * (optional bearer for proxied daemons), AUTONOMY_WAKE_COOLDOWN_MS
 * (default 30000), AUTONOMY_HEARTBEAT_MS (default 1800000, 0 disables).
 *
 * WAKE DISCIPLINE (Michael's efficiency ruling): wake only when notification
 * STATE changes — a state signature (priority handles + summary + visible
 * total) is compared against the last wake; an unchanged signature is
 * silence, no matter how many polls pass.
 */

import { stdin, stdout } from "node:process";

const BASE = process.env.AUTONOMY_BASE ?? "http://127.0.0.1:4600";
const ACTOR = process.env.AUTONOMY_ACTOR ?? "iris";
const TOKEN = process.env.AUTONOMY_TOKEN ?? "";
const POLL_HOLD_SECONDS = 20;
const WAKE_COOLDOWN_MS = Number(process.env.AUTONOMY_WAKE_COOLDOWN_MS ?? 30_000);
const ERROR_BACKOFF_MS = 5_000;
const HEARTBEAT_MS = Number(process.env.AUTONOMY_HEARTBEAT_MS ?? 1_800_000);

const emit = (kind, message) => {
	stdout.write(`${JSON.stringify({ kind, message })}\n`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function authHeaders() {
	const headers = { "X-Auth-User": ACTOR };
	if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
	return headers;
}

function stateSignature(data, priority) {
	const handles = priority.map((i) => i.handle ?? i.resource_key ?? i.text ?? "").sort();
	const summary = Object.entries(data.summary ?? {})
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([place, count]) => `${place}:${count}`);
	const visibleTotal =
		priority.length + Object.values(data.summary ?? {}).reduce((a, b) => a + b, 0);
	return JSON.stringify({ h: handles, s: summary, t: visibleTotal });
}

function renderItem(item, tier) {
	const place = item.place ? ` @ ${item.place}` : "";
	const key = item.resource_key ? ` (${item.resource_key})` : "";
	return `- [${tier}] ${item.sender ?? "?"}${place}${key}: ${item.text ?? "(no text)"}`;
}

function render(data, priority, summary) {
	const lines = [];
	for (const item of priority) lines.push(renderItem(item, "HIGH"));
	for (const [place, count] of Object.entries(summary ?? {})) {
		lines.push(`- [low] ${place}: ${count}`);
	}
	if (data.total !== undefined) lines.push(`total unattended: ${data.total}`);
	if (lines.length === 0) {
		return `autonomy notifications: response shape not recognized — inspecting raw:\n${JSON.stringify(data).slice(0, 2000)}`;
	}
	const head = `autonomy notifications (${priority.length} high, ${Object.keys(summary ?? {}).length} places, total ${data.total ?? "?"}):`;
	return `${head}\n${lines.join("\n")}`;
}

// ── heartbeat: idle-timeout self-wake, armed by lifecycle events on stdin ──
let idleTimer = null;
let heartbeatArmed = false;

const armIdleHeartbeat = () => {
	if (HEARTBEAT_MS <= 0) return;
	if (idleTimer) clearTimeout(idleTimer);
	idleTimer = setTimeout(() => {
		idleTimer = null;
		emit(
			"heartbeat",
			"[heartbeat] 30-minute inactivity check: run queue-watch, compare against the plan, " +
				"do the next unblocked step or dispatch/report on a worker. If everything is truly " +
				"blocked and there is genuinely nothing to plan, end this turn immediately — do not pad.",
		);
	}, HEARTBEAT_MS);
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
			if (parsed.event === "agent_start") {
				if (idleTimer) {
					clearTimeout(idleTimer);
					idleTimer = null;
				}
			} else if (parsed.event === "agent_end") {
				if (heartbeatArmed) armIdleHeartbeat();
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

// The first agent_end from the supervisor arms the heartbeat (it forwards one
// immediately after wiring, before the agent has done anything — arm on that).
let firstAgentEnd = true;

stdin.on("data", () => {}); // keep the readable side flowing
const armOnFirstAgentEnd = () => {
	if (heartbeatArmed) return;
	heartbeatArmed = true;
	armIdleHeartbeat();
};

// Fallback: arm after the first poll cycle even if no events arrived yet —
// covers supervisors that don't forward lifecycle events.
setTimeout(() => {
	if (!heartbeatArmed) {
		heartbeatArmed = true;
		armIdleHeartbeat();
	}
}, 10_000);

// ── main poll loop ──
let lastWake = 0;
let backlog = [];
let lastSig = null;
let running = true;

const cleanup = () => {
	running = false;
	if (idleTimer) clearTimeout(idleTimer);
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
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = await res.json();
			const priority = (data.priority_notifications ?? []).filter((n) => n.sender !== ACTOR);
			const summary = Object.fromEntries(
				Object.entries(data.summary ?? {}).filter(([place]) => !place.startsWith(`${ACTOR}/`)),
			);
			const trivial =
				priority.length === 0 &&
				Object.keys(summary).length === 0 &&
				(data.total === undefined || data.total === 0);
			if (trivial) continue;

			const sig = stateSignature(data, priority);
			if (sig === lastSig) continue;
			lastSig = sig;

			const now = Date.now();
			if (now - lastWake < WAKE_COOLDOWN_MS) {
				for (const item of priority) backlog.push(renderItem(item, "HIGH"));
				for (const [place, count] of Object.entries(summary)) {
					backlog.push(`- [low] ${place}: ${count}`);
				}
				continue;
			}
			lastWake = now;
			const buffered = backlog.splice(0);
			const message =
				buffered.length > 0
					? `autonomy notifications (buffered during cooldown):\n${buffered.join("\n")}`
					: render(data, priority, summary);
			emit("wake", message);
		} catch (err) {
			emit("wake", `[notifications] poll failed: ${err}; retrying in ${ERROR_BACKOFF_MS}ms`);
			await sleep(ERROR_BACKOFF_MS);
		}
	}
};

poll();
