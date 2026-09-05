/**
 * Autonomy notification transport adapter for Pi.
 *
 * One worker per parent session; native subagents must not consume its queue.
 * Use /reload or restart/resume after changing either file. A file watcher is
 * unnecessary: Pi reloads extensions without discarding the conversation.
 * Delivery policy belongs to Autonomy, not this process supervisor.
 *
 * Bounded continuation mode (opt-in, session-local):
 *
 *   A model-callable tool (`heartbeat_control`) and a human command (`/hb`)
 *   share the SAME supervisor-owned control state: enable / pause / status.
 *   `enable` records a next-action context pointer (safe fallback text when
 *   omitted), an idle delay (default two minutes, clamped 5s..1h) and a wake
 *   budget (default three, hard cap ten per enable). While enabled, idle
 *   transitions arm the worker's single delayed timer — an agent_end, an
 *   enable issued while already idle, or a crash replay while idle all arm;
 *   no per-turn re-arming tool call is needed. The supervisor owns the
 *   remaining budget: it decrements BEFORE delivering a heartbeat and
 *   re-checks generation, busy/shutdown/paused/budget at delivery time, so
 *   late or stale worker output is dropped. After a worker crash the state
 *   is replayed to the respawned worker, so a respawn never replenishes
 *   budget — and if the parent was idle at crash time, the replay arms the
 *   timer (a crash while idle may otherwise never see another agent_end).
 *
 *   Generation fence: every control transition (enable, pause) and every
 *   lifecycle forward (agent_start, agent_end) bumps a supervisor-owned
 *   generation that travels to the worker and is echoed on heartbeat
 *   responses. Heartbeats whose generation no longer matches — a legacy
 *   beat queued before an enable, a continuation beat from before a
 *   re-enable, a prior idle cycle's output arriving after a newer cycle —
 *   are rejected before any budget decrement or delivery.
 *
 *   Delivery idleness: the supervisor stores the current session context
 *   and re-checks its documented isIdle() at heartbeat delivery, failing
 *   closed (no delivery) when unavailable or when retry/compaction/queued
 *   continuation is in progress. A transient-busy check defers through the
 *   worker's existing full-delay timer without consuming budget, so manual
 *   compaction need not produce another agent run for waking to recover.
 *
 *   States: "legacy" (default — the original behavior with its active
 *   30-minute fallback), "continuation" (bounded wakes with the supplied
 *   context), "paused" (all heartbeat wakes silenced, legacy included,
 *   until enabled again). Per extensions.md, /reload and session
 *   replacement emit session_shutdown for the old runtime and bind a fresh
 *   extension instance, so this in-memory state ends with the session and
 *   a new session starts in legacy mode — nothing persists automatically.
 *
 *   Notification (wake) delivery is unaffected by any of this.
 */
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const WORKER_PATH = path.join(
	path.dirname(realpathSync(fileURLToPath(import.meta.url))),
	"notifications.worker.mjs",
);
const RESPAWN_DELAY_MS = 2_000;

