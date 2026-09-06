/**
 * Cross-extension lifecycle test: notifications (REAL worker, REAL goal
 * heartbeat) × context-controls (compaction dispatch), both loaded into one
 * real AgentSession — HERMETIC.
 *
 * - The real notifications.worker.mjs child long-polls a loopback fake
 *   autonomy server (AUTONOMY_BASE); the goal heartbeat is driven by real
 *   supervisor stdin events over the real timer.
 * - The model is the deterministic faux provider; compaction is deterministic
 *   via session_before_compact gated by the test (zero real model/network
 *   service calls).
 *
 * Teardown ownership/order (bounded fixture hygiene):
 *   1. shutdown extensions while the runtime is live (real session_shutdown
 *      handlers — the notifications worker child is killed);
 *   2. await the owned worker's exit (errors are surfaced, not swallowed);
 *   3. dispose the session; 4. close the fake server; 5. restore the ORIGINAL
 *   env (captured at module load, before any test mutates it); 6. remove the
 *   owned dirs.
 *
 * Proven:
 * 1. No heartbeat TURN runs while a compaction is in flight: the worker's
 *    beat fires mid-compaction and the supervisor defers it (ctx.isIdle() is
 *    false during compaction) — the exact faux call count does not move.
 * 2. After the compaction is confirmed, the deferred heartbeat continuation
 *    happens and the model receives the confirmed outcome without any extra
 *    conversational turn.
 * 3. A human /hb pause issued DURING the in-flight compaction remains paused
 *    afterward: no heartbeat continuation runs and status reports paused.
 *
 * Run: node --test pi/tests/context-controls/cross-extension.test.mjs
 */

import { execFileSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { awaitWorkerExit, killStrayWorkers, restoreOriginalEnv, setFakeAutonomyEnv } from "./hermetic.mjs";

const sdkRoot = process.env.PI_SDK_ROOT ?? join(
	execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(),
	"@earendil-works/pi-coding-agent",
);
const { fauxProvider, fauxAssistantMessage, fauxToolCall, fauxText } = await import(
	pathToFileURL(join(sdkRoot, "node_modules/@earendil-works/pi-ai/dist/providers/faux.js")).href
);
const { createAgentSession, SessionManager, SettingsManager, DefaultResourceLoader, getAgentDir, ModelRuntime } =
	await import(pathToFileURL(join(sdkRoot, "dist/index.js")).href);

// Loopback fake autonomy daemon: empty feed, always fast, request-counted.
async function startFakeAutonomyServer() {
	const state = { requests: 0 };
	const server = createServer((req, res) => {
		state.requests += 1;
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ priority_notifications: [], summary: {}, total: 0 }));
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const base = `http://127.0.0.1:${server.address().port}`;
	return { base, state, close: () => new Promise((r) => server.close(r)) };
}

async function makeCrossSession(t, { faux, onBeforeCompact, releaseCompaction, closeServer }) {
	const ownedAgentDir = await mkdtemp(join(tmpdir(), "cc-x-agentdir-"));
	const ownedCwd = await mkdtemp(join(tmpdir(), "cc-x-cwd-"));
	const fixture = { ownedAgentDir, ownedCwd, releaseCompaction, closeServer, session: null };
	t.after(() => teardownCrossSession(fixture));
	delete process.env.PI_SUBAGENT_CHILD;
	for (const file of ["notifications.ts", "notifications.worker.mjs", "notifications.sse.protocol.mjs", "context-controls.ts"]) {
		await copyFile(new URL(`../../extensions/${file}`, import.meta.url), join(ownedAgentDir, file));
	}

	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
	});
	const resourceLoader = new DefaultResourceLoader({
		cwd: ownedCwd,
		agentDir: ownedAgentDir,
		settingsManager,
		additionalExtensionPaths: [join(ownedAgentDir, "notifications.ts"), join(ownedAgentDir, "context-controls.ts")],
		extensionFactories: [
			// Deterministic compaction gated by the test.
			(pi) => {
				pi.on("session_before_compact", async (event) => {
					await onBeforeCompact?.();
					return {
						compaction: {
							summary: "deterministic cross-extension summary",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					};
				});
			},
		],
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await resourceLoader.reload();
	const loaded = resourceLoader.getExtensions();
	const fileBacked = loaded.extensions.map((e) => e.path).filter((p) => !p.startsWith("<")).sort();
	assert.deepEqual(
		fileBacked,
		[join(ownedAgentDir, "context-controls.ts"), join(ownedAgentDir, "notifications.ts")].sort(),
		"exactly notifications and context-controls loaded (no global/package discovery)",
	);
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
		tools: ["compact", "usage", "heartbeat_control"],
		sessionManager: SessionManager.inMemory(ownedCwd),
		settingsManager,
	});
	fixture.session = session;
	await session.bindExtensions({});

	let hbTool = null;
	let hbCommand = null;
	for (const ext of loaded.extensions) {
		const t1 = ext.tools.get("heartbeat_control")?.definition;
		if (t1) hbTool = t1;
		const c1 = ext.commands.get("hb");
		if (c1) hbCommand = c1.handler;
	}
	assert.ok(hbTool, "heartbeat_control registered");
	assert.ok(hbCommand, "/hb command registered");

	return { session, hbTool, hbCommand, ownedAgentDir, ownedCwd, loaded };
}

