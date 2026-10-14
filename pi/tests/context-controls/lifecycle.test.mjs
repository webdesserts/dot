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
 * A sole compact call ends its low-level run, completes native compaction,
 * then continues the same parent or child activity before prompt settlement.
 * The installed child runner verifies delivery/disposal, failed compaction,
 * sibling safety and cancellation. Compaction summaries are deterministic;
 * faux call counts prove which responses actually ran.
 *
 * Run: node --test pi/tests/context-controls/lifecycle.test.mjs  (repo root)
 */

import { execFileSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { registerHooks } from "node:module";
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

const subagentsRoot = process.env.PI_SUBAGENTS_ROOT ?? join(homedir(), ".pi/agent/npm/node_modules/pi-subagents");
const { resolveHostPeerAliases } = await import(pathToFileURL(join(subagentsRoot, "src/runs/background/runner-aliases.js")).href);
const { aliases, missing } = resolveHostPeerAliases(sdkRoot);
assert.deepEqual(missing, [], "installed child runner's host peer dependencies resolve");
// Use the runner's own host aliases, only while importing its consumer graph.
const peerHook = registerHooks({ resolve: (specifier, context, next) =>
	next(aliases[specifier] ? pathToFileURL(aliases[specifier]).href : specifier, context),
});
let runChildSession;
try {
	({ runChildSession } = await import(pathToFileURL(join(subagentsRoot, "src/runs/background/run-child-session.js")).href));
} finally {
	peerHook.deregister();
}

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
	sse: process.env.AUTONOMY_SSE_MODE,
	child: process.env.PI_SUBAGENT_CHILD,
};
const setFakeAutonomyEnv = (base) => {
	process.env.AUTONOMY_BASE = base;
	process.env.AUTONOMY_POLL_INTERVAL_MS = "50";
	process.env.AUTONOMY_FETCH_TIMEOUT_MS = "2000";
	process.env.AUTONOMY_HEARTBEAT_MS = "0";
	process.env.AUTONOMY_ERROR_BACKOFF_MS = "200";
	// Legacy long-poll fixtures: explicitly opt out of the default-on SSE mode.
	process.env.AUTONOMY_SSE_MODE = "0";
};
const restoreEnv = () => {
	for (const [k, v] of Object.entries({ AUTONOMY_BASE: ORIGINAL_ENV.base, AUTONOMY_POLL_INTERVAL_MS: ORIGINAL_ENV.poll, AUTONOMY_FETCH_TIMEOUT_MS: ORIGINAL_ENV.timeout, AUTONOMY_HEARTBEAT_MS: ORIGINAL_ENV.hb, AUTONOMY_ERROR_BACKOFF_MS: ORIGINAL_ENV.backoff, AUTONOMY_SSE_MODE: ORIGINAL_ENV.sse })) {
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

async function makeHermeticSession(t, { faux, extensionPaths, extensionFactories, child = false, nativeChildPrompt = false }) {
	const ownedAgentDir = await mkdtemp(join(tmpdir(), "cc-agentdir-"));
	const ownedCwd = await mkdtemp(join(tmpdir(), "cc-cwd-"));
	const savedChildEnv = process.env.PI_SUBAGENT_CHILD;
	if (child) process.env.PI_SUBAGENT_CHILD = "1";
	else delete process.env.PI_SUBAGENT_CHILD;
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
		...(nativeChildPrompt ? { systemPrompt: '<active_agent name="context-fixture"/>\n\nDeliver only the assigned fixture report.' } : {}),
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
			// Enough history for manual compaction, below the native automatic
			// threshold so auto-compaction cannot masquerade as tool dispatch.
			for (const filler of ["Old filler context. ".repeat(4_000), "Recent filler context. ".repeat(4_000)]) {
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

test("real parent session: sole compact completes before continuing the existing task (exact faux call count)", async (t) => {
	const faux = fauxProvider({ models: [{ id: "faux-lifecycle", contextWindow: 200_000, maxTokens: 4_000 }] });
	faux.setResponses([
		fauxAssistantMessage([fauxText("Requesting compaction."), fauxToolCall("compact", {})]),
		fauxAssistantMessage("Parent assignment continued after compaction."),
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
	const reasons = [];
	session.subscribe((event) => { if (event.type === "compaction_start") reasons.push(event.reason); });

	await session.prompt("Please compact the session now.");

	const settled = await waitUntil(() =>
		session.sessionManager.getEntries().some((e) => e.type === "compaction"),
	);
	assert.ok(settled, "a real CompactionEntry was appended after the accepted request");
	const entry = session.sessionManager.getEntries().find((e) => e.type === "compaction");
	assert.equal(entry.summary, "deterministic lifecycle summary", "extension-provided deterministic compaction ran");
	assert.equal(faux.state.callCount, 2, "the parent continued only after compaction completed");
	assert.equal(session.getLastAssistantText(), "Parent assignment continued after compaction.");
	assert.deepEqual(reasons, ["manual"], "the tool, not auto-compaction, produced the compaction entry");
});

test("a newer deferred user request consumes restoration before its first response without a stale wake", { timeout: 10_000 }, async (t) => {
	const faux = fauxProvider({ models: [{ id: "faux-delayed-user", contextWindow: 200_000, maxTokens: 4_000 }] });
	let firstPostCompactContext;
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("compact", {})]),
		(context) => { firstPostCompactContext = context; return fauxAssistantMessage("Newer user task completed."); },
		fauxAssistantMessage("Unwanted stale wake."),
	]);
	let enterCompaction;
	let releaseCompaction;
	const entered = new Promise((resolve) => { enterCompaction = resolve; });
	const gate = new Promise((resolve) => { releaseCompaction = resolve; });
	const { session, seedContext } = await makeHermeticSession(t, {
		faux,
		extensionPaths: { files: ["context-controls.ts"], paths: ["context-controls.ts"] },
		extensionFactories: [(pi) => {
			pi.on("session_before_compact", async (event) => {
				enterCompaction();
				await gate;
				return { compaction: {
					summary: "Preserve the approved task.",
					firstKeptEntryId: event.preparation.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
				} };
			});
		}],
	});
	seedContext();
	const prompting = session.prompt("Compact before continuing.");
	await entered;
	// AgentSession defers this while agent_settled is held by compaction.
	await session.prompt("NEWER_USER_REQUEST: finish this task instead.");
	releaseCompaction();
	await prompting;
	const context = JSON.stringify(firstPostCompactContext);
	assert.match(context, /NEWER_USER_REQUEST/);
	assert.ok(context.includes(RESTORATION_WORDING), "restoration precedes the newer task's first model response");
	assert.equal(faux.state.callCount, 2, "newer user input replaces the autonomous wake, rather than preceding it");
	assert.equal(session.getLastAssistantText(), "Newer user task completed.");
	assert.deepEqual(session.sessionManager.getEntries().filter((e) => e.message?.role === "user")
		.map((e) => e.message.content.map((c) => c.text ?? "").join(""))
		.filter((text) => !text.includes("filler context")), ["Compact before continuing.", "NEWER_USER_REQUEST: finish this task instead."]);
});

const RESTORATION_WORDING = "[system] Your context has been compacted, please review the summary, validate it against the current world state, and load any relevant skills and notes that you will need to continue.";
const CONTINUATION_NOTICE = "[system] Harness continuation after compaction.";

test("real parent continuation receives the existing skills and Working Memory reminder once", { timeout: 10_000 }, async (t) => {
	const ownedHome = await mkdtemp(join(tmpdir(), "cc-harness-home-"));
	const originalHome = process.env.HOME;
	const originalIdentity = process.env.AUTONOMY_AGENT_ID;
	process.env.HOME = ownedHome;
	process.env.AUTONOMY_AGENT_ID = "context-fixture";
	t.after(async () => {
		if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
		if (originalIdentity === undefined) delete process.env.AUTONOMY_AGENT_ID; else process.env.AUTONOMY_AGENT_ID = originalIdentity;
		await rm(ownedHome, { recursive: true, force: true });
	});
	const memoryDir = join(ownedHome, "notes/agents/context-fixture");
	await mkdir(memoryDir, { recursive: true });
	await writeFile(join(memoryDir, "Working Memory — context-fixture.md"), "Preserve fixture focus: CONTINUATION_MEMORY_MARKER.");
	const faux = fauxProvider({ models: [{ id: "faux-parent-harness", contextWindow: 200_000, maxTokens: 4_000 }] });
	let continuationContext;
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("compact", {})]),
		(context) => { continuationContext = context; return fauxAssistantMessage("Picked up after context restoration."); },
	]);
	const { session, seedContext } = await makeHermeticSession(t, {
		faux,
		extensionPaths: { files: ["context-controls.ts", "harness-context.ts"], paths: ["context-controls.ts", "harness-context.ts"] },
		extensionFactories: [deterministicCompaction],
	});
	seedContext();
	await session.prompt("Compact, then pick up where you left off.");
	const context = JSON.stringify(continuationContext);
	assert.equal(faux.state.callCount, 2, "the idle snapshot does not create a second continuation");
	assert.match(context, /Context was compacted\. Please load Nu and codemode/);
	assert.match(context, /CONTINUATION_MEMORY_MARKER/);
	assert.ok(context.includes(RESTORATION_WORDING));
	assert.ok(context.includes(CONTINUATION_NOTICE));
	assert.doesNotMatch(context, /Continue thinking about and doing what you were doing\./);
	const entries = session.sessionManager.getEntries();
	const notices = entries.filter((e) => e.type === "custom_message" && e.customType === "context-controls-restoration");
	assert.equal(notices.length, 1);
	assert.equal(notices[0].content[0].text, RESTORATION_WORDING, "the preferred wording remains typed custom context");
	assert.equal(entries.filter((e) => e.type === "custom_message" && e.customType === "context-controls-resume").length, 0, "no nested custom wake run");
	assert.equal(entries.filter((e) => e.message?.role === "user" && e.message.content[0]?.text === CONTINUATION_NOTICE).length, 1, "owner-approved wake persists in user role, labeled as harness control");
	assert.ok(!JSON.stringify(entries).includes("context-controls-resume:"), "opaque tokens never reach history");
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

