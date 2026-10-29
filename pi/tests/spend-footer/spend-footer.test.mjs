/**
 * spend-footer (pi/extensions/spend-footer.ts): scanner retention/attribution,
 * footer segment severity, provider tags, the /costs report, and real-loader
 * registration of the /costs command and its transcript renderer.
 *
 * The extension source is copied into an owned temp dir with a node_modules
 * link to the installed pi-tui so Node's type stripping can import its pure
 * exports. Session data is synthetic and lives in that temp dir.
 *
 * Run: node --test pi/tests/spend-footer/spend-footer.test.mjs  (repo root)
 * PI_SDK_ROOT overrides the installed SDK root.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const installRoot = join(homedir(), ".pi/agent/install/releases",
	readFileSync(join(homedir(), ".pi/agent/install/current-version"), "utf8").trim(), "node_modules");
const sdkRoot = process.env.PI_SDK_ROOT ?? join(installRoot, "@earendil-works/pi-coding-agent");
const tuiRoot = join(dirname(sdkRoot), "pi-tui");

const dir = await mkdtemp(join(tmpdir(), "spend-footer-test-"));
await copyFile(new URL("../../extensions/spend-footer.ts", import.meta.url), join(dir, "spend-footer.ts"));
await mkdir(join(dir, "node_modules/@earendil-works"), { recursive: true });
await symlink(tuiRoot, join(dir, "node_modules/@earendil-works/pi-tui"));
const sf = await import(pathToFileURL(join(dir, "spend-footer.ts")).href);

test.after(async () => { await rm(dir, { recursive: true, force: true }); });

// ── helpers ────────────────────────────────────────────────────────────────

const p2 = (n) => String(n).padStart(2, "0");
const dayKey = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const daysAgo = (n, hour = 12) => { const d = new Date(); d.setDate(d.getDate() - n); d.setHours(hour, 0, 0, 0); return d; };
const today = dayKey(new Date());

function assistant({ when, provider, model, cost, input = 100, output = 50, cacheRead = 0, cacheWrite = 0, responseId, id }) {
	return JSON.stringify({
		type: "message", id: id ?? responseId ?? `e${Math.random()}`, timestamp: when.toISOString(),
		message: { role: "assistant", provider, model, responseId, timestamp: when.getTime(),
			usage: { input, output, cacheRead, cacheWrite, cost: { total: cost } } },
	});
}

const totals = (o) => ({ cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 1, ...o });
const row = (day, provider, cost, extra = {}) => ({ day, provider, model: extra.model ?? `${provider}-m`, isSubagent: extra.isSubagent ?? false, totals: totals({ cost, ...extra.totals }) });

const cfg = sf.resolveSpendConfig({
	providers: { google: { monthlyCapUsd: 200 }, anthropic: { monthlyCapUsd: 200 }, openai: { subscription: true } },
});

// ── config ────────────────────────────────────────────────────────────────

test("config: defaults are warn $20 / red $30 and openai defaults to subscription", () => {
	const c = sf.resolveSpendConfig(undefined);
	assert.equal(c.dailyWarnUsd, 20);
	assert.equal(c.dailyRedUsd, 30);
	assert.equal(c.providers.get("openai").subscription, true);
	assert.equal(c.providers.get("openai-codex").subscription, true);
});

test("config: legacy budgets still give caps; a cap on openai makes it metered", () => {
	const c = sf.resolveSpendConfig({
		budgets: { jetstream: { monthlyUsd: 500, litellm: { baseUrl: "https://x", apiKeyEnv: "K" } } },
		providers: { openai: { monthlyCapUsd: 50 } },
	});
	assert.deepEqual(c.providers.get("jetstream"), { subscription: false, monthlyCapUsd: 500, litellm: { baseUrl: "https://x", apiKeyEnv: "K" } });
	assert.equal(c.providers.get("openai").subscription, false);
	assert.equal(c.providers.get("openai").monthlyCapUsd, 50);
});

// ── scanner ───────────────────────────────────────────────────────────────

test("scanner keeps a rolling 35-day window, attributes subagents/compaction, counts zero-cost turns and dedups", async () => {
	const sessions = join(dir, "sessions");
	const sess = join(sessions, "--proj--");
	const child = join(sess, "S1", "run-abc", "run-0");
	const artifacts = join(sess, "S1", "subagent-artifacts");
	await mkdir(child, { recursive: true });
	await mkdir(artifacts, { recursive: true });

	const now = daysAgo(0, new Date().getHours());
	const parent = [
		assistant({ when: now, provider: "google", model: "gemini", cost: 2, input: 1000, cacheRead: 3000, responseId: "g1" }),
		JSON.stringify({ type: "compaction", id: "c1", timestamp: now.toISOString(), usage: { input: 500, output: 10, cacheRead: 0, cacheWrite: 0, cost: { total: 0.5 } } }),
		assistant({ when: now, provider: "openai", model: "gpt", cost: 4, responseId: "o1" }),
		assistant({ when: now, provider: "umbra", model: "local", cost: 0, input: 700, output: 30, responseId: "u1" }),
		assistant({ when: daysAgo(10), provider: "google", model: "gemini", cost: 3, responseId: "g10" }),
		assistant({ when: daysAgo(20), provider: "anthropic", model: "opus", cost: 5, responseId: "a20" }),
		assistant({ when: daysAgo(33), provider: "google", model: "gemini", cost: 7, responseId: "g33" }),
		assistant({ when: daysAgo(40), provider: "google", model: "gemini", cost: 100, responseId: "g40" }),
	];
	await writeFile(join(sess, "S1.jsonl"), parent.join("\n") + "\n");
	const childLine = assistant({ when: now, provider: "anthropic", model: "opus", cost: 1.5, responseId: "a1" });
	await writeFile(join(child, "session.jsonl"), childLine + "\n");
	await writeFile(join(sess, "S2.jsonl"), assistant({ when: now, provider: "google", model: "gemini", cost: 2, responseId: "g1" }) + "\n");
	await writeFile(join(artifacts, "copy.jsonl"), childLine + "\n");

	const rows = sf.scanSessionsForTest(sessions);
	const s = sf.summarize(rows, cfg, today);

	assert.equal(rows.some((r) => r.totals.cost === 100), false, "40-day-old entry is outside retention");
	assert.equal(rows.some((r) => r.totals.cost === 7), true, "33-day-old entry is retained across month rollover");

	// today: google 2 + compaction 0.5 (attributed to google) + anthropic subagent 1.5; openai is subscription
	assert.equal(s.today.metered.cost, 4);
	assert.equal(s.today.unmetered.cost, 4);
	assert.equal(s.today.meteredSubagent.cost, 1.5);
	assert.equal(s.today.meteredDriver.cost, 2.5);
	assert.equal(s.today.providers.get("google").models.get("compaction").cost, 0.5);
	assert.equal(s.today.providers.get("google").total.turns, 1, "compaction adds no turn; duplicate g1 deduped");
	assert.equal(s.today.providers.get("umbra").total.turns, 1, "zero-cost local turn is counted");
	assert.equal(s.today.providers.get("anthropic").total.turns, 1, "artifact copy is not double-counted");

	// prior 30 days (excluding today): $3 and $5 on two active days; the 33-day entry is outside
	assert.equal(s.priorActiveDays, 2);
	assert.equal(s.avgDailyMetered, 4);
	assert.equal(s.avgIsFallback, false);
});

// ── footer segments ───────────────────────────────────────────────────────

const prior = (cost) => row(dayKey(daysAgo(5)), "google", cost);

const segsFor = (todayCost, avg) =>
	sf.computeSpendSegments(sf.summarize([prior(avg), row(today, "google", todayCost)], cfg, today), cfg, "google");

test("footer pace: the (N× avg) part is coloured only by the ratio to the 30d average", () => {
	const s = segsFor(4.8, 4);
	assert.deepEqual(s.todayCost, { text: "$4.80", level: "dim" });
	assert.deepEqual(s.todayPace, { text: "(1.2× avg)", level: "dim" });
	assert.equal(segsFor(5, 4).todayPace.level, "warning"); // 1.25×
	assert.equal(segsFor(7, 4).todayPace.level, "error");   // 1.75×
	assert.equal(segsFor(7, 4).todayCost.level, "dim", "cheap day stays dim in dollars even at a hot pace");
});

test("footer cost: the dollar part is coloured only by hard thresholds (strictly above $20 / $30)", () => {
	const level = (c) => segsFor(c, c).todayCost.level;
	assert.equal(level(20), "dim");
	assert.equal(level(20.01), "warning");
	assert.equal(level(30), "warning");
	assert.equal(level(30.01), "error");
	assert.equal(segsFor(31, 31).todayPace.level, "dim", "pace stays calm when today matches the average");
});

test("footer cost: subscription dollars never count toward metered spend", () => {
	const s = sf.summarize([row(today, "openai", 80), row(today, "google", 1, { totals: { input: 1_200_000 } })], cfg, today);
	const segs = sf.computeSpendSegments(s, cfg, "openai");
	assert.equal(segs.todayCost.text, "$1.00");
	assert.equal(segs.todayPace.text, "(1.0× avg)");
	assert.equal(segs.todayCost.level, "dim");
	assert.equal(segs.todayTokens, "today 1.2M tok");
	assert.deepEqual(segs.providerTag, { text: "(openai)", level: "dim" });
});

test("footer provider tag: capped, uncapped and background badges", () => {
	const s = sf.summarize([row(today, "google", 18), row(today, "anthropic", 160), row(today, "fireworks", 4.2)], cfg, today);
	const g = sf.computeSpendSegments(s, cfg, "google");
	assert.deepEqual(g.providerTag, { text: "(google $18/$200)", level: "dim" });
	assert.deepEqual(g.backgroundBadges, [{ text: "anthropic $160/$200", level: "warning" }]);
	assert.deepEqual(sf.computeSpendSegments(s, cfg, "anthropic").providerTag, { text: "(anthropic $160/$200)", level: "warning" });
	assert.deepEqual(sf.computeSpendSegments(s, cfg, "fireworks").providerTag, { text: "(fireworks $4.20)", level: "dim" });
	assert.deepEqual(sf.computeSpendSegments(s, cfg, "deepinfra").providerTag, { text: "(deepinfra)", level: "dim" });
	const hot = sf.summarize([row(today, "google", 185)], cfg, today);
	assert.equal(sf.computeSpendSegments(hot, cfg, "google").providerTag.level, "error");
});

// ── /costs report ────────────────────────────────────────────────────────

test("/costs report covers pacing, efficiency, driver/subagent split and both provider tables", () => {
	const rows = [
		row(dayKey(daysAgo(5)), "google", 4, { totals: { turns: 40 } }),
		row(today, "google", 6, { totals: { turns: 25, input: 1000, cacheRead: 9000 } }),
		row(today, "anthropic", 2, { isSubagent: true, totals: { turns: 5 } }),
		row(today, "openai", 12, { totals: { input: 50_000, turns: 9 } }),
		row(today, "umbra", 0, { model: "accounts/x/models/glm-local", totals: { input: 7000, turns: 3 } }),
	];
	const report = sf.buildCostsReport(sf.summarize(rows, cfg, today), cfg);
	assert.match(report, /Today \(metered\)\s+\$8\.00 vs \$4\.00\/d · 2\.0×/);
	assert.match(report, /warn >\$20\.00 \/ red >\$30\.00 · dollars ok · pace error/);
	assert.match(report, /\$\/turn \(metered\)\s+today \$0\.27 \(30 turns\) · 30d \$0\.10 \(40 turns\)/);
	assert.match(report, /Cache hit\s+today 90%/);
	assert.match(report, /driver \$6\.00 \/ subagents \$2\.00 \(25% subagents\)/);
	assert.match(report, /google\s+\$6\.00\s+\$\d+\.\d\d\s+\$200 \/ \d+%/);
	assert.match(report, /openai\s+50k\s+50k\s+9\s+0%\s+~\$12\.00 eq/);
	const [meteredPart, tokenPart] = report.split("Subscription");
	assert.doesNotMatch(meteredPart, /openai|umbra/, "subscription and zero-cost providers stay out of the metered table");
	assert.match(tokenPart, /umbra\s+7\.0k\s+7\.0k\s+3/);
	assert.match(tokenPart, /\n\s+└─ glm-local\s/, "model paths are shortened and drawn as tree rows");
});

// ── styled /costs report ─────────────────────────────────────────────────

/** Theme stub emitting real SGR codes per token, so visibleWidth must ignore them. */
const SGR = { accent: 36, text: 37, muted: 90, dim: 2, success: 32, warning: 33, error: 31 };
const ansiTheme = {
	fg: (c, t) => `\x1b[${SGR[c]}m${t}\x1b[39m`,
	bold: (t) => `\x1b[1m${t}\x1b[22m`,
};
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const color = (token, text) => ansiTheme.fg(token, text);

