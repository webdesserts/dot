/**
 * Autonomy notification transport adapter for Pi.
 *
 * One worker per parent session; native subagents must not consume its queue.
 * Use /reload or restart/resume after changing either file. A file watcher is
 * unnecessary: Pi reloads extensions without discarding the conversation.
 * Delivery policy belongs to Autonomy, not this process supervisor.
 *
 * Goal heartbeat mode (opt-in, session-owned):
 *
 *   A model-callable tool (`heartbeat_control`) and a human command (`/hb`)
 *   share the SAME supervisor-owned control state: enable / hold / complete /
 *   pause / status.
 *
 *   enable — records ONE active goal pointer (a non-empty nextAction is
 *   required; an empty string never invents indefinite work), plus an idle
 *   delay (default 30s, clamped 5s..1h). There is NO wake-count expiry: the
 *   goal wakes on every idle transition until it is explicitly completed or
 *   paused. The retired per-enable wake budget is gone from schema, guidance
 *   and status rather than being silently treated as infinite.
 *
 *   hold — defers heartbeats until an explicit absolute deadline (epoch ms,
 *   derived from a finite positive holdSeconds, e.g. holdSeconds 300). Hold
 *   is heartbeat-only: ordinary notifications, human messages and native
 *   child completion are never blocked. A busy run is never interrupted —
 *   the next wake is scheduled no earlier than BOTH the normal idle delay
 *   and the hold deadline, and hold resumes automatically without a
 *   re-enable. Hold while all-paused is rejected rather than silently
 *   reactivating wakes.
 *
 *   complete — ends the goal and enters the bounded ambient fallback. The
 *   tool result itself carries the handoff prompt (check for another
 *   authorized goal, keep the fallback, or pause); no second self-triggering
 *   message is sent. Repeated complete with no active goal never renews the
 *   ambient lifetime, and complete while paused never re-enables ambient.
 *
 *   Ambient fallback — 30-minute idle checks with a FIXED 2h expiry measured
 *   from entering ambient. Its own wakes, model replies, holds and worker
 *   crashes cannot extend the deadline: the worker never schedules a timer
 *   past the expiry and the supervisor re-checks the deadline at delivery.
 *   After expiry heartbeats stop. Completing another genuinely active goal
 *   starts a new fallback window.
 *
 *   pause — all heartbeat wakes off, ambient included, until an explicit
 *   enable. Human/ordinary notifications are unaffected.
 *
 *   status — truthful mode, goal pointer, delay, hold deadline, ambient
 *   expiry/expired state and suppression reasons. It never claims a
 *   next-due time while busy or paused and carries no wake-count counter.
 *
 *   While a goal is active, idle transitions arm the worker's single delayed
 *   timer — an agent_end, an enable issued while already idle, or a crash
 *   replay while idle all arm; no per-turn re-arming tool call is needed.
 *
 *   Generation fence: every control transition (enable, hold, complete,
 *   pause) and every lifecycle forward (agent_start, agent_end) bumps a
 *   supervisor-owned generation that travels to the worker and is echoed on
 *   heartbeat responses. Heartbeats whose generation no longer matches — a
 *   queued beat from before a transition, or a prior idle cycle's output
 *   arriving after a newer cycle — are rejected before delivery.
 *
 *   Delivery idleness: the supervisor stores the current session context
 *   and re-checks its documented isIdle() at heartbeat delivery, failing
 *   closed (no delivery) when unavailable or when retry/compaction/queued
 *   continuation is in progress. A transient-busy check defers through the
 *   worker's existing full-delay timer, so manual compaction need not
 *   produce another agent run for waking to recover.
 *
 *   Persistence: state TRANSITIONS (enable, hold, complete, pause) are
 *   written as Pi custom entries (pi.appendEntry, customType
 *   "heartbeat-control") so same-session reload/resume keeps the explicit
 *   goal/mode and absolute deadlines. Restore on session_start reads the
 *   latest VALID control entry across getEntries() for this session
 *   identity — control intent is session-wide, so a newer pause/complete can
 *   never be resurrected into a goal by navigating to an older tree branch
 *   and reloading. Forks and brand-new sessions do NOT inherit the old
 *   owner's active goal: they start a fresh bounded ambient window. Absolute
 *   deadlines (hold, ambient expiry) persist as epoch ms and are never
 *   renewed by a reload. Ephemeral/in-memory sessions degrade gracefully:
 *   appendEntry failures are logged, never fatal.
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

const DEFAULT_IDLE_DELAY_MS = 30_000;
const MIN_IDLE_DELAY_MS = 5_000;
// Finite maximum: Node clamps setTimeout delays above 2^31-1ms down to 1ms,
// which would turn a "slow" heartbeat into a hot loop.
const MAX_IDLE_DELAY_MS = 3_600_000;
// Fixed ambient fallback window, measured from entering ambient. Nothing in
// the system may extend it — not its own wakes, not a reload, not a hold.
const AMBIENT_LIFETIME_MS = 2 * 3_600_000;
const MIN_HOLD_MS = 1_000;
// Custom-entry type used for session-owned control persistence.
const ENTRY_TYPE = "heartbeat-control";
// Exact handoff prompt delivered in the complete tool result. Deliberately
// NOT sent as a second self-triggering user message.
const COMPLETE_HANDOFF =
	"Goal complete. Is there another authorized goal you can work on? " +
	"If so, enable it and continue. Otherwise leave the bounded fallback " +
	"active, or pause all wakes for a human wait.";

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const isFiniteMs = (value) => {
	const n = Number(value);
	return Number.isFinite(n) && n > 0 ? n : 0;
};

export default function (pi) {
	// pi-subagents marks its background runtime explicitly; session_start does
	// not carry the systemPromptOptions used by before_agent_start.
	if (process.env.PI_SUBAGENT_CHILD === "1") return;

	// ── goal heartbeat control state (session-owned, supervisor-owned) ──
	let mode = "ambient";
	let goal = "";
	let idleDelayMs = DEFAULT_IDLE_DELAY_MS;
	// Absolute epoch-ms deadlines. Absolute (not relative) so they survive
	// reload/resume without being silently renewed.
	let holdUntil = 0;
	let ambientExpiresAt = Date.now() + AMBIENT_LIFETIME_MS;
	// Control/lifecycle generation: bumped on enable, hold, complete, pause,
	// agent_start and agent_end; echoed by the worker on heartbeat responses.
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

	// ── SSE presentation delivery (opt-in worker mode; see worker header) ──
	// Transient ONE-OUTSTANDING guard in supervisor memory ONLY — not a
	// second durable suppression policy. A presentation id stays in-flight
	// from its deliver request until the worker reports the ack outcome;
	// SSE-mode reconnect replays of the same outstanding offer are then
	// suppressed for THIS instance while un-acked, and everything is
	// forgotten on process replacement.
	const sseInFlight = new Map();
	const SSE_IN_FLIGHT_CAP = 16;

	const isSafePresentationId = (value) =>
		typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

	// Deliver the EXACT server body as a custom message with display:true,
	// normally steer + triggerTurn:true (the SDK queues it while busy —
	// ordinary notification delivery is never gated on isIdle; that
	// belongs to heartbeat delivery). The send return is NEVER receipt
	// evidence: only qualifying disk-recorded bytes authorize the ack.
	const deliverPresentation = (message, presentationId) => {
		if (!running) return;
		if (!message || typeof message !== "object") return;
		if (typeof message.customType !== "string" || typeof message.content !== "string") return;
		if (message.display !== true || !message.details || typeof message.details !== "object") return;
		if (!isSafePresentationId(presentationId)) return;
		if (sseInFlight.has(presentationId)) return; // transient one-outstanding guard
		if (sseInFlight.size >= SSE_IN_FLIGHT_CAP) {
			console.error("[notifications] SSE in-flight guard saturated — refusing delivery (static class)");
			return;
		}
		const sessionId = sessionOwner();
		if (!sessionId) {
			// Without the current session id the disk receipt could never
			// qualify; refuse rather than deliver an unacknowledgeable body.
			console.error("[notifications] SSE delivery refused: no current session id (static class)");
			return;
		}
		sseInFlight.set(presentationId, Date.now());
		try {
			pi.sendMessage(
				{ ...message, details: { ...message.details, sessionId } },
				{ deliverAs: "steer", triggerTurn: true },
			);
		} catch {
			sseInFlight.delete(presentationId);
			console.error("[notifications] SSE delivery failed (static class)");
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

	// Session identity for ownership binding: control entries written by this
	// runtime are only valid for the session that wrote them. A fork copies
	// the parent's entries into a new file, but they keep the OLD owner id and
	// must never restore here.
	const sessionOwner = (ctx = currentCtx) => {
		try {
			const id = ctx?.sessionManager?.getSessionId?.();
			return typeof id === "string" && id ? id : null;
		} catch {
			return null;
		}
	};

	// Persist a control-state transition (or a session's fresh baseline) as a
	// custom entry bound to this session's identity. Transitions only — never
	// polls, never status. Custom entries do not enter LLM context and are
	// read back by scanning getEntries() for the latest valid owned snapshot.
	const persist = () => {
		try {
			pi.appendEntry(ENTRY_TYPE, {
				owner: sessionOwner(),
				mode,
				goal,
				idleDelayMs,
				holdUntil,
				ambientExpiresAt,
				at: Date.now(),
			});
		} catch (err) {
			// Ephemeral/in-memory sessions may not persist; heartbeating still
			// works from in-memory state.
			console.error(`[notifications] persist failed: ${err}`);
		}
	};

	// Full control snapshot, replayed to a freshly spawned worker so a crash
	// respawn resumes the same mode/goal/deadlines instead of starting over.
	const workerInit = () => ({
		event: "init",
		busy,
		mode,
		idleDelayMs,
		goal,
		holdUntil,
		ambientExpiresAt,
		generation,
	});

	const statusState = () => ({
		mode,
		busy,
		idleDelayMs,
		goal,
		holdUntil,
		ambientExpiresAt,
		ambientExpired: mode === "ambient" && ambientExpiresAt < Date.now(),
		generation,
	});

	const fmtTime = (ms) => new Date(ms).toISOString();

	const formatState = (state) => {
		const busyTag = state.busy ? " (busy — wakes resume when idle)" : "";
		if (state.mode === "goal") {
			let line = `heartbeat goal${busyTag} — idle ${Math.round(state.idleDelayMs / 1000)}s`;
			if (state.holdUntil > Date.now()) line += ` — held until ${fmtTime(state.holdUntil)}`;
			else if (!state.busy) line += ` — next wake: after ${Math.round(state.idleDelayMs / 1000)}s idle`;
			line += ` — next: ${state.goal}`;
			return line;
		}
		if (state.mode === "ambient") {
			const busyTag = state.busy ? " (busy — wakes resume when idle)" : "";
			if (state.ambientExpired) return `heartbeat ambient${busyTag} — 2h fallback window EXPIRED; no further fallback wakes (enable a goal to resume)`;
			let line = `heartbeat ambient${busyTag} — 30-minute fallback, expires ${fmtTime(state.ambientExpiresAt)} (fixed; not extended by its own wakes)`;
			if (state.holdUntil > Date.now()) line += ` — held until ${fmtTime(state.holdUntil)}`;
			return line;
		}
		return "heartbeat paused — all heartbeat wakes silenced (ordinary notifications unaffected); enable a goal to resume";
	};

	// Restore the latest VALID control entry for this session identity,
	// scanning all entries (not just the current branch): control intent is
	// session-wide, so navigating to an older branch cannot resurrect a
	// superseded goal over a newer pause/complete. Invalid snapshots (unknown
	// mode, goal mode with an empty pointer) are skipped, not repaired.
	const restoreFromSession = (ctx) => {
		try {
			const self = sessionOwner(ctx);
			const entries = ctx?.sessionManager?.getEntries?.() ?? [];
			for (let i = entries.length - 1; i >= 0; i--) {
				const entry = entries[i];
				if (entry?.type !== "custom" || entry?.customType !== ENTRY_TYPE) continue;
				const data = entry?.data;
				if (!data || typeof data !== "object") continue;
				if (data.owner !== self) continue; // another session's entries never own this runtime
				if (data.mode === "goal" && typeof data.goal === "string" && data.goal.trim()) {
					mode = "goal";
					goal = data.goal.trim();
					idleDelayMs = clamp(isFiniteMs(data.idleDelayMs) || DEFAULT_IDLE_DELAY_MS, MIN_IDLE_DELAY_MS, MAX_IDLE_DELAY_MS);
					holdUntil = isFiniteMs(data.holdUntil);
					ambientExpiresAt = 0;
					return true;
				}
				if (data.mode === "ambient" || data.mode === "paused") {
					mode = data.mode;
					goal = "";
					holdUntil = isFiniteMs(data.holdUntil);
					ambientExpiresAt = data.mode === "ambient" ? isFiniteMs(data.ambientExpiresAt) : 0;
					return true;
				}
			}
		} catch (err) {
			console.error(`[notifications] restore failed: ${err}`);
			return false;
		}
		// No usable history (or the entry scan failed): fresh bounded ambient,
		// persisted so a later reload restores the SAME window, not a new one.
		return false;
	};

	// Fresh sessions and forks never inherit an active goal; they may start a
	// new bounded ambient window.
	const freshAmbient = () => {
		mode = "ambient";
		goal = "";
		holdUntil = 0;
		ambientExpiresAt = Date.now() + AMBIENT_LIFETIME_MS;
	};

	// Single control path shared by the model tool and the human command.
	const control = (action, args = {}, ctx = null) => {
		if (args && args.wakeBudget !== undefined) {
			// Retired concept: an old finite-budget request must fail
			// explicitly rather than silently become an unlimited goal.
			return { ok: false, state: statusState(), error: "wakeBudget is retired: goal heartbeats have no count expiry; remove wakeBudget and call again" };
		}
		if (action === "enable") {
			const pointer = typeof args.nextAction === "string" ? args.nextAction.trim() : "";
			if (!pointer) {
				return { ok: false, state: statusState(), error: "enable requires a non-empty nextAction naming the approved goal (an empty goal must not become indefinite work)" };
			}
			const delaySeconds = Number(args.idleDelaySeconds);
			mode = "goal";
			goal = pointer;
			idleDelayMs = clamp(
				Number.isFinite(delaySeconds) && delaySeconds > 0 ? delaySeconds * 1000 : DEFAULT_IDLE_DELAY_MS,
				MIN_IDLE_DELAY_MS,
				MAX_IDLE_DELAY_MS,
			);
			holdUntil = 0; // a fresh goal starts unheld
			generation += 1;
			persist();
			// The worker arms here when the session is already idle: a command
			// issued while idle is never followed by an agent_end of its own.
			const busyAtEnable = busy || (ctx !== null && typeof ctx.isIdle === "function" && ctx.isIdle() === false);
			sendToWorker({ event: "enable", idleDelayMs, goal, busy: busyAtEnable, generation });
		} else if (action === "hold") {
			if (mode === "paused") {
				return { ok: false, state: statusState(), error: "hold rejected: all wakes are paused (enable first, then hold)" };
			}
			const seconds = Number(args.holdSeconds);
			if (!Number.isFinite(seconds) || seconds <= 0) {
				return { ok: false, state: statusState(), error: "hold requires a positive finite holdSeconds (e.g. 300)" };
			}
			const ms = clamp(seconds * 1000, MIN_HOLD_MS, MAX_IDLE_DELAY_MS);
			holdUntil = Date.now() + ms;
			generation += 1;
			persist();
			sendToWorker({ event: "hold", holdUntil, generation });
		} else if (action === "complete") {
			if (mode !== "goal") {
				// Never renew ambient from an empty completion, and never sneak a
				// paused session back into waking.
				const note = mode === "paused"
					? "No active goal (paused): nothing completed, ambient stays off."
					: "No active goal: the ambient window is unchanged and was not renewed.";
				return { ok: true, state: statusState(), message: note };
			}
			mode = "ambient";
			goal = "";
			holdUntil = 0;
			ambientExpiresAt = Date.now() + AMBIENT_LIFETIME_MS;
			generation += 1;
			persist();
			sendToWorker({ event: "complete", ambientExpiresAt, generation });
			return { ok: true, state: statusState(), message: COMPLETE_HANDOFF };
		} else if (action === "pause") {
			mode = "paused";
			goal = "";
			holdUntil = 0;
			generation += 1;
			persist();
			sendToWorker({ event: "pause", generation });
		} else if (action !== "status") {
			return { ok: false, state: statusState(), error: `unknown action: ${action}` };
		}
		return { ok: true, state: statusState() };
	};

	const spawnWorker = () => {
		if (!running || child) return;
		const spawned = spawn(process.execPath, [WORKER_PATH], {
			env: process.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		child = spawned;
		// Replay control state (mode, goal, delay, absolute deadlines,
		// generation) and the current busy/idle snapshot so the fresh worker
		// matches reality — and arms itself when the parent was idle.
		sendToWorker(workerInit());
		// SSE mode (harmless in legacy mode): bind the worker's receipt
		// reconciliation to THIS session and request startup reconciliation
		// against the bound session.
		sendToWorker({
			event: "session",
			sessionId: sessionOwner(),
			sessionFile: currentCtx?.sessionManager?.getSessionFile?.() ?? null,
		});
		sendToWorker({ event: "reconcile" });
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
					} else if (parsed.kind === "deliver") {
						// The worker's generic emitter nests every payload under
						// `message`: the presentation id lives at
						// parsed.message.details.presentationId (validated for safety
						// inside deliverPresentation).
						const deliverMessage =
							parsed.message && typeof parsed.message === "object" ? parsed.message : null;
						const deliverId = deliverMessage?.details?.presentationId;
						deliverPresentation(deliverMessage, isSafePresentationId(deliverId) ? deliverId : null);
					} else if (parsed.kind === "ack") {
						// Same nested envelope: {kind:"ack", message:{presentationId,
						// outcome}}. Only a validated outcome releases the guard.
						const ackPayload =
							parsed.message && typeof parsed.message === "object" ? parsed.message : null;
						const ackId = ackPayload?.presentationId;
						if (
							isSafePresentationId(ackId) &&
							(ackPayload.outcome === "acknowledged" ||
								ackPayload.outcome === "already_acknowledged")
						) {
							sseInFlight.delete(ackId);
						}
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
		if (mode === "paused") return; // silenced until explicitly enabled again
		if (!idleNow()) {
			// Manual compaction can finish without another agent run. Retry via
			// the worker's existing full-delay timer, never queue a busy wake.
			sendToWorker({ event: "heartbeat_defer", generation });
			return;
		}
		// A hold is honored at DELIVERY time too: a current-generation beat
		// whose output lands before the deadline defers through the worker's
		// timer (which already schedules no earlier than the hold deadline)
		// instead of bypassing the hold.
		if (holdUntil > Date.now()) {
			sendToWorker({ event: "heartbeat_defer", generation });
			return;
		}
		if (mode === "goal") {
			send(message);
			return;
		}
		if (mode === "ambient") {
			// Fixed expiry: a beat armed before expiry is still dropped when it
			// would be delivered past it, and nothing re-arms after expiry.
			if (Date.now() > ambientExpiresAt) return;
			send(message);
		}
	};

	pi.on("session_start", (event, ctx) => {
		if (running) return;
		running = true;
		// Snapshot idleness from documented Pi context (ctx.isIdle).
		currentCtx = ctx ?? null;
		busy = !(ctx?.isIdle?.() ?? true);
		const reason = event?.reason;
		let restored = false;
		if (reason === "fork" || reason === "new") {
			// Forks and brand-new sessions must not inherit the previous
			// owner's active goal; they start a fresh bounded ambient window.
			freshAmbient();
		} else {
			restored = restoreFromSession(ctx);
		}
		if (!restored) {
			// A fresh session persists its ambient baseline immediately so a
			// later reload restores the same absolute expiry instead of
			// renewing it.
			persist();
		}
		spawnWorker();
	});
	pi.on("session_shutdown", () => {
		running = false;
		if (respawnTimer) clearTimeout(respawnTimer);
		respawnTimer = null;
		const stopped = child;
		child = null;
		stopped?.kill();
		sseInFlight.clear();
		// In-memory control state ends with this instance; durable intent was
		// persisted as custom entries and is restored by the next instance.
		mode = "ambient";
		goal = "";
		holdUntil = 0;
		ambientExpiresAt = Date.now() + AMBIENT_LIFETIME_MS;
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
	// Hook-driven receipt reconciliation (the second supported lifecycle
	// hook alongside session_start): the worker reads qualifying disk
	// receipts against the bound session and acks them.
	pi.on("agent_settled", () => {
		sendToWorker({ event: "reconcile" });
	});

	// ── model-callable control tool ──
	pi.registerTool({
		name: "heartbeat_control",
		label: "Heartbeat Control",
		description:
			"Control the goal heartbeat for this session. " +
			"enable: arm idle wakes for ONE approved goal until it is explicitly completed or paused — pass a concise nextAction naming the goal (required; empty is rejected). " +
			"hold: defer heartbeat wakes until now + holdSeconds (absolute deadline; ordinary notifications unaffected; auto-resumes). " +
			"complete: end the active goal and enter the bounded ambient fallback (30-minute checks, fixed 2h expiry). " +
			"pause: silence all heartbeat wakes (including ambient) until enabled again — use this when blocked, waiting on a human, or fully stopped. " +
			"status: report mode, goal, delay, hold deadline, fallback expiry and suppression reasons.",
		promptSnippet: "Enable/hold/complete/pause/inspect the session's goal heartbeat",
		promptGuidelines: [
			"Use heartbeat_control enable once at the start of an approved goal with a concise nextAction describing it; idle wakes then re-arm automatically after every turn with no wake-count limit — do not call it again each turn.",
			"Use heartbeat_control hold for a known finite wait instead of letting heartbeats fire into a busy or deliberately deferred period.",
			"When the approved goal is genuinely done, call heartbeat_control complete and follow its handoff prompt; if blocked, waiting on a human, or stopping, call heartbeat_control pause and report the blocker — never invent work or authority.",
		],
		parameters: Type.Object({
			action: StringEnum(["enable", "hold", "complete", "pause", "status"] as const),
			nextAction: Type.Optional(
				Type.String({ description: "Required for enable: concise approved goal / next-action pointer quoted in every heartbeat" }),
			),
			idleDelaySeconds: Type.Optional(
				Type.Integer({ minimum: 5, maximum: 3600, description: "Idle delay before each goal heartbeat (default 30, max 3600)" }),
			),
			holdSeconds: Type.Optional(
				Type.Integer({ minimum: 1, maximum: 3600, description: "For hold: defer heartbeats until now + holdSeconds (e.g. 300)" }),
			),
		}, { additionalProperties: false }),
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			const result = control(params.action, params, ctx);
			const text = result.ok
				? result.message
					? `${result.message}\n${formatState(result.state)}`
					: formatState(result.state)
				: result.error;
			return {
				content: [{ type: "text", text }],
				details: result,
			};
		},
	});

	// ── human command sharing the same control state ──
	pi.registerCommand("hb", {
		description:
			"Goal heartbeat: /hb enable <next action> | /hb hold <seconds> | /hb complete | /hb pause | /hb status " +
			"(enable requires a non-empty next action)",
		handler: async (args, ctx) => {
			const text = (args ?? "").trim();
			const verb = text.split(/\s+/)[0] ?? "";
			const rest = text.slice(verb.length).trim();
			let result;
			if (verb === "enable") {
				result = control("enable", rest ? { nextAction: rest } : {}, ctx);
			} else if (verb === "hold") {
				result = control("hold", { holdSeconds: Number(rest) });
			} else if (verb === "complete" || verb === "pause" || verb === "status") {
				result = control(verb);
			} else {
				result = {
					ok: false,
					state: statusState(),
					error: "usage: /hb enable <next action> | /hb hold <seconds> | /hb complete | /hb pause | /hb status",
				};
			}
			const line = result.ok
				? result.message
					? `${result.message} — ${formatState(result.state)}`
					: formatState(result.state)
				: result.error;
			try {
				ctx?.ui?.notify?.(line, result.ok ? "info" : "warning");
			} catch {
				console.error(`[notifications] /hb: ${line}`);
			}
		},
	});
}
