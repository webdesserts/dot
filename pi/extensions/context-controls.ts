/**
 * Context controls for Pi: `usage()` / `compact()` tools plus 40%/60%
 * context-pressure alerts for parents and native children. Stock Pi public
 * APIs only — no SDK patches or settings changes.
 *
 * compact() only REQUESTS native compaction; preparation is the model's job.
 * `AgentSession.compact()` begins with `await this.abort()` and never resumes
 * (dist/core/agent-session.js), so dispatch happens only from `agent_settled`
 * (abort() is a no-op there). A compact call batched with sibling tool calls
 * is rejected; an accepted sole call returns `terminate: true` — the agent
 * core ends the run after a batch only when EVERY call sets it
 * (pi-agent-core tool-placement.js) — so compaction starts at settle without
 * killing sibling work. Settlement is held through the terminal compact
 * callback, then a successful compaction queues a coalescible continuation
 * of the existing task. Failed/aborted compaction or observed session
 * replacement does not restart work.
 * Duplicate/in-flight guards, stale-callback fences by
 * session identity + generation, and requests are invalidated on session or
 * branch replacement. Fulfillment is correlated by a request-time branch
 * marker (entry count + leaf id): a native error string alone is never
 * success, and only a real, LATER compaction on the SAME branch fulfills.
 *
 * 40%/60% alerts: once per level per epoch. An epoch resets only on a
 * CONFIRMED compaction entry (session_compact, by entry identity) or a
 * model/window change; unknown (null) usage and decreases never reset it.
 * Delivered levels are persisted per session and restored across same-epoch
 * reload/resume. Crossings coalesce into one notice projected through the
 * stock context hook into the request being built. Alerts create no turn,
 * mutate no tool result and do not accumulate in session history. Confirmed
 * compaction outcomes and restoration guidance use sendMessage with
 * triggerTurn:false. A private extension-origin input token checks whether
 * restoration still needs an autonomous wake after earlier settled input
 * drains. A valid token transforms into a labeled user-role harness control
 * message within the original awaited prompt; stale tokens are handled.
 * The opaque token is never intentionally added to conversation history.
 */
import { Type } from "typebox";
import { randomUUID } from "node:crypto";

/** Alert levels, as percentages of the context window. */
const LEVELS = [
	{ id: "p40", percent: 40, label: "40%" },
	{ id: "p60", percent: 60, label: "60%" },
];

const ENTRY_TYPE = "context-controls-state";
// The owner-selected [system] label is provenance text, not a system role.
const RESTORATION_NOTICE = "[system] Your context has been compacted, please review the summary, validate it against the current world state, and load any relevant skills and notes that you will need to continue.";
const CONTINUATION_NOTICE = "[system] Harness continuation after compaction.";

const fmtK = (tokens) =>
	tokens >= 1000 ? `${Math.round(tokens / 100) / 10}k` : String(tokens);

