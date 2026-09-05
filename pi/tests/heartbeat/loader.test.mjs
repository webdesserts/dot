/**
 * Real-loader test for the goal-heartbeat extension
 * (pi/extensions/notifications.ts).
 *
 * Unlike supervisor.test.mjs (a VM sandbox with stubbed imports), this test
 * copies the source into a dependency-free temporary directory and loads
 * it through Pi's loadExtensions API, including its real package aliases.
 * Set PI_SDK_ROOT for a non-global installation; otherwise npm root -g
 * locates the installed SDK. It proves the extension transpiles, registers a valid
 * model-callable tool and human command, and that the TypeBox schema itself
 * carries the settled contract (action enum incl. hold/complete, no retired
 * wakeBudget, bounded integers).
 *
 * Run: node --test pi/tests/heartbeat/loader.test.mjs (from the repo root)
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

async function isolatedExtension(t, isChild = false) {
	const dir = await mkdtemp(join(tmpdir(), "goal-heartbeat-loader-"));
	const savedChildEnv = process.env.PI_SUBAGENT_CHILD;
	t.after(async () => {
		if (savedChildEnv === undefined) delete process.env.PI_SUBAGENT_CHILD;
		else process.env.PI_SUBAGENT_CHILD = savedChildEnv;
		await rm(dir, { recursive: true, force: true });
	});
	for (const file of ["notifications.ts", "notifications.worker.mjs"]) {
		await copyFile(new URL(`../../extensions/${file}`, import.meta.url), join(dir, file));
	}
	if (isChild) process.env.PI_SUBAGENT_CHILD = "1";
	else delete process.env.PI_SUBAGENT_CHILD;
	const loaded = await loadExtensions([join(dir, "notifications.ts")], dir);
	assert.deepEqual(loaded.errors, []);
	assert.equal(loaded.extensions.length, 1);
	return loaded;
}

test("Pi loads the dependency-free extension and its control surface", async (t) => {
	const loaded = await isolatedExtension(t);
	const extension = loaded.extensions[0];
	const handlers = extension.handlers;
	const commands = extension.commands;
	const toolDef = extension.tools.get("heartbeat_control")?.definition;
	const appended = [];
	// Exercise controls without session_start: no worker or live HTTP traffic.
	loaded.runtime.appendEntry = (customType, data) => appended.push({ customType, data });

	assert.ok(toolDef, "registerTool called");
	assert.equal(toolDef.name, "heartbeat_control");
	assert.ok(commands.has("hb"), "registerCommand called with /hb");
	assert.ok(handlers.has("session_start"), "lifecycle handlers registered");

	// Real TypeBox schema: action enum includes hold/complete; the retired
	// wakeBudget is gone; integers stay bounded.
	const props = toolDef.parameters.properties;
	assert.deepEqual(props.action.enum, ["enable", "hold", "complete", "pause", "status"]);
	assert.equal(props.wakeBudget, undefined, "retired wake-budget is not in the schema");
	assert.equal(toolDef.parameters.additionalProperties, false, "stale params fail schema validation");
	assert.ok(props.nextAction, "nextAction present");
	assert.equal(props.idleDelaySeconds.minimum, 5);
	assert.equal(props.idleDelaySeconds.maximum, 3600);
	assert.equal(props.holdSeconds.minimum, 1);
	assert.equal(props.holdSeconds.maximum, 3600);

	// The tool executes against the real control state (no worker spawned —
	// session_start never fired — so stdin writes are no-ops).
	const enabled = await toolDef.execute("id", {
		action: "enable",
		nextAction: "finish the acceptance report",
	});
	assert.equal(enabled.details.ok, true);
	assert.equal(enabled.details.state.mode, "goal");
	assert.equal(enabled.details.state.idleDelayMs, 30_000, "default idle delay is 30s");
	assert.match(enabled.content[0].text, /heartbeat goal/);
	assert.deepEqual(appended.map((a) => a.customType), ["heartbeat-control"]);

	// Empty goal is rejected through the real execute path.
	const empty = await toolDef.execute("id", { action: "enable", nextAction: "  " });
	assert.equal(empty.details.ok, false);
	assert.match(empty.details.error, /non-empty nextAction/);

	// An old finite wakeBudget request fails explicitly through the real
	// execute path — it must never silently become an unlimited goal.
	const staleBudget = await toolDef.execute("id", { action: "enable", nextAction: "goal", wakeBudget: 5 });
	assert.equal(staleBudget.details.ok, false);
	assert.match(staleBudget.details.error, /wakeBudget is retired/);

	// Hold derives an absolute deadline from a finite delay.
	const held = await toolDef.execute("id", { action: "hold", holdSeconds: 300 });
	assert.equal(held.details.state.mode, "goal");
	assert.ok(held.details.state.holdUntil > Date.now() + 290_000, "absolute hold deadline ≈ now + 300s");

	// Complete carries the exact handoff prompt in the tool result.
	const done = await toolDef.execute("id", { action: "complete" });
	assert.equal(done.details.state.mode, "ambient");
	assert.match(
		done.content[0].text,
		/Goal complete\. Is there another authorized goal you can work on\? If so, enable it and continue\. Otherwise leave the bounded fallback active, or pause all wakes for a human wait\./,
	);

	// Repeated complete must not renew the ambient window.
	const windowBefore = done.details.state.ambientExpiresAt;
	const again = await toolDef.execute("id", { action: "complete" });
	assert.equal(again.details.state.ambientExpiresAt, windowBefore);

	// Pause, and the human command sharing the same state.
	const paused = await toolDef.execute("id", { action: "pause" });
	assert.equal(paused.details.state.mode, "paused");
	const notes = [];
	await commands.get("hb").handler("status", { ui: { notify: (m) => notes.push(m) } });
	assert.match(notes[0], /paused/);
	await commands.get("hb").handler("enable another authorized goal", { ui: { notify: (m) => notes.push(m) } });
	assert.equal((await toolDef.execute("id", { action: "status" })).details.state.mode, "goal");
});

test("Pi loads a native child without heartbeat tools or lifecycle handlers", async (t) => {
	const loaded = await isolatedExtension(t, true);
	const extension = loaded.extensions[0];
	assert.equal(extension.tools.size, 0);
	assert.equal(extension.commands.size, 0);
	assert.equal(extension.handlers.size, 0);
});
