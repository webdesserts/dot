/**
 * Hindsight recall: parallel HTTP fetch from agent + shared banks.
 * REST endpoint: POST {baseUrl}/v1/default/banks/{bank}/memories/recall
 * Response: { results: MemoryResult[], ...extra keys tolerated }
 *
 * Uses only fetch() — no MCP, no spawned process.
 * Always degrades silently on network failure or timeout.
 *
 * Score selection (Hindsight 1.1.0+):
 *   Primary: reranker score when present and numeric (field "reranker").
 *   Fallback: semantic score (field "semantic") when reranker is null/absent.
 *   Both the field used and value are logged in the audit entry.
 */
import type { MemoryResult, MemoryRecallConfig } from "./types.ts";

/** Rough token estimate: ~4 chars per token. */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/** Resolve which score field to use and return the value. */
export function resolveScore(
	scores: MemoryResult["scores"],
	preferField: string,
): { field: string; value: number } {
	const primary = scores[preferField];
	if (typeof primary === "number" && isFinite(primary)) {
		return { field: preferField, value: primary };
	}
	// Fallback: semantic
	const semantic = scores["semantic"];
	if (typeof semantic === "number" && isFinite(semantic)) {
		return { field: "semantic", value: semantic };
	}
	return { field: preferField, value: 0 };
}

/** Call one bank. Returns [] on any error. */
async function fetchBank(
	baseUrl: string,
	bank: string,
	query: string,
	types: string[] | undefined,
	trace: boolean,
	signal: AbortSignal,
): Promise<MemoryResult[]> {
	const url = `${baseUrl.replace(/\/+$/, "")}/v1/default/banks/${bank}/memories/recall`;
	const body: Record<string, unknown> = { query, max_tokens: 600 };
	if (types && types.length > 0) body.types = types;
	if (trace) body.trace = true;
	try {
		const res = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal,
		});
		if (!res.ok) return [];
		// Tolerate extra top-level keys (trace, entities, chunks, source_facts, …)
		const data = (await res.json()) as Record<string, unknown>;
		const results = data?.results;
		return Array.isArray(results) ? (results as MemoryResult[]) : [];
	} catch {
		return [];
	}
}

/** Dedup by id, keeping the copy with the higher resolved score. */
function dedupResults(results: MemoryResult[], preferField: string): MemoryResult[] {
	const seen = new Map<string, MemoryResult>();
	for (const r of results) {
		const prev = seen.get(r.id);
		const score = resolveScore(r.scores, preferField).value;
		if (!prev || score > resolveScore(prev.scores, preferField).value) {
			seen.set(r.id, r);
		}
	}
	return [...seen.values()];
}

export interface FilteredMemory {
	result: MemoryResult;
	usedField: string;
	usedScore: number;
}

export interface FilteredMemories {
	injected: FilteredMemory[];
	dropped: { id: string; reason: string }[];
}

/**
 * Apply threshold (with reranker→semantic fallback), dedup against seenIds,
 * cap to maxMemories / maxMemoryTokens.
 *
 * Threshold logic (Hindsight 1.1.0+):
 *   If preferField=="reranker" and the result has a numeric reranker score → compare to config threshold.
 *   If reranker is null/missing → fall back to semantic field against fallbackThreshold (0.75).
 *   Any other preferField → compare directly.
 */
export function filterMemories(
	results: MemoryResult[],
	config: Pick<MemoryRecallConfig, "minScore" | "maxMemories" | "maxMemoryTokens">,
	seenIds: ReadonlySet<string>,
): FilteredMemories {
	const injected: FilteredMemory[] = [];
	const dropped: { id: string; reason: string }[] = [];
	let usedTokens = 0;
	const { field: preferField, value: threshold } = config.minScore;
	// When the preferred field is reranker and it's missing, fall back to semantic ≥ 0.75
	const semanticFallbackThreshold = 0.75;

	for (const r of results) {
		if (seenIds.has(r.id)) {
			dropped.push({ id: r.id, reason: "already injected" });
			continue;
		}
		const { field: usedField, value: usedScore } = resolveScore(r.scores, preferField);
		const effectiveThreshold = usedField !== preferField
			? semanticFallbackThreshold
			: threshold;
		if (usedScore < effectiveThreshold) {
			dropped.push({ id: r.id, reason: `${usedField} ${usedScore.toFixed(4)} < ${effectiveThreshold} (${usedField === preferField ? "primary" : "semantic fallback"})` });
			continue;
		}
		if (injected.length >= config.maxMemories) {
			dropped.push({ id: r.id, reason: "memory cap" });
			continue;
		}
		const tok = estimateTokens(r.text);
		if (usedTokens + tok > config.maxMemoryTokens) {
			dropped.push({ id: r.id, reason: "token cap" });
			continue;
		}
		injected.push({ result: r, usedField, usedScore });
		usedTokens += tok;
	}
	return { injected, dropped };
}

export interface RecallResult {
	memories: FilteredMemories;
	allResults: MemoryResult[];
	error: string | null;
}

/**
 * Recall from both banks in parallel.
 * Never throws; returns empty results with error on any failure.
 */
export async function recallMemories(
	query: string,
	config: MemoryRecallConfig,
	seenIds: ReadonlySet<string>,
	timeoutMs: number,
): Promise<RecallResult> {
	const ac = new AbortController();
	const tid = setTimeout(() => ac.abort(), timeoutMs);
	try {
		const [agentResults, sharedResults] = await Promise.all([
			fetchBank(config.hindsightBaseUrl, config.agentBank, query, config.memoryTypes, config.enableTrace, ac.signal),
			fetchBank(config.hindsightBaseUrl, config.sharedBank, query, config.memoryTypes, config.enableTrace, ac.signal),
		]);
		clearTimeout(tid);
		// Sort combined results by resolved score descending before dedup
		const combined = [...agentResults, ...sharedResults].sort(
			(a, b) => resolveScore(b.scores, config.minScore.field).value - resolveScore(a.scores, config.minScore.field).value,
		);
		const deduped = dedupResults(combined, config.minScore.field);
		return {
			memories: filterMemories(deduped, config, seenIds),
			allResults: deduped,
			error: null,
		};
	} catch (err) {
		clearTimeout(tid);
		const msg = err instanceof Error ? err.message : String(err);
		return { memories: { injected: [], dropped: [] }, allResults: [], error: msg };
	}
}
