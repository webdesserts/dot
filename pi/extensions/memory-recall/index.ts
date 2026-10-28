/**
 * memory-recall — automatic Hindsight + vault recall for prime agents.
 *
 * Trigger → search → filter → inject → log.
 *
 * Injection (live mode):
 *   pi.sendMessage({customType:"memory-recall", display:true, ...}, {triggerTurn:false})
 *   Called with triggerTurn:false so it is never a new turn trigger.
 *   When isStreaming=true: queued to _pendingCustomMessages, flushed at turn_end
 *     → visible to the model on the NEXT turn.
 *   When isStreaming=false (before_agent_start): appended immediately
 *     → visible on the FIRST turn of the run.
 *   Source: agent-session.js:1857-1880 and :796 (turn_end flush).
 *
 * Serialisation to Anthropic (agent-session.js + anthropic-messages.js):
 *   custom role → convertToLlm → role:"user" content:[{type:"text",text}]
 *   Placed after any tool_result user message as a SEPARATE consecutive user
 *   message (not merged). Source: anthropic-messages.js:1192-1218.
 *   Anthropic accepts consecutive user messages without modification.
 *
 * Audit-only mode (default):
 *   Searches + logs but never calls sendMessage.
 *   Shows Michael a dim notify: ctx.ui.notify("⚙ recall (audit) · …", "info")
 *   ctx.ui.notify is not persisted to the session and never reaches the LLM.
 *   Source: types.d.ts:80.
 *
 * Settings (read from pi.getSettings() which has additionalProperties:true):
 *   { memoryRecall: MemoryRecallConfig }
 *   Source: settings-schema.js:290, types.d.ts:1286.
 *
 * Linking (tell Michael):
 *   Add to Dot.toml: "~/.pi/agent/extensions/memory-recall" = "pi/extensions/memory-recall"
 *   (Same pattern as context-retention directory.)
 *
 * customTypes found in real session data (grep of session JSONL):
 *   autonomy-notification-presentation (138), heartbeat-control (131),
 *   subagent-notify (84), context-controls-state (79), context-controls-notice (59),
 *   working-memory-snapshot (32), context-controls-restoration (7),
 *   subagent_control_notice (6), subagent-incremental-child-notify (5).
 *   Autonomy notifications arrive as customType "autonomy-notification-presentation",
 *   NOT as plain user messages.
 */
import type { ExtensionAPI, ExtensionContext, SessionStartEvent, SessionCompactEvent, SessionShutdownEvent } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import * as os from "node:os";
import type { MemoryRecallConfig, RecallDetails, InjectedMemory } from "./types.ts";
import { recallMemories } from "./recall.ts";
import { NotesMcpManager, filterNotes, normaliseNotePath } from "./notes.ts";
import { appendAuditLog, buildBlockText, buildSummaryLine } from "./audit.ts";

// ── Custom message types whose text we extract as a query source ─────────────
const CUSTOM_QUERY_TYPES = new Set([
	"autonomy-notification-presentation",
	"subagent-notify",
	"subagent_control_notice",
	"subagent-incremental-child-notify",
	"subagent-compaction-resume",
]);

// ── Acknowledgement skip rule ─────────────────────────────────────────────────
// Matches bare acknowledgements (single or short compound) that carry no query signal.
const ACK_PATTERN = /^(yeah[, ]*(sure|ok|okay)?|yep|ok|okay|sure|go ahead|sounds good|thanks\.?|great|perfect|noted|got it|will do|done|makes sense)[.!]?\s*$/i;

function isAck(text: string): boolean {
	return ACK_PATTERN.test(text.trim());
}

