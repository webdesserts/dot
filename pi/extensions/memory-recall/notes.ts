/**
 * Long-lived obsidian-memory MCP subprocess manager.
 *
 * Protocol (verified against obsidian-memory 0.5.7):
 *   Client → Server: initialize (id:1)
 *   Server → Client: initialize result
 *   Client → Server: notifications/initialized  (notification, no id)
 *   Client → Server: tools/call {name:"search", arguments:{query}} (id:N)
 *   Server → Client: tools/call result — markdown text
 *
 * Search result format (one entry per line pair):
 *   1. **[[Title]]** (52% relevant)
 *      - Path: `knowledge/Rust.md`
 *
 * The process stays alive across searches; one spawn per session.
 * Killed on session_shutdown to avoid orphan processes.
 */
import { spawn } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import type { NoteResult, MemoryRecallConfig } from "./types.ts";

interface PendingCall {
	resolve: (result: string) => void;
	reject: (err: Error) => void;
}

export class NotesMcpManager {
	private proc: ReturnType<typeof spawn> | null = null;
	private buf = "";
	private nextId = 2;
	private pending = new Map<number, PendingCall>();
	private ready = false;
	private vaultPath: string;

	constructor(vaultPath: string) {
		this.vaultPath = vaultPath.replace(/^~(?=\/|$)/, os.homedir());
	}

	/** Spawn the process and complete the MCP handshake. */
	private async ensureRunning(): Promise<boolean> {
		if (this.proc && !this.proc.killed && this.ready) return true;
		return this.start();
	}

	private async start(): Promise<boolean> {
		this.shutdown(); // kill any stale process
		this.buf = "";
		this.ready = false;
		try {
			this.proc = spawn("memory", ["mcp", "io", "--vault", this.vaultPath], {
				stdio: ["pipe", "pipe", "ignore"],
			});
		} catch {
			return false;
		}

		this.proc.on("exit", () => {
			// Reject all pending calls so they don't hang
			for (const { reject } of this.pending.values()) {
				reject(new Error("notes process exited"));
			}
			this.pending.clear();
			this.ready = false;
			this.proc = null;
		});

		this.proc.stdout!.on("data", (chunk: Buffer) => this.onData(chunk.toString()));

		// Send initialize and wait for its result
		return new Promise<boolean>((resolve) => {
			const initId = 1;
			const tid = setTimeout(() => resolve(false), 4000);
			const handler = (result: string) => {
				clearTimeout(tid);
				// After initialize result, send notifications/initialized then we're ready
				this.sendRaw({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
				this.ready = true;
				resolve(true);
			};
			this.pending.set(initId, {
				resolve: handler,
				reject: () => { clearTimeout(tid); resolve(false); },
			});
			this.sendRaw({
				jsonrpc: "2.0", id: initId, method: "initialize",
				params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "memory-recall", version: "1" } },
			});
		});
	}

	private sendRaw(obj: unknown): void {
		if (!this.proc?.stdin?.writable) return;
		this.proc.stdin.write(JSON.stringify(obj) + "\n");
	}

	private onData(chunk: string): void {
		this.buf += chunk;
		const lines = this.buf.split("\n");
		this.buf = lines.pop() ?? "";
		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				const msg = JSON.parse(line) as { id?: number; result?: { content?: { type: string; text: string }[] }; error?: unknown };
				if (msg.id == null) continue; // notification
				const cb = this.pending.get(msg.id);
				if (!cb) continue;
				this.pending.delete(msg.id);
				if (msg.error) {
					cb.reject(new Error(String((msg.error as Record<string,unknown>).message ?? msg.error)));
				} else {
					const text = (msg.result?.content ?? []).find((c) => c.type === "text")?.text ?? "";
					cb.resolve(text);
				}
			} catch {
				// Malformed line — ignore
			}
		}
	}

	/** Search the vault. Returns [] on any error or timeout. */
	async search(query: string, timeoutMs = 4000): Promise<NoteResult[]> {
		const running = await this.ensureRunning();
		if (!running || !this.proc) return [];
		const id = this.nextId++;
		return new Promise<NoteResult[]>((resolve) => {
			const tid = setTimeout(() => {
				this.pending.delete(id);
				resolve([]);
			}, timeoutMs);
			this.pending.set(id, {
				resolve: (text) => { clearTimeout(tid); resolve(parseNoteSearchResult(text)); },
				reject: () => { clearTimeout(tid); resolve([]); },
			});
			this.sendRaw({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "search", arguments: { query } } });
		});
	}

	/** Kill the process. Safe to call multiple times. */
	shutdown(): void {
		if (this.proc) {
			try { this.proc.kill(); } catch { /* ignore */ }
			this.proc = null;
		}
		this.ready = false;
		this.buf = "";
		for (const { reject } of this.pending.values()) reject(new Error("shutdown"));
		this.pending.clear();
	}
}

/**
 * Parse obsidian-memory search result markdown.
 *
 * Expected format per result:
 *   N. **[[Title]]** (52% relevant)
 *      - Path: `relative/path.md`
 */