test('the immediately next text-only model response receives a crossing alert', async (t) => {
	const faux = fauxProvider({ models: [{ id: 'faux-alert-boundary', contextWindow: 200_000, maxTokens: 4_000 }] });
	let output = 'small baseline';
	let nextContext;
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall('sibling', {})]),
		() => {
			output = 'x'.repeat(360_000);
			return fauxAssistantMessage([fauxToolCall('sibling', {})]);
		},
		(context) => {
			nextContext = context;
			return fauxAssistantMessage('Finished without another tool.');
		},
	]);
	const { session } = await makeHermeticSession(t, {
		faux,
		extensionPaths: { files: ['context-controls.ts'], paths: ['context-controls.ts'] },
		extensionFactories: [(pi) => { pi.registerTool({
			name: 'sibling', label: 'Fixture output', description: 'Return controlled fixture data',
			parameters: { type: 'object', properties: {}, additionalProperties: false },
			execute: async () => ({ content: [{ type: 'text', text: output }] }),
		}); }],
	});
	await session.prompt('Read both fixture outputs, then finish.');
	assert.equal(faux.state.callCount, 3, 'only the three scripted responses ran');
	assert.ok(JSON.stringify(nextContext).includes('Context pressure: usage crossed 40%'),
		'the first response after the large tool result receives the warning');
	const entries = session.sessionManager.getEntries();
	assert.equal(entries.filter((e) => e.type === 'custom_message' && JSON.stringify(e).includes('Context pressure:')).length, 0, 'pressure notices do not accumulate in history');
	assert.ok(entries.filter((e) => e.message?.role === 'toolResult').every(
		(e) => !JSON.stringify(e.message.content).includes('Context pressure:'),
	), 'tool output is not rewritten to carry alerts');
});

