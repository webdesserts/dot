/**
 * Context controls for Pi: `usage()` / `compact()` tools plus 40%/60%
 * context-pressure alerts. Sibling of notifications.ts (deliberately not
 * grown into it). Stock Pi public APIs only — no SDK patches, no settings
 * reads or changes (near-auto alerting is dropped for this slice because the
 * extension API exposes no settings).
 *
 * Preparation is the model's responsibility, not the compact tool's: compact()
 * only REQUESTS native compaction. An accepted request is not success — the
 * confirmed outcome surfaces through usage() and lifecycle events. Continuation
 * after compaction belongs to the existing goal heartbeat; no resume daemon.
 *
 * ── Safe dispatch (source-verified against the installed SDK) ──
 * The extension context's compact() runs AgentSession.compact(), which begins
 * with `await this.abort()` (dist/core/agent-session.js) — it aborts the
 * current operation and does NOT resume it. Calling it inline from a running
 * tool would kill sibling mutations. Therefore dispatch always happens from
 * `agent_settled` — documented as fired after an agent run has fully settled,
 * when no retry/compaction/continuation will run, so the abort() inside
 * compact() is a no-op there.
 *
 * Tool-batch coordination (parent-approved refinement, source-verified):
 * - The assistant message's tool-call list is snapshotted from `message_end`
 *   (the full batch is known before any call executes).
 * - A compact request BATCHED WITH SIBLING tool calls is REJECTED with a clear
 *   retry-alone message — queued compaction must not hang over unrelated work.
 * - An accepted SOLE compact call returns `terminate: true` on its result;
 *   the agent-core honors early termination only when EVERY finalized call in
 *   the batch sets it (pi-agent-core dist/harness/runtime/drive/tool-placement.js:
 *   `completedCalls.every((call) => call.status === "completed" && call.terminate)`),
 *   and the extension tool wrapper passes the result through unchanged
 *   (dist/core/extensions/wrapper.js), so a sole compact call ends the run
 *   right after the batch and agent_settled dispatches immediately.
 * - If the batch snapshot is unavailable, acceptance still carries
 *   terminate:true and degrades safely to waiting for the run's natural
 *   settle — siblings without terminate simply prevent early termination.
 * Human pause/cancel/new-session intent is never overridden (aborting the run
 * is out of scope).
 *
 * ── Alerts (40% / 60% of the context window) ──
 * Per-LEVEL DELIVERED state: a level alerts at most once per epoch. Oscillation
 * around a threshold (39%→41%→39%→41%) never re-alerts; the epoch resets only
 * on session start, a model/window change, or the silent post-unknown
 * re-baseline after compaction (null usage). Crossings observed in one
 * evaluation are coalesced into ONE notice; notices are replaced, never
 * accumulated. Dual-channel delivery, both stock and turn-free:
 * - `tool_result`: the pending notice is appended to the next tool result's
 *   content (afterToolCall adopts extension content), so the model sees it
 *   during the ONGOING run — no wake message, no extra LLM turn.
 * - `before_agent_start`: fallback for notices that never met a tool result
 *   (the SDK appends the returned custom message to the next run's inputs).
 * sendUserMessage is never called by this file.
 *
 * ── usage() ──
 * Reports the SDK's ctx.getContextUsage() (tokens, configured window, percent),
 * distinguishing unavailable from zero and calling out the intentional
 * post-compaction null, plus the CONFIRMED outcome of the last compaction
 * (success/failure/abort — an accepted request is never reported as success).
 */
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

/** Alert levels, as percentages of the context window. */
const LEVELS = [
	{ id: "p40", percent: 40, label: "40%" },
	{ id: "p60", percent: 60, label: "60%" },
];

const fmtK = (tokens) =>
	tokens >= 1000 ? `${Math.round(tokens / 100) / 10}k` : String(tokens);