export default function (pi) {
	let currentCtx = null;
	let generation = 0;

	// ── compaction request state ──
	let batchToolCalls = [];
	let pending = null; // accepted request, awaiting agent_settled dispatch
	let inFlight = false; // dispatched, awaiting a terminal callback/event
	let lastCompaction = null; // latest confirmed truth (success/error/abort)
	let notifiedKey = null; // dedupe: one outcome announcement per operation
	let inFlightRequest = null; // the request object while dispatched
	let restoration = null;
	// A runtime-private namespace lets stale owned tokens be dropped without
	// retaining a growing collection of old requests or intercepting other input.
	const resumePrefix = `context-controls-resume:${randomUUID()}:`;
	let resumeToken = null;

	// ── alert state ──
	let lastPercent = null; // consecutive-observation baseline
	let lastWindow = null;
	let lastModelId = null;
	let deliveredLevels = new Set(); // per-epoch delivered levels
	let epochMarker = null; // compaction entry id defining the current epoch
	let pendingNotice = null; // replaced, never accumulated

	const sessionOwner = (ctx = currentCtx) => {
		try {
			const id = ctx?.sessionManager?.getSessionId?.();
			return typeof id === "string" && id ? id : null;
		} catch {
			return null;
		}
	};

	const modelIdentity = (ctx) => {
		try { return ctx?.model ? `${ctx.model.provider ?? ""}/${ctx.model.id}` : null; }
		catch { return null; }
	};
	const latestCompactionId = (ctx) => {
		try { return ctx?.sessionManager?.getBranch?.().filter((e) => e.type === "compaction").at(-1)?.id ?? null; }
		catch { return null; }
	};
	const invalidateRequests = () => {
		generation += 1;
		pending = null;
		inFlight = false;
		inFlightRequest = null;
		restoration = null;
		resumeToken = null;
	};

	const recordFailure = (outcome, detail) => {
		lastCompaction = { outcome, at: Date.now(), detail };
		pending = null;
		inFlight = false;
		notifyOutcome(`fail:${Date.now()}`, lastCompaction);
	};

	// Branch marker + correlation: only a compaction entry appended to the
	// CURRENT branch AFTER the request (order, not timestamps) fulfills it.
	const branchSnapshot = (ctx) => {
		try {
			const branch = ctx?.sessionManager?.getBranch?.();
			if (!Array.isArray(branch)) return null;
			return { count: branch.length, leafId: branch.at(-1)?.id ?? null };
		} catch {
			return null;
		}
	};

	const fulfilledAfterRequest = (ctx, request) => {
		if (!request.marker) return false; // marker unavailable: refuse
		try {
			const branch = ctx?.sessionManager?.getBranch?.();
			if (!Array.isArray(branch)) return false;
			if (branch.length < request.marker.count) return false; // branch replaced/shortened
			if (request.marker.leafId !== null && branch[request.marker.count - 1]?.id !== request.marker.leafId) {
				return false; // leaf changed: request belongs to another branch
			}
			for (let i = request.marker.count; i < branch.length; i++) {
				if (branch[i]?.type === "compaction") return true;
			}
		} catch {
			return false;
		}
		return false;
	};

	const notifyOutcome = (key, record) => {
		if (notifiedKey === key) return; // one outcome per operation
		notifiedKey = key;
		lastCompaction = record;
		const when = new Date(record.at).toISOString();
		const text =
			record.outcome === "success"
				? `Compaction completed successfully at ${when}.`
				: record.outcome === "aborted"
					? `Compaction was aborted at ${when}.${record.detail ? ` ${record.detail}` : ""}`
					: `Compaction FAILED at ${when}.${record.detail ? ` ${record.detail}` : ""}`;
		// Simple no-turn confirmed-outcome channel: appended to session
		// history immediately (or queued to the run flush mid-run) — the
		// model sees it without any extra conversational turn.
		try {
			pi.sendMessage(
				{ customType: "context-controls-notice", content: [{ type: "text", text }] },
				{ triggerTurn: false },
			);
		} catch (err) {
			console.error(`[context-controls] outcome delivery failed: ${err}`);
		}
	};

	// ── alert evaluation ──
	const evaluateAlerts = (ctx) => {
		const usage = (() => {
			try {
				return ctx?.getContextUsage?.();
			} catch {
				return undefined;
			}
		})();
		if (!usage) return;
		const modelId = modelIdentity(ctx);
		// Model/window change: new epoch, re-baseline silently.
		if ((lastWindow !== null && usage.contextWindow !== lastWindow) ||
			(lastModelId !== null && modelId !== null && modelId !== lastModelId)) {
			lastPercent = null;
			deliveredLevels = new Set();
			pendingNotice = null;
		}
		lastWindow = usage.contextWindow ?? lastWindow;
		lastModelId = modelId ?? lastModelId;
		if (usage.tokens === null || typeof usage.tokens !== "number") {
			// Unknown (may happen post-compaction): never resets the epoch.
			return;
		}
		const percent = typeof usage.percent === "number" ? usage.percent : (usage.tokens / usage.contextWindow) * 100;
		const prev = lastPercent;
		lastPercent = percent;
		if (prev === null) return; // first observation is the baseline
		const crossed = LEVELS.filter(
			(l) => prev < l.percent && percent >= l.percent && !deliveredLevels.has(l.id),
		);
		if (crossed.length === 0) return;
		for (const l of crossed) deliveredLevels.add(l.id);
		persistEpoch();
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
		try {
			if (ctx?.isIdle?.() === false) return; // a new run started: wait for the next settle
		} catch {
			// idleness unknown: proceed (agent_settled remains the safe point)
		}
		const request = pending;
		if (request.owner !== sessionOwner(ctx)) {
			pending = null;
			return;
		}
		pending = null;
		// The handle for the operation currently dispatched: native terminal
		// events clear it so our callbacks never double-record the same op.
		inFlightRequest = request;
		let completeDispatch;
		const completion = new Promise((resolve) => { completeDispatch = resolve; });
		const complete = () => completeDispatch(request);
		try {
			inFlight = true;
			ctx.compact({
				customInstructions: request.customInstructions,
				onComplete: (result) => {
					finish(request, "success", undefined, {
						tokensBefore: result?.tokensBefore,
						estimatedTokensAfter: result?.estimatedTokensAfter,
					});
					complete();
				},
				onError: (error) => {
					finish(request, "error", error?.message ?? String(error));
					complete();
				},
			});
		} catch (err) {
			finish(request, "error", err?.message ?? String(err));
			complete();
		}
		return completion;
	};

	// Terminal record for OUR dispatched operation. Stale-era callbacks and
	// operations already recorded by their native event are skipped.
	const finish = (request, outcome, detail, extra = {}) => {
		if (inFlightRequest !== request || request.generation !== generation ||
			request.owner !== sessionOwner(currentCtx)) return;
		inFlightRequest = null;
		inFlight = false;
		if (outcome === "error" && fulfilledAfterRequest(currentCtx, request)) {
			notifyOutcome(`op:${request.generation}`, {
				outcome: "success",
				at: Date.now(),
				detail: `request fulfilled by an actual compaction observed after it (${detail ?? "native error"})`,
				...extra,
			});
			return;
		}
		notifyOutcome(`op:${request.generation}`, { outcome, at: Date.now(), detail, ...extra });
	};

	// ── epoch persistence (delivered levels survive same-epoch reload) ──
	const persistEpoch = () => {
		try {
			pi.appendEntry(ENTRY_TYPE, {
				owner: sessionOwner(),
				modelId: modelIdentity(currentCtx),
				contextWindow: currentCtx?.getContextUsage?.()?.contextWindow ?? lastWindow,
				epochMarker,
				leafId: branchSnapshot(currentCtx)?.leafId ?? null,
				delivered: [...deliveredLevels],
			});
		} catch {
			// Ephemeral sessions: in-memory state still works.
		}
	};

	const restoreEpoch = (ctx) => {
		try {
			const branch = ctx?.sessionManager?.getBranch?.();
			if (!Array.isArray(branch)) return false;
			const self = sessionOwner(ctx);
			const entries = ctx?.sessionManager?.getEntries?.() ?? [];
			for (let i = entries.length - 1; i >= 0; i--) {
				const e = entries[i];
				if (e?.type !== "custom" || e?.customType !== ENTRY_TYPE) continue;
				if (e?.data?.owner !== self) continue;
				if (e.data.modelId !== modelIdentity(ctx) ||
					e.data.contextWindow !== ctx?.getContextUsage?.()?.contextWindow ||
					e.data.epochMarker !== latestCompactionId(ctx)) return false;
				// The persisted epoch is valid only if its defining identity
				// still exists on the current branch: the confirmed compaction
				// entry, or (pre-compaction epochs) the persisted leaf entry.
				const marker = e?.data?.epochMarker;
				const leafId = e?.data?.leafId;
				const markerOnBranch = typeof marker === "string" && branch.some((b) => b?.id === marker);
				const leafOnBranch = typeof leafId === "string" && branch.some((b) => b?.id === leafId);
				// Initial epoch (no compaction yet, empty branch): same-session
				// reload keeps the epoch; anything else starts fresh.
				if (!markerOnBranch && !leafOnBranch && !(marker === null && leafId === null)) return false;
				deliveredLevels = new Set(
					Array.isArray(e.data.delivered) ? e.data.delivered.filter((x) => typeof x === "string") : [],
				);
				epochMarker = marker;
				return true;
			}
		} catch {
			return false;
		}
		return false;
	};

	pi.on("session_start", (event, ctx) => {
		currentCtx = ctx ?? null;
		invalidateRequests();
		batchToolCalls = [];
		lastCompaction = null;
		pendingNotice = null;
		notifiedKey = null;
		lastPercent = null;
		lastWindow = null;
		lastModelId = null;
		// Same-epoch reload/resume keeps delivered announcements; new/fork
		// sessions (or a stale epoch) start fresh.
		const reason = event?.reason;
		const restored = reason !== "new" && reason !== "fork" && restoreEpoch(ctx);
		if (!restored) {
			deliveredLevels = new Set();
			epochMarker = latestCompactionId(ctx);
		}
	});
	pi.on("session_shutdown", () => {
		invalidateRequests();
		pendingNotice = null;
		notifiedKey = null;
		currentCtx = null;
	});
	pi.on("session_before_switch", invalidateRequests);
	pi.on("session_before_tree", invalidateRequests);
	pi.on("session_before_fork", invalidateRequests);
	pi.on("message_end", (event, _ctx) => {
		const message = event?.message;
		if (message?.role === "assistant") {
			batchToolCalls = Array.isArray(message.content)
				? message.content.filter((c) => c?.type === "toolCall")
				: [];
		}
	});
	pi.on("context", (event, ctx) => {
		currentCtx = ctx ?? currentCtx;
		evaluateAlerts(ctx);
		const notice = pendingNotice;
		pendingNotice = null;
		if (!notice) return;
		// Project once into the request being built, without starting a turn,
		// changing tool output, or accumulating alert messages in history.
		return { messages: [...event.messages, {
			role: "custom", customType: "context-controls-notice",
			content: [{ type: "text", text: notice }], display: false, timestamp: Date.now(),
		}] };
	});
	pi.on("before_agent_start", () => {
		// Any real run (including a newer user request) consumes the need for
		// an autonomous wake. The durable notice is already in its context.
		restoration = null;
		resumeToken = null;
	});
	pi.on("input", (event, ctx) => {
		if (event.source !== "extension" || !event.text.startsWith(resumePrefix)) return;
		// An older owned token must not consume a newer request's wake.
		if (event.text !== resumeToken) return { action: "handled" };
		const requirement = restoration;
		const canResume = requirement && requirement.owner === sessionOwner(ctx) &&
			requirement.generation === generation && lastCompaction?.outcome === "success";
		resumeToken = null;
		if (!canResume) return { action: "handled" };
		restoration = null;
		// Keep this run inside AgentSession's awaited deferred prompt. Starting
		// a separate sendMessage run here would let the parent/child finish early.
		return { action: "transform", text: CONTINUATION_NOTICE };
	});
	pi.on("agent_settled", async (event, ctx) => {
		currentCtx = ctx ?? currentCtx;
		if (event.aborted) {
			pending = null;
			restoration = null;
			resumeToken = null;
			return;
		}
		const completion = dispatchPending(ctx);
		const request = completion && await completion;
		if (request && request.owner === sessionOwner(currentCtx) &&
			request.generation === generation && lastCompaction?.outcome === "success" &&
			restoration?.generation === request.generation) {
			// Settled actions are awaited in order by AgentSession. A newer
			// deferred user run may finish before this token reaches input;
			// recheck there, rather than enqueueing an unconditional model run.
			resumeToken = `${resumePrefix}${request.generation}`;
			pi.sendUserMessage(resumeToken);
		}
	});
	pi.on("session_compact", (event, ctx) => {
		currentCtx = ctx ?? currentCtx;
		// Native truth (ours or auto). Clears any pending request so a queued
		// dispatch never double-compacts, and starts a NEW alert epoch by the
		// confirmed entry identity.
		const entryId = typeof event?.compactionEntry?.id === "string" ? event.compactionEntry.id : null;
		pending = null;
		const key = entryId ? `entry:${entryId}` : `native:${Date.now()}`;
		lastCompaction = {
			outcome: "success",
			at: Date.now(),
			tokensBefore: event?.compactionEntry?.tokensBefore,
			detail: "confirmed by session_compact",
		};
		inFlightRequest = null;
		inFlight = false;
		notifyOutcome(key, lastCompaction);
		restoration = { owner: sessionOwner(), generation };
		pi.sendMessage({ customType: "context-controls-restoration", display: false,
			content: [{ type: "text", text: RESTORATION_NOTICE }] }, { triggerTurn: false });
		// New epoch by confirmed entry identity: levels may announce again as
		// usage regrows. A stale pre-compaction pressure notice is dropped.
		deliveredLevels = new Set();
		epochMarker = entryId;
		pendingNotice = null;
		persistEpoch();
	});
	pi.on("session_compact_failed", (event, _ctx) => {
		const detail = event?.errorMessage ?? "compaction failed or was aborted";
		const outcome = event?.aborted ? "aborted" : "error";
		if (inFlightRequest) {
			// The native failure for OUR dispatched operation: record it here;
			// the wrapped onError/onComplete is deduplicated against this.
			const request = inFlightRequest;
			inFlightRequest = null;
			inFlight = false;
			if (request.generation !== generation || request.owner !== sessionOwner(currentCtx)) return;
			if (outcome !== "aborted" && fulfilledAfterRequest(currentCtx, request)) {
				notifyOutcome(`op:${request.generation}`, {
					outcome: "success",
					at: Date.now(),
					detail: `request fulfilled by an actual compaction observed after it (${detail})`,
				});
				return;
			}
			notifyOutcome(`op:${request.generation}`, { outcome, at: Date.now(), detail });
			return;
		}
		recordFailure(outcome, detail);
	});

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
			"After compaction finishes, the session continues its existing approved task; no heartbeat is required. " +
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
			const marker = branchSnapshot(ctx);
			pending = {
				owner: sessionOwner(ctx),
				generation: ++generation,
				marker,
				customInstructions: focus,
			};
			return {
				content: [
					{
						type: "text",
						text:
							"Compaction request accepted (not yet started). This call terminates the turn; compaction runs " +
							"automatically as soon as the run fully settles. Do not start new work in this turn. " +
							"This acceptance is not success: the confirmed outcome (success, failure, or abort) is reported " +
							"by the usage() tool. After the terminal compaction callback, the session continues its existing " +
							"approved task without needing a heartbeat. A failed/aborted compaction or replaced session does not restart work.",
					},
				],
				details: { ok: true, accepted: true, dispatched: false, terminate: true },
				terminate: true,
			};
		},
	});
}
