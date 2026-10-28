/**
 * Audit log writer and block-text builder for memory-recall.
 *
 * Log location: ~/.pi/agent/logs/memory-recall.jsonl
 * Rotation: rename to .1 when size exceeds maxLogBytes (5 MB default).
 * Written synchronously to avoid losing entries on crash.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { AuditEntry, MemoryRecallConfig, RecallDetails, InjectedMemory } from "./types.ts";

function resolveLogPath(logPath: string): string {
	return logPath.replace(/^~(?=\/|$)/, os.homedir());
}

/** Append one JSON line; rotate if the file exceeds maxLogBytes. */
export function appendAuditLog(entry: AuditEntry, config: Pick<MemoryRecallConfig, "logPath" | "maxLogBytes">): void {
	const logPath = resolveLogPath(config.logPath);
	const logDir = path.dirname(logPath);
	try {
		fs.mkdirSync(logDir, { recursive: true });
		// Rotate if too large
		try {
			const stat = fs.statSync(logPath);
			if (stat.size > config.maxLogBytes) {
				fs.renameSync(logPath, logPath + ".1");
			}
		} catch {
			// File doesn't exist yet — ok
		}
		fs.appendFileSync(logPath, JSON.stringify(entry) + "\n", "utf8");
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
