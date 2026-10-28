/**
 * spend-footer — cross-session spend display for Pi's interactive footer.
 *
 * Replaces the all-time session cost/token segment with:
 *   today $X.XX · Yt tok │ Mon $X.XX · Yt tok │ provider ~$X.XX/$500
 *
 * Everything else the default footer shows is preserved:
 *   • Line 1: cwd (git branch) • session name
 *   • Line 2: spend segments (this extension) + context% / window  model • thinking
 *   • Line 3: extension statuses from ctx.ui.setStatus()
 *
 * ── Data sources ─────────────────────────────────────────────────────────────
 *
 * Under ~/.pi/agent/sessions there are three kinds of JSONL files:
 *
 *   1. Parent session files   – <sessions>/<dir>/<session>.jsonl
 *      The main chat session. Contains the parent agent's assistant messages.
 *      Entry format: { type:"message", id:"…", timestamp:"ISO", message:{role:"assistant",
 *        provider, responseId, usage:{cost:{total}, input, output, cacheRead, cacheWrite}} }
 *      Also: { type:"usage"|"compaction"|"branch_summary", usage:{cost:{total},…} }
 *
 *   2. Child session files    – <sessions>/<dir>/<session>/<runId>/run-N/session.jsonl
 *      Each subagent run writes its own session JSONL in this tree.
 *      Same entry format as parent sessions (type:"message", message.responseId present).
 *      These are the AUTHORITATIVE record for subagent costs.
 *
 *   3. Artifact transcript files – <sessions>/<dir>/<session>/subagent-artifacts/*.jsonl
 *      A secondary copy of each child session's messages written by pi-subagents.
 *      Every responseId in these files ALSO appears in the corresponding child
 *      session file. Including them would double-count every subagent response.
 *      *** Skipped entirely. ***
 *
 * ── Deduplication ────────────────────────────────────────────────────────────
 *
 *   Primary:  subagent-artifacts/ directories are excluded from the file walk.
 *             This eliminates all known duplicates (verified: 0 cross-file dups
 *             remain in parent + child sessions by responseId comparison).
 *
 *   Safety net: a module-level Set tracks message.responseId (or file:entryId
 *             as fallback) for entries in the current calendar month. Resets
 *             automatically on month rollover. Per-file contributedKeys enable
 *             clean removal if a file is truncated and re-scanned.
 *
 *   Only current-month entries are stored in the per-file day buckets, bounding
 *   both memory usage and the dedup set size.
 *
 * ── Performance contract ─────────────────────────────────────────────────────
 *
 *   • Footer render is synchronous — reads only pre-aggregated in-memory data.
 *   • Initial file scan runs asynchronously via setImmediate after session_start.
 *   • Subsequent scans are incremental (only new bytes per file via byte-offset cache).
 *   • Files whose mtime predates the current month are skipped after first scan.
 *   • A 60 s timer catches growing child-session files from async subagent runs.
 *   • "spend …" placeholder shown until the first scan finishes.
 *
 * ── Configuration in ~/.pi/agent/settings.json ───────────────────────────────
 *
 * {
 *   "spendFooter": {
 *     "budgets": {
 *       "jetstream": {
 *         "monthlyUsd": 500,
 *         "litellm": {
 *           "baseUrl": "https://example.litellm.ai",
 *           "apiKeyEnv": "MY_LITELLM_KEY_ENV_VAR"
 *         }
 *       }
 *     }
 *   }
 * }
 *
 * ── Notes ─────────────────────────────────────────────────────────────────────
 *
 *   • "Today" and "this month" use the LOCAL timezone calendar.
 *   • LiteLLM's budget period resets at UTC midnight, which may differ slightly
 *     from the local calendar month boundary; acceptable and documented.
 *   • Historical costs reflect pricing at the time each message was sent.
 *   • Temp subagent event files (/var/folders/.../pi-subagents-uid-N/…) are NOT
 *     scanned: their message_start entries carry zero cost, and their completed-run
 *     summaries would double-count the child session files.
 *   • The context% window shown is whatever ctx.getContextUsage() / ctx.model
 *     reports for the active model — the real configured context window.
 */

