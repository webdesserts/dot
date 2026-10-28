/**
 * Context controls for Pi: `usage()` / `compact()` tools plus durable, visible
 * context-pressure alerts at 40 % and 60 % of the active context window.
 * Generic (public dots) — used on all of Michael's machines.
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
 * Alerts — durable + visible:
 *   Delivered via pi.sendMessage({ display: true }, { triggerTurn: false }).
 *   Each alert is stored in session history, shown in the TUI, sent to the
 *   model on subsequent requests, and never starts a new turn.  Called from
 *   the `context` hook (which fires before every model request) so that a
 *   crossing detected during a tool-heavy run is queued to the current run
 *   flush and lands at the next model request without delay.
 *
 *   40%: nudge to consolidate Working Memory and notes, look for a compact point.
 *   60%: direct to wrap up, consolidate, and compact; states the actual
 *        auto-compaction threshold derived from compaction.reserveTokens in
 *        settings (default 16 384 tokens → computed %).
 *   One alert per level per epoch; epoch resets on a confirmed compaction or
 *   model/window change.  Delivered levels persisted via appendEntry and
 *   restored across same-epoch reload/resume.
 *
 * Model / window change:
 *   A visible notice is sent naming the old and new window sizes, the current
 *   percentage, and any applicable threshold guidance for levels already exceeded
 *   under the new window.
 *
 * Resume / reload / new process:
 *   If the first usage observation in a new epoch already exceeds an undelivered
 *   level, that alert fires once instead of silently baselining.
 *
 * session_compact:
 *   The visible outcome notice names the trigger reason ("Automatic compaction
 *   (context threshold)", "Overflow-recovery compaction", or "Manual compaction").
 *   The model-facing restoration message explicitly instructs re-validation of
 *   world state, reloading of needed skills/notes, and updating Working Memory
 *   with anything the summary may have lost.
 *
 * Restoration wake: a private extension-origin input token checks whether
 * restoration still needs an autonomous wake after earlier settled input
 * drains. A valid token transforms into a labeled user-role harness control
 * message within the original awaited prompt; stale tokens are handled.
 * The opaque token is never intentionally added to conversation history.
 */
import type { ExtensionAPI, SessionStartEvent, SessionCompactEvent, SessionShutdownEvent } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { randomUUID } from "node:crypto";

/** Alert levels, as percentages of the context window. */
const LEVELS = [
	{ id: "p40", percent: 40 },
	{ id: "p60", percent: 60 },
] as const;

type LevelId = typeof LEVELS[number]["id"];

const ENTRY_TYPE = "context-controls-state";
// The owner-selected [system] label is provenance text, not a system role.
const CONTINUATION_NOTICE = "[system] Harness continuation after compaction.";

const fmtK = (tokens: number) =>
	tokens >= 1000 ? `${Math.round(tokens / 100) / 10}k` : String(tokens);

// Reason labels for compaction notices.
const REASON_LABEL: Record<string, string> = {
	threshold: "Automatic compaction (context threshold)",
	overflow: "Overflow-recovery compaction",
	manual: "Manual compaction",
};

// Build the model-facing restoration instruction, naming the trigger reason.
const buildRestorationText = (reason: string): string => {
	const label = REASON_LABEL[reason] ?? "Compaction";
	return (
		`[system] ${label} just completed. ` +
		"Re-validate your understanding of the current world state against the compaction summary. " +
		"Reload any skills or notes you will need. " +
		"Update your Working Memory with anything the summary may have omitted or oversimplified. " +
		"Resume your task from where you left off."
	);
};

