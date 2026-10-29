/**
 * spend-footer — cross-session spend pacing for Pi's interactive footer, plus
 * an on-demand `/costs` diagnostic report.
 *
 * Footer layout (the default footer's information is preserved):
 *   • Line 1: cwd (git branch) • session name
 *   • Line 2: 40.2%/700k │ today 1.2M tok · $8.40 (1.2× avg)      (google $18/$200) gemini-4-argon • high
 *             └ context ┘   └ all tokens ┘  └ metered $ + pace ┘   └ provider month gauge ┘ └ model • thinking ┘
 *   • Line 3: extension statuses from ctx.ui.setStatus()
 *
 * Today's cost is METERED spend only (subscription and zero-cost usage
 * excluded). The two parts are coloured independently: the dollar amount by
 * the hard daily thresholds (above dailyWarnUsd warning, above dailyRedUsd
 * error) and the "(N× avg)" pace by the ratio to the 30-day active-day average
 * (≥ 1.25 warning, ≥ 1.75 error).
 *
 * The right-hand provider tag shows the active provider's month-to-date spend:
 *   capped metered     (google $18/$200)    coloured at ≥ 75 % / ≥ 90 % of cap
 *   uncapped metered   (fireworks $4.20)
 *   subscription       (openai)             JSONL cost is synthetic list price
 * Non-active capped providers at ≥ 75 % of their cap are prepended as badges.
 *
 * ── Data sources ─────────────────────────────────────────────────────────────
 *
 * Under ~/.pi/agent/sessions there are three kinds of JSONL files:
 *
 *   1. Parent session files   – <sessions>/<dir>/<session>.jsonl
 *      Entry format: { type:"message", timestamp:"ISO", message:{role:"assistant",
 *        provider, model, responseId, usage:{cost:{total}, input, output, cacheRead, cacheWrite}} }
 *      Also: { type:"usage"|"compaction"|"branch_summary", usage:{cost:{total},…} }
 *
 *   2. Child session files    – <sessions>/<dir>/<session>/<runId>/run-N/session.jsonl
 *      Each subagent run writes its own session JSONL. AUTHORITATIVE for
 *      subagent costs; counted as "subagent" spend in the driver/subagent split.
 *
 *   3. Artifact transcript files – <sessions>/<dir>/<session>/subagent-artifacts/*.jsonl
 *      A secondary copy of child messages. Skipped entirely (would double-count).
 *
 * Compaction / branch-summary entries carry no provider or model; they are
 * attributed to the most recent assistant provider seen in the same file, under
 * the model label "compaction".
 *
 * ── Retention and deduplication ──────────────────────────────────────────────
 *
 *   Daily buckets are retained from min(start of current month, today − 35 days),
 *   so both the calendar month and the rolling 30-day baseline survive month
 *   rollover. Older buckets and their dedup keys are pruned when the day changes.
 *
 *   Dedup: subagent-artifacts/ is excluded from the walk; a global map of
 *   message.responseId (or file:entryId fallback) → day catches any remaining
 *   duplicates. Per-file contributed keys allow clean removal on truncation.
 *
 * ── Performance contract ─────────────────────────────────────────────────────
 *
 *   • Footer render is synchronous and reads a cached summary.
 *   • Initial scan runs via setImmediate after session_start; later scans are
 *     incremental (byte offsets), on turn_end, every 60 s and on /costs.
 *   • Files whose entries all predate the retention window and whose mtime does
 *     too are skipped after the first scan.
 *
 * ── Configuration (settings.json) ────────────────────────────────────────────
 *
 * {
 *   "spendFooter": {
 *     "dailyWarnUsd": 20,                       // default 20; above → warning
 *     "dailyRedUsd": 30,                        // default 30; above → error
 *     "providers": {
 *       "google":    { "monthlyCapUsd": 200 },
 *       "anthropic": { "monthlyCapUsd": 200 },
 *       "openai":    { "subscription": true },
 *       "jetstream": { "monthlyCapUsd": 500,
 *                      "litellm": { "baseUrl": "https://…", "apiKeyEnv": "ENV_VAR" } }
 *     },
 *     "budgets": { "<provider>": { "monthlyUsd": 500, "litellm": {…} } }  // legacy, still honoured
 *   }
 * }
 *
 * `openai` and `openai-codex` default to subscription (ChatGPT OAuth: JSONL cost
 * is a list-price equivalent, not metered spend) unless configured with a
 * monthlyCapUsd or `subscription: false`.
 *
 * ── Notes ─────────────────────────────────────────────────────────────────────
 *
 *   • "Today" and "this month" use the LOCAL timezone calendar.
 *   • LiteLLM budget periods reset at UTC midnight; acceptable and documented.
 *   • Historical costs reflect pricing at the time each message was sent.
 *   • Zero-cost entries (local models, subscriptions) still count tokens and turns.
 */