// ── Config defaults ───────────────────────────────────────────────────────────
const DEFAULT_CONFIG: MemoryRecallConfig = {
	hindsightBaseUrl: "http://127.0.0.1:8888",  // umbra's local port; rhea overrides to 18888 in settings.json
	agentBank: `agent-${process.env.AUTONOMY_AGENT_ID ?? "unknown"}`,
	sharedBank: "user",
	// Reranker-first (Hindsight 1.1.0+). Falls back to semantic≥0.75 if null.
	minScore: { field: "reranker", value: 0.02 },
	memoryTypes: undefined,
	maxMemories: 3,
	maxMemoryTokens: 400,
	maxNotes: 3,
	noteThreshold: 40,
	vaultPath: "~/notes",
	noteExclusions: [
		"agents/*/Working Memory*",
		"archive/**",
		"*Working Memory archive*",
		"scratchpad/**",
		"journal/20??-[Ww]*",
	],
	toolResultAllowlist: [],
	minIntervalMs: 20000,
	timeoutMs: 2000,   // raised from 1500 — 740-910ms observed latency on 501-fact bank
	auditOnly: true,
	enableTrace: false,
	logPath: "~/.pi/agent/logs/memory-recall.jsonl",
	maxLogBytes: 5 * 1024 * 1024,
};

function readConfig(pi: ExtensionAPI): MemoryRecallConfig {
	const settings = pi.getSettings() as Record<string, unknown>;
	const raw = (settings?.memoryRecall ?? {}) as Partial<MemoryRecallConfig>;
	return { ...DEFAULT_CONFIG, ...raw };
}

// ── Text extraction helpers ───────────────────────────────────────────────────
function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return (content as { type?: string; text?: string }[])
		.filter((c) => c.type === "text")
		.map((c) => c.text ?? "")
		.join(" ");
}

/**
 * Extract a raw note reference from a read / read_note tool call.
 * Returns whatever the caller passed; normalisation happens in updateSeenNotes.
 * read_note uses the 'note' argument; read uses 'path'.
 */
function noteRefFromToolCall(args: unknown): string | null {
	if (args && typeof args === "object") {
		const a = args as Record<string, unknown>;
		const p = a.note ?? a.path ?? a.note_path;
		if (typeof p === "string" && p.trim()) return p.trim();
	}
	return null;
}

// ── Query extraction from context messages ────────────────────────────────────
interface QueryInfo {
	text: string;
	source: string;
}

function extractQuery(
	newMessages: { role: string; content?: unknown; customType?: string }[],
	/** Assistant text from within newMessages only (not the full history). */
	assistantIntentText: string | null,
	toolResultAllowlist: ReadonlySet<string>,
): QueryInfo | null {
	const parts: { text: string; source: string }[] = [];

	for (const m of newMessages) {
		if (m.role === "user") {
			const t = contentText(m.content).trim().slice(0, 800);
			if (t && !isAck(t)) parts.push({ text: t, source: "user" });
		} else if (m.role === "custom") {
			const ct = m.customType ?? "";
			if (CUSTOM_QUERY_TYPES.has(ct)) {
				const t = contentText(m.content).trim().slice(0, 400);
				if (t) parts.push({ text: t, source: `custom:${ct}` });
			}
		} else if (m.role === "toolResult") {
			const toolName = (m as Record<string, unknown>).toolName as string | undefined;
			if (toolName && toolResultAllowlist.has(toolName)) {
				const t = contentText(m.content).trim().slice(0, 300);
				if (t) parts.push({ text: t, source: `tool:${toolName}` });
			}
		}
	}

	// Stated intent: only from assistant messages inside newMessages (fix 2).
	// This prevents re-searching the same intent every minIntervalMs.
	if (assistantIntentText) {
		const t = assistantIntentText.trim().slice(0, 300);
		if (t && !isAck(t)) parts.push({ text: t, source: "stated_intent" });
	}

	if (parts.length === 0) return null;

	const combined = parts.map((p) => p.text).join(" ").slice(0, 800);
	const primarySource = parts[0].source;
	return { text: combined, source: primarySource };
}

/** Extract the latest assistant text block from the message list. */
function latestAssistantText(messages: { role: string; content?: unknown }[]): string | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role === "assistant") {
			const t = contentText(m.content).trim();
			if (t) return t;
		}
	}
	return null;
}

