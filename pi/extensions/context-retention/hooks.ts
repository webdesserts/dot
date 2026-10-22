import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { cleanEntry, cleanMessage, cleanSummary, supportedPreparation, supportedTree } from "./policy.ts";

/** Exact versions qualified by the real native-compactor consumer suite. */
export const TESTED_VERSIONS = ["1.4.0"];

export function registerRetention(pi: ExtensionAPI, version: string) {
	const qualified = TESTED_VERSIONS.includes(version);
	const reported = new Set<string>();
	const diagnostic = (reason: string, ctx: ExtensionContext) => {
		if (reported.has(reason)) return;
		reported.add(reason);
		const text = `Context retention cancelled summarization: ${reason} (Pi ${version}). ` +
			"Qualify context-retention against this SDK and preparation shape before retrying; no archive was changed.";
		console.warn(`[context-retention] ${text}`);
		try { if (ctx.hasUI) ctx.ui.notify(text, "warning"); } catch { /* cancellation must still reach the caller */ }
	};
	pi.on("session_start", () => { reported.clear(); });
	pi.on("context", (event, ctx) => {
		if (!qualified) return;
		const entries = ctx.sessionManager.getBranch();
		return { messages: event.messages.map((message) => cleanMessage(message, entries)) };
	});
	pi.on("session_before_compact", (event, ctx) => {
		if (!qualified || !supportedPreparation(event.preparation) || !Array.isArray(event.branchEntries)) {
			diagnostic(qualified ? "unsupported compaction preparation" : "unqualified SDK version", ctx);
			return { cancel: true };
		}
		// 1.4.0 passes this SAME object to native compact after the event. This
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
		if (!qualified || !supportedTree(event.preparation)) {
			diagnostic(qualified ? "unsupported tree preparation" : "unqualified SDK version", ctx);
			return { cancel: true };
		}
		// Native navigateTree retains the ARRAY alias, not property reassignment.
		// Its elements may reference stored entries: replace them with clones.
		const entries = event.preparation.entriesToSummarize;
		const cleaned = entries.map(cleanEntry);
		cleaned.forEach((entry, i) => { entries[i] = entry; });
	});
}