// Ordered teardown: (1) real session_shutdown handlers while the runtime is
// live — the worker child is killed; (2) await the owned worker's exit —
// shutdown errors are surfaced, not swallowed; (3) dispose; (4) close the
// fake server; (5) restore ORIGINAL env; (6) remove owned dirs.
async function teardownCrossSession({ session, ownedAgentDir, ownedCwd, closeServer, releaseCompaction }) {
	const errors = [];
	try {
		if (session) {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			session.abortCompaction();
			releaseCompaction();
			await session.abort();
			assert.ok(await waitUntil(() => session.isIdle, 5000), "SDK settled during teardown");
		}
	} catch (error) {
		errors.push(error);
	}
	const workerExited = await awaitWorkerExit(ownedAgentDir, 5000);
	if (!workerExited) {
		killStrayWorkers(ownedAgentDir);
		errors.push(new Error(`Worker required forced cleanup; inspect ${ownedAgentDir}`));
	}
	session?.dispose();
	try { await closeServer(); } catch (error) { errors.push(error); }
	restoreOriginalEnv();
	if (workerExited) {
		await rm(ownedAgentDir, { recursive: true, force: true });
		await rm(ownedCwd, { recursive: true, force: true });
	}
	if (errors.length) throw new AggregateError(errors, "Fixture teardown failed");
}

const seedContext = (session) => {
	for (const filler of ["Old filler context. ".repeat(60_000), "Recent filler context. ".repeat(60_000)]) {
		session.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: filler }],
			timestamp: Date.now(),
		});
	}
};

async function waitUntil(fn, ms = 20_000) {
	const start = Date.now();
	for (;;) {
		if (fn()) return true;
		if (Date.now() - start > ms) return false;
		await new Promise((r) => setTimeout(r, 50));
	}
}