const styledRows = () => [
	row(dayKey(daysAgo(5)), "google", 4, { totals: { turns: 40, input: 100, cacheRead: 900 } }),
	row(today, "google", 6, { model: "gemini", totals: { turns: 25, input: 1000, cacheRead: 9000 } }),
	row(today, "google", 1, { model: "accounts/x/models/flash", totals: { turns: 5, input: 480, cacheRead: 520 } }),
	row(today, "anthropic", 160, { isSubagent: true, totals: { turns: 5, input: 900, cacheRead: 100 } }),
	row(today, "openai", 12, { totals: { input: 50_000, turns: 9 } }),
];

test("styled /costs: same text as the plain report once ANSI is stripped", async () => {
	const s = sf.summarize(styledRows(), cfg, today);
	const styled = sf.buildCostsReport(s, cfg, new Map(), ansiTheme);
	assert.match(styled, /\x1b\[/, "styled output carries ANSI codes");
	assert.equal(stripAnsi(styled), sf.buildCostsReport(s, cfg));
	assert.doesNotMatch(sf.buildCostsReport(s, cfg), /\x1b/, "plain output has no ANSI");
});

test("styled /costs: table columns align by visible width despite ANSI codes", async () => {
	const { visibleWidth } = await import(pathToFileURL(join(dir, "node_modules/@earendil-works/pi-tui/dist/index.js")).href);
	const styled = sf.buildCostsReport(sf.summarize(styledRows(), cfg, today), cfg, new Map(), ansiTheme).split("\n");
	const start = styled.findIndex((l) => stripAnsi(l).includes("provider / model"));
	const tableLines = styled.slice(start, styled.findIndex((l, i) => i > start && stripAnsi(l).trim() === ""));
	assert.ok(tableLines.length >= 5, "header + 2 providers + models");
	const widths = new Set(tableLines.map((l) => visibleWidth(l)));
	assert.equal(widths.size, 1, `every metered row ends at the cache% column: ${[...widths]}`);
	// The right-aligned "month" column ends at the same visible offset on every row.
	const header = stripAnsi(tableLines[0]);
	const monthCol = header.indexOf("month") + "month".length;
	for (const l of tableLines.slice(1)) {
		const plain = stripAnsi(l);
		assert.notEqual(plain[monthCol - 1], " ", `month column right edge holds a value: ${plain}`);
		assert.equal(plain[monthCol], " ");
	}
});

test("styled /costs: semantic colours mark thresholds, pace, caps, cache and tree rows", () => {
	const styled = sf.buildCostsReport(sf.summarize(styledRows(), cfg, today), cfg, new Map(), ansiTheme);
	assert.ok(styled.includes(ansiTheme.bold(color("accent", "1. Daily pacing & monthly runway"))), "section heading accent+bold");
	assert.ok(styled.includes(color("muted", "Today (metered)    ")), "row label muted");
	assert.ok(styled.includes(color("error", "$167.00")), "today dollars above red threshold");
	assert.ok(styled.includes(color("error", "41.8×")), "pace ≥1.75× is error");
	assert.ok(styled.includes(color("muted", " · dollars ") + color("error", "error")), "dollar status badge is error");
	assert.ok(styled.includes(ansiTheme.bold(color("text", "anthropic"))), "provider name bold text, not accent");
	const accents = [...styled.matchAll(/\x1b\[36m([^\x1b]*)/g)].map((m) => m[1]);
	assert.deepEqual(accents, ["1. Daily pacing & monthly runway", "2. Efficiency", "3. Providers & models"],
		"accent is reserved for the numbered section headers");
	assert.ok(styled.includes(ansiTheme.bold(color("text", "Spend report"))), "title is bold text");
	assert.ok(styled.includes(ansiTheme.bold(color("text", "Subscription / local"))), "sub-table header is bold text");
	assert.ok(styled.includes(color("warning", "$200 / 80%")), "cap ≥75% is warning");
	assert.match(styled, /\x1b\[90m\$200 \/ [1-9]%\x1b\[39m/, "calm google cap is muted");
	assert.ok(styled.includes(color("success", "90%")), "cache ≥80% success");
	assert.ok(styled.includes(color("muted", "52%")), "mid-range cache on a model row is muted");
	assert.doesNotMatch(styled, /\x1b\[33m\d+%/, "cache% never uses warning");
	assert.ok(styled.includes(color("dim", "10%")), "cache <50% dim");
	assert.ok(styled.includes(color("dim", "├─ ")) && styled.includes(color("dim", "└─ ")), "tree connectors dim");
	assert.ok(styled.includes(color("dim", "~$12.00 eq")), "synthetic eq dim");
});

test("styled /costs: calm day renders dollars, pace and status in success", () => {
	const rows = [row(dayKey(daysAgo(3)), "google", 5, { totals: { turns: 10 } }), row(today, "google", 5, { totals: { turns: 10 } })];
	const styled = sf.buildCostsReport(sf.summarize(rows, cfg, today), cfg, new Map(), ansiTheme);
	assert.ok(styled.includes(color("success", "$5.00")));
	assert.ok(styled.includes(color("success", "1.0×")));
	assert.ok(styled.includes(color("success", "ok")));
	assert.ok(styled.includes(color("success", "$0.50")), "$/turn at the 30d average is success");
});

// ── real loader ──────────────────────────────────────────────────────────

test("real loader registers /costs and its transcript entry renderer", async () => {
	const { loadExtensions } = await import(pathToFileURL(join(sdkRoot, "dist/core/extensions/loader.js")).href);
	delete process.env.PI_SUBAGENT_CHILD;
	const loaded = await loadExtensions([join(dir, "spend-footer.ts")], dir);
	assert.deepEqual(loaded.errors, []);
	const ext = loaded.extensions[0];
	assert.ok(ext.commands.get("costs"), "costs command registered");
	assert.match(ext.commands.get("costs").description, /pacing/);
	assert.ok(ext.entryRenderers?.get("costs-report"), "costs-report entry renderer registered");
});