export default function (pi) {
	// Native subagent children get no context controls (no inheritance).
	if (process.env.PI_SUBAGENT_CHILD === "1") return;

	let currentCtx = null;
	let owner = null;
	let generation = 0;

	// ── compaction request state ──
	// Current assistant-message tool-call batch (from message_end): the sole
	// vs. sibling decision input for the compact tool.
	let batchToolCalls = [];
	// pending: an accepted-but-not-yet-dispatched request. Cleared by dispatch,
	// by a native session_compact (auto fulfilled it), by any terminal
	// callback, or by session replacement. Never left stranded.
	let pending = null;
	// True from dispatch until a terminal callback/event: blocks a second
	// request racing into an already-running compaction operation.
	let inFlight = false;
	let lastCompaction = null;

	// ── alert state ──
	let lastPercent = null; // consecutive-observation baseline
	let sawUnknown = false; // null/unknown usage observed; next known value re-baselines silently
	let lastWindow = null;
	let lastModelId = null;
	let deliveredLevels = new Set(); // per-epoch delivered levels — no threshold flapping
	let pendingNotice = null; // replaced, never accumulated
	let pendingOutcome = null; // confirmed compaction outcome notice — delivered once

	const sessionOwner = (ctx = currentCtx) => {
		try {
			const id = ctx?.sessionManager?.getSessionId?.();
			return typeof id === "string" && id ? id : null;
		} catch {
			return null;
		}
	};

	const recordFailure = (outcome, detail) => {
		lastCompaction = { outcome, at: Date.now(), detail };
		pending = null;
		inFlight = false;
		notifyOutcome(lastCompaction);
	};

	// Confirmed compaction outcome, surfaced to the returning model through the
	// same turn-free channels as pressure alerts (tool_result append, else
	// before_agent_start fallback). Delivered once, never accumulated.
	const notifyOutcome = (compaction) => {
		const when = new Date(compaction.at).toISOString();
		pendingOutcome =
			compaction.outcome === "success"
				? `Compaction completed successfully at ${when}.`
				: compaction.outcome === "aborted"
					? `Compaction was aborted at ${when}.${compaction.detail ? ` ${compaction.detail}` : ""}`
					: `Compaction FAILED at ${when}.${compaction.detail ? ` ${compaction.detail}` : ""}`;
	};

	// Evaluation: per-epoch delivered state (level re-alerts only in a new
	// epoch), multi-threshold jumps coalesced into one notice.
	const evaluateAlerts = (ctx) => {
		const usage = (() => {
			try {
				return ctx?.getContextUsage?.();
			} catch {
				return undefined;
			}
		})();
		if (!usage) return; // no active model context: no chatter
		const modelId = (() => {
			try {
				return ctx?.model?.id ?? null;
			} catch {
				return null;
			}
		})();
		// Model/window change: new epoch, re-baseline silently.
		if (lastWindow !== null && usage.contextWindow !== lastWindow) {
			lastPercent = null;
			sawUnknown = false;
			deliveredLevels = new Set();
			pendingNotice = null;
		}
		if (lastModelId !== null && modelId !== null && modelId !== lastModelId) {
			lastPercent = null;
			sawUnknown = false;
			deliveredLevels = new Set();
			pendingNotice = null;
		}
		lastWindow = usage.contextWindow ?? lastWindow;
		lastModelId = modelId ?? lastModelId;
		if (usage.tokens === null || typeof usage.tokens !== "number") {
			// Unknown (e.g. right after compaction): stay silent and remember;
			// the next known value starts a NEW epoch silently, so compaction
			// followed by regrowth never re-emits 40/60 from stale state.
			sawUnknown = true;
			return;
		}
		const percent = typeof usage.percent === "number" ? usage.percent : (usage.tokens / usage.contextWindow) * 100;
		if (sawUnknown) {
			// Silent re-baseline after an unknown window; new epoch, no alert.
			sawUnknown = false;
			lastPercent = percent;
			deliveredLevels = new Set();
			return;
		}
		const prev = lastPercent;
		lastPercent = percent;
		if (prev === null) return; // first observation is the baseline
		const crossed = LEVELS.filter((l) => prev < l.percent && percent >= l.percent && !deliveredLevels.has(l.id));
		if (crossed.length === 0) return;
		for (const l of crossed) deliveredLevels.add(l.id);
		const parts = crossed.map((l) => l.label);
		pendingNotice =
			`Context pressure: usage crossed ${parts.join(" and ")} — now ${Math.round(percent)}% of the ` +
			`${fmtK(usage.contextWindow)}-token window (${fmtK(usage.tokens)} tokens). ` +
			"Native auto-compaction remains the safety net; consider running out the current task cleanly. " +
			"This notice is delivered once; do not act on stale context.";
	};

	// ── usage report ──
	const buildUsageReport = (ctx) => {
		const lines = [];
		let usage;
		try {
			usage = ctx?.getContextUsage?.();
		} catch {
			usage = undefined;
		}
		if (!usage) {
			lines.push("Context usage: unavailable (no active model context).");
		} else if (usage.tokens === null || typeof usage.tokens !== "number") {
			lines.push(
				`Context usage: tokens unknown (window ${fmtK(usage.contextWindow)} tokens). ` +
					"This is expected right after compaction, before the next assistant response — it is not zero.",
			);
		} else {
			const percent = typeof usage.percent === "number" ? usage.percent : (usage.tokens / usage.contextWindow) * 100;
			lines.push(
				`Context usage: ${fmtK(usage.tokens)} tokens of a ${fmtK(usage.contextWindow)}-token window (${Math.round(percent)}%).`,
			);
		}
		if (lastCompaction) {
			const when = new Date(lastCompaction.at).toISOString();
			if (lastCompaction.outcome === "success") {
				lines.push(
					`Last compaction: SUCCESS at ${when}` +
						(lastCompaction.tokensBefore !== undefined
							? ` (tokens before: ${fmtK(lastCompaction.tokensBefore)}` +
								(lastCompaction.estimatedTokensAfter !== undefined
									? `, after: ≈${fmtK(lastCompaction.estimatedTokensAfter)}`
									: "") +
								")"
							: "") +
						(lastCompaction.detail ? ` — ${lastCompaction.detail}` : "") +
						".",
				);
			} else if (lastCompaction.outcome === "aborted") {
				lines.push(`Last compaction: ABORTED at ${when}${lastCompaction.detail ? ` — ${lastCompaction.detail}` : ""}.`);
			} else {
				lines.push(`Last compaction: FAILED at ${when}${lastCompaction.detail ? ` — ${lastCompaction.detail}` : ""}.`);
			}
		} else {
			lines.push("Last compaction: none recorded by this session instance.");
		}
		return lines.join("\n");
	};

	// ── compaction dispatch ──
	const dispatchPending = (ctx) => {
		if (!pending) return;
		// agent_settled should imply idle, but an earlier handler may have
		// started a new run: do not dispatch (nor clear) into a running
		// session — a later settle will dispatch instead.
		try {
			if (ctx?.isIdle?.() === false) return;
		} catch {
			// idleness unknown: proceed (agent_settled remains the safe point)
		}
		const request = pending;
		// Stale request after session replacement: drop silently.
		if (request.owner !== sessionOwner(ctx)) {
			pending = null;
			return;
		}
		pending = null;
		const actualCompactionAfterRequest = () => {
			// Correlate a failure with an ACTUAL compaction appended to this same
			// session branch AFTER the request (ordering by entry index, not
			// timestamps — real entry timestamps are not epoch numbers). An error
			// string alone ("Already compacted") is never treated as fulfillment.
			try {
				const entries = ctx?.sessionManager?.getEntries?.() ?? [];
				for (let i = request.entryCount; i < entries.length; i++) {
					if (entries[i]?.type === "compaction") return true;
				}
			} catch {
				// Entry scan unavailable: no correlation evidence either way.
			}
			return false;
		};
		const finish = (outcome, detail, extra = {}) => {
			// A stale callback (old era) must return BEFORE touching inFlight or
			// any state belonging to the current era.
			if (request.generation !== generation || request.owner !== sessionOwner(ctx)) return;
			inFlight = false;
			if (outcome === "error" && actualCompactionAfterRequest()) {
				// The failure was a race with a real, later compaction in this
				// session — report the correlated fulfillment truthfully.
				lastCompaction = {
					outcome: "success",
					at: Date.now(),
					detail: `request fulfilled by an actual compaction observed after it (${detail ?? "native error"})`,
					...extra,
				};
			} else {
				lastCompaction = { outcome, at: Date.now(), detail, ...extra };
			}
			notifyOutcome(lastCompaction);
		};
		try {
			// Set the in-flight guard BEFORE dispatch: a terminal callback that
			// fires synchronously inside ctx.compact must already see it and
			// clear it — never a stranded guard from a later overwrite.
			inFlight = true;
			ctx.compact({
				customInstructions: request.customInstructions,
				onComplete: (result) =>
					finish("success", undefined, {
						tokensBefore: result?.tokensBefore,
						estimatedTokensAfter: result?.estimatedTokensAfter,
					}),
				onError: (error) => finish("error", error?.message ?? String(error)),
			});
		} catch (err) {
			// Stale extension context after reload/new-session must not strand state.
			finish("error", err?.message ?? String(err));
		}
	};

	pi.on("session_start", (event, ctx) => {
		currentCtx = ctx ?? null;
		owner = sessionOwner(ctx);
		generation += 1;
		// Fresh baseline per session instance: reload/resume/fork must not
		// replay old alerts or resurrect a stale compaction request.
		pending = null;
		inFlight = false;
		lastCompaction = null;
		pendingNotice = null;
		pendingOutcome = null;
		lastPercent = null;
		sawUnknown = false;
		deliveredLevels = new Set();
		lastWindow = null;
		lastModelId = null;
	});
	pi.on("session_shutdown", () => {
		// Invalidate the old era: queued requests, in-flight guards and pending
		// notices must not leak across shutdown.
		pending = null;
		inFlight = false;
		pendingNotice = null;
		pendingOutcome = null;
		generation += 1;
		currentCtx = null;
	});
	pi.on("message_end", (event, _ctx) => {
		// Snapshot the assistant message's full tool-call batch before tools run.
		const message = event?.message;
		if (message?.role === "assistant") {
			batchToolCalls = Array.isArray(message.content)
				? message.content.filter((c) => c?.type === "toolCall")
				: [];
		}
	});
	pi.on("turn_end", (_event, ctx) => {
		currentCtx = ctx ?? currentCtx;
		evaluateAlerts(ctx);
	});
	pi.on("agent_settled", (_event, ctx) => {
		currentCtx = ctx ?? currentCtx;
		dispatchPending(ctx);
	});
	pi.on("session_compact", (event, _ctx) => {
		// Native truth (ours or auto). Clears any pending request so a queued
		// dispatch never double-compacts an already-compacted session.
		pending = null;
		inFlight = false;
		lastCompaction = {
			outcome: "success",
			at: Date.now(),
			tokensBefore: event?.compactionEntry?.tokensBefore,
			detail: "confirmed by session_compact",
		};
		notifyOutcome(lastCompaction);
		// A pressure notice raised before compaction is stale history now —
		// drop it rather than delivering obsolete context.
		pendingNotice = null;
	});
	pi.on("session_compact_failed", (event, _ctx) => {
		recordFailure(event?.aborted ? "aborted" : "error", event?.errorMessage ?? "compaction failed or was aborted");
	});

	// Mid-run delivery: append the pending notice (pressure alert or confirmed
	// compaction outcome) to the NEXT tool result's content (the SDK adopts
	// extension tool_result content). The model sees it during the ongoing run
	// — no wake message, no extra LLM turn, nothing accumulated.
	pi.on("tool_result", (event, _ctx) => {
		const notice = pendingNotice ?? pendingOutcome;
		if (!notice) return undefined;
		pendingNotice = null;
		pendingOutcome = null;
		return {
			content: [...(Array.isArray(event?.content) ? event.content : []), { type: "text", text: notice }],
		};
	});

	// Fallback delivery: a notice that never met a tool result (e.g. raised by
	// the final turn of a run) rides along with the next run's inputs — still
	// no extra turn, still delivered once.
	pi.on("before_agent_start", (_event, _ctx) => {
		const notice = pendingNotice ?? pendingOutcome;
		if (!notice) return undefined;
		pendingNotice = null;
		pendingOutcome = null;
		return {
			message: {
				customType: "context-controls-notice",
				content: [{ type: "text", text: notice }],
			},
		};
	});

	// ── model-callable tools ──
	pi.registerTool({
		name: "usage",
		label: "Context Usage",
		description:
			"Report current context usage: estimated tokens, the configured model's context window, percent used, " +
			"and the confirmed outcome of the last compaction. Read-only: it never changes model or window settings.",
		promptSnippet: "Inspect context-window usage and last compaction outcome",
		parameters: Type.Object({}, { additionalProperties: false }),
		execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
			const text = buildUsageReport(ctx);
			return { content: [{ type: "text", text }], details: { report: text } };
		},
	});

	pi.registerTool({
		name: "compact",
		label: "Compact Context",
		description:
			"Request native context compaction for this session, with optional summary-focus instructions. " +
			"Call it as the ONLY tool call in your response: a batched call is rejected, and an accepted call " +
			"terminates the turn so compaction starts when the run settles (running it mid-turn would abort " +
			"sibling tool work). Acceptance is not success — check usage() for the confirmed outcome. " +
			"This tool does not do memory preparation and requires no checklist.",
		promptSnippet: "Request native compaction of the session context",
		parameters: Type.Object(
			{
				summaryFocus: Type.Optional(
					Type.String({ description: "Optional instructions focusing what the compaction summary preserves" }),
				),
			},
			{ additionalProperties: false },
		),
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			if (pending || inFlight) {
				return {
					content: [
						{
							type: "text",
							text:
								"A compaction request is already accepted and waiting for the current run to settle. " +
								"Not re-requesting. Check usage() for the confirmed outcome.",
						},
					],
					details: { ok: false, duplicate: true, inFlight },
				};
			}
			// Reject a compact call mixed with sibling tool calls: queued
			// compaction must not hang over unrelated sibling work. (The SDK
			// would ignore terminate anyway unless EVERY call in the batch sets it.)
			if (batchToolCalls.length > 1) {
				return {
					content: [
						{
							type: "text",
							text:
								`Compaction request REJECTED: it was batched with ${batchToolCalls.length - 1} sibling tool call(s). ` +
								"The sibling work must not be interrupted by compaction. Retry with compact as the ONLY tool " +
								"call in your response — the accepted call then terminates the turn and compaction starts at " +
								"settle. No request was recorded.",
						},
					],
					details: { ok: false, rejected: "siblings", batchSize: batchToolCalls.length },
				};
			}
			const focus = typeof params?.summaryFocus === "string" && params.summaryFocus.trim() ? params.summaryFocus.trim() : undefined;
		let entryCount = 0;
		try {
			const entries = ctx?.sessionManager?.getEntries?.();
			entryCount = Array.isArray(entries) ? entries.length : 0;
		} catch {
			entryCount = 0;
		}
		pending = { owner: sessionOwner(ctx), generation: ++generation, at: Date.now(), entryCount, customInstructions: focus };
			return {
				content: [
					{
						type: "text",
						text:
							"Compaction request accepted (not yet started). This call terminates the turn; compaction runs " +
							"automatically as soon as the run fully settles. Do not start new work in this turn. " +
							"This acceptance is not success: the confirmed outcome (success, failure, or abort) is reported " +
							"by the usage() tool. Ordinary continuation via the existing heartbeat is unaffected; nothing " +
							"is auto-resumed beyond it.",
					},
				],
				details: { ok: true, accepted: true, dispatched: false, terminate: true },
				// Ends the run right after this (sole) tool batch; agent_settled
				// then dispatches. Honored by the SDK only when every call in the
				// batch sets it — which is exactly the accepted case.
				terminate: true,
			};
		},
	});

	// Returned for the parent's future wiring; harmless if unused.
	return { __owner: () => owner };
}
