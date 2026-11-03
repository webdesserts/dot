import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { cleanEntry, cleanMessage, cleanSummary, supportedPreparation, supportedTree } from "./policy.ts";

export function registerRetention(pi: ExtensionAPI) {
	const reported = new Set<string>();
	const diagnostic = (reason: string, ctx: ExtensionContext) => {
		if (reported.has(reason)) return;
		reported.add(reason);
		const text = `Context retention cleanup skipped: ${reason}. Compaction proceeds without retention cleanup; no archive was changed.`;
		console.warn(`[context-retention] ${text}`);
		try { if (ctx.hasUI) ctx.ui.notify(text, "warning"); } catch { /* skip is advisory only */ }
	};
	pi.on("session_start", () => { reported.clear(); });
	pi.on("context", (event, ctx) => {
		const entries = ctx.sessionManager.getBranch();
		return { messages: event.messages.map((message) => cleanMessage(message, entries)) };
	});
	pi.on("session_before_compact", (event, ctx) => {
		if (!supportedPreparation(event.preparation) || !Array.isArray(event.branchEntries)) {
			diagnostic("unsupported compaction preparation", ctx);
			return;
		}
		// Pi passes this SAME object to native compact after the event. This
		// is source-qualified mutation, NOT a documented preparation override.
		const preparation = event.preparation;
		const previousSummary = preparation.previousSummary === undefined ? undefined :
			cleanSummary(preparation.previousSummary, event.branchEntries);
		const messagesToSummarize = preparation.messagesToSummarize.map((message) => cleanMessage(message, event.branchEntries));
		const turnPrefixMessages = preparation.turnPrefixMessages.map((message) => cleanMessage(message, event.branchEntries));
		Object.assign(preparation, { previousSummary, messagesToSummarize, turnPrefixMessages,
			fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() } });
		// Returning no result preserves native routing/stream/retry/usage and
		// the existing abort, cut-boundary and restoration lifecycle.
	});
	pi.on("session_before_tree", (event, ctx) => {
		if (event.preparation?.userWantsSummary === false) return;
		if (!supportedTree(event.preparation)) {
			diagnostic("unsupported tree preparation", ctx);
			return;
		}
		// Native navigateTree retains the ARRAY alias, not property reassignment.
		// Its elements may reference stored entries: replace them with clones.
		const entries = event.preparation.entriesToSummarize;
		const cleaned = entries.map(cleanEntry);
		cleaned.forEach((entry, i) => { entries[i] = entry; });
	});
}