export function parseNoteSearchResult(text: string): NoteResult[] {
	if (!text || text.includes("No relevant notes found")) return [];
	const results: NoteResult[] = [];
	const lines = text.split("\n");
	let i = 0;
	while (i < lines.length) {
		// Match numbered entry: "1. **[[Title]]** (52% relevant)"
		const titleMatch = lines[i].match(/^\d+\.\s+\*\*\[\[(.+?)\]\]\*\*\s+\((\d+)%/);
		if (titleMatch) {
			const title = titleMatch[1];
			const relevance = parseInt(titleMatch[2], 10);
			// Next non-empty line should be the path
			let pathLine = "";
			for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
				const pathMatch = lines[j].match(/Path:\s+`(.+?)`/);
				if (pathMatch) { pathLine = pathMatch[1]; break; }
			}
			if (pathLine) {
				results.push({ title, path: pathLine, relevance });
			}
		}
		i++;
	}
	return results;
}

/**
 * Normalise a raw note reference to a lowercase vault-relative key with no
 * extension. Handles all forms seen in real tool calls:
 *   - vault-relative path with or without .md  ("dir/x.md", "dir/x")
 *   - absolute path                             ("/Users/.../notes/dir/x.md")
 *   - tilde path                                ("~/notes/dir/x.md")
 *   - [[wiki link]]                             ("[[Title]]")
 *   - memory: prefix                            ("memory:dir/x")
 *   - bare title                                ("Title")
 *
 * The returned key can be compared against normalised n.path values from MCP
 * results, and also against just the basename for title-only matches.
 */
export function normaliseNotePath(raw: string, vaultPath: string): string {
	let s = raw.trim();
	// Strip [[ ]] link syntax
	s = s.replace(/^\[\[/, "").replace(/\]\]$/, "");
	// Strip memory: prefix
	s = s.replace(/^memory:/, "");
	// Expand vault path for absolute-prefix stripping
	const vaultAbs = vaultPath.replace(/^~(?=\/|$)/, os.homedir());
	if (s.startsWith(vaultAbs + path.sep) || s.startsWith(vaultAbs + "/")) {
		s = s.slice(vaultAbs.length + 1);
	} else if (s.startsWith(vaultPath + "/")) {
		s = s.slice(vaultPath.length + 1);
	}
	// Drop .md extension
	s = s.replace(/\.md$/i, "");
	return s.toLowerCase();
}

/** Simple glob match: *, **, ?, and [...] character classes supported. */
export function globMatch(pattern: string, str: string): boolean {
	// Convert glob to regex, preserving [...] character classes.
	let rx = "";
	let i = 0;
	while (i < pattern.length) {
		const ch = pattern[i];
		if (ch === "*" && pattern[i + 1] === "*") {
			rx += ".*"; i += 2;
		} else if (ch === "*") {
			rx += "[^/]*"; i++;
		} else if (ch === "?") {
			rx += "[^/]"; i++;
		} else if (ch === "[") {
			// Pass character class through as-is up to the closing ]
			const end = pattern.indexOf("]", i + 1);
			if (end === -1) { rx += "\\["; i++; }
			else { rx += pattern.slice(i, end + 1); i = end + 1; }
		} else if (".+^${}()|\\]".includes(ch)) {
			rx += "\\" + ch; i++;
		} else {
			rx += ch; i++;
		}
	}
	return new RegExp(`^${rx}$`).test(str);
}

/** Return true if the path should be excluded (always excludes Working Memory). */
export function isExcluded(notePath: string, exclusions: string[]): boolean {
	if (/[/\\]Working Memory/i.test(notePath)) return true;
	for (const pat of exclusions) {
		if (globMatch(pat, notePath)) return true;
	}
	return false;
}

export interface FilteredNotes {
	injected: { title: string; path: string }[];
	dropped: { path: string; reason: string }[];
}

/**
 * Apply threshold + exclusions + seenPaths + cap.
 *
 * `seenPaths` must contain normalised keys (output of `normaliseNotePath`).
 * Checks both the full normalised path and the basename (title) so that a
 * note loaded via `read_note Title` matches the MCP result at `dir/Title.md`.
 */
export function filterNotes(
	results: NoteResult[],
	config: Pick<MemoryRecallConfig, "noteThreshold" | "maxNotes" | "noteExclusions" | "vaultPath">,
	seenPaths: ReadonlySet<string>,
): FilteredNotes {
	const injected: { title: string; path: string }[] = [];
	const dropped: { path: string; reason: string }[] = [];
	for (const n of results) {
		if (isExcluded(n.path, config.noteExclusions)) {
			dropped.push({ path: n.path, reason: "excluded pattern" });
			continue;
		}
		// Normalise the MCP-returned path and check against normalised seen set
		// by both full path and bare basename (title-only reads match here).
		const normPath = normaliseNotePath(n.path, config.vaultPath);
		const basename = normPath.split("/").pop() ?? normPath;
		if (seenPaths.has(normPath) || seenPaths.has(basename)) {
			dropped.push({ path: n.path, reason: "already in context" });
			continue;
		}
		if (n.relevance < config.noteThreshold) {
			dropped.push({ path: n.path, reason: `relevance ${n.relevance}% < ${config.noteThreshold}%` });
			continue;
		}
		if (injected.length >= config.maxNotes) {
			dropped.push({ path: n.path, reason: "note cap" });
			continue;
		}
		injected.push({ title: n.title, path: n.path });
	}
	return { injected, dropped };
}
