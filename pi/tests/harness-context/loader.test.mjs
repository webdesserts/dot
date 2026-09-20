/**
 * Real-loader test for the harness-context extension
 * (pi/extensions/harness-context.ts) — autonomy/t:163's prime
 * working-memory injection.
 *
 * Contract: the prime seat (NO AUTONOMY_AGENT_ID) with
 * AUTONOMY_PRIME_MEMORY_PATH configured gets the note's content in
 * context at EVERY before_agent_start (founding, post-compaction,
 * post-restart — the hook fires per run). A guest seat (agent id set) or
 * an unconfigured prime gains NOTHING — no other seat's turn-start
 * context changes. A misconfigured path refuses honestly, in-context.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const sdkRoot = process.env.PI_SDK_ROOT ?? join(
	execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(),
	"@earendil-works/pi-coding-agent",
);
const { loadExtensions } = await import(pathToFileURL(join(sdkRoot, "dist/core/extensions/loader.js")).href);

async function isolatedExtension(t) {
	const dir = await mkdtemp(join(tmpdir(), "harness-context-loader-"));
	t.after(async () => {
		await rm(dir, { recursive: true, force: true });
	});
	await copyFile(new URL("../../extensions/harness-context.ts", import.meta.url), join(dir, "harness-context.ts"));
	const loaded = await loadExtensions([join(dir, "harness-context.ts")], dir);
	assert.deepEqual(loaded.errors, []);
	assert.equal(loaded.extensions.length, 1);
	const extension = loaded.extensions[0];
	assert.ok(extension.handlers.has("before_agent_start"), "before_agent_start handler registered");
	return extension;
}

async function runTurn(extension) {
	const event = { systemPrompt: "BASE" };
	const handler = extension.handlers.get("before_agent_start")[0];
	const out = await handler(event);
	return out?.systemPrompt ?? "BASE";
}

test("prime seat: the configured working-memory note auto-loads into context", async (t) => {
	const note = await mkdtemp(join(tmpdir(), "prime-memory-"));
	t.after(() => rm(note, { recursive: true, force: true }));
	const notePath = join(note, "Umbra Working Memory.md");
	await writeFile(notePath, "LIVE STATE MARKER t163", "utf8");

	process.env.AUTONOMY_PRIME_MEMORY_PATH = notePath;
	process.env.AUTONOMY_AGENT_ID = "";
	process.env.PI_SUBAGENT_CHILD = "";
	const extension = await isolatedExtension(t);
	try {
		const prompt = await runTurn(extension);
		assert.ok(prompt.includes("LIVE STATE MARKER t163"), "the note's content is in context");
		assert.ok(prompt.includes("Working Memory (prime"), "labeled as the prime's memory");
		assert.ok(prompt.startsWith("BASE"), "the base system prompt is preserved");
	} finally {
		for (const k of ["AUTONOMY_PRIME_MEMORY_PATH", "AUTONOMY_AGENT_ID", "PI_SUBAGENT_CHILD"]) delete process.env[k];
	}
});

test("guest seat: an agent id means NO prime injection (prime-seat-only)", async (t) => {
	const note = await mkdtemp(join(tmpdir(), "prime-memory-"));
	t.after(() => rm(note, { recursive: true, force: true }));
	const notePath = join(note, "Umbra Working Memory.md");
	await writeFile(notePath, "LIVE STATE MARKER t163", "utf8");

	process.env.AUTONOMY_PRIME_MEMORY_PATH = notePath;
	process.env.AUTONOMY_AGENT_ID = "iris";
	const extension = await isolatedExtension(t);
	try {
		const prompt = await runTurn(extension);
		assert.ok(!prompt.includes("LIVE STATE MARKER t163"), "guest context never carries the prime note");
	} finally {
		for (const k of ["AUTONOMY_PRIME_MEMORY_PATH", "AUTONOMY_AGENT_ID"]) delete process.env[k];
	}
});

test("unconfigured prime: no injection, no error", async (t) => {
	delete process.env.AUTONOMY_PRIME_MEMORY_PATH;
	process.env.AUTONOMY_AGENT_ID = "";
	const extension = await isolatedExtension(t);
	try {
		const prompt = await runTurn(extension);
		assert.ok(!prompt.includes("Working Memory (prime"), "unconfigured prime gains nothing");
	} finally {
		delete process.env.AUTONOMY_AGENT_ID;
	}
});

test("misconfigured prime path: an honest in-context refusal", async (t) => {
	process.env.AUTONOMY_PRIME_MEMORY_PATH = "/nonexistent/t163/Working Memory.md";
	process.env.AUTONOMY_AGENT_ID = "";
	const extension = await isolatedExtension(t);
	try {
		const prompt = await runTurn(extension);
		assert.match(prompt, /Working Memory \(prime\) unavailable/);
	} finally {
		for (const k of ["AUTONOMY_PRIME_MEMORY_PATH", "AUTONOMY_AGENT_ID"]) delete process.env[k];
	}
});