test("cross-extension: no heartbeat turn during in-flight compaction; confirmed outcome on the next heartbeat continuation", async (t) => {
	const server = await startFakeAutonomyServer();
	setFakeAutonomyEnv(server.base);

	const faux = fauxProvider({ models: [{ id: "faux-x", contextWindow: 200_000, maxTokens: 4_000 }] });
	const capturedContexts = [];
	let releaseCompaction = null;
	const compactionInFlight = new Promise((r) => { releaseCompaction = r; });
	faux.setResponses([
		fauxAssistantMessage([fauxText("Requesting compaction."), fauxToolCall("compact", {})]),
		// Capture the first heartbeat request, before any usage tool or human follow-up.
		(context) => {
			capturedContexts.push(context);
			return fauxAssistantMessage("Continuing after compaction.");
		},
	]);

	const { session, hbTool, hbCommand } = await makeCrossSession(t, {
		faux,
		onBeforeCompact: () => compactionInFlight,
		releaseCompaction,
		closeServer: server.close,
	});
	seedContext(session);

	// Enable the goal heartbeat (idle at this point): real worker arms 5s.
	const enabled = await hbTool.execute("id", { action: "enable", nextAction: "verify compaction coordination", idleDelaySeconds: 5 }, undefined, undefined, undefined);
	assert.equal(enabled.details.state.mode, "goal");

	await session.prompt("Please compact the session now.");

	// The compact call was the only model call so far; compaction is now
	// in flight behind the test gate.
	assert.equal(faux.state.callCount, 1, "only the compact turn so far");
	const compactionEntry = () => session.sessionManager.getEntries().find((e) => e.type === "compaction");

	// The real worker's heartbeat fires ~5s after agent_end — while the
	// compaction is still in flight behind the gate. It must be DEFERRED:
	// wait past that point, then assert no model call happened.
	await new Promise((r) => setTimeout(r, 6500));
	assert.ok(!compactionEntry(), "compaction still in flight behind the gate");
	assert.equal(faux.state.callCount, 1, "no heartbeat turn while the compaction is in flight");

	// Confirmed outcome must reach the very first heartbeat continuation.
	releaseCompaction();
	const outcomeEntry = () =>
		session.sessionManager.getEntries().find(
			(e) => e.type === "custom_message" && JSON.stringify(e).includes("Compaction completed successfully"),
		);
	const outcomeAppeared = await waitUntil(() => outcomeEntry(), 20_000);
	assert.ok(outcomeAppeared, "the confirmed outcome is in session history (model-visible, no extra turn)");
	const continued = await waitUntil(() => faux.state.callCount >= 2 && capturedContexts.length > 0, 20_000);
	assert.ok(continued, "heartbeat continuation ran without another human prompt");
	await hbCommand("pause", { ui: { notify() {} } });
	assert.equal(faux.state.callCount, 2, "only the compact request and heartbeat continuation called the model");
	assert.ok(
		capturedContexts.some((c) => JSON.stringify(c).includes("Compaction completed successfully")),
		"the first continuation already receives confirmed completion",
	);
	assert.equal(session.sessionManager.getEntries().filter(
		(e) => e.type === "custom_message" && JSON.stringify(e).includes("Compaction completed successfully"),
	).length, 1, "native event plus callback report one outcome");
	const heartbeatUserEntry = session.sessionManager.getEntries().find(
		(e) => e.type === "message" && JSON.stringify(e).includes("[heartbeat] goal check"),
	);
	assert.ok(heartbeatUserEntry, "the heartbeat itself was delivered as a user turn after compaction");
});

test("cross-extension: /hb pause during in-flight compaction remains paused afterward", async (t) => {
	const server = await startFakeAutonomyServer();
	setFakeAutonomyEnv(server.base);

	const faux = fauxProvider({ models: [{ id: "faux-x-2", contextWindow: 200_000, maxTokens: 4_000 }] });
	let releaseCompaction = null;
	const compactionInFlight = new Promise((r) => { releaseCompaction = r; });
	faux.setResponses([
		fauxAssistantMessage([fauxText("Requesting compaction."), fauxToolCall("compact", {})]),
		fauxAssistantMessage("should never run: paused"),
	]);

	const { session, hbTool, hbCommand } = await makeCrossSession(t, {
		faux,
		onBeforeCompact: () => compactionInFlight,
		releaseCompaction,
		closeServer: server.close,
	});
	seedContext(session);

	await hbTool.execute("id", { action: "enable", nextAction: "pause coordination check", idleDelaySeconds: 5 }, undefined, undefined, undefined);
	await session.prompt("Please compact the session now.");
	assert.equal(faux.state.callCount, 1, "only the compact turn so far");

	// Human pause DURING the in-flight compaction.
	await hbCommand("pause", { ui: { notify() {} } });
	releaseCompaction();
	const compacted = await waitUntil(() => session.sessionManager.getEntries().some((e) => e.type === "compaction"), 5000);
	assert.ok(compacted, "compaction still completes");

	// No heartbeat continuation for at least two full idle delays.
	await new Promise((r) => setTimeout(r, 12_000));
	assert.equal(faux.state.callCount, 1, "paused: no heartbeat turn after the compaction");

	const status = await hbTool.execute("id", { action: "status" }, undefined, undefined, undefined);
	assert.equal(status.details.state.mode, "paused", "heartbeat state remains paused");
});
