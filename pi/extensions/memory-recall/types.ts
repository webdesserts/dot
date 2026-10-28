/**
 * Shared types for memory-recall extension.
 */

export interface MemoryResult {
	id: string;
	text: string;
	type: string;             // "world" | "observation" | "experience" | …
	mentioned_at: string;     // ISO timestamp
	scores: { [key: string]: number | null | undefined };
	// Extra keys tolerated (entities, tags, metadata, …)
	[key: string]: unknown;
}

export interface NoteResult {
	title: string;    // raw title without [[]]
	path: string;     // vault-relative path
	relevance: number; // 0–100 integer percentage from MCP response
}

export interface MemoryRecallConfig {
	/** Hindsight REST base URL. Default: "http://127.0.0.1:18888" */
	hindsightBaseUrl: string;
	/** Agent-specific bank ID. Default: "agent-${AUTONOMY_AGENT_ID}" */
	agentBank: string;
	/** Shared bank ID. Default: "user" */
	sharedBank: string;
	/**
	 * Score field + minimum value.
	 * Default: {field:"reranker", value:0.02} (Hindsight 1.1.0+).
	 * When the reranker field is null/absent the code falls back to semantic ≥ 0.75.
	 */
	minScore: { field: string; value: number };
	/** Memory types to restrict to. Default: undefined (no filter; all types). */
	memoryTypes: string[] | undefined;
	/** Max injected memories per recall. Default: 3 */
	maxMemories: number;
	/** Token budget for memory text (≈4 chars/token). Default: 400 */
	maxMemoryTokens: number;
	/** Max injected note titles. Default: 3 */
	maxNotes: number;
	/** Minimum note relevance percentage (0–100) from MCP. Default: 40 */
	noteThreshold: number;
	/** Vault path. Default: "~/notes" */
	vaultPath: string;
	/** Glob patterns of vault paths to exclude. Working Memory always excluded in code. */
	noteExclusions: string[];
	/** Tool names whose results feed into the query. Default: [] */
	toolResultAllowlist: string[];
	/** Minimum milliseconds between searches. Default: 20000 */
	minIntervalMs: number;
	/** before_agent_start recall timeout ms. Default: 2000 */
	timeoutMs: number;
	/** Audit-only: search + log but never inject into session. Default: true */
	auditOnly: boolean;
	/** Send trace:true in recall requests. Default: false */
	enableTrace: boolean;
	/** JSONL audit log path. Default: "~/.pi/agent/logs/memory-recall.jsonl" */
	logPath: string;
	/** Rotate log when it exceeds this many bytes. Default: 5 MB */
	maxLogBytes: number;
}

export interface InjectedMemory {
	id: string;
	type: string;
	scoreField: string;
	scoreValue: number;
	mentionedAt: string;
	text: string;
}

/** Stored in the custom message `details` field; drives the renderer. */
export interface RecallDetails {
	injectedMemories: InjectedMemory[];
	droppedMemories: { id: string; reason: string }[];
	injectedNotes: { title: string; path: string }[];
	droppedNotes: { path: string; reason: string }[];
	querySource: string;
	latencyMs: number;
	query: string;
}

export interface AuditEntry {
	ts: string;
	sessionId: string;
	agent: string;
	querySource: string;
	query: string;
	banks: string[];
	results: { id: string; text: string; type: string; scores: Record<string, number | null | undefined>; usedField: string; usedScore: number }[];
	injected: string[];
	dropped: { id: string; reason: string }[];
	notesResults: { title: string; path: string; relevance: number }[];
	notesInjected: string[];
	notesDropped: { path: string; reason: string }[];
	auditOnly: boolean;
	latencyMs: number;
	error: string | null;
}