import type { ExtensionAPI, ExtensionContext, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { Box, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

interface LiteLLMConfig {
  /** Base URL of the LiteLLM proxy, without trailing slash. */
  baseUrl: string;
  /** Name of the environment variable holding the API key (never displayed). */
  apiKeyEnv: string;
}

interface ProviderSettings {
  monthlyCapUsd?: number;
  subscription?: boolean;
  litellm?: LiteLLMConfig;
}

/** Legacy `spendFooter.budgets.<provider>` shape. */
interface LegacyBudgetSettings {
  monthlyUsd?: number;
  litellm?: LiteLLMConfig;
}

interface SpendFooterSettings {
  dailyWarnUsd?: number;
  dailyRedUsd?: number;
  providers?: Record<string, ProviderSettings>;
  budgets?: Record<string, LegacyBudgetSettings>;
}

export interface ResolvedProvider {
  monthlyCapUsd?: number;
  subscription: boolean;
  litellm?: LiteLLMConfig;
}

export interface SpendConfig {
  dailyWarnUsd: number;
  dailyRedUsd: number;
  providers: Map<string, ResolvedProvider>;
}

const DEFAULT_SUBSCRIPTION_PROVIDERS = ["openai", "openai-codex"];

function positiveNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
}

/** Resolve settings.spendFooter into a complete config with defaults applied. */
export function resolveSpendConfig(raw: unknown): SpendConfig {
  const s = (raw !== null && typeof raw === "object" ? raw : {}) as SpendFooterSettings;
  const providers = new Map<string, ResolvedProvider>();

  for (const prov of DEFAULT_SUBSCRIPTION_PROVIDERS) {
    providers.set(prov, { subscription: true });
  }
  for (const [prov, b] of Object.entries(s.budgets ?? {})) {
    const cap = positiveNumber(b?.monthlyUsd);
    providers.set(prov, { subscription: false, monthlyCapUsd: cap, litellm: b?.litellm });
  }
  for (const [prov, p] of Object.entries(s.providers ?? {})) {
    const prev = providers.get(prov);
    const cap = positiveNumber(p?.monthlyCapUsd) ?? (prev?.subscription ? undefined : prev?.monthlyCapUsd);
    // A configured cap means metered unless subscription is explicitly true.
    const subscription = p?.subscription ?? (cap !== undefined ? false : prev?.subscription ?? false);
    providers.set(prov, {
      subscription,
      monthlyCapUsd: subscription ? undefined : cap,
      litellm: p?.litellm ?? prev?.litellm,
    });
  }

  return {
    dailyWarnUsd: positiveNumber(s.dailyWarnUsd) ?? 20,
    dailyRedUsd: positiveNumber(s.dailyRedUsd) ?? 30,
    providers,
  };
}

function isSubscription(cfg: SpendConfig, provider: string): boolean {
  return cfg.providers.get(provider)?.subscription ?? false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Usage totals
// ─────────────────────────────────────────────────────────────────────────────

export interface UsageTotals {
  cost: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Assistant messages (compaction / standalone usage entries add 0). */
  turns: number;
}

function zeroTotals(): UsageTotals {
  return { cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0 };
}

function addTotals(dst: UsageTotals, src: UsageTotals): void {
  dst.cost += src.cost;
  dst.input += src.input;
  dst.output += src.output;
  dst.cacheRead += src.cacheRead;
  dst.cacheWrite += src.cacheWrite;
  dst.turns += src.turns;
}

function totalTokens(t: UsageTotals): number {
  return t.input + t.output + t.cacheRead + t.cacheWrite;
}

/** cacheRead / (input + cacheRead); undefined when no prompt tokens. */
function cacheHitRate(t: UsageTotals): number | undefined {
  const prompt = t.input + t.cacheRead;
  return prompt > 0 ? t.cacheRead / prompt : undefined;
}

function costPerTurn(t: UsageTotals): number | undefined {
  return t.turns > 0 ? t.cost / t.turns : undefined;
}

/** One aggregated bucket: a local day × provider × model × driver/subagent. */
export interface UsageRow {
  day: string; // "YYYY-MM-DD"
  provider: string;
  model: string;
  isSubagent: boolean;
  totals: UsageTotals;
}

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

function nowDayKey(): string {
  return localDayKey(Date.now());
}

/** Shift a "YYYY-MM-DD" key by whole calendar days (DST-safe). */
function shiftDayKey(dayKey: string, days: number): string {
  const [y, m, d] = dayKey.split("-").map(Number);
  return localDayKey(new Date(y, m - 1, d + days).getTime());
}

function dayKeyStartMs(dayKey: string): number {
  const [y, m, d] = dayKey.split("-").map(Number);
  return new Date(y, m - 1, d).getTime();
}

const RETENTION_DAYS = 35;

/** Earliest retained day: min(start of current month, today − 35 days). */
function retentionStartKey(todayKey: string): string {
  const monthStart = `${todayKey.slice(0, 7)}-01`;
  const rolling = shiftDayKey(todayKey, -RETENTION_DAYS);
  return rolling < monthStart ? rolling : monthStart;
}

function monthAbbrev(monthKey: string): string {
  const [y, m] = monthKey.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleString("en", { month: "short" });
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatting helpers
// ─────────────────────────────────────────────────────────────────────────────

function fmtCost(n: number): string {
  if (n === 0) return "$0.00";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

/** Compact dollars for gauges: whole dollars from $10, cents below. */
function fmtGaugeCost(n: number): string {
  if (n === 0) return "$0";
  if (n >= 10) return `$${Math.round(n)}`;
  return `$${n.toFixed(2)}`;
}

function fmtTokens(n: number): string {
  if (n < 1_000) return `${n}`;
  if (n < 10_000) return `${(n / 1_000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1_000)}k`;
  if (n < 10_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return `${Math.round(n / 1_000_000)}M`;
}

function fmtPct(rate: number | undefined): string {
  return rate === undefined ? "—" : `${Math.round(rate * 100)}%`;
}

function fmtPerTurn(v: number | undefined): string {
  return v === undefined ? "—" : fmtCost(v);
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

export interface ParsedUsage {
  tsMs: number;
  /** Empty for compaction / branch-summary entries (attributed by the scanner). */
  provider: string;
  model: string;
  totals: UsageTotals;
  /** Entry-level id field (fallback dedup key when responseId is absent). */
  entryId: string;
  /** message.responseId — empty string when not present. */
  responseId: string;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function costFrom(c: unknown): number {
  if (typeof c === "number") return c;
  if (c !== null && typeof c === "object") return num((c as Record<string, unknown>).total);
  return 0;
}

function tsFrom(entry: Record<string, unknown>, msg?: Record<string, unknown>): number {
  if (msg && typeof msg.timestamp === "number") return msg.timestamp;
  if (typeof entry.timestamp === "string") return Date.parse(entry.timestamp);
  if (typeof entry.timestamp === "number") return entry.timestamp;
  if (typeof entry.ts === "number") return entry.ts;
  return 0;
}

function totalsFrom(u: Record<string, unknown>, turns: number): UsageTotals {
  return {
    cost: costFrom(u.cost),
    input: num(u.input),
    output: num(u.output),
    cacheRead: num(u.cacheRead),
    cacheWrite: num(u.cacheWrite),
    turns,
  };
}

/**
 * Extract usage from one JSONL line, or null when the line carries no usage.
 * Zero-cost entries with tokens are kept so local/subscription turns count.
 */
export function parseLine(line: string): ParsedUsage | null {
  if (!line.includes('"usage"')) return null;

  let e: Record<string, unknown>;
  try {
    e = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }

  const entryId = typeof e.id === "string" ? e.id : "";
  let parsed: ParsedUsage | null = null;

  const msg = e.message as Record<string, unknown> | undefined;
  if (e.type === "message" && msg && msg.role === "assistant") {
    const u = msg.usage as Record<string, unknown> | undefined;
    if (!u) return null;
    parsed = {
      tsMs: tsFrom(e, msg),
      provider: typeof msg.provider === "string" ? msg.provider : "unknown",
      model: typeof msg.model === "string" ? msg.model : "unknown",
      totals: totalsFrom(u, 1),
      entryId,
      responseId: typeof msg.responseId === "string" ? msg.responseId : "",
    };
  } else if (e.type === "usage" && e.usage) {
    parsed = {
      tsMs: tsFrom(e),
      provider: typeof e.provider === "string" ? e.provider : "unknown",
      model: typeof e.model === "string" ? e.model : "unknown",
      totals: totalsFrom(e.usage as Record<string, unknown>, 0),
      entryId,
      responseId: "",
    };
  } else if ((e.type === "compaction" || e.type === "branch_summary") && e.usage) {
    parsed = {
      tsMs: tsFrom(e),
      provider: "",
      model: "compaction",
      totals: totalsFrom(e.usage as Record<string, unknown>, 0),
      entryId,
      responseId: "",
    };
  }

  if (!parsed || !parsed.tsMs || Number.isNaN(parsed.tsMs)) return null;
  if (parsed.totals.cost === 0 && totalTokens(parsed.totals) === 0) return null;
  return parsed;
}

// ─────────────────────────────────────────────────────────────────────────────
// Incremental file scanner  (module state survives session switches)
// ─────────────────────────────────────────────────────────────────────────────

interface BucketEntry {
  provider: string;
  model: string;
  totals: UsageTotals;
}

interface FileScanState {
  path: string;
  /** True for child runs: <runId>/run-N/session.jsonl. */
  isSubagent: boolean;
  byteOffset: number;
  partialLine: string;
  /** day → "provider\0model" → bucket. Only retained days are stored. */
  days: Map<string, Map<string, BucketEntry>>;
  /** True while no entry falls inside the retention window. */
  allHistorical: boolean;
  /** Dedup keys this file contributed → day key (for pruning/truncation). */
  contributedKeys: Map<string, string>;
  /** Last assistant provider seen, used to attribute compaction usage. */
  lastProvider: string;
}

const SUBAGENT_SESSION_RE = /[\\/][^\\/]+[\\/]run-\d+[\\/]session\.jsonl$/;

const fileStates = new Map<string, FileScanState>();
let scanDone = false;
const litellmCache = new Map<string, LiteLLMData>();

/** Global dedup: key → day key. Pruned with the retention window. */
const dedupSeen = new Map<string, string>();
let prunedThroughKey = "";

let totalsDirty = true;
let aggDayKey = "";
let aggRows: UsageRow[] = [];

const CHUNK = 65536;

function recordUsage(state: FileScanState, u: ParsedUsage): void {
  if (u.provider) state.lastProvider = u.provider;

  const dk = localDayKey(u.tsMs);
  if (dk < retentionStartKey(nowDayKey())) return;
  state.allHistorical = false;

  const key = u.responseId || `${state.path}:${u.entryId}`;
  if (dedupSeen.has(key)) return;
  dedupSeen.set(key, dk);
  state.contributedKeys.set(key, dk);

  const provider = u.provider || state.lastProvider || "compaction";
  let dayMap = state.days.get(dk);
  if (!dayMap) {
    dayMap = new Map();
    state.days.set(dk, dayMap);
  }
  const bucketKey = `${provider}\0${u.model}`;
  let b = dayMap.get(bucketKey);
  if (!b) {
    b = { provider, model: u.model, totals: zeroTotals() };
    dayMap.set(bucketKey, b);
  }
  addTotals(b.totals, u.totals);
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
      isSubagent: SUBAGENT_SESSION_RE.test(filePath),
      byteOffset: 0,
      partialLine: "",
      days: new Map(),
      allHistorical: true,
      contributedKeys: new Map(),
      lastProvider: "",
    };
    fileStates.set(filePath, state);
  } else {
    if (state.allHistorical && stat.mtimeMs < dayKeyStartMs(retentionStartKey(nowDayKey()))) return;
    if (stat.size === state.byteOffset) return;
    if (stat.size < state.byteOffset) {
      // Truncated: undo this file's contributions and re-scan from the start.
      for (const k of state.contributedKeys.keys()) dedupSeen.delete(k);
      state.contributedKeys.clear();
      state.byteOffset = 0;
      state.partialLine = "";
      state.days.clear();
      state.allHistorical = true;
      state.lastProvider = "";
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
      const n = fs.readSync(fd, buf, 0, Math.min(CHUNK, stat.size - offset), offset);
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

/** Collect *.jsonl under dir, skipping subagent-artifacts/ (duplicate transcripts). */
function collectJsonl(dir: string): string[] {
  const results: string[] = [];
  try {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.isDirectory()) {
        if (ent.name === "subagent-artifacts") continue;
        results.push(...collectJsonl(path.join(dir, ent.name)));
      } else if (ent.isFile() && ent.name.endsWith(".jsonl")) {
        results.push(path.join(dir, ent.name));
      }
    }
  } catch { /* unreadable dir */ }
  return results;
}

/** Drop buckets and dedup keys older than the retention window. */
function pruneRetention(todayKey: string): void {
  const cutoff = retentionStartKey(todayKey);
  if (cutoff === prunedThroughKey) return;
  prunedThroughKey = cutoff;
  for (const state of fileStates.values()) {
    for (const dk of state.days.keys()) {
      if (dk < cutoff) state.days.delete(dk);
    }
    for (const [k, dk] of state.contributedKeys) {
      if (dk < cutoff) {
        state.contributedKeys.delete(k);
        dedupSeen.delete(k);
      }
    }
    if (state.days.size === 0) state.allHistorical = true;
  }
  totalsDirty = true;
}

/** Run (or re-run) the incremental scan. Safe to call at any time. */
function runScan(sessionDir: string): void {
  pruneRetention(nowDayKey());
  for (const f of collectJsonl(sessionDir)) scanFile(f);
  scanDone = true;
}

/** Flatten per-file buckets into rows merged by day × provider × model × subagent. */
function getRows(): UsageRow[] {
  const dk = nowDayKey();
  if (!totalsDirty && aggDayKey === dk) return aggRows;
  pruneRetention(dk);
  const merged = new Map<string, UsageRow>();
  for (const state of fileStates.values()) {
    for (const [day, buckets] of state.days) {
      for (const b of buckets.values()) {
        const key = `${day}\0${b.provider}\0${b.model}\0${state.isSubagent ? 1 : 0}`;
        let row = merged.get(key);
        if (!row) {
          row = { day, provider: b.provider, model: b.model, isSubagent: state.isSubagent, totals: zeroTotals() };
          merged.set(key, row);
        }
        addTotals(row.totals, b.totals);
      }
    }
  }
  aggRows = [...merged.values()];
  aggDayKey = dk;
  totalsDirty = false;
  return aggRows;
}

// ─────────────────────────────────────────────────────────────────────────────
// Summary  (pure — exported for verification)
// ─────────────────────────────────────────────────────────────────────────────

export interface ProviderStats {
  total: UsageTotals;
  models: Map<string, UsageTotals>;
}

export interface PeriodStats {
  all: UsageTotals;
  metered: UsageTotals;
  /** Subscription providers plus zero-cost (local) usage. */
  unmetered: UsageTotals;
  meteredDriver: UsageTotals;
  meteredSubagent: UsageTotals;
  providers: Map<string, ProviderStats>;
}

export interface SpendSummary {
  todayKey: string;
  monthKey: string;
  today: PeriodStats;
  month: PeriodStats;
  /** The 30 days before today (today excluded). */
  prior30: PeriodStats;
  /** Days in prior30 with metered spend. */
  priorActiveDays: number;
  /** Metered average over prior active days; falls back to today when there are none. */
  avgDailyMetered: number;
  avgIsFallback: boolean;
}

function emptyPeriod(): PeriodStats {
  return {
    all: zeroTotals(),
    metered: zeroTotals(),
    unmetered: zeroTotals(),
    meteredDriver: zeroTotals(),
    meteredSubagent: zeroTotals(),
    providers: new Map(),
  };
}

function addRowToPeriod(p: PeriodStats, row: UsageRow, unmetered: boolean): void {
  addTotals(p.all, row.totals);
  if (unmetered) {
    addTotals(p.unmetered, row.totals);
  } else {
    addTotals(p.metered, row.totals);
    addTotals(row.isSubagent ? p.meteredSubagent : p.meteredDriver, row.totals);
  }
  let prov = p.providers.get(row.provider);
  if (!prov) {
    prov = { total: zeroTotals(), models: new Map() };
    p.providers.set(row.provider, prov);
  }
  addTotals(prov.total, row.totals);
  let model = prov.models.get(row.model);
  if (!model) {
    model = zeroTotals();
    prov.models.set(row.model, model);
  }
  addTotals(model, row.totals);
}

export function summarize(rows: UsageRow[], cfg: SpendConfig, todayKey: string): SpendSummary {
  const monthKey = todayKey.slice(0, 7);
  const windowStart = shiftDayKey(todayKey, -30);
  const today = emptyPeriod();
  const month = emptyPeriod();
  const prior30 = emptyPeriod();
  const priorDaily = new Map<string, number>();

  for (const row of rows) {
    // Zero-cost rows (local models) stay out of metered $/turn and cache rates.
    const sub = isSubscription(cfg, row.provider) || row.totals.cost === 0;
    if (row.day === todayKey) addRowToPeriod(today, row, sub);
    if (row.day.slice(0, 7) === monthKey && row.day <= todayKey) addRowToPeriod(month, row, sub);
    if (row.day >= windowStart && row.day < todayKey) {
      addRowToPeriod(prior30, row, sub);
      if (!sub) priorDaily.set(row.day, (priorDaily.get(row.day) ?? 0) + row.totals.cost);
    }
  }

  let priorActiveDays = 0;
  for (const cost of priorDaily.values()) if (cost > 0) priorActiveDays++;
  const avgIsFallback = priorActiveDays === 0;
  const avgDailyMetered = avgIsFallback ? today.metered.cost : prior30.metered.cost / priorActiveDays;

  return { todayKey, monthKey, today, month, prior30, priorActiveDays, avgDailyMetered, avgIsFallback };
}

// ─────────────────────────────────────────────────────────────────────────────
// Footer segments  (pure — exported for verification)
// ─────────────────────────────────────────────────────────────────────────────

export type Level = "dim" | "warning" | "error";

export interface Segment {
  text: string;
  level: Level;
}

export interface SpendSegments {
  /** "today 1.2M tok" — all providers, all token kinds. */
  todayTokens: string;
  /** "$8.40" — metered spend, coloured only by the hard daily thresholds. */
  todayCost: Segment;
  /** "(1.2× avg)" — coloured only by pace; undefined when there is no average. */
  todayPace?: Segment;
  /** Today ÷ 30d active-day average; undefined when both are zero. */
  paceRatio?: number;
  /** "(google $18/$200)" etc.; undefined without an active provider. */
  providerTag?: Segment;
  /** Non-active capped providers at ≥ 75 % of cap: "anthropic $160/$200". */
  backgroundBadges: Segment[];
}

interface LiteLLMData {
  spend: number;
  /** max_budget from the server; 0 when absent. */
  maxBudget: number;
  budgetResetAt: string;
  fetchedAt: number;
}

interface CapGauge {
  spend: number;
  cap: number;
  pct: number;
  level: Level;
}

function capLevel(pct: number): Level {
  return pct >= 0.9 ? "error" : pct >= 0.75 ? "warning" : "dim";
}

function capGauge(
  provider: string,
  summary: SpendSummary,
  cfg: SpendConfig,
  live: Map<string, LiteLLMData>,
): CapGauge | undefined {
  const pc = cfg.providers.get(provider);
  const l = live.get(provider);
  const cap = l && l.maxBudget > 0 ? l.maxBudget : pc?.monthlyCapUsd;
  if (!cap || pc?.subscription) return undefined;
  const spend = l ? l.spend : summary.month.providers.get(provider)?.total.cost ?? 0;
  const pct = spend / cap;
  return { spend, cap, pct, level: capLevel(pct) };
}

export function paceLevel(ratio: number | undefined): Level {
  if (ratio === undefined) return "dim";
  return ratio >= 1.75 ? "error" : ratio >= 1.25 ? "warning" : "dim";
}

export function dailyThresholdLevel(cost: number, cfg: SpendConfig): Level {
  return cost > cfg.dailyRedUsd ? "error" : cost > cfg.dailyWarnUsd ? "warning" : "dim";
}

export function computeSpendSegments(
  summary: SpendSummary,
  cfg: SpendConfig,
  activeProvider: string | undefined,
  live: Map<string, LiteLLMData> = new Map(),
): SpendSegments {
  const todayMetered = summary.today.metered.cost;
  const paceRatio = summary.avgDailyMetered > 0 ? todayMetered / summary.avgDailyMetered : undefined;
  const todayCost: Segment = { text: fmtCost(todayMetered), level: dailyThresholdLevel(todayMetered, cfg) };
  const todayPace: Segment | undefined =
    paceRatio === undefined ? undefined : { text: `(${paceRatio.toFixed(1)}× avg)`, level: paceLevel(paceRatio) };

  let providerTag: Segment | undefined;
  if (activeProvider) {
    const gauge = capGauge(activeProvider, summary, cfg, live);
    if (gauge) {
      providerTag = {
        text: `(${activeProvider} ${fmtGaugeCost(gauge.spend)}/${fmtGaugeCost(gauge.cap)})`,
        level: gauge.level,
      };
    } else if (isSubscription(cfg, activeProvider)) {
      providerTag = { text: `(${activeProvider})`, level: "dim" };
    } else {
      const spend = summary.month.providers.get(activeProvider)?.total.cost ?? 0;
      providerTag = { text: spend > 0 ? `(${activeProvider} ${fmtCost(spend)})` : `(${activeProvider})`, level: "dim" };
    }
  }

  const backgroundBadges: Segment[] = [];
  const capped = new Set([...cfg.providers.keys(), ...live.keys()]);
  for (const prov of [...capped].sort()) {
    if (prov === activeProvider) continue;
    const gauge = capGauge(prov, summary, cfg, live);
    if (!gauge || gauge.pct < 0.75) continue;
    backgroundBadges.push({
      text: `${prov} ${fmtGaugeCost(gauge.spend)}/${fmtGaugeCost(gauge.cap)}`,
      level: gauge.level,
    });
  }

  return {
    todayTokens: `today ${fmtTokens(totalTokens(summary.today.all))} tok`,
    todayCost,
    todayPace,
    paceRatio,
    providerTag,
    backgroundBadges,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// /costs report  (pure — exported for verification)
//
// The report is built as a JSON-safe document of semantically tagged spans and
// stored in the session entry. Styling happens at render time with the active
// theme, so theme changes recolour old reports (no ANSI is persisted).
// ─────────────────────────────────────────────────────────────────────────────

/** Semantic role of a report span; mapped to theme colours at render time. */
export type ReportRole =
  | "heading" | "label" | "note" | "text" | "strong" | "muted" | "dim"
  | "success" | "warning" | "error" | "provider" | "model" | "tree";

export type ReportSpan = [text: string, role?: ReportRole];

export type ReportBlock =
  | { kind: "line"; spans: ReportSpan[] }
  | { kind: "table"; indent: number; rows: ReportSpan[][][]; right: number[] };

export interface CostsReportDoc {
  version: 1;
  blocks: ReportBlock[];
}

/** The subset of Pi's Theme the report needs (keeps the pure code testable). */
export interface ReportTheme {
  fg(color: "accent" | "text" | "muted" | "dim" | "success" | "warning" | "error", text: string): string;
  bold(text: string): string;
}

function paintSpan([text, role]: ReportSpan, theme: ReportTheme | undefined): string {
  if (!theme || !role || text === "") return text;
  switch (role) {
    case "heading":
      return theme.bold(theme.fg("accent", text));
    case "label":
      return theme.fg("muted", text);
    case "note":
    case "tree":
      return theme.fg("dim", text);
    case "provider":
    case "strong":
      return theme.bold(theme.fg("text", text));
    case "model":
      return theme.fg("text", text);
    default:
      return theme.fg(role, text);
  }
}

function spansText(spans: ReportSpan[]): string {
  return spans.map(([t]) => t).join("");
}

/**
 * Render table rows with columns padded by visible width, so cells containing
 * ANSI styling stay aligned.
 */
function renderTable(block: Extract<ReportBlock, { kind: "table" }>, theme: ReportTheme | undefined): string[] {
  const right = new Set(block.right);
  const widths: number[] = [];
  for (const r of block.rows) {
    r.forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, visibleWidth(spansText(cell)))));
  }
  const pad = " ".repeat(block.indent);
  return block.rows.map((r) => {
    const cells = r.map((cell, i) => {
      const styled = cell.map((s) => paintSpan(s, theme)).join("");
      const fill = " ".repeat(Math.max(0, widths[i] - visibleWidth(spansText(cell))));
      return right.has(i) ? fill + styled : styled + fill;
    });
    return (pad + cells.join("  ")).trimEnd();
  });
}

/** Render a report document; plain text when no theme is given. */
export function renderCostsReport(doc: CostsReportDoc, theme?: ReportTheme): string {
  const out: string[] = [];
  for (const b of doc.blocks) {
    if (b.kind === "line") out.push(b.spans.map((s) => paintSpan(s, theme)).join(""));
    else out.push(...renderTable(b, theme));
  }
  return out.join("\n");
}

function levelRole(level: Level, calm: ReportRole): ReportRole {
  return level === "dim" ? calm : level;
}

/** Cache hit colour: green when healthy, never warning (too loud across tables). */
function cacheRole(rate: number | undefined, calm: ReportRole = "text"): ReportRole {
  if (rate === undefined) return "dim";
  return rate >= 0.8 ? "success" : rate >= 0.5 ? calm : "dim";
}

function statusSpan(level: Level): ReportSpan {
  return level === "dim" ? ["ok", "success"] : [level, level];
}

/** "accounts/fireworks/models/x" → "x". */
function shortModel(model: string): string {
  return model.slice(model.lastIndexOf("/") + 1);
}

function sortedByCost<T>(m: Map<string, T>, cost: (v: T) => number): [string, T][] {
  return [...m.entries()].sort((a, b) => cost(b[1]) - cost(a[1]) || a[0].localeCompare(b[0]));
}

function splitSpans(label: string, p: PeriodStats): ReportSpan[] {
  const total = p.metered.cost;
  const sub = p.meteredSubagent.cost;
  const spans: ReportSpan[] = [
    ["   "], [label, "label"],
    ["driver ", "muted"], [fmtCost(p.meteredDriver.cost), "text"],
    [" / subagents ", "muted"], [fmtCost(sub), "text"],
  ];
  if (total > 0) spans.push([` (${Math.round((sub / total) * 100)}% subagents)`, "note"]);
  return spans;
}

/** Build the structured `/costs` report document. */
export function buildCostsReportDoc(
  summary: SpendSummary,
  cfg: SpendConfig,
  live: Map<string, LiteLLMData> = new Map(),
): CostsReportDoc {
  const { today, month, prior30 } = summary;
  const blocks: ReportBlock[] = [];
  const line = (...spans: ReportSpan[]) => blocks.push({ kind: "line", spans });
  const mon = monthAbbrev(summary.monthKey);
  const [y, m, d] = summary.todayKey.split("-").map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();

  // ── 1. Pacing & runway ────────────────────────────────────────────────────
  const ratio = summary.avgDailyMetered > 0 ? today.metered.cost / summary.avgDailyMetered : undefined;
  const avgNote = summary.avgIsFallback
    ? "no prior active days; using today"
    : `30d active-day avg over ${summary.priorActiveDays} day${summary.priorActiveDays === 1 ? "" : "s"}`;
  const dollarLevel = dailyThresholdLevel(today.metered.cost, cfg);
  const pace = paceLevel(ratio);
  const projectedPace = (month.metered.cost / d) * daysInMonth;
  const projectedAvg = month.metered.cost + summary.avgDailyMetered * (daysInMonth - d);
  let capSum = 0;
  for (const pc of cfg.providers.values()) if (!pc.subscription && pc.monthlyCapUsd) capSum += pc.monthlyCapUsd;
  const projRole = (v: number): ReportRole => (capSum > 0 ? levelRole(capLevel(v / capSum), "text") : "text");

  line(["Spend report", "strong"], [` · ${summary.todayKey}`, "text"],
    ["  (local time; metered excludes subscription and zero-cost usage)", "note"]);
  line();
  line(["1. Daily pacing & monthly runway", "heading"]);
  line(
    ["   "], ["Today (metered)    ", "label"],
    [fmtCost(today.metered.cost), levelRole(dollarLevel, "success")],
    [" vs ", "muted"], [`${fmtCost(summary.avgDailyMetered)}/d`, "text"],
    ...(ratio === undefined ? [] : [[" · ", "muted"], [`${ratio.toFixed(1)}×`, levelRole(pace, "success")]] as ReportSpan[]),
    [`  (${avgNote})`, "note"],
  );
  line(
    ["   "], ["Daily thresholds   ", "label"],
    ["warn ", "muted"], [`>${fmtCost(cfg.dailyWarnUsd)}`, "text"],
    [" / red ", "muted"], [`>${fmtCost(cfg.dailyRedUsd)}`, "text"],
    [" · dollars ", "muted"], statusSpan(dollarLevel),
    [" · pace ", "muted"], statusSpan(pace),
    ["  (warn ≥1.25× / red ≥1.75×)", "note"],
  );
  line(["   "], ["Month to date      ", "label"], [fmtCost(month.metered.cost), "text"],
    [`  (${mon}, day ${d}/${daysInMonth})`, "note"]);
  line(
    ["   "], ["Projected finish   ", "label"],
    [fmtCost(projectedPace), projRole(projectedPace)], [" at month-to-date pace · ", "muted"],
    [fmtCost(projectedAvg), projRole(projectedAvg)], [" at 30d avg pace", "muted"],
    ...(capSum > 0 ? [[`  (caps total ${fmtGaugeCost(capSum)})`, "note"]] as ReportSpan[] : []),
  );
  line();

  // ── 2. Efficiency ─────────────────────────────────────────────────────────
  const todayPerTurn = costPerTurn(today.metered);
  const priorPerTurn = costPerTurn(prior30.metered);
  const perTurnRole: ReportRole =
    todayPerTurn === undefined || priorPerTurn === undefined || priorPerTurn === 0
      ? "text"
      : levelRole(paceLevel(todayPerTurn / priorPerTurn), "success");
  const todayCache = cacheHitRate(today.metered);
  const priorCache = cacheHitRate(prior30.metered);

  line(["2. Efficiency", "heading"], ["  (why today is high or low)", "note"]);
  line(
    ["   "], ["$/turn (metered)   ", "label"],
    ["today ", "muted"], [fmtPerTurn(todayPerTurn), perTurnRole], [` (${today.metered.turns} turns)`, "note"],
    [" · 30d ", "muted"], [fmtPerTurn(priorPerTurn), "text"], [` (${prior30.metered.turns} turns)`, "note"],
  );
  line(
    ["   "], ["Cache hit          ", "label"],
    ["today ", "muted"], [fmtPct(todayCache), cacheRole(todayCache)],
    [" · 30d ", "muted"], [fmtPct(priorCache), cacheRole(priorCache)],
    ["  (cacheRead ÷ (input + cacheRead), metered)", "note"],
  );
  line(...splitSpans("Today              ", today));
  line(...splitSpans("Month              ", month));
  line();

  // ── 3. Providers & models ─────────────────────────────────────────────────
  // Zero-cost providers (local models) are listed with subscriptions: tokens matter, dollars don't.
  const tokenOnly = (prov: string, st: ProviderStats) => isSubscription(cfg, prov) || st.total.cost === 0;
  const metered = sortedByCost(month.providers, (p) => p.total.cost).filter(([p, st]) => !tokenOnly(p, st));
  const subs = sortedByCost(month.providers, (p) => totalTokens(p.total)).filter(([p, st]) => tokenOnly(p, st));
  const header = (cols: string[]): ReportSpan[][] => cols.map((c) => [[c, "muted"]]);
  const modelCell = (model: string, last: boolean): ReportSpan[] => [[last ? "└─ " : "├─ ", "tree"], [shortModel(model), "model"]];

  line(["3. Providers & models", "heading"], [`  (${mon})`, "note"]);
  if (metered.length === 0) {
    line(["   "], ["No metered usage this month.", "muted"]);
  } else {
    const rows: ReportSpan[][][] = [header(["provider / model", "today", "month", "cap / %", "turns", "$/turn", "cache%"])];
    for (const [prov, stats] of metered) {
      const gauge = capGauge(prov, summary, cfg, live);
      const todayProv = today.providers.get(prov);
      const rate = cacheHitRate(stats.total);
      rows.push([
        [[prov, "provider"]],
        [[fmtCost(todayProv?.total.cost ?? 0), "strong"]],
        [[fmtCost(gauge && live.has(prov) ? gauge.spend : stats.total.cost), "strong"]],
        gauge
          ? [[`${fmtGaugeCost(gauge.cap)} / ${Math.round(gauge.pct * 100)}%`, levelRole(gauge.level, "muted")]]
          : [["—", "dim"]],
        [[`${stats.total.turns}`, "text"]],
        [[fmtPerTurn(costPerTurn(stats.total)), "text"]],
        [[fmtPct(rate), cacheRole(rate)]],
      ]);
      const models = sortedByCost(stats.models, (v) => v.cost);
      models.forEach(([model, t], i) => {
        const mRate = cacheHitRate(t);
        rows.push([
          modelCell(model, i === models.length - 1),
          [[fmtCost(todayProv?.models.get(model)?.cost ?? 0), "muted"]],
          [[fmtCost(t.cost), "muted"]],
          [],
          [[`${t.turns}`, "muted"]],
          [[fmtPerTurn(costPerTurn(t)), "muted"]],
          [[fmtPct(mRate), cacheRole(mRate, "muted")]],
        ]);
      });
    }
    blocks.push({ kind: "table", indent: 3, rows, right: [1, 2, 4, 5, 6] });
  }

  if (subs.length > 0) {
    line();
    line(["   "], ["Subscription / local", "strong"], ["  (not metered; ~eq = synthetic list-price value)", "note"]);
    const rows: ReportSpan[][][] = [header(["provider / model", "tok today", "tok month", "turns", "cache%", "~eq"])];
    for (const [prov, stats] of subs) {
      const todayProv = today.providers.get(prov);
      const rate = cacheHitRate(stats.total);
      rows.push([
        [[prov, "provider"]],
        [[fmtTokens(todayProv ? totalTokens(todayProv.total) : 0), "strong"]],
        [[fmtTokens(totalTokens(stats.total)), "strong"]],
        [[`${stats.total.turns}`, "text"]],
        [[fmtPct(rate), cacheRole(rate)]],
        [[`~${fmtCost(stats.total.cost)} eq`, "dim"]],
      ]);
      const models = sortedByCost(stats.models, (v) => totalTokens(v));
      models.forEach(([model, t], i) => {
        const tm = todayProv?.models.get(model);
        const mRate = cacheHitRate(t);
        rows.push([
          modelCell(model, i === models.length - 1),
          [[fmtTokens(tm ? totalTokens(tm) : 0), "muted"]],
          [[fmtTokens(totalTokens(t)), "muted"]],
          [[`${t.turns}`, "muted"]],
          [[fmtPct(mRate), cacheRole(mRate, "muted")]],
          [[`~${fmtCost(t.cost)} eq`, "dim"]],
        ]);
      });
    }
    blocks.push({ kind: "table", indent: 3, rows, right: [1, 2, 3, 4, 5] });
  }

  return { version: 1, blocks };
}

/** Build the `/costs` report; plain text without a theme, styled with one. */
export function buildCostsReport(
  summary: SpendSummary,
  cfg: SpendConfig,
  live: Map<string, LiteLLMData> = new Map(),
  theme?: ReportTheme,
): string {
  return renderCostsReport(buildCostsReportDoc(summary, cfg, live), theme);
}

// ─────────────────────────────────────────────────────────────────────────────
// LiteLLM polling  (GET {baseUrl}/key/info)
// ─────────────────────────────────────────────────────────────────────────────

async function pollLiteLLM(provider: string, cfg: LiteLLMConfig, onUpdate: () => void): Promise<void> {
  const apiKey = process.env[cfg.apiKeyEnv];
  if (!apiKey) return;

  const url = `${cfg.baseUrl.replace(/\/+$/, "")}/key/info`;
  let resp: Response;
  try {
    const ac = new AbortController();
    const tid = setTimeout(() => ac.abort(), 10_000);
    resp = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` }, signal: ac.signal });
    clearTimeout(tid);
  } catch {
    return;
  }
  if (!resp.ok) return;

  let body: Record<string, unknown>;
  try {
    body = (await resp.json()) as Record<string, unknown>;
  } catch {
    return;
  }
  const info = body.info as Record<string, unknown> | undefined;
  if (!info || typeof info.spend !== "number") return;

  litellmCache.set(provider, {
    spend: info.spend,
    maxBudget: typeof info.max_budget === "number" ? info.max_budget : 0,
    budgetResetAt: typeof info.budget_reset_at === "string" ? info.budget_reset_at : "",
    fetchedAt: Date.now(),
  });
  onUpdate();
}

// ─────────────────────────────────────────────────────────────────────────────
// Extension entry point
// ─────────────────────────────────────────────────────────────────────────────

const COSTS_ENTRY_TYPE = "costs-report";

interface CostsReportData {
  /** Plain-text rendering; fallback for entries without a document. */
  text: string;
  /** Structured report, styled with the active theme on every render. */
  doc?: CostsReportDoc;
}

function readSettings(pi: ExtensionAPI): { cfg: SpendConfig; sessionDir: string } {
  const settings = pi.getSettings() as Record<string, unknown>;
  const rawSessionDir = typeof settings.sessionDir === "string" ? settings.sessionDir : undefined;
  return {
    cfg: resolveSpendConfig(settings.spendFooter),
    sessionDir: rawSessionDir
      ? rawSessionDir.replace(/^~(?=\/|$)/, os.homedir())
      : path.join(os.homedir(), ".pi", "agent", "sessions"),
  };
}

export default function spendFooterExtension(pi: ExtensionAPI): void {
  // Subagent children have no interactive footer (PI_SUBAGENT_CHILD is set by pi-subagents).
  if (process.env.PI_SUBAGENT_CHILD === "1") return;

  const cleanupFns: (() => void)[] = [];
  function drainCleanup(): void {
    let fn: (() => void) | undefined;
    while ((fn = cleanupFns.pop())) {
      try { fn(); } catch { /* ignore */ }
    }
  }

  // Summary cache keyed by the rows array identity (rebuilt only when dirty).
  let summaryRows: UsageRow[] | undefined;
  let summaryCfg: SpendConfig | undefined;
  let summaryCache: SpendSummary | undefined;
  function currentSummary(cfg: SpendConfig): SpendSummary {
    const rows = getRows();
    if (rows !== summaryRows || cfg !== summaryCfg || summaryCache?.todayKey !== aggDayKey) {
      summaryCache = summarize(rows, cfg, aggDayKey);
      summaryRows = rows;
      summaryCfg = cfg;
    }
    return summaryCache;
  }

  // ── /costs: durable, visible, excluded from model context ─────────────────
  // appendEntry + an entry renderer shows the report in the transcript without
  // sending it to the model (pi.sendMessage would add it to LLM context).

  pi.registerEntryRenderer<CostsReportData>(COSTS_ENTRY_TYPE, (entry, _opts, theme) => {
    const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
    box.addChild(new Text(theme.fg("accent", "⚙ costs"), 0, 0));
    const doc = entry.data?.doc;
    box.addChild(new Text(doc?.version === 1 ? renderCostsReport(doc, theme) : entry.data?.text ?? "", 0, 0));
    return box;
  });

  pi.registerCommand("costs", {
    description: "Show detailed spend, pacing, efficiency (Wh/mi), and provider/model breakdown",
    handler: async (_args, ctx) => {
      const { cfg, sessionDir } = readSettings(pi);
      try {
        runScan(sessionDir);
      } catch (err) {
        ctx.ui.notify(`costs: scan failed: ${err instanceof Error ? err.message : String(err)}`, "warning");
        return;
      }
      const doc = buildCostsReportDoc(currentSummary(cfg), cfg, litellmCache);
      pi.appendEntry<CostsReportData>(COSTS_ENTRY_TYPE, { text: renderCostsReport(doc), doc });
    },
  });

  pi.on("session_start", async (_event: SessionStartEvent, ctx: ExtensionContext) => {
    drainCleanup();
    if (ctx.mode !== "tui") return;

    const { cfg, sessionDir } = readSettings(pi);
    let tui: { requestRender(): void } | null = null;

    ctx.ui.setFooter((tuiRef, theme, footerData) => {
      tui = tuiRef;
      const unsubBranch = footerData.onBranchChange(() => tuiRef.requestRender());
      const paint = (s: Segment) => theme.fg(s.level, s.text);
      const sep = theme.fg("dim", " │ ");

      return {
        dispose(): void {
          unsubBranch();
          tui = null;
        },
        invalidate(): void {},
        render(width: number): string[] {
          // ── Line 1: cwd (branch) • session ────────────────────────────
          let pwd = fmtCwd(ctx.sessionManager.getCwd());
          const branch = footerData.getGitBranch();
          if (branch) pwd = `${pwd} (${branch})`;
          const sname = ctx.sessionManager.getSessionName();
          if (sname) pwd = `${pwd} • ${sname}`;
          const pwdLine = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));

          // ── Line 2 left: context% │ today tokens · cost (pace) ─────────
          const cu = ctx.getContextUsage();
          const pct = cu?.percent ?? null;
          const win = cu?.contextWindow ?? ctx.model?.contextWindow ?? 0;
          const ctxDisplay = `${pct !== null ? `${pct.toFixed(1)}%` : "?"}/${win > 0 ? fmtTokens(win) : "?"}`;
          const ctxLevel: Level = pct !== null && pct > 90 ? "error" : pct !== null && pct > 70 ? "warning" : "dim";

          const activeProvider = ctx.model?.provider;
          let segs: SpendSegments | undefined;
          let left = theme.fg(ctxLevel, ctxDisplay) + sep;
          if (!scanDone) {
            left += theme.fg("dim", "spend …");
          } else {
            segs = computeSpendSegments(currentSummary(cfg), cfg, activeProvider, litellmCache);
            left += theme.fg("dim", `${segs.todayTokens} · `) + paint(segs.todayCost);
            if (segs.todayPace) left += ` ${paint(segs.todayPace)}`;
          }

          // ── Line 2 right: [badges · ](provider …) model • thinking ─────
          const modelId = ctx.model?.id ?? "no-model";
          const thinking = ctx.thinkingLevel;
          const modelStr =
            ctx.model?.reasoning && thinking
              ? thinking === "off" ? `${modelId} • thinking off` : `${modelId} • ${thinking}`
              : modelId;
          const tag = segs?.providerTag ?? (activeProvider ? { text: `(${activeProvider})`, level: "dim" as Level } : undefined);
          const core = (tag ? `${paint(tag)} ` : "") + theme.fg("dim", modelStr);
          const badges = (segs?.backgroundBadges ?? []).map((b) => paint(b) + theme.fg("dim", " · ")).join("");

          const leftW = visibleWidth(left);
          let right = badges + core;
          if (leftW + 2 + visibleWidth(right) > width) right = core; // drop badges first

          let statsLine: string;
          const rightW = visibleWidth(right);
          if (leftW + 2 + rightW <= width) {
            statsLine = left + " ".repeat(width - leftW - rightW) + right;
          } else if (width - leftW - 2 >= 12) {
            const tr = truncateToWidth(right, width - leftW - 2, "");
            statsLine = left + " ".repeat(Math.max(0, width - leftW - visibleWidth(tr))) + tr;
          } else if (leftW <= width) {
            statsLine = left; // too narrow for a useful model fragment
          } else {
            statsLine = truncateToWidth(left, width, theme.fg("dim", "..."));
          }

          // ── Line 3: extension statuses ─────────────────────────────────
          const lines = [pwdLine, statsLine];
          const statuses = footerData.getExtensionStatuses();
          if (statuses.size > 0) {
            const statusText = Array.from(statuses.entries())
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([, v]) => v.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim())
              .join(" ");
            lines.push(truncateToWidth(statusText, width, theme.fg("dim", "...")));
          }
          return lines;
        },
      };
    });

    const rescan = () => {
      try {
        runScan(sessionDir);
      } catch { /* scan errors must never surface in the footer */ }
      tui?.requestRender();
    };

    setImmediate(rescan);
    const refreshTimer = setInterval(rescan, 60_000);
    cleanupFns.push(() => clearInterval(refreshTimer));
    cleanupFns.push(pi.on("turn_end", async () => rescan()));

    // ── LiteLLM polling: 5-minute interval ─────────────────────────────────
    for (const [prov, pc] of cfg.providers) {
      if (!pc.litellm) continue;
      const litellmCfg = pc.litellm;
      const refresh = () => tui?.requestRender();
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

  pi.on("session_shutdown", () => {
    drainCleanup();
  });
}

/** Test hook: scan a sessions directory into module state and return its rows. */
export function scanSessionsForTest(sessionDir: string): UsageRow[] {
  fileStates.clear();
  dedupSeen.clear();
  prunedThroughKey = "";
  totalsDirty = true;
  runScan(sessionDir);
  return getRows();
}