// Exercise the installed child runner's settlement/disposal boundary around
// a real, hermetically loaded AgentSession, without a provider or MCP launch.
async function runHermeticChild(session, { registerStop } = {}) {
	let disposed = false;
	const result = await runChildSession({
		factory: { create: async () => ({
			get messages() { return session.messages; },
			subscribe: (listener) => session.subscribe(listener),
			prompt: (text) => session.prompt(text),
			steer: (text) => session.steer(text),
			followUp: (text) => session.followUp(text),
			abort: () => session.abort(),
			hasQueuedMessages: () => session.hasQueuedMessages(),
			dispose: async () => {
				disposed = true;
				await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
				session.dispose();
			},
		}) },
		launch: {
			session: { hooks: [] }, config: { agent: "context-fixture" },
			capture: { finalDrainHeld: () => false },
		},
		prompt: "Manage context, then deliver the assigned fixture report.",
		writeOutputLine: () => {}, appendChildEvent: () => {}, registerStop,
	});
	return { result, disposed };
}

const deterministicCompaction = (pi) => {
	pi.on("session_before_compact", (event) => ({ compaction: {
		summary: "Preserve the fixture assignment and continue it.",
		firstKeptEntryId: event.preparation.firstKeptEntryId,
		tokensBefore: event.preparation.tokensBefore,
	} }));
};

