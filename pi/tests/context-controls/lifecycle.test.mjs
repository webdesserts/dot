/**
 * Real-SDK lifecycle test for the context-controls extension
 * (pi/extensions/context-controls.ts).
 *
 * Unlike supervisor.test.mjs (VM sandbox), this drives a REAL AgentSession
 * from the installed SDK with the deterministic faux provider (no network, no
 * model keys) and the extension loaded through the real resource loader:
 *
 * - sole compact() tool call → terminate:true ends the run after the batch →
 *   compaction is dispatched at agent_settled and CONFIRMED via a
 *   deterministic session_before_compact handler (no LLM summarization call);
 * - a compact() call batched with a sibling tool call is rejected mid-run
 *   while the sibling still executes, and no compaction is dispatched;
 * - the confirmed outcome notice is delivered turn-free.
 *
 * Run: node --test pi/tests/context-controls/lifecycle.test.mjs  (repo root)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const sdkRoot = process.env.PI_SDK_ROOT ?? join(
	execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(),
	"@earendil-works/pi-coding-agent",
);
const { fauxProvider, fauxAssistantMessage, fauxToolCall, fauxText } = await import(
	pathToFileURL(join(sdkRoot, "node_modules/@earendil-works/pi-ai/dist/providers/faux.js")).href
);
const sdk = await import(pathToFileURL(join(sdkRoot, "dist/index.js")).href);
const { createAgentSession, SessionManager, SettingsManager, DefaultResourceLoader, getAgentDir } = sdk;

function makeSession(t, extensionPath, siblingCalls, faux) {
	const observed = { siblingExecuted: 0, compactCalls: [] };
	const resourceLoader = new DefaultResourceLoader({
		cwd: tmpdir(),
		agentDir: getAgentDir(),
		additionalExtensionPaths: [extensionPath],
		extensionFactories: [
			// Deterministic compaction: the extension-provided content path in
			// AgentSession.compact needs no model call at all.
			(pi) => {
				pi.on("session_before_compact", async (event) => ({
					compaction: {
						summary: "deterministic lifecycle summary",
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
					},
				}));
			},
			(pi) => {
				pi.registerTool({
					name: "sibling",
					label: "Sibling",
					description: "test sibling tool",
					parameters: { type: "object", properties: {}, additionalProperties: false },
					execute: async () => {
						observed.siblingExecuted += 1;
						return { content: [{ type: "text", text: "sibling ran" }] };
					},
				});
			},
		],
	});
	const sessionPromise = (async () => {
		const modelRuntime = await sdk.ModelRuntime.create({ agentDir: getAgentDir(), refreshOnCreate: false, modelNetworkEnabled: false });
		modelRuntime.registerNativeProvider(faux.provider);
		const loaderReady = await resourceLoader.reload();
		return createAgentSession({
			cwd: tmpdir(),
			agentDir: getAgentDir(),
			model: faux.getModel(),
			thinkingLevel: "off",
			modelRuntime,
			resourceLoader,
			tools: ["compact", "usage", "sibling"],
			sessionManager: SessionManager.inMemory(tmpdir()),
			settingsManager: SettingsManager.inMemory({ compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 } }),
		});
	})();
	return { sessionPromise, observed };
}

async function waitUntil(fn, ms = 5000) {
	const start = Date.now();
	for (;;) {
		if (fn()) return true;
		if (Date.now() - start > ms) return false;
		await new Promise((r) => setTimeout(r, 50));
	}
}

test("real session: sole compact call terminates the run and compaction is confirmed", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "cc-lifecycle-"));
	t.after(async () => { await rm(dir, { recursive: true, force: true }); });
	await copyFile(new URL("../../extensions/context-controls.ts", import.meta.url), join(dir, "context-controls.ts"));
	delete process.env.PI_SUBAGENT_CHILD;

	const faux = fauxProvider({
		models: [{ id: "faux-lifecycle", contextWindow: 200_000, maxTokens: 4_000 }],
	});
	// One response: a SOLE compact tool call, then nothing (the run must end
	// via terminate:true, not via another model response).
	faux.setResponses([
		fauxAssistantMessage([
			fauxText("Requesting compaction."),
			fauxToolCall("compact", {}),
		]),
	]);

	const { sessionPromise } = makeSession(t, join(dir, "context-controls.ts"), 0, faux);
	const { session } = await sessionPromise;
	t.after(() => session.dispose());
	// Seed two large turns so deterministic compaction has a non-empty
	// summarize set (the newest turn stays within the keep-recent budget).
	for (const filler of ["Old filler context. ".repeat(60_000), "Recent filler context. ".repeat(60_000)]) {
		session.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: filler }],
			timestamp: Date.now(),
		});
	}

	let outcomeNoticeSeen = false;
	session.subscribe((event) => {
		if (event.type === "tool_result" && JSON.stringify(event.result?.content ?? []).includes("Compaction completed successfully")) {
			outcomeNoticeSeen = true;
		}
	});

	await session.prompt("Please compact the session now.");

	// The run must have terminated without another model response, compaction
	// dispatched at agent_settled, and the CompactionEntry actually appended.
	const settled = await waitUntil(() =>
		session.sessionManager.getEntries().some((e) => e.type === "compaction"),
	);
	if (!settled) {
		console.log("entries at failure:", session.sessionManager.getEntries().map((e) => e.type).join(","));
		console.log("faux callCount:", faux.state.callCount, "pending:", faux.getPendingResponseCount());
	}
	assert.ok(settled, "a real CompactionEntry was appended after the accepted request");
	const entry = session.sessionManager.getEntries().find((e) => e.type === "compaction");
	assert.equal(entry.summary, "deterministic lifecycle summary", "extension-provided deterministic compaction ran (no LLM call)");
	// The faux provider consumed exactly one response: the run did not continue
	// past the terminating compact call.
	assert.equal(faux.getPendingResponseCount(), 0);
	assert.ok(faux.state.callCount >= 1);
});

test("real session: compact batched with a sibling is rejected and the sibling still runs", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "cc-lifecycle-"));
	t.after(async () => { await rm(dir, { recursive: true, force: true }); });
	await copyFile(new URL("../../extensions/context-controls.ts", import.meta.url), join(dir, "context-controls.ts"));
	delete process.env.PI_SUBAGENT_CHILD;

	const faux = fauxProvider({
		models: [{ id: "faux-lifecycle-2", contextWindow: 200_000, maxTokens: 4_000 }],
	});
	faux.setResponses([
		// Batch: compact + sibling. compact must be rejected; sibling must run.
		fauxAssistantMessage([
			fauxToolCall("compact", {}),
			fauxToolCall("sibling", {}),
		]),
		fauxAssistantMessage("Batch handled; compaction was correctly refused."),
	]);

	const { sessionPromise, observed } = makeSession(t, join(dir, "context-controls.ts"), 1, faux);
	const { session } = await sessionPromise;
	t.after(() => session.dispose());
	for (const filler of ["Old filler context. ".repeat(60_000), "Recent filler context. ".repeat(60_000)]) {
		session.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: filler }],
			timestamp: Date.now(),
		});
	}

	await session.prompt("Do a thing and also compact.");

	assert.equal(observed.siblingExecuted, 1, "sibling tool executed normally");
	// Give a (wrong) async dispatch no chance to happen.
	await new Promise((r) => setTimeout(r, 100));
	const compactionEntries = session.sessionManager.getEntries().filter((e) => e.type === "compaction");
	assert.equal(compactionEntries.length, 0, "rejected request never dispatches native compaction");
});