export default function contextControlsExtension(pi: ExtensionAPI) {
	let currentCtx: import("@earendil-works/pi-coding-agent").ExtensionContext | null = null;
	let generation = 0;

	// ── compaction request state ──
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let batchToolCalls: any[] = [];
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let pending: any = null; // accepted request, awaiting agent_settled dispatch
	let inFlight = false; // dispatched, awaiting a terminal callback/event
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let lastCompaction: any = null; // latest confirmed truth (success/error/abort)
	let notifiedKey: string | null = null; // dedupe: one outcome announcement per operation
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let inFlightRequest: any = null; // the request object while dispatched
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let restoration: any = null;
	// A runtime-private namespace lets stale owned tokens be dropped without
	// retaining a growing collection of old requests or intercepting other input.
	const resumePrefix = `context-controls-resume:${randomUUID()}:`;
	let resumeToken: string | null = null;

	// ── alert state ──
	let lastPercent: number | null = null; // consecutive-observation baseline
	let lastWindow: number | null = null;
	let lastModelId: string | null = null;
	let deliveredLevels = new Set<LevelId>(); // per-epoch delivered levels
	let epochMarker: string | null = null; // compaction entry id defining the current epoch

	// ── helpers ──
	const sessionOwner = (ctx = currentCtx) => {
		try {
			const id = ctx?.sessionManager?.getSessionId?.();
			return typeof id === "string" && id ? id : null;
		} catch {
			return null;
		}
	};

	const modelIdentity = (ctx: typeof currentCtx) => {
		try { return ctx?.model ? `${ctx.model.provider ?? ""}/${ctx.model.id}` : null; }
		catch { return null; }
	};
	const latestCompactionId = (ctx: typeof currentCtx) => {
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

	const recordFailure = (outcome: string, detail?: string): void => {
		lastCompaction = { outcome, at: Date.now(), detail };
		pending = null;
		inFlight = false;
		notifyOutcome(`fail:${Date.now()}`, lastCompaction);
	};

	// Branch marker + correlation: only a compaction entry appended to the
	// CURRENT branch AFTER the request (order, not timestamps) fulfills it.
	const branchSnapshot = (ctx: typeof currentCtx): { count: number; leafId: string | null } | null => {
		try {
			const branch = ctx?.sessionManager?.getBranch?.();
			if (!Array.isArray(branch)) return null;
			return { count: branch.length, leafId: branch.at(-1)?.id ?? null };
		} catch {
			return null;
		}
	};

	const fulfilledAfterRequest = (ctx: typeof currentCtx, request: any): boolean => {
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

	const notifyOutcome = (key: string, record: any): void => {
		if (!record) return;
		if (notifiedKey === key) return; // one outcome per operation
		notifiedKey = key;
		lastCompaction = record;
		const when = new Date(record.at).toISOString();
		let text: string;
		if (record.outcome === "success") {
			const label = REASON_LABEL[record.reason ?? "manual"] ?? "Compaction";
			text = `${label} completed successfully at ${when}.`;
		} else if (record.outcome === "aborted") {
			text = `Compaction was aborted at ${when}.${record.detail ? ` ${record.detail}` : ""}`;
		} else {
			text = `Compaction FAILED at ${when}.${record.detail ? ` ${record.detail}` : ""}`;
		}
		// Simple no-turn confirmed-outcome channel: appended to session
		// history immediately (or queued to the run flush mid-run) — the
		// model sees it without any extra conversational turn.
		try {
			pi.sendMessage(
				{ customType: "context-controls-notice", display: true, content: [{ type: "text", text }] },
				{ triggerTurn: false },
			);
		} catch (err) {
			console.error(`[context-controls] outcome delivery failed: ${err}`);
		}
	};

	// ── auto-compact threshold ──
	/** Compute the effective auto-compaction trigger as a percentage of the given window. */
	const autoCompactPercent = (window: number): string | null => {
		try {
			const settings = pi.getSettings() as Record<string, unknown>;
			const compaction = settings?.compaction as Record<string, unknown> | undefined;
			const reserve = typeof compaction?.reserveTokens === "number" ? compaction.reserveTokens : 16384;
			if (!window || window <= 0) return null;
			return `${Math.round((1 - reserve / window) * 100)}%`;
		} catch {
			return null;
		}
	};

	/** Format "N% (Mk / Wk tokens)" */
	const fmtCtx = (percent: number, tokens: number, window: number) =>
		`${Math.round(percent)}% (${fmtK(tokens)} / ${fmtK(window)} tokens)`;

	/** Build the body text for a single alert level. */
	const alertText = (level: typeof LEVELS[number], percent: number, tokens: number, window: number): string => {
		const loc = fmtCtx(percent, tokens, window);
		if (level.id === "p40") {
			return (
				`Context at ${loc}. ` +
				"Start consolidating your Working Memory and notes, and look for the next good pause point to compact."
			);
		}
		// p60
		const autoPct = autoCompactPercent(window);
		const autoNote = autoPct ? ` Auto-compaction will trigger at ~${autoPct}.` : "";
		return (
			`Context at ${loc}. ` +
			"Wrap up what you're doing, consolidate Working Memory and notes, then compact (use the compact tool)." +
			autoNote
		);
	};

	/** Send a durable, visible alert via pi.sendMessage. */
	const sendAlert = (levels: ReadonlyArray<typeof LEVELS[number]>, percent: number, tokens: number, window: number) => {
		// If multiple levels crossed at once, report the highest one's guidance.
		const level = levels[levels.length - 1];
		const text = alertText(level, percent, tokens, window);
		try {
			pi.sendMessage(
				{ customType: "context-controls-notice", display: true, content: [{ type: "text", text }] },
				{ triggerTurn: false },
			);
		} catch (err) {
			console.error(`[context-controls] alert delivery failed: ${err}`);
		}
	};

	/** Send a durable, visible notice about a model/window change. */
	const sendWindowChangeNotice = (
		oldWindow: number | null,
		newWindow: number,
		percent: number | null,
		tokens: number | null,
		pastLevels: ReadonlyArray<typeof LEVELS[number]>,
	) => {
		const oldStr = oldWindow ? `${fmtK(oldWindow)} tokens` : "unknown";
		const newStr = `${fmtK(newWindow)} tokens`;
		let text = `Context window changed: ${oldStr} → ${newStr}.`;
		if (percent !== null && tokens !== null) {
			text += ` You're now at ${fmtCtx(percent, tokens, newWindow)}.`;
			if (pastLevels.length > 0) {
				// Append the highest threshold's guidance.
				text += " " + alertText(pastLevels[pastLevels.length - 1], percent, tokens, newWindow);
			}
		} else {
			text += " Context percentage will be reported at the next model response.";
		}
		try {
			pi.sendMessage(
				{ customType: "context-controls-notice", display: true, content: [{ type: "text", text }] },
				{ triggerTurn: false },
			);
		} catch (err) {
			console.error(`[context-controls] window-change notice failed: ${err}`);
		}
	};

	// ── alert evaluation ──
	const evaluateAlerts = (ctx: typeof currentCtx) => {
		const usage = (() => {
			try {
				return ctx?.getContextUsage?.();
			} catch {
				return undefined;
			}
		})();
		if (!usage) return;

		const modelId = modelIdentity(ctx);
		const windowChanged = lastWindow !== null && usage.contextWindow !== lastWindow;
		const modelChanged = lastModelId !== null && modelId !== null && modelId !== lastModelId;

		if (windowChanged || modelChanged) {
			const oldWindow = lastWindow;
			// Reset epoch for the new model/window.
			lastPercent = null;
			deliveredLevels = new Set();
			lastWindow = usage.contextWindow ?? lastWindow;
			lastModelId = modelId ?? lastModelId;

			// Send a visible change notice, including threshold guidance if already exceeded.
			if (usage.tokens !== null && typeof usage.tokens === "number") {
				const percent = typeof usage.percent === "number"
					? usage.percent
					: (usage.tokens / usage.contextWindow) * 100;
				const pastLevels = LEVELS.filter((l) => percent >= l.percent);
				for (const l of pastLevels) deliveredLevels.add(l.id);
				if (pastLevels.length > 0) persistEpoch();
				sendWindowChangeNotice(oldWindow, usage.contextWindow, percent, usage.tokens, pastLevels);
				lastPercent = percent;
			} else {
				sendWindowChangeNotice(oldWindow, usage.contextWindow, null, null, []);
			}
			return;
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
		if (prev === null) {
			// First observation in this epoch.  For resume/reload: if already past
			// any undelivered threshold, alert once instead of silently baselining.
			const past = LEVELS.filter((l) => percent >= l.percent && !deliveredLevels.has(l.id));
			if (past.length > 0) {
				for (const l of past) deliveredLevels.add(l.id);
				persistEpoch();
				sendAlert(past, percent, usage.tokens, usage.contextWindow);
			}
			return;
		}

		// Normal crossing detection.
		const crossed = LEVELS.filter(
			(l) => prev < l.percent && percent >= l.percent && !deliveredLevels.has(l.id),
		);
		if (crossed.length === 0) return;
		for (const l of crossed) deliveredLevels.add(l.id);
		persistEpoch();
		sendAlert(crossed, percent, usage.tokens, usage.contextWindow);
	};

	// ── usage report ──
	const buildUsageReport = (ctx: typeof currentCtx) => {
		const lines: string[] = [];
		let usage: ReturnType<NonNullable<typeof ctx>["getContextUsage"]> | undefined;
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
	const dispatchPending = (ctx: typeof currentCtx): Promise<any> | undefined => {
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
		let completeDispatch: (r: typeof request) => void;
		const completion = new Promise<typeof request>((resolve) => { completeDispatch = resolve; });
		const complete = () => completeDispatch(request);
		try {
			inFlight = true;
			ctx!.compact({
				customInstructions: request.customInstructions,
				onComplete: (result) => {
					finish(request, "success", undefined, {
						tokensBefore: result?.tokensBefore,
						estimatedTokensAfter: result?.estimatedTokensAfter,
					});
					complete();
				},
				onError: (error: Error) => {
					finish(request, "error", error?.message ?? String(error));
					complete();
				},
			});
		} catch (err) {
			finish(request, "error", (err as Error)?.message ?? String(err));
			complete();
		}
		return completion;
	};

	// Terminal record for OUR dispatched operation. Stale-era callbacks and
	// operations already recorded by their native event are skipped.
	const finish = (
		request: any,
		outcome: string,
		detail?: string,
		extra: Record<string, unknown> = {},
	): void => {
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

	const restoreEpoch = (ctx: typeof currentCtx) => {
		try {
			const branch = ctx?.sessionManager?.getBranch?.();
			if (!Array.isArray(branch)) return false;
			const self = sessionOwner(ctx);
			const entries = ctx?.sessionManager?.getEntries?.() ?? [];
			for (let i = entries.length - 1; i >= 0; i--) {
				const e = entries[i];
				if (e?.type !== "custom" || e?.customType !== ENTRY_TYPE) continue;
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const d = e?.data as any;
				if (d?.owner !== self) continue;
				if (d.modelId !== modelIdentity(ctx) ||
					d.contextWindow !== ctx?.getContextUsage?.()?.contextWindow ||
					d.epochMarker !== latestCompactionId(ctx)) return false;
				const marker = d?.epochMarker;
				const leafId = d?.leafId;
				const markerOnBranch = typeof marker === "string" && branch.some((b) => b?.id === marker);
				const leafOnBranch = typeof leafId === "string" && branch.some((b) => b?.id === leafId);
				// The persisted epoch is valid only if its defining identity
				// still exists on the current branch: the confirmed compaction
				// entry, or (pre-compaction epochs) the persisted leaf entry.
				// Initial epoch (no compaction yet, empty branch): same-session
				// reload keeps the epoch; anything else starts fresh.
				if (!markerOnBranch && !leafOnBranch && !(marker === null && leafId === null)) return false;
				deliveredLevels = new Set(
					Array.isArray(d.delivered) ? d.delivered.filter((x: unknown) => typeof x === "string") : [],
				);
				epochMarker = marker;
				return true;
			}
		} catch {
			return false;
		}
		return false;
	};

	// ── lifecycle ──
	pi.on("session_start", (event: SessionStartEvent, ctx) => {
		currentCtx = ctx ?? null;
		invalidateRequests();
		batchToolCalls = [];
		lastCompaction = null;
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
	pi.on("session_shutdown", (_event: SessionShutdownEvent, _ctx) => {
		invalidateRequests();
		notifiedKey = null;
		currentCtx = null;
	});
	pi.on("session_before_switch", invalidateRequests);
	pi.on("session_before_tree", invalidateRequests);
	pi.on("session_before_fork", invalidateRequests);
	pi.on("message_end", (event, _ctx) => {
		const message = (event as { message?: { role?: string; content?: unknown[] } })?.message;
		if (message?.role === "assistant") {
			batchToolCalls = Array.isArray(message.content)
				? (message.content as { type?: string }[]).filter((c) => c?.type === "toolCall")
				: [];
		}
	});
	pi.on("context", (event, ctx) => {
		currentCtx = ctx ?? currentCtx;
		evaluateAlerts(ctx);
		// Alerts are now sent via pi.sendMessage (durable, visible) — no longer
		// injected as ephemeral one-shot messages into the request being built.
	});
	pi.on("before_agent_start", () => {
		// Any real run (including a newer user request) consumes the need for
		// an autonomous wake. The durable notice is already in its context.
		restoration = null;
		resumeToken = null;
	});
	pi.on("input", (event, ctx) => {
		if ((event as { source?: string; text?: string }).source !== "extension" ||
			!(event as { text?: string }).text?.startsWith(resumePrefix)) return;
		// An older owned token must not consume a newer request's wake.
		if ((event as { text: string }).text !== resumeToken) return { action: "handled" } as const;
		const requirement = restoration;
		const canResume = requirement && requirement.owner === sessionOwner(ctx) &&
			requirement.generation === generation && lastCompaction?.outcome === "success";
		resumeToken = null;
		if (!canResume) return { action: "handled" } as const;
		restoration = null;
		// Keep this run inside AgentSession's awaited deferred prompt. Starting
		// a separate sendMessage run here would let the parent/child finish early.
		return { action: "transform", text: CONTINUATION_NOTICE } as const;
	});
	pi.on("agent_settled", async (event, ctx) => {
		currentCtx = ctx ?? currentCtx;
		if ((event as { aborted?: boolean }).aborted) {
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
	pi.on("session_compact", (event: SessionCompactEvent, ctx) => {
		currentCtx = ctx ?? currentCtx;
		// Native truth (ours or auto). Clears any pending request so a queued
		// dispatch never double-compacts, and starts a NEW alert epoch by the
		// confirmed entry identity.
		const entryId = typeof event?.compactionEntry?.id === "string" ? event.compactionEntry.id : null;
		const reason = event?.reason ?? "manual";
		pending = null;
		const key = entryId ? `entry:${entryId}` : `native:${Date.now()}`;
		lastCompaction = {
			outcome: "success",
			at: Date.now(),
			tokensBefore: event?.compactionEntry?.tokensBefore,
			detail: "confirmed by session_compact",
			reason,
		};
		inFlightRequest = null;
		inFlight = false;
		notifyOutcome(key, lastCompaction);
		restoration = { owner: sessionOwner(), generation };
		pi.sendMessage(
			{
				customType: "context-controls-restoration",
				display: false,
				content: [{ type: "text", text: buildRestorationText(reason) }],
			},
			{ triggerTurn: false },
		);
		// New epoch by confirmed entry identity: levels may announce again as
		// usage regrows.
		deliveredLevels = new Set();
		epochMarker = entryId;
		persistEpoch();
	});
	pi.on("session_compact_failed", (event, _ctx) => {
		const detail = (event as { errorMessage?: string })?.errorMessage ?? "compaction failed or was aborted";
		const outcome = (event as { aborted?: boolean })?.aborted ? "aborted" : "error";
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

	// ── tools ──
	pi.registerTool({
		name: "usage",
		label: "Context Usage",
		description:
			"Report current context usage: estimated tokens, the configured model's context window, percent used, " +
			"and the confirmed outcome of the last compaction. Read-only: it never changes model or window settings.",
		promptSnippet: "Inspect context-window usage and last compaction outcome",
		parameters: Type.Object({}, { additionalProperties: false }),
		execute: async (_toolCallId: string, _params: unknown, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: typeof currentCtx) => {
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
		execute: async (_toolCallId: string, params: { summaryFocus?: string }, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: typeof currentCtx) => {
			if (pending || inFlight) {
				return {
					content: [
						{
							type: "text" as const,
							text:
								"A compaction request is already accepted and waiting for the current run to settle. " +
								"Not re-requesting. Check usage() for the confirmed outcome.",
						},
					],
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					details: { ok: false, duplicate: true, inFlight } as any,
				};
			}
			if (batchToolCalls.length > 1) {
				return {
					content: [
						{
							type: "text" as const,
							text:
								`Compaction request REJECTED: it was batched with ${batchToolCalls.length - 1} sibling tool call(s). ` +
								"The sibling work must not be interrupted by compaction. Retry with compact as the ONLY tool " +
								"call in your response — the accepted call then terminates the turn and compaction starts at " +
								"settle. No request was recorded.",
						},
					],
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					details: { ok: false, rejected: "siblings", batchSize: batchToolCalls.length } as any,
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
