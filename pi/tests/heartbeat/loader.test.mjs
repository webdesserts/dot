/**
 * Real-loader test for the goal-heartbeat extension
 * (pi/extensions/notifications.ts).
 *
 * Unlike supervisor.test.mjs (a VM sandbox with stubbed imports), this test
 * loads the ACTUAL TypeScript source through jiti — the same transpiler pi
 * uses for extensions — with the REAL typebox and @earendil-works/pi-ai
 * packages, resolved via the node_modules symlink into pi's installed
 * runtime. It proves the extension transpiles, registers a valid
 * model-callable tool and human command, and that the TypeBox schema itself
 * carries the settled contract (action enum incl. hold/complete, no retired
 * wakeBudget, bounded integers).
 *
 * Run: node --test tests/heartbeat/loader.test.mjs   (from the repo root)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);

test("extension transpiles via the real Pi loader (jiti) and registers the control surface", async () => {
	const { default: setup } = await jiti.import("../../extensions/notifications.ts");

	// This test process may itself run under pi-subagents
	// (PI_SUBAGENT_CHILD=1), which the supervisor must — and does — refuse.
	// Clear it here to simulate a parent session; child-exclusion behavior is
	// covered in supervisor.test.mjs.
	const savedChildEnv = process.env.PI_SUBAGENT_CHILD;
	delete process.env.PI_SUBAGENT_CHILD;

	const handlers = new Map();
	let toolDef = null;
	const commands = new Map();
	const appended = [];
	const pi = {
		on: (name, fn) => handlers.set(name, fn),
		sendUserMessage: () => {},
		registerTool: (def) => (toolDef = def),
		registerCommand: (name, opts) => commands.set(name, opts),
		appendEntry: (customType, data) => appended.push({ customType, data }),
	};
	setup(pi);
	if (savedChildEnv !== undefined) process.env.PI_SUBAGENT_CHILD = savedChildEnv;

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
		idleDelaySeconds: 30,
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