for (const mode of ["background", "foreground"]) {
test(`native child runner (${mode}): usage and compact are available, compaction completes before the assignment`, { timeout: 10_000 }, async (t) => {
	const faux = fauxProvider({ models: [{ id: "faux-child-context", contextWindow: 200_000, maxTokens: 4_000 }] });
	let finalContext;
	let resumedContext;
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("usage", {})]),
		fauxAssistantMessage([fauxToolCall("compact", { summaryFocus: "Preserve the fixture assignment." })]),
		(context) => { resumedContext = context; return fauxAssistantMessage([fauxToolCall("usage", {})]); },
		(context) => { finalContext = context; return fauxAssistantMessage("Fixture assignment completed after compaction."); },
	]);
	const { session, seedContext } = await makeHermeticSession(t, {
		faux, child: mode === "background", nativeChildPrompt: mode === "foreground",
		extensionPaths: { files: ["context-controls.ts"], paths: ["context-controls.ts"] },
		extensionFactories: [deterministicCompaction],
	});
	assert.ok(session.getActiveToolNames().includes("usage"), "child usage is registered and allowed");
	assert.ok(session.getActiveToolNames().includes("compact"), "child compact is registered and allowed");
	seedContext();
	const reasons = [];
	session.subscribe((event) => { if (event.type === "compaction_start") reasons.push(event.reason); });
	const { result, disposed } = await runHermeticChild(session);
	assert.equal(result.exitCode, 0, result.error);
	assert.equal(result.finalOutput, "Fixture assignment completed after compaction.");
	assert.equal(faux.state.callCount, 4, "the existing child prompt owns every response through final delivery");
	assert.deepEqual(reasons, ["manual"], "tool-requested compaction, not automatic threshold recovery");
	assert.equal(session.sessionManager.getEntries().filter((e) => e.type === "compaction").length, 1);
	assert.match(JSON.stringify(finalContext), /Last compaction: SUCCESS/);
	assert.ok(JSON.stringify(resumedContext).includes(RESTORATION_WORDING), "the first post-compaction child response gets restoration guidance");
	const entries = session.sessionManager.getEntries();
	assert.equal(entries.filter((e) => e.message?.role === "user" && e.message.content[0]?.text === CONTINUATION_NOTICE).length, 1);
	assert.ok(!JSON.stringify(entries).includes("context-controls-resume:"));
	assert.ok(disposed, "the runner closes the session only after the post-compaction assignment finishes");
});
}