// ── Extension factory ─────────────────────────────────────────────────────────
export default function memoryRecallExtension(pi: ExtensionAPI): void {
	// Skip entirely in subagent children (they have no recall, no LLM injection).
	if (process.env.PI_SUBAGENT_CHILD === "1") return;

	// ── Module-level state (reset per session) ──────────────────────────────
	let config = DEFAULT_CONFIG;
	let sessionId = "";
	let sessionActive = false;
	let lastSearchTs = 0;
	let lastMessageCount = 0;
	// Fix 1 (revised): set by session_compact to rebaseline without zeroing
	// lastMessageCount, which would cause slice(0) to query all post-compact history.
	let rebaselinePending = false;
	// Fix 2: track the last assistant text included in a query so we don't
	// re-search the same stated intent every minIntervalMs.
	let lastQueriedAssistantText: string | null = null;
	let seenMemoryIds = new Set<string>();
	// Fix 4: seenNotePaths stores normalised vault-relative lowercase keys.
	let seenNotePaths = new Set<string>();
	let notesMgr: NotesMcpManager | null = null;
	let currentCtx: ExtensionContext | null = null;

	// ── Message renderer ────────────────────────────────────────────────────
	pi.registerMessageRenderer<RecallDetails>("memory-recall", (message, { outputPad, expanded }, theme) => {
		const details = message.details;
		if (!details) {
			const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
			box.addChild(new Text(theme.fg("dim", "⚙ recall"), 0, 0));
			return box;
		}
		const summary = theme.fg("dim", buildSummaryLine(details));
		const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
		box.addChild(new Text(summary, 0, 0));
		if (expanded) {
			for (const m of details.injectedMemories) {
				const scoreStr = `${m.scoreField}=${m.scoreValue.toFixed(4)}`;
				const line = `  [${m.type} · ${m.mentionedAt.slice(0, 10)} · ${scoreStr}] ${m.text}`;
				box.addChild(new Text(theme.fg("dim", line), 0, 0));
			}
			for (const n of details.injectedNotes) {
				box.addChild(new Text(theme.fg("dim", `  [[${n.title}]]  (${n.path})`), 0, 0));
			}
			const droppedCount = details.droppedMemories.length + details.droppedNotes.length;
			if (droppedCount > 0) {
				box.addChild(new Text(theme.fg("dim", `  (${droppedCount} item${droppedCount === 1 ? "" : "s"} dropped — expand audit log for details)`), 0, 0));
			}
		}
		return box;
	});

	// ── Core recall function ────────────────────────────────────────────────
	async function runRecall(
		query: string,
		querySource: string,
		ctx: ExtensionContext,
		timeoutMs: number,
	): Promise<void> {
		const t0 = Date.now();
		const vaultPath = config.vaultPath.replace(/^~(?=\/|$)/, os.homedir());

		// Ensure notes manager exists
		if (!notesMgr) {
			notesMgr = new NotesMcpManager(vaultPath);
		}

		// Run Hindsight + notes in parallel
		const [recallResult, rawNoteResults] = await Promise.all([
			recallMemories(query, config, seenMemoryIds, timeoutMs),
			notesMgr.search(query, timeoutMs).catch(() => [] as import("./types.ts").NoteResult[]),
		]);

		const latencyMs = Date.now() - t0;
		const { memories, allResults, error: recallError } = recallResult;

		// Filter notes (fix 4: pass vaultPath so filterNotes can normalise paths).
		const filteredNotes = filterNotes(rawNoteResults, config, seenNotePaths);

		const injectedMemories: InjectedMemory[] = memories.injected.map((fm) => ({
			id: fm.result.id,
			type: fm.result.type,
			scoreField: fm.usedField,
			scoreValue: fm.usedScore,
			mentionedAt: fm.result.mentioned_at,
			text: fm.result.text,
		}));

		const details: RecallDetails = {
			injectedMemories,
			droppedMemories: memories.dropped,
			injectedNotes: filteredNotes.injected,
			droppedNotes: filteredNotes.dropped,
			querySource,
			latencyMs,
			query,
		};

		const hasContent = injectedMemories.length > 0 || filteredNotes.injected.length > 0;

		// ── Audit log ─────────────────────────────────────────────────────
		appendAuditLog({
			ts: new Date().toISOString(),
			sessionId,
			agent: process.env.AUTONOMY_AGENT_ID ?? "unknown",
			querySource,
			query,
			banks: [config.agentBank, config.sharedBank],
			results: allResults.map((r) => {
				const { field: usedField, value: usedScore } = resolveScoreForLog(r.scores, config.minScore.field);
				return { id: r.id, text: r.text, type: r.type, scores: r.scores as Record<string, number | null | undefined>, usedField, usedScore };
			}),
			injected: injectedMemories.map((m) => m.id),
			dropped: memories.dropped,
			notesResults: rawNoteResults,
			notesInjected: filteredNotes.injected.map((n) => n.path),
			notesDropped: filteredNotes.dropped,
			auditOnly: config.auditOnly,
			latencyMs,
			error: recallError,
		}, config);

		if (!hasContent) return;

		if (config.auditOnly) {
			// Audit-only: show a non-context indicator. ctx.ui.notify is ephemeral TUI
			// only — never persisted to session, never reaches the LLM. types.d.ts:80
			if (ctx.mode === "tui") {
				ctx.ui.notify(`⚙ recall (audit) · ${buildSummaryLine(details)}`, "info");
			}
			return;
		}

		// ── Live mode: inject persisted custom message ─────────────────────
		if (!sessionActive) return; // session shut down during async

		// Update seen sets before injecting (fix 4: store normalised keys).
		const vaultPathExp = config.vaultPath.replace(/^~(?=\/|$)/, os.homedir());
		for (const m of injectedMemories) seenMemoryIds.add(m.id);
		for (const n of filteredNotes.injected) seenNotePaths.add(normaliseNotePath(n.path, vaultPathExp));
		lastSearchTs = Date.now();

		const blockText = buildBlockText(details);
		try {
			pi.sendMessage(
				{
					customType: "memory-recall",
					display: true,
					content: [{ type: "text", text: blockText }],
					details,
				},
				{ triggerTurn: false },
			);
		} catch (err) {
			console.error(`[memory-recall] sendMessage failed: ${err}`);
		}
	}

	// Helper to log which score field was actually used
	function resolveScoreForLog(scores: { [key: string]: number | null | undefined }, preferField: string): { field: string; value: number } {
		const primary = scores[preferField];
		if (typeof primary === "number" && isFinite(primary)) return { field: preferField, value: primary };
		const semantic = scores["semantic"];
		if (typeof semantic === "number" && isFinite(semantic)) return { field: "semantic", value: semantic };
		return { field: preferField, value: 0 };
	}

	// ── Update seen note paths from tool calls in context ──────────────────
	// Fix 3: match tool names ending in 'read_note' (covers mcp__obsidian_memory__read_note)
	// and exactly 'read' (pi's built-in file reader). Fix 4: normalise before storing.
	function updateSeenNotes(messages: { role: string; content?: unknown; [key: string]: unknown }[]): void {
		const vaultPathExp = config.vaultPath.replace(/^~(?=\/|$)/, os.homedir());
		for (const m of messages) {
			if (m.role === "assistant" && Array.isArray(m.content)) {
				for (const block of (m.content as { type?: string; name?: string; arguments?: unknown }[])) {
					if (block.type === "toolCall" &&
						(block.name?.endsWith("read_note") || block.name === "read")) {
						const raw = noteRefFromToolCall(block.arguments);
						if (raw) seenNotePaths.add(normaliseNotePath(raw, vaultPathExp));
					}
				}
			}
		}
	}

	// ── Lifecycle handlers ──────────────────────────────────────────────────

	pi.on("session_start", (_event: SessionStartEvent, ctx: ExtensionContext) => {
		config = readConfig(pi);
		currentCtx = ctx;
		sessionId = ctx.sessionManager.getSessionId?.() ?? "";
		sessionActive = true;
		lastSearchTs = 0;
		lastMessageCount = 0;
		rebaselinePending = false;
		lastQueriedAssistantText = null;
		seenMemoryIds = new Set();
		seenNotePaths = new Set();
		// Kill any leftover notes process from a prior session
		if (notesMgr) { notesMgr.shutdown(); notesMgr = null; }
	});

	pi.on("session_shutdown", (_event: SessionShutdownEvent, _ctx: ExtensionContext) => {
		sessionActive = false;
		currentCtx = null;
		if (notesMgr) { notesMgr.shutdown(); notesMgr = null; }
	});

	pi.on("session_compact", (_event: SessionCompactEvent, ctx: ExtensionContext) => {
		currentCtx = ctx;
		// Reset seen sets: compaction is a new epoch, re-inject if relevant.
		seenMemoryIds = new Set();
		seenNotePaths = new Set();
		lastSearchTs = 0;
		lastQueriedAssistantText = null;
		// Fix 1 (revised): signal the context hook to rebaseline without querying.
		// Zeroing lastMessageCount caused slice(0) to query the whole post-compact
		// history before the shrink check could fire (prev was 0, not > new length).
		rebaselinePending = true;
	});

	pi.on("before_agent_start", async (event, ctx: ExtensionContext) => {
		currentCtx = ctx;
		if (!sessionActive) return;

		// Rate limit
		if (Date.now() - lastSearchTs < config.minIntervalMs) return;

		// Extract query from the triggering event
		let query = "";
		let source = "";
		const ev = event as { messageType?: string; prompt?: string; message?: { content?: unknown; customType?: string } };
		if (ev.messageType === "user" && ev.prompt) {
			const t = ev.prompt.trim().slice(0, 800);
			if (t && !isAck(t)) { query = t; source = "user"; }
		} else if (ev.messageType === "custom" && ev.message) {
			const ct = ev.message.customType ?? "";
			if (CUSTOM_QUERY_TYPES.has(ct)) {
				const t = contentText(ev.message.content).trim().slice(0, 400);
				if (t) { query = t; source = `custom:${ct}`; }
			}
		}

		// Include stated intent only if it is NEW since the last search (fix 2).
		// This prevents the same assistant statement from repeating in every query.
		const branch = ctx.sessionManager.getBranch?.() ?? [];
		const projMessages = branch
			.filter((e) => e.type === "message")
			.map((e) => (e as import("@earendil-works/pi-coding-agent").SessionMessageEntry).message as { role: string; content?: unknown })
			.filter(Boolean);
		const intent = latestAssistantText(projMessages);
		if (intent && !isAck(intent) && intent !== lastQueriedAssistantText) {
			const intentText = intent.slice(0, 300);
			query = query ? `${query} ${intentText}` : intentText;
			if (!source) source = "stated_intent";
		}

		if (!query) return;
		lastSearchTs = Date.now(); // claim the slot even if recall fails
		// Remember the intent text we queried with so before_agent_start and context
		// hook don't re-search the same stated intent.
		if (intent && intent !== lastQueriedAssistantText) lastQueriedAssistantText = intent;

		await runRecall(query, source || "user", ctx, config.timeoutMs).catch(() => {});
	});

	pi.on("context", (event, ctx: ExtensionContext) => {
		currentCtx = ctx;
		if (!sessionActive) return;

		const allMessages = (event.messages ?? []) as { role: string; content?: unknown; customType?: string; [key: string]: unknown }[];

		// Update seen note paths from tool calls (read/read_note)
		updateSeenNotes(allMessages);

		// Fix 1: after compaction, rebaseline to the current projection length
		// without querying. The first post-compaction query comes from
		// before_agent_start or the next genuinely new messages.
		if (rebaselinePending) {
			lastMessageCount = allMessages.length;
			rebaselinePending = false;
			return;
		}

		// Rate limit check
		if (Date.now() - lastSearchTs < config.minIntervalMs) return;

		// Shrink fallback: if the projection shrank without a preceding
		// session_compact event (e.g. branch switch), rebaseline without querying.
		const prevCount = lastMessageCount;
		lastMessageCount = allMessages.length;
		if (allMessages.length < prevCount) {
			return;
		}

		const newMessages = allMessages.slice(prevCount);
		if (newMessages.length === 0) return;

		// Fix 2: extract assistant intent only from messages within newMessages,
		// not from the full history — prevents re-searching the same old intent.
		const newAssistantText = latestAssistantText(newMessages);
		const allowlist = new Set(config.toolResultAllowlist);
		const qi = extractQuery(newMessages, newAssistantText, allowlist);
		if (!qi) return;

		lastSearchTs = Date.now(); // claim slot
		if (newAssistantText) lastQueriedAssistantText = newAssistantText;
		// Fire background — never blocks the current request
		runRecall(qi.text, qi.source, ctx, Math.min(config.timeoutMs, 1200)).catch(() => {});
	});
}
