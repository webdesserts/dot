import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sdk, faux as fauxModule } from "../context-controls/sdk.mjs";

export const { fauxAssistantMessage, fauxToolCall } = fauxModule;
export const GOAL = "## Goal\nResume ACTIVE_GOAL; obey ACTIVE_CONSTRAINT; useful pointer src/current.ts.";
export const LITERAL = "User code example:\n```xml\n<read-files>\nUSER_LITERAL\n</read-files>\n```";
export const inventory = (readFiles, modifiedFiles = []) => [
	readFiles.length ? `<read-files>\n${readFiles.join("\n")}\n</read-files>` : "",
	modifiedFiles.length ? `<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>` : "",
].filter(Boolean).map((part) => `\n\n${part}`).join("");
export function answer(text = GOAL) {
	const message = fauxAssistantMessage(text);
	message.usage = { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	return message;
}

export async function fixture(t, { seed = true, settings = {}, extensionFactories = [] } = {}) {
	const dir = await mkdtemp(join(tmpdir(), "retention-sdk-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const manager = sdk.SessionManager.inMemory(dir);
	const settingsManager = sdk.SettingsManager.inMemory({
		compaction: { enabled: false, keepRecentTokens: 200, reserveTokens: 1_000 },
		retry: { enabled: true, maxRetries: 1, baseDelayMs: 0, maxAgentDelayMs: 0 }, ...settings,
	});
	let legacy;
	if (seed) {
		const kept = manager.appendMessage({ role: "user", content: [{ type: "text", text: `${LITERAL}\n${"history ".repeat(500)}` }], timestamp: Date.now() });
		manager.appendMessage({ role: "user", content: [{ type: "text", text: "recent ".repeat(500) }], timestamp: Date.now() });
		const readFiles = Array.from({ length: 1_500 }, (_, i) => `LEGACY_INVENTORY/file-${String(i).padStart(5, "0")}.ts`);
		const modifiedFiles = ["LEGACY_MODIFIED.ts"];
		manager.appendCompaction(GOAL + inventory(readFiles, modifiedFiles), kept, 30_000, { readFiles, modifiedFiles }, false);
		legacy = structuredClone(manager.getBranch().at(-1));
	}
	const faux = fauxModule.fauxProvider({ models: [{ id: "retention-owned", contextWindow: 200_000, maxTokens: 4_000 }] });
	const extension = dirname(fileURLToPath(new URL("../../extensions/context-retention/index.ts", import.meta.url)));
	const loader = new sdk.DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager,
		additionalExtensionPaths: [extension], extensionFactories,
		noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	assert.deepEqual(loader.getExtensions().extensions.map((entry) => entry.path).filter((path) => !path.startsWith("<")), [extension], "only the selected retention source and explicit inline fixtures load");
	const runtime = await sdk.ModelRuntime.create({ agentDir: dir, refreshOnCreate: false, modelNetworkEnabled: false });
	// Native and compatibility registrations replace one another. Keep the
	// in-process native stream intact and resolve only owned synthetic auth.
	runtime.registerNativeProvider({ ...faux.provider, auth: { apiKey: {
		name: "Owned fixture",
		check: async () => ({ type: "api_key", source: "owned fixture" }),
		resolve: async ({ signal }) => {
			signal.throwIfAborted();
			return { auth: { apiKey: "owned-fixture-not-a-secret", headers: { "x-retention-fixture": "owned" } },
				env: { RETENTION_FIXTURE: "owned" }, source: "owned fixture" };
		},
	} } });
	const { session } = await sdk.createAgentSession({ cwd: dir, agentDir: dir, model: faux.getModel(), modelRuntime: runtime,
		resourceLoader: loader, sessionManager: manager, settingsManager, tools: [], thinkingLevel: "off" });
	t.after(() => session.dispose());
	await session.bindExtensions({});
	return { session, manager, settingsManager, faux, legacy, loader, dir };
}
