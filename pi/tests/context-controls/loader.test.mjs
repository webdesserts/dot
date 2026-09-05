/**
 * Real-loader test for the context-controls extension
 * (pi/extensions/context-controls.ts).
 *
 * Like tests/heartbeat/loader.test.mjs, this copies the source into a
 * dependency-free temporary directory and loads it through Pi's
 * loadExtensions API with its real package aliases (no node_modules symlinks
 * in git; PI_SDK_ROOT overrides the installed SDK root). It proves the
 * extension transpiles, registers the usage/compact tools with the settled
 * schemas, that usage() reports truthfully through the real execute path,
 * that compact() only accepts a sole call and carries terminate:true, that
 * batched calls are rejected, and that alerts are delivered through the real
 * before_agent_start handler without sendUserMessage.
 *
 * Run: node --test pi/tests/context-controls/loader.test.mjs  (repo root)
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
const { loadExtensions } = await import(pathToFileURL(join(sdkRoot, "dist/core/extensions/loader.js")).href);

async function isolatedExtension(t) {
	const dir = await mkdtemp(join(tmpdir(), "context-controls-loader-"));
	t.after(async () => {
		await rm(dir, { recursive: true, force: true });
	});
	await copyFile(new URL("../../extensions/context-controls.ts", import.meta.url), join(dir, "context-controls.ts"));
	delete process.env.PI_SUBAGENT_CHILD;
	const loaded = await loadExtensions([join(dir, "context-controls.ts")], dir);
	assert.deepEqual(loaded.errors, []);
	assert.equal(loaded.extensions.length, 1);
	return loaded;
}

// Synthetic extension context: deterministic usage, no native compaction call.
function fakeCtx(state) {
	return {
		getContextUsage: () => state.usage,
		isIdle: () => true,
		model: { id: "loader-test-model" },
		sessionManager: { getSessionId: () => "loader-session", getEntries: () => state.entries ?? [] },
		compact: (options) => {
			state.compactCalls.push(options);
			if (state.compactImpl) state.compactImpl(options);
		},
	};
}

test("Pi loads the dependency-free extension with usage/compact tools", async (t) => {
	const loaded = await isolatedExtension(t);
	const extension = loaded.extensions[0];
	const toolDef = extension.tools.get("usage")?.definition;
	const compactDef = extension.tools.get("compact")?.definition;
	assert.ok(toolDef, "usage tool registered");
	assert.ok(compactDef, "compact tool registered");
	assert.ok(extension.handlers.has("turn_end"), "alert evaluation handler registered");
	assert.ok(extension.handlers.has("agent_settled"), "dispatch handler registered");
	assert.ok(extension.handlers.has("session_compact"), "native compaction handler registered");
	// Stock no-turn delivery only: no tool-result mutation, no
	// before_agent_start fallback.
	assert.equal(extension.handlers.get("tool_result"), undefined, "tool results are never mutated");
	assert.equal(extension.handlers.get("before_agent_start"), undefined, "no fallback delivery channel");

	// TypeBox schemas: no stale/extra parameters.
	assert.deepEqual(toolDef.parameters.properties, {}, "usage takes no parameters");
	assert.equal(toolDef.parameters.additionalProperties, false);
	assert.deepEqual(Object.keys(compactDef.parameters.properties), ["summaryFocus"]);
	assert.equal(compactDef.parameters.additionalProperties, false);

	const state = { usage: undefined, compactCalls: [], compactImpl: null, entries: [] };
	const ctx = fakeCtx(state);

	// usage(): unavailable, then unknown (post-compaction), then concrete.
	let report = await toolDef.execute("id", {}, undefined, undefined, ctx);
	assert.match(report.content[0].text, /unavailable/);
	state.usage = { tokens: null, contextWindow: 200_000, percent: null };
	report = await toolDef.execute("id", {}, undefined, undefined, ctx);
	assert.match(report.content[0].text, /unknown/);
	assert.match(report.content[0].text, /not zero/);
	state.usage = { tokens: 100_000, contextWindow: 200_000, percent: 50 };
	report = await toolDef.execute("id", {}, undefined, undefined, ctx);
	assert.match(report.content[0].text, /50%/);
	state.usage = { tokens: 100_000, contextWindow: 200_000, percent: 50 };
	report = await toolDef.execute("id", {}, undefined, undefined, ctx);
	assert.match(report.content[0].text, /100k tokens of a 200k-token window \(50%\)/);

	// compact(): an accepted sole call returns terminate:true and dispatches
	// only at agent_settled — through the real loaded extension.
	const accepted = await compactDef.execute("call-1", {}, undefined, undefined, ctx);
	assert.equal(accepted.details.accepted, true);
	assert.equal(accepted.terminate, true);
	assert.equal(state.compactCalls.length, 0, "no inline native compaction");
	extension.handlers.get("agent_settled")[0]({}, ctx);
	assert.equal(state.compactCalls.length, 1, "dispatched at agent_settled");
	const dup = await compactDef.execute("call-2", {}, undefined, undefined, ctx);
	assert.equal(dup.details.duplicate, true, "in-flight duplicate refused");

	// A batched compact call is rejected through the real execute path (the
	// first request's in-flight guard is resolved first via its terminal
	// callback, mirroring a completed compaction).
	state.compactCalls[0].onComplete({ tokensBefore: 100_000, estimatedTokensAfter: 10_000 });
	extension.handlers.get("message_end")[0]({
		message: { role: "assistant", content: [{ type: "toolCall", id: "a", name: "compact" }, { type: "toolCall", id: "b", name: "bash" }] },
	}, ctx);
	const rejected = await compactDef.execute("a", {}, undefined, undefined, ctx);
	assert.equal(rejected.details.rejected, "siblings");
	assert.equal(rejected.terminate, undefined);

	// Alerts: real turn_end evaluation; delivery is stock pi.sendMessage
	// with triggerTurn:false (the SDK flushes it into the immediately next
	// model request). The extension never calls sendUserMessage (which would
	// wake the model) and never mutates tool results.
	const sent = [];
	const piProbe = { sendUserMessage: (...a) => sent.push(a) };
	state.usage = { tokens: 50_000, contextWindow: 200_000, percent: 25 };
	extension.handlers.get("turn_end")[0]({}, ctx);
	state.usage = { tokens: 170_000, contextWindow: 200_000, percent: 85 };
	extension.handlers.get("turn_end")[0]({}, ctx);
	assert.equal(sent.length, 0, "no wake message, no extra LLM turn");
});
