import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sdk, faux as fauxModule } from "../context-controls/sdk.mjs";
import { awaitWorkerExit, killStrayWorkers } from "../context-controls/hermetic.mjs";
import { ACTOR_ID, appendPadding, digest, receipt } from "./fixtures/large-session.mjs";
import { CUSTOM_TYPE, readQualifyingReceipts } from "../../extensions/notifications.sse.protocol.mjs";

// No real daemon, credentials or inference: actual Pi1.4 supervisor, worker,
// file-backed SDK custom messages and an in-process faux provider meet here.
test("Pi1.4 recovery: old large-file disk offer retires and a fresh offer wakes the model and persists a qualifying receipt", { timeout: 30_000 }, async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "sse-sdk-recovery-owned-"));
	const oldBody = "OLD_PERSISTED_PRESENTATION";
	const freshBody = "FRESH_CURRENT_FEED_WORK — exact server body 🌱";
	const acks = [];
	let stream;
	let freshSent = false;
	let session;
	let file;
	let sessionId;
	let origin;
	let onFreshAck;
	const freshAck = new Promise((resolve) => { onFreshAck = resolve; });
	const offer = (id, body) => ({ presentation_id: id, content_offer_id: null, summary_offer_id: 0,
		body, render_version: 1, digest: digest(body) });
	const sendOffer = (id, body) => stream.write(`event: presentation\ndata: ${JSON.stringify(offer(id, body))}\n\n`);
	const server = createServer((req, res) => {
		let raw = "";
		req.on("data", (chunk) => { raw += chunk; });
		req.on("end", () => {
			const respond = (payload) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(payload)); };
			if (req.url === "/whoami") return respond({ user: "rhea", actor_id: ACTOR_ID });
			if (req.url === "/notifications/lease/status") return respond({ epoch: 0, owner: null });
			if (req.url === "/notifications/lease/claim") return respond({ outcome: "granted", epoch: 1,
				runtime_id: JSON.parse(raw).runtime_id, grant_secret: "ab".repeat(32), deadline_remaining_ms: 30_000 });
			if (req.url === "/notifications/lease/renew") return respond({ outcome: "renewed", deadline_remaining_ms: 30_000 });
			if (req.url === "/notifications/presentation/stream") {
				res.writeHead(200, { "content-type": "text/event-stream" });
				stream = res;
				sendOffer(7, oldBody);
				return;
			}
			if (req.url === "/notifications/presentation/acknowledge") {
				const ack = JSON.parse(raw);
				acks.push(ack);
				respond({ outcome: "acknowledged" });
				if (ack.presentation_id === 7 && !freshSent) {
					freshSent = true;
					queueMicrotask(() => sendOffer(8, freshBody));
				}
				if (ack.presentation_id === 8) onFreshAck(ack);
				return;
			}
			res.writeHead(404); res.end();
		});
	});
	const env = {
		PI_SUBAGENT_CHILD: undefined, AUTONOMY_BASE: "", AUTONOMY_TOKEN: "owned-fixture-not-a-credential",
		AUTONOMY_SESSION_COOKIE_FILE: "", AUTONOMY_SSE_MODE: "1", AUTONOMY_SSE_SCOPE: "",
		AUTONOMY_SSE_EXPECTED_ACTOR_ID: "", AUTONOMY_SSE_RENEW_INTERVAL_MS: "",
		AUTONOMY_SSE_TRACE_FILE: join(dir, "worker-trace.jsonl"), AUTONOMY_HEARTBEAT_MS: "0",
		AUTONOMY_FETCH_TIMEOUT_MS: "2000", AUTONOMY_SSE_RECONNECT_BACKOFF_MS: "30",
	};
	const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
	t.after(async () => {
		try {
			if (session) {
				await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
				await session.abort();
				session.dispose();
			}
			server.closeAllConnections?.();
			if (server.listening) await new Promise((resolve) => server.close(resolve));
			if (!await awaitWorkerExit(dir)) {
				killStrayWorkers(dir);
				throw new Error(`owned SDK notification worker did not close: ${dir}`);
			}
			await rm(dir, { recursive: true, force: true });
		} finally {
			for (const [key, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[key]; else process.env[key] = value;
			}
		}
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	origin = `http://127.0.0.1:${server.address().port}`;
	env.AUTONOMY_BASE = origin;
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined) delete process.env[key]; else process.env[key] = value;
	}
	for (const name of ["notifications.ts", "notifications.worker.mjs", "notifications.sse.protocol.mjs"]) {
		await copyFile(new URL(`../../extensions/${name}`, import.meta.url), join(dir, name));
	}
	const manager = sdk.SessionManager.create(dir, join(dir, "sessions"));
	// An SDK-written assistant commits the real header/file; the old receipt
	// is also produced by the SDK, not supervisor send-return inference.
	manager.appendMessage(fauxModule.fauxAssistantMessage("Owned preceding session response."));
	sessionId = manager.getSessionId();
	file = manager.getSessionFile();
	manager.appendCustomMessageEntry(CUSTOM_TYPE, oldBody, true, receipt(oldBody, 7, { sessionId, scope: origin }).details);
	const bytes = appendPadding(file);
	const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false } });
	const loader = new sdk.DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager,
		additionalExtensionPaths: [join(dir, "notifications.ts")],
		noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	assert.deepEqual(loader.getExtensions().extensions.map((entry) => entry.path), [join(dir, "notifications.ts")]);
	const faux = fauxModule.fauxProvider({ models: [{ id: "owned-notification", contextWindow: 200_000, maxTokens: 2_000 }] });
	let modelContext;
	faux.setResponses([(context) => { modelContext = context; return fauxModule.fauxAssistantMessage("Fresh notification handled."); }]);
	const runtime = await sdk.ModelRuntime.create({ agentDir: dir, refreshOnCreate: false, modelNetworkEnabled: false });
	runtime.registerNativeProvider(faux.provider);
	({ session } = await sdk.createAgentSession({ cwd: dir, agentDir: dir, model: faux.getModel(), modelRuntime: runtime,
		resourceLoader: loader, sessionManager: manager, settingsManager, tools: [], thinkingLevel: "off" }));
	await session.bindExtensions({});
	const ack = await freshAck;
	await session.waitForIdle();
	assert.equal(ack.expected_digest, digest(freshBody));
	assert.ok(acks.some((item) => item.presentation_id === 7), "only recovered old disk evidence retires the outstanding offer");
	assert.equal(faux.state.callCount, 1, "old persisted offer never creates a stale extra model run");
	assert.ok(JSON.stringify(modelContext).includes(freshBody));
	assert.equal(session.getLastAssistantText(), "Fresh notification handled.");
	const entry = manager.getEntries().find((item) => item.type === "custom_message" && item.content === freshBody);
	assert.equal(entry.display, true);
	assert.equal(entry.details.sessionId, sessionId);
	assert.equal(entry.details.actorId, ACTOR_ID);
	const disk = readQualifyingReceipts(file, sessionId, origin, "rhea", ACTOR_ID);
	assert.equal(disk.ok, true);
	assert.ok(disk.receipts.some((item) => !item.refused && item.presentationId === 8 && item.digest === digest(freshBody) && item.summaryOfferId === 0));
	t.diagnostic(JSON.stringify({ bytes, sdk: sdk.VERSION, oldDiskReceipt: true, freshModelCalls: faux.state.callCount,
		freshDiskReceipt: true, freshAck: ack.presentation_id }));
});
