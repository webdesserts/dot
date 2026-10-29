/**
 * Audit log writer and block-text builder for memory-recall.
 *
 * Log location: ~/.pi/agent/logs/memory-recall.jsonl
 * Rotation: rename to .1 when size exceeds maxLogBytes (5 MB default).
 * Written synchronously to avoid losing entries on crash.
 *
 * Log directory is created with mode 0700; log file is written with mode 0600.
 * The rotated .1 file is also chmod'd to 0600 after rename.
 *
 * Detail levels (logDetail in config):
 *   "metadata" (default) — logs ids, types, scores, note paths and lengths.
 *     No query text or result text is written.
 *   "full" — additionally writes query text and result text (for calibration).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { AuditEntry, MemoryRecallConfig, RecallDetails, InjectedMemory } from "./types.ts";

function resolveLogPath(logPath: string): string {
	return logPath.replace(/^~(?=\/|$)/, os.homedir());
}

/** Append one JSON line; rotate if the file exceeds maxLogBytes. */
export function appendAuditLog(entry: AuditEntry, config: Pick<MemoryRecallConfig, "logPath" | "maxLogBytes" | "logDetail">): void {
	const logPath = resolveLogPath(config.logPath);
	const logDir = path.dirname(logPath);
	try {
		// Directory: 0700 so only the owning user can list or enter it.
		// mkdirSync({mode}) only sets permissions on directories it creates;
		// chmod tightens one that already exists at a looser mode (e.g. 755).
		fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
		try { fs.chmodSync(logDir, 0o700); } catch { /* ignore — best effort */ }
		// Rotate if too large; chmod the rotated file to 0600 as well.
		try {
			const stat = fs.statSync(logPath);
			if (stat.size > config.maxLogBytes) {
				fs.renameSync(logPath, logPath + ".1");
				try { fs.chmodSync(logPath + ".1", 0o600); } catch { /* ignore */ }
			}
		} catch {
			// File doesn't exist yet — ok
		}
		// Build the log object. "metadata" mode omits query text and result text.
		const logObj = config.logDetail === "full"
			? entry
			: {
				ts: entry.ts,
				sessionId: entry.sessionId,
				agent: entry.agent,
				querySource: entry.querySource,
				queryLength: entry.query.length,
				banks: entry.banks,
				results: entry.results.map((r) => ({
					id: r.id, type: r.type,
					scores: r.scores, usedField: r.usedField, usedScore: r.usedScore,
				})),
				injected: entry.injected,
				dropped: entry.dropped,
				notesResults: entry.notesResults.map((n) => ({ path: n.path, relevance: n.relevance })),
				notesInjected: entry.notesInjected,
				notesDropped: entry.notesDropped,
				auditOnly: entry.auditOnly,
				latencyMs: entry.latencyMs,
				error: entry.error,
			};
		fs.appendFileSync(logPath, JSON.stringify(logObj) + "\n", "utf8");
		// Tighten file permissions to 0600 after every write (idempotent, cheap).
		try { fs.chmodSync(logPath, 0o600); } catch { /* ignore */ }
	} catch {
		// Log failures must never propagate to the agent
	}
}

/** Build the model-visible block text injected via sendMessage. */
export function buildBlockText(details: Pick<RecallDetails, "injectedMemories" | "injectedNotes">): string {
	const parts: string[] = [
		"Possibly relevant memories. Use them only if they help with the current step; otherwise ignore them.",
	];
	for (const m of details.injectedMemories) {
		const date = m.mentionedAt.slice(0, 10);
		parts.push(`• [${m.type} · ${date}] ${m.text}`);
	}
	if (details.injectedNotes.length > 0) {
		const titles = details.injectedNotes.map((n) => `[[${n.title}]]`).join(", ");
		parts.push(`Related notes: ${titles}`);
	}
	return parts.join("\n\n");
}

/** Build the summary string for the one-line notice / notify call. */
export function buildSummaryLine(details: RecallDetails): string {
	const memTypes = [...new Set(details.injectedMemories.map((m) => m.type))];
	const memParts: string[] = [];
	if (details.injectedMemories.length > 0) {
		const typeSuffix = memTypes.length > 0 ? ` (${memTypes.join(", ")})` : "";
		memParts.push(`${details.injectedMemories.length} memor${details.injectedMemories.length === 1 ? "y" : "ies"}${typeSuffix}`);
	}
	if (details.injectedNotes.length > 0) {
		memParts.push(`${details.injectedNotes.length} note${details.injectedNotes.length === 1 ? "" : "s"}`);
	}
	const droppedCount = details.droppedMemories.length + details.droppedNotes.length;
	const droppedStr = droppedCount > 0 ? ` · ${droppedCount} dropped` : "";
	const contentStr = memParts.length > 0 ? memParts.join(" · ") : "nothing";
	return `⚙ recall · ${contentStr}${droppedStr}`;
}