const DEFAULT_IDLE_DELAY_MS = 2 * 60_000;
const DEFAULT_WAKE_BUDGET = 3;
const MAX_WAKE_BUDGET = 10;
const MIN_IDLE_DELAY_MS = 5_000;
// Finite maximum: Node clamps setTimeout delays above 2^31-1ms down to 1ms,
// which would turn a "slow" heartbeat into a hot loop.
const MAX_IDLE_DELAY_MS = 3_600_000;
// Safe documented fallback so an enable without a next action can never
// produce an empty reminder.
const FALLBACK_NEXT_ACTION =
	"(no next action was provided — inspect this session's approved work, " +
	"continue one safe unblocked step, or pause the heartbeat)";

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export default function (pi) {
	// pi-subagents marks its background runtime explicitly; session_start does
	// not carry the systemPromptOptions used by before_agent_start.
	if (process.env.PI_SUBAGENT_CHILD === "1") return;

	// ── continuation control state (session-local, supervisor-owned) ──
	let mode = "legacy";
	let idleDelayMs = DEFAULT_IDLE_DELAY_MS;
	let contextText = "";
	let remainingWakes = 0;
	// Control/lifecycle generation: bumped on enable, pause, agent_start and
	// agent_end; echoed by the worker on heartbeat responses.
	let generation = 0;

	let running = false;
	let child = null;
	let respawnTimer = null;
	// Cheap busy pre-filter from lifecycle events; the authoritative check is
	// currentCtx.isIdle() at delivery time (covers retry/compaction/queued
	// continuation, which agent_end does not necessarily precede).
	let busy = false;
	let currentCtx = null;

	const send = (message) => {
		if (!message) return;
		try {
			pi.sendUserMessage(message, { deliverAs: "steer" });
		} catch (err) {
			console.error(`[notifications] send failed: ${err}`);
		}
	};

	const sendToWorker = (event) => {
		if (child?.stdin?.writable) child.stdin.write(`${JSON.stringify(event)}\n`);
	};

	// Authoritative idleness from the stored session context; fails closed.
	const idleNow = () => {
		try {
			return typeof currentCtx?.isIdle === "function" ? currentCtx.isIdle() === true : false;
		} catch {
			return false;
		}
	};

	// Full control snapshot, replayed to a freshly spawned worker so a crash
	// respawn resumes the same mode/budget instead of replenishing it.
	const workerInit = () => ({
		event: "init",
		busy,
		mode,
		idleDelayMs,
		context: contextText,
		remaining: remainingWakes,
		generation,
	});

	const statusState = () => ({
		mode,
		busy,
		idleDelayMs,
		remainingWakes,
		nextAction: contextText,
		generation,
	});

	const sanitizeNextAction = (value) => {
		const text = String(value ?? "").trim();
		return text || FALLBACK_NEXT_ACTION;
	};

	// Single control path shared by the model tool and the human command.
	const control = (action, args = {}, ctx = null) => {
		if (action === "enable") {
			const delaySeconds = Number(args.idleDelaySeconds);
			const budget = Number(args.wakeBudget);
			mode = "continuation";
			idleDelayMs = clamp(
				Number.isFinite(delaySeconds) && delaySeconds > 0 ? delaySeconds * 1000 : DEFAULT_IDLE_DELAY_MS,
				MIN_IDLE_DELAY_MS,
				MAX_IDLE_DELAY_MS,
			);
			contextText = sanitizeNextAction(args.nextAction);
			remainingWakes = clamp(
				Number.isFinite(budget) && budget > 0 ? Math.floor(budget) : DEFAULT_WAKE_BUDGET,
				1,
				MAX_WAKE_BUDGET,
			);
			generation += 1;
			// The worker arms here when the session is already idle: a command
			// issued while idle is never followed by an agent_end of its own.
			const busyAtEnable = busy || (ctx !== null && typeof ctx.isIdle === "function" && ctx.isIdle() === false);
			sendToWorker({
				event: "enable",
				idleDelayMs,
				context: contextText,
				remaining: remainingWakes,
				busy: busyAtEnable,
				generation,
			});
		} else if (action === "pause") {
			mode = "paused";
			remainingWakes = 0;
			generation += 1;
			sendToWorker({ event: "pause", generation });
		} else if (action !== "status") {
			return { ok: false, state: statusState(), error: `unknown action: ${action}` };
		}
		return { ok: true, state: statusState() };
	};

	const formatState = (state) =>
		`heartbeat ${state.mode}${state.busy ? " (busy)" : ""}` +
		(state.mode === "continuation"
			? ` — ${state.remainingWakes} wake(s) left, idle ${Math.round(state.idleDelayMs / 1000)}s` +
				(state.nextAction ? ` — next: ${state.nextAction}` : "")
			: "") +
		(state.mode === "legacy"
			? " — 30-minute fallback active; enable continuation for bounded idle wakes"
			: "");

	const spawnWorker = () => {
		if (!running || child) return;
		const spawned = spawn(process.execPath, [WORKER_PATH], {
			env: process.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		child = spawned;
		// Replay control state (mode, delay, context, remaining budget,
		// generation) and the current busy/idle snapshot so the fresh worker
		// matches reality — and arms itself when the parent was idle.
		sendToWorker(workerInit());
		let stdoutBuf = "";
		spawned.stdout.on("data", (chunk) => {
			if (child !== spawned || !running) return;
			stdoutBuf += chunk;
			let idx;
			while ((idx = stdoutBuf.indexOf("\n")) !== -1) {
				const line = stdoutBuf.slice(0, idx);
				stdoutBuf = stdoutBuf.slice(idx + 1);
				if (!line) continue;
				try {
					const parsed = JSON.parse(line);
					if (parsed.kind === "wake" && typeof parsed.message === "string") {
						send(parsed.message);
					} else if (parsed.kind === "heartbeat" && typeof parsed.message === "string") {
						deliverHeartbeat(parsed.message, parsed.generation);
					}
				} catch {
					send(line);
				}
			}
		});
		spawned.stderr.on("data", (chunk) => console.error(`[notifications.worker] ${chunk}`));
		const exited = (reason) => {
			// An old child's late exit must not clear a replacement's handle or
			// schedule another worker. Error followed by exit also runs only once.
			if (child !== spawned) return;
			child = null;
			if (!running) return;
			console.error(`[notifications.worker] stopped (${reason}); retry in ${RESPAWN_DELAY_MS}ms`);
			respawnTimer = setTimeout(() => {
				respawnTimer = null;
				spawnWorker();
			}, RESPAWN_DELAY_MS);
		};
		spawned.on("exit", exited);
		spawned.on("error", exited);
	};

	// Supervisor-side gate for worker heartbeat output, re-checked at delivery
	// time to handle stale or late output from any prior era.
	const deliverHeartbeat = (message, heartbeatGeneration) => {
		if (!running) return; // session shut down
		if (heartbeatGeneration !== generation) return; // stale control/lifecycle era
		if (busy) return;
		if (!idleNow()) {
			// Manual compaction can finish without another agent run. Retry via
			// the worker's existing full-delay timer, never queue a busy wake.
			if (mode === "continuation" && remainingWakes > 0) {
				sendToWorker({ event: "heartbeat_defer", generation });
			}
			return;
		}
		if (mode === "paused") return; // silenced until explicitly enabled again
		if (mode === "continuation") {
			if (remainingWakes <= 0) return;
			remainingWakes -= 1; // supervisor owns the budget: decrement BEFORE delivery
			if (remainingWakes === 0) sendToWorker({ event: "budget", remaining: 0 });
		}
		send(message);
	};

	pi.on("session_start", (_event, ctx) => {
		if (running) return;
		running = true;
		// Fresh extension instance: control state already defaults to legacy
		// (whose 30-minute fallback is active). Snapshot idleness from
		// documented Pi context (ctx.isIdle) instead of any worker fallback.
		currentCtx = ctx ?? null;
		busy = !(ctx?.isIdle?.() ?? true);
		spawnWorker();
	});
	pi.on("session_shutdown", () => {
		running = false;
		if (respawnTimer) clearTimeout(respawnTimer);
		respawnTimer = null;
		const stopped = child;
		child = null;
		stopped?.kill();
		// Control state is session-local: reset to safe defaults. A later
		// session_start in this instance starts in legacy mode.
		mode = "legacy";
		remainingWakes = 0;
		contextText = "";
		busy = false;
		generation = 0;
		currentCtx = null;
	});
	const forward = (name) => (_event, ctx) => {
		if (ctx) currentCtx = ctx;
		busy = name === "agent_start";
		generation += 1;
		sendToWorker({ event: name, generation });
	};
	pi.on("agent_start", forward("agent_start"));
	pi.on("agent_end", forward("agent_end"));

	// ── model-callable control tool ──
	pi.registerTool({
		name: "heartbeat_control",
		label: "Heartbeat Control",
		description:
			"Control the bounded idle continuation heartbeat for this session. " +
			"enable: arm automatic idle wakes that remind you to continue the current approved work; " +
			"pass a concise nextAction — when omitted, a documented fallback reminder is used. " +
			"pause: silence all heartbeat wakes (including legacy) until enabled again — use this when " +
			"blocked, waiting on a human, or finished. status: report mode, remaining wake budget and delay.",
		promptSnippet: "Enable/pause/inspect the session's bounded continuation heartbeat",
		promptGuidelines: [
			"Use heartbeat_control enable once at the start of a work period with a concise nextAction describing the approved next step; idle wakes then re-arm automatically after every turn — do not call it again each turn.",
			"If a heartbeat finds you genuinely blocked, waiting on human input, or done, call heartbeat_control pause and report the blocker instead of inventing work or authority.",
		],
		parameters: Type.Object({
			action: StringEnum(["enable", "pause", "status"] as const),
			nextAction: Type.Optional(
				Type.String({ description: "Concise approved next action / context pointer quoted in every heartbeat reminder" }),
			),
			idleDelaySeconds: Type.Optional(
				Type.Integer({ minimum: 5, maximum: 3600, description: "Idle delay before each heartbeat (default 120, max 3600)" }),
			),
			wakeBudget: Type.Optional(
				Type.Integer({ minimum: 1, maximum: 10, description: "Max heartbeats per enable (default 3, hard cap 10)" }),
			),
		}),
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			const result = control(params.action, params, ctx);
			return {
				content: [{ type: "text", text: result.ok ? formatState(result.state) : result.error }],
				details: result,
			};
		},
	});

	// ── human command sharing the same control state ──
	pi.registerCommand("hb", {
		description:
			"Bounded continuation heartbeat: /hb enable <next action> | /hb pause | /hb status " +
			"(enable without text uses a documented fallback reminder)",
		handler: async (args, ctx) => {
			const text = (args ?? "").trim();
			const verb = text.split(/\s+/)[0] ?? "";
			const rest = text.slice(verb.length).trim();
			let result;
			if (verb === "enable") {
				result = control("enable", rest ? { nextAction: rest } : {}, ctx);
			} else if (verb === "pause" || verb === "status") {
				result = control(verb);
			} else {
				result = { ok: false, state: statusState(), error: "usage: /hb enable <next action> | /hb pause | /hb status" };
			}
			const line = result.ok ? formatState(result.state) : result.error;
			try {
				ctx?.ui?.notify?.(line, result.ok ? "info" : "warning");
			} catch {
				console.error(`[notifications] /hb: ${line}`);
			}
		},
	});
}