import type { ExtensionAPI, ExtensionContext, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// Config types  (read from settings.spendFooter at session_start)
// ─────────────────────────────────────────────────────────────────────────────

interface LiteLLMConfig {
  /** Base URL of the LiteLLM proxy, without trailing slash. */
  baseUrl: string;
  /**
   * Name of the environment variable that holds the API key.
   * The key is never logged or displayed; only the env var name appears in config.
   */
  apiKeyEnv: string;
}

interface ProviderBudgetConfig {
  /** Hard monthly cap in USD. */
  monthlyUsd: number;
  /** Optional live spend from a LiteLLM /key/info endpoint. */
  litellm?: LiteLLMConfig;
}

interface SpendFooterConfig {
  budgets?: Record<string, ProviderBudgetConfig>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal data types
// ─────────────────────────────────────────────────────────────────────────────

interface BucketTotals {
  cost: number;
  totalTokens: number;
  uncachedTokens: number; // input + output (excludes cache hits/writes)
}

/** Incremental per-file scan state. */
interface FileScanState {
  /** Absolute path to the file — used for fallback dedup keys. */
  path: string;
  /** Number of bytes already processed from this file. */
  byteOffset: number;
  /** Partial line buffered from the end of the last read chunk. */
  partialLine: string;
  /**
   * Contributions from this file, keyed by local calendar day ("YYYY-MM-DD").
   * Only entries from the current calendar month are stored here.
   * Each day maps provider → BucketTotals.
   */
  days: Map<string, Map<string, BucketTotals>>;
  /**
   * True when all entries in this file predate the current calendar month.
   * Files flagged as allHistorical are skipped if their mtime also predates
   * the current month start, saving re-reads of old sessions.
   */
  allHistorical: boolean;
  /**
   * Dedup keys (responseId or filePath:entryId) that this file contributed to
   * the global dedupSeen set. Used to cleanly undo contributions on truncation.
   */
  contributedKeys: Set<string>;
}

interface LiteLLMData {
  spend: number;
  /** max_budget from the server; 0 when absent. */
  maxBudget: number;
  budgetResetAt: string;
  fetchedAt: number; // Date.now() ms
}

// ─────────────────────────────────────────────────────────────────────────────
// Module-level scan state  (survives session switches)
// ─────────────────────────────────────────────────────────────────────────────

const fileStates = new Map<string, FileScanState>();
let scanDone = false;

/** Live LiteLLM data keyed by provider name. */
const litellmCache = new Map<string, LiteLLMData>();

// ── Global response-ID dedup (bounded to current calendar month) ───────────
//
// Tracks message.responseId (or filePath:entryId fallback) for every entry
// recorded in the current month.  Reset automatically on month rollover.
// Per-file contributedKeys allow precise removal when a file is truncated.

let dedupMonthKey = "";       // month at which dedupSeen was last reset
const dedupSeen = new Set<string>(); // dedup keys for the current month

// Lazy aggregate cache — recomputed when totalsDirty or day/month rolls over.
let totalsDirty = true;
let aggDayKey = "";
let aggMonthKey = "";
let aggDay = new Map<string, BucketTotals>(); // provider → today's totals
let aggMonth = new Map<string, BucketTotals>(); // provider → this month's totals

// ─────────────────────────────────────────────────────────────────────────────
// Date helpers  (local timezone)
// ─────────────────────────────────────────────────────────────────────────────

function p2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function localDayKey(tsMs: number): string {
  const d = new Date(tsMs);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

function localMonthKey(tsMs: number): string {
  const d = new Date(tsMs);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}`;
}

function nowDayKey(): string {
  return localDayKey(Date.now());
}

function nowMonthKey(): string {
  return localMonthKey(Date.now());
}

function monthAbbrev(mk: string): string {
  // mk = "YYYY-MM"
  const [y, m] = mk.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleString("en", { month: "short" });
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatting helpers
// ─────────────────────────────────────────────────────────────────────────────

function fmtCost(n: number): string {
  // Sub-cent: 4 decimal places. Round dollars: no decimals. Otherwise: 2 places.
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n >= 1 && n === Math.floor(n)) return `$${n}`;
  return `$${n.toFixed(2)}`;
}

function fmtTokens(n: number): string {
  if (n < 1_000) return `${n}`;
  if (n < 10_000) return `${(n / 1_000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1_000)}k`;
  if (n < 10_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return `${Math.round(n / 1_000_000)}M`;
}

function fmtCwd(cwd: string): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  if (home && cwd.startsWith(home)) {
    const rel = cwd.slice(home.length);
    return rel === "" ? "~" : `~${rel}`;
  }
  return cwd;
}

// ─────────────────────────────────────────────────────────────────────────────
// JSONL line parser
// ─────────────────────────────────────────────────────────────────────────────

interface ParsedUsage {
  tsMs: number;
  provider: string;
  cost: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Entry-level id field (for fallback dedup key when responseId is absent). */
  entryId: string;
  /** message.responseId — empty string when not present. */
  responseId: string;
}

/**
 * Extract usage from a single JSONL line. Returns null when the line has no
 * billable usage or cannot be parsed.
 *
 * Handled formats:
 *
 *   1. Parent/child session messages  – type:"message", message.role:"assistant"
 *      message.usage.cost is { total: number, ... }
 *
 *   2. Standalone usage entries        – type:"usage"
 *      (e.g. tool-result usage; same usage shape)
 *
 *   3. Compaction / branch_summary entries
 *      usage.cost is { total: number, ... }
 */
function parseLine(line: string): ParsedUsage | null {
  // Fast pre-filter: skip lines without "usage" to avoid expensive JSON.parse.
  if (!line.includes('"usage"')) return null;

  let e: Record<string, unknown>;
  try {
    e = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }

  function costFrom(c: unknown): number {
    if (typeof c === "number") return c;
    if (c !== null && typeof c === "object") {
      return (c as Record<string, unknown>).total as number ?? 0;
    }
    return 0;
  }

  function tsFrom(
    entry: Record<string, unknown>,
    msg?: Record<string, unknown>
  ): number {
    // Prefer message.timestamp (ms integer) — most accurate for parent/child sessions.
    if (msg && typeof msg.timestamp === "number") return msg.timestamp;
    // Fall back to entry.timestamp (ISO string or ms).
    if (typeof entry.timestamp === "string")
      return Date.parse(entry.timestamp as string);
    if (typeof entry.timestamp === "number") return entry.timestamp;
    // Subagent artifacts use entry.ts (ms) — kept for safety even though we skip them.
    if (typeof entry.ts === "number") return entry.ts;
    return 0;
  }

  const entryId = (e.id as string) ?? "";

  // ── Format 1: parent or child session assistant message ──────────────────
  const msg = e.message as Record<string, unknown> | undefined;
  if (msg && msg.role === "assistant" && e.type === "message") {
    const u = msg.usage as Record<string, unknown> | undefined;
    if (!u) return null;
    const cost = costFrom(u.cost);
    if (!cost) return null;
    const tsMs = tsFrom(e, msg);
    if (!tsMs || isNaN(tsMs)) return null;
    return {
      tsMs,
      provider: (msg.provider as string) ?? "unknown",
      cost,
      input: (u.input as number) ?? 0,
      output: (u.output as number) ?? 0,
      cacheRead: (u.cacheRead as number) ?? 0,
      cacheWrite: (u.cacheWrite as number) ?? 0,
      entryId,
      responseId: (msg.responseId as string) ?? "",
    };
  }

  // ── Format 2: standalone type:"usage" entry ──────────────────────────────
  if (e.type === "usage") {
    const u = e.usage as Record<string, unknown> | undefined;
    if (!u) return null;
    const cost = costFrom(u.cost);
    if (!cost) return null;
    const tsMs = tsFrom(e);
    if (!tsMs || isNaN(tsMs)) return null;
    return {
      tsMs,
      provider: (e.provider as string) ?? "unknown",
      cost,
      input: (u.input as number) ?? 0,
      output: (u.output as number) ?? 0,
      cacheRead: (u.cacheRead as number) ?? 0,
      cacheWrite: (u.cacheWrite as number) ?? 0,
      entryId,
      responseId: "",
    };
  }

  // ── Format 3: compaction / branch_summary with usage ────────────────────
  if (
    (e.type === "compaction" || e.type === "branch_summary") &&
    e.usage
  ) {
    const u = e.usage as Record<string, unknown>;
    const cost = costFrom(u.cost);
    if (!cost) return null;
    const tsMs = tsFrom(e);
    if (!tsMs || isNaN(tsMs)) return null;
    return {
      tsMs,
      provider: "compaction",
      cost,
      input: (u.input as number) ?? 0,
      output: (u.output as number) ?? 0,
      cacheRead: (u.cacheRead as number) ?? 0,
      cacheWrite: (u.cacheWrite as number) ?? 0,
      entryId,
      responseId: "",
    };
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Incremental file scanner
// ─────────────────────────────────────────────────────────────────────────────

const CHUNK = 65536; // 64 KB read chunks

/**
 * Record one parsed usage entry into the file's day-bucket map.
 *
 * Only entries from the current calendar month are stored (historical data
 * is never displayed and keeping it would grow memory unboundedly).
 *
 * Dedup logic:
 *   - On month rollover: clear dedupSeen and all contributedKeys.
 *   - Key = responseId when present; else "filePath:entryId".
 *   - Skip if key already in dedupSeen; otherwise add and record in
 *     state.contributedKeys so the key can be removed on truncation.
 */
function recordUsage(state: FileScanState, u: ParsedUsage): void {
  const dk = localDayKey(u.tsMs);
  const mk = dk.slice(0, 7); // "YYYY-MM"
  const curMk = nowMonthKey();

  // Silently drop entries from months before the current one.
  if (mk < curMk) return;

  // Month rollover: clear global dedup set and all per-file contribution lists.
  if (dedupMonthKey !== curMk) {
    dedupSeen.clear();
    dedupMonthKey = curMk;
    for (const fs of fileStates.values()) {
      fs.contributedKeys.clear();
    }
  }

  // Mark file as having current-month entries.
  state.allHistorical = false;

  // Deduplicate. Primary key is responseId; fallback is file path + entry id.
  const key = u.responseId || `${state.path}:${u.entryId}`;
  if (dedupSeen.has(key)) return;
  dedupSeen.add(key);
  state.contributedKeys.add(key);

  // Accumulate into the per-day bucket.
  let dayMap = state.days.get(dk);
  if (!dayMap) {
    dayMap = new Map();
    state.days.set(dk, dayMap);
  }

  let b = dayMap.get(u.provider);
  if (!b) {
    b = { cost: 0, totalTokens: 0, uncachedTokens: 0 };
    dayMap.set(u.provider, b);
  }

  b.cost += u.cost;
  b.totalTokens += u.input + u.output + u.cacheRead + u.cacheWrite;
  b.uncachedTokens += u.input + u.output;
  totalsDirty = true;
}

function processChunk(state: FileScanState, buf: Buffer, len: number): void {
  const text = state.partialLine + buf.subarray(0, len).toString("utf8");
  const lines = text.split("\n");
  state.partialLine = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const u = parseLine(line);
    if (u) recordUsage(state, u);
  }
}

function scanFile(filePath: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return;
  }

  let state = fileStates.get(filePath);

  if (!state) {
    state = {
      path: filePath,
      byteOffset: 0,
      partialLine: "",
      days: new Map(),
      allHistorical: true,
      contributedKeys: new Set(),
    };
    fileStates.set(filePath, state);
  } else {
    // Skip entirely-historical files whose mtime predates the current month.
    if (state.allHistorical) {
      const monthStart = new Date();
      monthStart.setDate(1);
      monthStart.setHours(0, 0, 0, 0);
      if (stat.mtimeMs < monthStart.getTime()) return;
    }

    // Nothing new to read.
    if (stat.size === state.byteOffset) return;

    // File shrank (truncation): remove this file's dedup contributions,
    // then reset and re-scan from the start.
    if (stat.size < state.byteOffset) {
      for (const k of state.contributedKeys) dedupSeen.delete(k);
      state.contributedKeys.clear();
      state.byteOffset = 0;
      state.partialLine = "";
      state.days.clear();
      state.allHistorical = true;
      totalsDirty = true;
    }
  }

  if (stat.size === state.byteOffset) return;

  const buf = Buffer.allocUnsafe(CHUNK);
  let fd: number;
  try {
    fd = fs.openSync(filePath, "r");
  } catch {
    return;
  }

  try {
    let offset = state.byteOffset;
    while (offset < stat.size) {
      const want = Math.min(CHUNK, stat.size - offset);
      const n = fs.readSync(fd, buf, 0, want, offset);
      if (n <= 0) break;
      processChunk(state, buf, n);
      offset += n;
    }
    state.byteOffset = offset;
  } finally {
    try {
      fs.closeSync(fd);
    } catch { /* ignore */ }
  }
}

/**
 * Recursively collect *.jsonl files under dir, skipping subagent-artifacts/
 * directories to avoid double-counting (their entries are a strict subset of
 * the child session files under <runId>/run-N/session.jsonl).
 */
function collectJsonl(dir: string): string[] {
  const results: string[] = [];
  try {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.isDirectory()) {
        // Skip artifact transcripts — all their responseIds appear in child sessions.
        if (ent.name === "subagent-artifacts") continue;
        results.push(...collectJsonl(path.join(dir, ent.name)));
      } else if (ent.isFile() && ent.name.endsWith(".jsonl")) {
        results.push(path.join(dir, ent.name));
      }
    }
  } catch { /* unreadable dir */ }
  return results;
}

/** Run (or re-run) the full scan. Safe to call at any time. */
function runScan(sessionDir: string): void {
  for (const f of collectJsonl(sessionDir)) {
    scanFile(f);
  }
  scanDone = true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Aggregate computation
// ─────────────────────────────────────────────────────────────────────────────

function addToBucket(
  dest: Map<string, BucketTotals>,
  provider: string,
  src: BucketTotals
): void {
  let b = dest.get(provider);
  if (!b) {
    b = { cost: 0, totalTokens: 0, uncachedTokens: 0 };
    dest.set(provider, b);
  }
  b.cost += src.cost;
  b.totalTokens += src.totalTokens;
  b.uncachedTokens += src.uncachedTokens;
}

function rebuildAggregates(): void {
  const dk = nowDayKey();
  const mk = nowMonthKey();
  const day = new Map<string, BucketTotals>();
  const month = new Map<string, BucketTotals>();

  for (const state of fileStates.values()) {
    for (const [dayKey, providers] of state.days) {
      const isToday = dayKey === dk;
      const isThisMonth = dayKey.slice(0, 7) === mk;
      if (!isToday && !isThisMonth) continue;
      for (const [prov, bucket] of providers) {
        if (isToday) addToBucket(day, prov, bucket);
        if (isThisMonth) addToBucket(month, prov, bucket);
      }
    }
  }

  aggDayKey = dk;
  aggMonthKey = mk;
  aggDay = day;
  aggMonth = month;
  totalsDirty = false;
}

function getAggregates(): {
  day: Map<string, BucketTotals>;
  month: Map<string, BucketTotals>;
} {
  if (
    totalsDirty ||
    aggDayKey !== nowDayKey() ||
    aggMonthKey !== nowMonthKey()
  ) {
    rebuildAggregates();
  }
  return { day: aggDay, month: aggMonth };
}

function sumMap(m: Map<string, BucketTotals>): BucketTotals {
  const t: BucketTotals = { cost: 0, totalTokens: 0, uncachedTokens: 0 };
  for (const b of m.values()) {
    t.cost += b.cost;
    t.totalTokens += b.totalTokens;
    t.uncachedTokens += b.uncachedTokens;
  }
  return t;
}

// ─────────────────────────────────────────────────────────────────────────────
// LiteLLM polling  (GET {baseUrl}/key/info)
// ─────────────────────────────────────────────────────────────────────────────

async function pollLiteLLM(
  provider: string,
  cfg: LiteLLMConfig,
  onUpdate: () => void
): Promise<void> {
  const apiKey = process.env[cfg.apiKeyEnv];
  if (!apiKey) return; // Key not configured — silently skip.

  const url = `${cfg.baseUrl.replace(/\/+$/, "")}/key/info`;
  let resp: Response;
  try {
    const ac = new AbortController();
    const tid = setTimeout(() => ac.abort(), 10_000);
    resp = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: ac.signal,
    });
    clearTimeout(tid);
  } catch {
    return; // Network / timeout — keep existing cached value or local estimate.
  }

  if (!resp.ok) return;

  let body: Record<string, unknown>;
  try {
    body = (await resp.json()) as Record<string, unknown>;
  } catch {
    return;
  }

  const info = body.info as Record<string, unknown> | undefined;
  if (!info) return;

  const spend = info.spend as number | undefined;
  if (typeof spend !== "number") return;

  litellmCache.set(provider, {
    spend,
    maxBudget:
      typeof info.max_budget === "number" ? info.max_budget : 0,
    budgetResetAt:
      typeof info.budget_reset_at === "string"
        ? (info.budget_reset_at as string)
        : "",
    fetchedAt: Date.now(),
  });

  onUpdate();
}

// ─────────────────────────────────────────────────────────────────────────────
// Spend segment computation  (pure — exported for verification / testing)
// ─────────────────────────────────────────────────────────────────────────────

export interface SpendGauge {
  provider: string;
  /** Formatted spend amount; "~" prefix when derived from local session-file estimate. */
  spendStr: string;
  /** Formatted cap amount. */
  capStr: string;
  /** Spend as a fraction of the cap (0–1+). */
  pct: number;
  /** True when spend comes from a live LiteLLM fetch. */
  isServer: boolean;
}

export interface SpendSegments {
  todayStr: string;
  monthStr: string;
  gauges: SpendGauge[];
}

/**
 * Compute display segments from aggregated data and live LiteLLM values.
 * Pure function — no side effects, safe to call from tests or scripts.
 */
export function computeSpendSegments(
  day: Map<string, BucketTotals>,
  month: Map<string, BucketTotals>,
  budgets: Record<string, ProviderBudgetConfig> | undefined,
  monthKey: string,
  liveCache: Map<string, LiteLLMData>
): SpendSegments {
  const dayTotal = sumMap(day);
  const monthTotal = sumMap(month);
  const mon = monthAbbrev(monthKey);

  const todayStr = `today ${fmtCost(dayTotal.cost)} · ${fmtTokens(dayTotal.totalTokens)} tok`;
  const monthStr = `${mon} ${fmtCost(monthTotal.cost)} · ${fmtTokens(monthTotal.totalTokens)} tok`;

  const gauges: SpendGauge[] = [];
  for (const [prov, cfg] of Object.entries(budgets ?? {})) {
    const live = liveCache.get(prov);
    const localSpend = month.get(prov)?.cost ?? 0;

    const spend = live ? live.spend : localSpend;
    const cap =
      live && live.maxBudget > 0 ? live.maxBudget : cfg.monthlyUsd;
    const pct = cap > 0 ? spend / cap : 0;
    const isServer = !!live;

    gauges.push({
      provider: prov,
      spendStr: `${isServer ? "" : "~"}${fmtCost(spend)}`,
      capStr: fmtCost(cap),
      pct,
      isServer,
    });
  }

  return { todayStr, monthStr, gauges };
}

// ─────────────────────────────────────────────────────────────────────────────
// Extension entry point
// ─────────────────────────────────────────────────────────────────────────────

export default function spendFooterExtension(pi: ExtensionAPI): void {
  // Subagent children have no interactive footer; skip entirely.
  // PI_SUBAGENT_CHILD="1" is set by pi-subagents in every child process
  // (verified in pi-subagents/bundle/index.js). ctx.mode !== "tui" is a
  // second guard that covers non-interactive modes even without this var.
  if (process.env.PI_SUBAGENT_CHILD === "1") return;

  // Cleanup functions drained on session_shutdown (and defensively at the
  // start of each session_start to prevent accumulation across reloads).
  const cleanupFns: (() => void)[] = [];

  function drainCleanup(): void {
    let fn: (() => void) | undefined;
    while ((fn = cleanupFns.pop())) {
      try { fn(); } catch { /* ignore */ }
    }
  }

  // ExtensionHandler<E> = (event: E, ctx: ExtensionContext) => ...
  // Bug fixed: first arg is the event, second is ctx.
  pi.on("session_start", async (_event: SessionStartEvent, ctx: ExtensionContext) => {
    // Drain any stale cleanup from a prior session (defensive guard against
    // any edge case where session_shutdown was skipped).
    drainCleanup();

    // Only run in interactive TUI mode; non-interactive modes have no footer.
    if (ctx.mode !== "tui") return;

    // ── Read extension configuration from settings ──────────────────────────
    // getSettings() is on ExtensionAPI (pi), NOT on ExtensionContext (ctx).

    const settings = pi.getSettings() as Record<string, unknown>;
    const sfCfg = settings.spendFooter as SpendFooterConfig | undefined;
    const budgets = sfCfg?.budgets ?? {};

    // Resolve session directory, honouring a custom sessionDir setting.
    const rawSessionDir = settings.sessionDir as string | undefined;
    const sessionDir = rawSessionDir
      ? rawSessionDir.replace(/^~(?=\/|$)/, os.homedir())
      : path.join(os.homedir(), ".pi", "agent", "sessions");

    // ── TUI reference (filled by setFooter; used by async callbacks) ────────

    let tui: { requestRender(): void } | null = null;

    // ── Register custom footer ───────────────────────────────────────────────

    ctx.ui.setFooter((tuiRef, theme, footerData) => {
      tui = tuiRef;

      // Trigger a re-render when the git branch changes.
      const unsubBranch = footerData.onBranchChange(() => tuiRef.requestRender());

      return {
        dispose(): void {
          unsubBranch();
          tui = null;
        },
        invalidate(): void {
          // Render is cheap — no caching needed.
        },
        render(width: number): string[] {
          // ── Line 1: cwd (branch) • session ────────────────────────────
          let pwd = fmtCwd(ctx.sessionManager.getCwd());
          const branch = footerData.getGitBranch();
          if (branch) pwd = `${pwd} (${branch})`;
          const sname = ctx.sessionManager.getSessionName();
          if (sname) pwd = `${pwd} • ${sname}`;
          const pwdLine = truncateToWidth(
            theme.fg("dim", pwd),
            width,
            theme.fg("dim", "...")
          );

          // ── Line 2: spend + context% + model ──────────────────────────

          // Left: spend segments
          let spendLine: string;
          if (!scanDone) {
            spendLine = theme.fg("dim", "spend …");
          } else {
            const { day, month } = getAggregates();
            const mk = nowMonthKey();
            const segs = computeSpendSegments(
              day,
              month,
              budgets,
              mk,
              litellmCache
            );

            const parts: string[] = [
              theme.fg("dim", segs.todayStr),
              theme.fg("dim", segs.monthStr),
            ];

            for (const g of segs.gauges) {
              const label = `${g.provider} ${g.spendStr}/${g.capStr}`;
              if (g.pct >= 0.9) {
                parts.push(theme.fg("error", label));
              } else if (g.pct >= 0.75) {
                parts.push(theme.fg("warning", label));
              } else {
                parts.push(theme.fg("dim", label));
              }
            }

            spendLine = parts.join(theme.fg("dim", " │ "));
          }

          // Right: context usage  (real window from ctx.getContextUsage() / ctx.model)
          const cu = ctx.getContextUsage();
          const pct = cu?.percent ?? null;
          const win = cu?.contextWindow ?? (ctx.model?.contextWindow ?? 0);
          const pctStr = pct !== null ? `${pct.toFixed(1)}%` : "?";
          const winStr = win > 0 ? fmtTokens(win) : "?";
          const ctxDisplay = `${pctStr}/${winStr}`;
          const ctxColoured =
            pct !== null && pct > 90
              ? theme.fg("error", ctxDisplay)
              : pct !== null && pct > 70
              ? theme.fg("warning", ctxDisplay)
              : theme.fg("dim", ctxDisplay);

          // Right: model + thinking level
          const modelId = ctx.model?.id ?? "no-model";
          const thinking = ctx.thinkingLevel;
          let modelStr =
            ctx.model?.reasoning && thinking
              ? thinking === "off"
                ? `${modelId} • thinking off`
                : `${modelId} • ${thinking}`
              : modelId;

          // Prepend "(provider)" when multiple providers are configured and space allows.
          if (footerData.getAvailableProviderCount() > 1 && ctx.model) {
            const withProv = `(${ctx.model.provider}) ${modelStr}`;
            const spendW = visibleWidth(spendLine);
            const ctxW = visibleWidth(ctxColoured);
            const testW = spendW + 2 + ctxW + 2 + visibleWidth(withProv);
            if (testW <= width) modelStr = withProv;
          }

          // Lay out line 2: [spend]···[ctx  model]
          const rightStr = `${ctxColoured}  ${theme.fg("dim", modelStr)}`;
          const leftW = visibleWidth(spendLine);
          const rightW = visibleWidth(rightStr);
          const needed = leftW + 2 + rightW;

          let statsLine: string;
          if (needed <= width) {
            const pad = " ".repeat(width - leftW - rightW);
            statsLine = spendLine + pad + rightStr;
          } else if (leftW + 2 < width) {
            const avail = Math.max(0, width - leftW - 2);
            const tr = truncateToWidth(rightStr, avail, "");
            const pad = " ".repeat(
              Math.max(0, width - leftW - visibleWidth(tr))
            );
            statsLine = spendLine + pad + tr;
          } else {
            statsLine = truncateToWidth(
              spendLine,
              width,
              theme.fg("dim", "...")
            );
          }

          // ── Line 3: extension statuses ─────────────────────────────────
          const lines = [pwdLine, statsLine];
          const statuses = footerData.getExtensionStatuses();
          if (statuses.size > 0) {
            const statusText = Array.from(statuses.entries())
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([, v]) =>
                v
                  .replace(/[\r\n\t]/g, " ")
                  .replace(/ +/g, " ")
                  .trim()
              )
              .join(" ");
            lines.push(
              truncateToWidth(statusText, width, theme.fg("dim", "..."))
            );
          }

          return lines;
        },
      };
    });

    // ── Initial scan (deferred so it doesn't block session startup) ─────────

    setImmediate(() => {
      try {
        runScan(sessionDir);
      } catch { /* scan errors must never surface */ }
      tui?.requestRender();
    });

    // ── Periodic refresh: 60 s (catches growing child-session files) ─────────

    const refreshTimer = setInterval(() => {
      try {
        runScan(sessionDir);
      } catch {}
      tui?.requestRender();
    }, 60_000);
    cleanupFns.push(() => clearInterval(refreshTimer));

    // ── Incremental scan after each assistant turn ────────────────────────────

    const unsubTurnEnd = pi.on("turn_end", async (_event, _ctx) => {
      try {
        runScan(sessionDir);
      } catch {}
      tui?.requestRender();
    });
    cleanupFns.push(unsubTurnEnd);

    // ── LiteLLM polling: 5-minute interval ───────────────────────────────────

    for (const [prov, cfg] of Object.entries(budgets)) {
      if (!cfg.litellm) continue;
      const litellmCfg = cfg.litellm;
      const refresh = () => tui?.requestRender();

      // First poll after a short delay so startup feels instant.
      const initTimer = setTimeout(() => {
        pollLiteLLM(prov, litellmCfg, refresh).catch(() => {});
      }, 3_000);
      cleanupFns.push(() => clearTimeout(initTimer));

      const pollTimer = setInterval(() => {
        pollLiteLLM(prov, litellmCfg, refresh).catch(() => {});
      }, 5 * 60_000);
      cleanupFns.push(() => clearInterval(pollTimer));
    }
  });

  pi.on("session_shutdown", (_event, _ctx) => {
    drainCleanup();
  });
}
