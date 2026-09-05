/**
 * Real-SDK lifecycle test for the context-controls extension
 * (pi/extensions/context-controls.ts) — HERMETIC.
 *
 * Drives a REAL AgentSession from the installed SDK with the deterministic
 * faux provider (no network, no model keys) and the extension loaded through
 * the real resource loader. Hermeticity:
 * - fresh owned agentDir AND cwd (temp dirs) are passed consistently to
 *   DefaultResourceLoader, ModelRuntime and createAgentSession — nothing
 *   reads the real ~/.pi/agent directory or credentials;
 * - one in-memory SettingsManager instance is shared by loader and session;
 * - explicit resource exclusions (noSkills/noPromptTemplates/noThemes/
 *   noContextFiles) and an assertion that exactly the owned extensions loaded;
 * - PI_SUBAGENT_CHILD is restored in cleanup;
 * - session.bindExtensions() runs real startup (session_start handlers);
 * - cleanup disposes the session and kills any surviving notification worker
 *   spawned under the owned temp dirs.
 *
 * Proven here against the real session: a SOLE compact() tool call carries
 * terminate:true, ends the run after the batch, compaction is dispatched at
 * agent_settled and CONFIRMED via a deterministic session_before_compact
 * handler (no LLM summarization call — exact faux call count asserted);
 * a compact() call batched with a sibling tool call is rejected mid-run while
 * the sibling still executes.
 *
 * Run: node --test pi/tests/context-controls/lifecycle.test.mjs  (repo root)
 */

import { execFileSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as hermetic from "./hermetic.mjs";

const sdkRoot = process.env.PI_SDK_ROOT ?? join(
	execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(),
	"@earendil-works/pi-coding-agent",
);
const { fauxProvider, fauxAssistantMessage, fauxToolCall, fauxText } = await import(
	pathToFileURL(join(sdkRoot, "node_modules/@earendil-works/pi-ai/dist/providers/faux.js")).href
);
const { createAgentSession, SessionManager, SettingsManager, DefaultResourceLoader, getAgentDir, ModelRuntime } =
	await import(pathToFileURL(join(sdkRoot, "dist/index.js")).href);

// Kill any notification worker spawned under `dir` (the real worker is a
// child process; tests must not leave survivors behind).
const killStrayWorkers = hermetic.killStrayWorkers;

// Capture ORIGINAL env before any test mutates it, so teardown restores the
// true originals rather than a previous test's fake values.
const ORIGINAL_ENV = {
	base: process.env.AUTONOMY_BASE,
	poll: process.env.AUTONOMY_POLL_INTERVAL_MS,
	timeout: process.env.AUTONOMY_FETCH_TIMEOUT_MS,
	hb: process.env.AUTONOMY_HEARTBEAT_MS,
	backoff: process.env.AUTONOMY_ERROR_BACKOFF_MS,
	child: process.env.PI_SUBAGENT_CHILD,
};
const setFakeAutonomyEnv = (base) => {
	process.env.AUTONOMY_BASE = base;
	process.env.AUTONOMY_POLL_INTERVAL_MS = "50";
	process.env.AUTONOMY_FETCH_TIMEOUT_MS = "2000";
	process.env.AUTONOMY_HEARTBEAT_MS = "0";
	process.env.AUTONOMY_ERROR_BACKOFF_MS = "200";
};
const restoreEnv = () => {
	for (const [k, v] of Object.entries({ AUTONOMY_BASE: ORIGINAL_ENV.base, AUTONOMY_POLL_INTERVAL_MS: ORIGINAL_ENV.poll, AUTONOMY_FETCH_TIMEOUT_MS: ORIGINAL_ENV.timeout, AUTONOMY_HEARTBEAT_MS: ORIGINAL_ENV.hb, AUTONOMY_ERROR_BACKOFF_MS: ORIGINAL_ENV.backoff })) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	if (ORIGINAL_ENV.child === undefined) delete process.env.PI_SUBAGENT_CHILD;
	else process.env.PI_SUBAGENT_CHILD = ORIGINAL_ENV.child;
};

// Wait until no notification worker spawned under `dir` remains (owned
// teardown: shutdown extensions while live, then await their exit).
async function awaitWorkerExit(dir, ms = 5000) {
	const start = Date.now();
	for (;;) {
		let alive = 0;
		try {
			const out = execFileSync("ps", ["-eo", "pid,command"], { encoding: "utf8" });
			alive = out.split("\n").filter((l) => l.includes("notifications.worker.mjs") && l.includes(dir)).length;
		} catch { return true; }
		if (alive === 0) return true;
		if (Date.now() - start > ms) return false;
		await new Promise((r) => setTimeout(r, 100));
	}
}

async function makeHermeticSession(t, { faux, extensionPaths, extensionFactories }) {
	const ownedAgentDir = await mkdtemp(join(tmpdir(), "cc-agentdir-"));
	const ownedCwd = await mkdtemp(join(tmpdir(), "cc-cwd-"));
	const savedChildEnv = process.env.PI_SUBAGENT_CHILD;
	delete process.env.PI_SUBAGENT_CHILD;
	t.after(async () => {
		if (savedChildEnv === undefined) delete process.env.PI_SUBAGENT_CHILD;
		else process.env.PI_SUBAGENT_CHILD = savedChildEnv;
		killStrayWorkers(ownedAgentDir);
		killStrayWorkers(ownedCwd);
		await rm(ownedAgentDir, { recursive: true, force: true });
		await rm(ownedCwd, { recursive: true, force: true });
	});
	for (const file of extensionPaths.files) {
		await copyFile(new URL(`../../extensions/${file}`, import.meta.url), join(ownedAgentDir, file));
	}

	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
	});
	const resourceLoader = new DefaultResourceLoader({
		cwd: ownedCwd,
		agentDir: ownedAgentDir,
		settingsManager,
		additionalExtensionPaths: extensionPaths.paths.map((p) => join(ownedAgentDir, p)),
		extensionFactories,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await resourceLoader.reload();
	// Resource exclusions/allowlist: exactly the owned extensions loaded —
	// every loaded extension is either one of the owned file copies or an
	// inline test factory; nothing discovered from global/package scope.
	const loaded = resourceLoader.getExtensions();
	const loadedPaths = loaded.extensions.map((e) => e.path).sort();
	const fileBacked = loadedPaths.filter((p) => !p.startsWith("<"));
	assert.deepEqual(
		fileBacked,
		extensionPaths.paths.map((p) => join(ownedAgentDir, p)).sort(),
		"exactly the owned extensions loaded (no global/package discovery)",
	);
	assert.ok(loadedPaths.every((p) => p.startsWith("<") || p.startsWith(ownedAgentDir)), "no extension loaded from outside the owned dirs");
	assert.deepEqual(loaded.errors, []);

	const modelRuntime = await ModelRuntime.create({
		agentDir: ownedAgentDir,
		refreshOnCreate: false,
		modelNetworkEnabled: false,
	});
	modelRuntime.registerNativeProvider(faux.provider);
	const { session } = await createAgentSession({
		cwd: ownedCwd,
		agentDir: ownedAgentDir,
		model: faux.getModel(),
		thinkingLevel: "off",
		modelRuntime,
		resourceLoader,
		tools: ["compact", "usage", "sibling", "heartbeat_control"],
		sessionManager: SessionManager.inMemory(ownedCwd),
		settingsManager,
	});
	t.after(() => session.dispose());

	// Real startup: session_start handlers run through the public binding.
	await session.bindExtensions({});

	return {
		session,
		ownedAgentDir,
		ownedCwd,
		seedContext: () => {
			// Two large turns so deterministic compaction has a non-empty
			// summarize set (the newest turn stays within keep-recent).
			for (const filler of ["Old filler context. ".repeat(60_000), "Recent filler context. ".repeat(60_000)]) {
				session.sessionManager.appendMessage({
					role: "user",
					content: [{ type: "text", text: filler }],
					timestamp: Date.now(),
				});
			}
		},
	};
}

async function waitUntil(fn, ms = 10_000) {
	const start = Date.now();
	for (;;) {
		if (fn()) return true;
		if (Date.now() - start > ms) return false;
		await new Promise((r) => setTimeout(r, 50));
	}
}

test("real session: sole compact call terminates the run and compaction is confirmed (exact faux call count)", async (t) => {
	const faux = fauxProvider({ models: [{ id: "faux-lifecycle", contextWindow: 200_000, maxTokens: 4_000 }] });
	faux.setResponses([
		fauxAssistantMessage([fauxText("Requesting compaction."), fauxToolCall("compact", {})]),
		// Not consumed in this test: the run must terminate without another
		// model response after the terminating compact call.
		fauxAssistantMessage("should never be reached"),
	]);

	const dir = await mkdtemp(join(tmpdir(), "cc-lifecycle-"));
	t.after(async () => { await rm(dir, { recursive: true, force: true }); });
	await copyFile(new URL("../../extensions/context-controls.ts", import.meta.url), join(dir, "context-controls.ts"));

	const { session, seedContext } = await makeHermeticSession(t, {
		faux,
		extensionPaths: { files: ["context-controls.ts"], paths: ["context-controls.ts"] },
		extensionFactories: [
			// Deterministic deferred compaction: no model call at all.
			(pi) => {
				pi.on("session_before_compact", async (event) => ({
					compaction: {
						summary: "deterministic lifecycle summary",
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
					},
				}));
			},
		],
	});
	seedContext();

	await session.prompt("Please compact the session now.");

	const settled = await waitUntil(() =>
		session.sessionManager.getEntries().some((e) => e.type === "compaction"),
	);
	assert.ok(settled, "a real CompactionEntry was appended after the accepted request");
	const entry = session.sessionManager.getEntries().find((e) => e.type === "compaction");
	assert.equal(entry.summary, "deterministic lifecycle summary", "extension-provided deterministic compaction ran");
	// EXACT faux call count: the compact turn only — the run terminated after
	// the batch instead of continuing to the second scripted response.
	assert.equal(faux.state.callCount, 1, "exactly one model call (the compact turn)");
});

test("real session: compact batched with a sibling is rejected and the sibling still runs (exact faux call count)", async (t) => {
	const faux = fauxProvider({ models: [{ id: "faux-lifecycle-2", contextWindow: 200_000, maxTokens: 4_000 }] });
	faux.setResponses([
		// Batch: compact + sibling. compact must be rejected; sibling must run.
		fauxAssistantMessage([fauxToolCall("compact", {}), fauxToolCall("sibling", {})]),
		fauxAssistantMessage("Batch handled; compaction was correctly refused."),
	]);

	let siblingExecuted = 0;
	const dir = await mkdtemp(join(tmpdir(), "cc-lifecycle-"));
	t.after(async () => { await rm(dir, { recursive: true, force: true }); });
	await copyFile(new URL("../../extensions/context-controls.ts", import.meta.url), join(dir, "context-controls.ts"));

	const { session, seedContext } = await makeHermeticSession(t, {
		faux,
		extensionPaths: { files: ["context-controls.ts"], paths: ["context-controls.ts"] },
		extensionFactories: [
			(pi) => {
				pi.registerTool({
					name: "sibling",
					label: "Sibling",
					description: "test sibling tool",
					parameters: { type: "object", properties: {}, additionalProperties: false },
					execute: async () => {
						siblingExecuted += 1;
						return { content: [{ type: "text", text: "sibling ran" }] };
					},
				});
			},
		],
	});
	seedContext();

	await session.prompt("Do a thing and also compact.");

	assert.equal(siblingExecuted, 1, "sibling tool executed normally");
	await new Promise((r) => setTimeout(r, 100));
	const compactionEntries = session.sessionManager.getEntries().filter((e) => e.type === "compaction");
	assert.equal(compactionEntries.length, 0, "rejected request never dispatches native compaction");
	// EXACT faux call count: the batch turn + the follow-up response turn.
	assert.equal(faux.state.callCount, 2, "exactly two model calls (batch turn + follow-up)");
});