test("native child runner: failed compaction reports failure without restarting the assignment", { timeout: 10_000 }, async (t) => {
	const faux = fauxProvider({ models: [{ id: "faux-child-too-small", contextWindow: 200_000, maxTokens: 4_000 }] });
	let finalContext;
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("compact", {})]),
		fauxAssistantMessage([fauxToolCall("usage", {})]),
		(context) => { finalContext = context; return fauxAssistantMessage("Reported context-compaction failure; no task completion claimed."); },
	]);
	const { session } = await makeHermeticSession(t, {
		faux, child: true,
		extensionPaths: { files: ["context-controls.ts"], paths: ["context-controls.ts"] },
	});
	const { result } = await runHermeticChild(session);
	assert.equal(result.exitCode, 0, result.error);
	assert.equal(faux.state.callCount, 1, "failed compaction does not authorize a continuation");
	assert.equal(session.sessionManager.getEntries().filter((e) => e.type === "compaction").length, 0);
	assert.equal(finalContext, undefined, "scripted post-failure responses never ran");
	const entries = JSON.stringify(session.sessionManager.getEntries());
	assert.match(entries, /Compaction FAILED/);
	assert.ok(!entries.includes(RESTORATION_WORDING), "failure never claims restoration");
	assert.doesNotMatch(result.finalOutput ?? "", /no task completion claimed/);
});

test("native child runner: batched compact leaves sibling work intact and never dispatches", { timeout: 10_000 }, async (t) => {
	const faux = fauxProvider({ models: [{ id: "faux-child-batch", contextWindow: 200_000, maxTokens: 4_000 }] });
	let siblings = 0;
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("compact", {}), fauxToolCall("sibling", {})]),
		fauxAssistantMessage("Sibling completed; compaction was refused."),
	]);
	const { session, seedContext } = await makeHermeticSession(t, {
		faux, child: true,
		extensionPaths: { files: ["context-controls.ts"], paths: ["context-controls.ts"] },
		extensionFactories: [(pi) => { pi.registerTool({
			name: "sibling", label: "Sibling", description: "Owned fixture operation",
			parameters: { type: "object", properties: {}, additionalProperties: false },
			execute: async () => { siblings += 1; return { content: [{ type: "text", text: "sibling ran" }] }; },
		}); }],
	});
	seedContext();
	const { result } = await runHermeticChild(session);
	assert.equal(result.exitCode, 0, result.error);
	assert.equal(siblings, 1);
	assert.equal(faux.state.callCount, 2);
	assert.equal(session.sessionManager.getEntries().filter((e) => e.type === "compaction").length, 0);
});

test("native child runner: stopping during compaction does not restart the worker or claim success", { timeout: 10_000 }, async (t) => {
	const faux = fauxProvider({ models: [{ id: "faux-child-cancel", contextWindow: 200_000, maxTokens: 4_000 }] });
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("compact", {})]),
		fauxAssistantMessage("Must not restart after cancellation."),
	]);
	let releaseCompaction;
	let enteredCompaction;
	const entered = new Promise((resolve) => { enteredCompaction = resolve; });
	const { session, seedContext } = await makeHermeticSession(t, {
		faux, child: true,
		extensionPaths: { files: ["context-controls.ts"], paths: ["context-controls.ts"] },
		extensionFactories: [(pi) => {
			pi.on("session_before_compact", async (event) => {
				enteredCompaction();
				await new Promise((resolve) => { releaseCompaction = resolve; });
				return { compaction: {
					summary: "Cancelled fixture summary.",
					firstKeptEntryId: event.preparation.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
				} };
			});
		}],
	});
	seedContext();
	let stop;
	const running = runHermeticChild(session, { registerStop: (callback) => { stop = callback; } });
	await entered;
	stop();
	releaseCompaction();
	const { result } = await running;
	assert.equal(result.stopped, true);
	assert.equal(result.exitCode, 1);
	assert.equal(faux.state.callCount, 1, "no continuation after the owning runner stops the child");
	assert.equal(session.sessionManager.getEntries().filter((e) => e.type === "compaction").length, 0);
});
