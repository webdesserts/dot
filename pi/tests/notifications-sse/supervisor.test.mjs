/**
 * Behavioral tests for the SSE supervisor half of notifications.ts —
 * delivery through pi.sendMessage with the exact server body, the
 * transient one-outstanding guard, and the session/reconcile wiring that
 * actually drives worker receipt reconciliation.
 *
 * Runs the TypeScript source in a VM sandbox with a fake pi double (same
 * harness shape as tests/heartbeat/supervisor.test.mjs). Most tests fabricate
 * the worker's lines; ONE integration-shaped check spawns the REAL worker and
 * routes its actual stdout lines through the supervisor's stdout handler to
 * prove the stdio contract end-to-end (loopback fake daemon only, no live
 * APIs/credentials/daemon; cleanup registered immediately, bounded waits).
 *
 * Run: node --test pi/tests/notifications-sse/supervisor.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import crypto from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function fixture(env = {}) {
	const handlers = new Map();
	const children = [];
	const writes = [];
	const sentMessages = [];
	const sentUser = [];
	class FakeDate extends Date {}
	FakeDate.now = () => 1_700_000_000_000;
	const tool = { def: null };
	const commands = new Map();
	const pi = {
		on: (name, fn) => handlers.set(name, fn),
		sendUserMessage: (message, options) => sentUser.push({ message, options }),
		sendMessage: (message, options) => sentMessages.push({ message, options }),
		registerTool: (def) => {
			tool.def = def;
		},
		registerCommand: (name, opts) => commands.set(name, opts),
		appendEntry: () => {},
	};
	const source = fs
		.readFileSync(new URL("../../extensions/notifications.ts", import.meta.url), "utf8")
		.replace(/^import .*;\n/gm, "")
		.replace(/ as const/g, "")
		.replace('fileURLToPath(import.meta.url)', '"/fixture/notifications.ts"')
		.replace("export default function (pi)", "function setup(pi)");
	vm.runInNewContext(`${source}\nsetup(pi);`, {
		pi,
		process: { env, execPath: "/fake/node" },
		path,
		realpathSync: (value) => value,
		console: { error() {} },
		Date: FakeDate,
		Type: { Object: (v) => v, String: (v) => v, Integer: (v) => v, Optional: (v) => v },
		StringEnum: (v) => v,
		setTimeout: () => 0,
		clearTimeout: () => {},
		spawn: () => {
			const child = new EventEmitter();
			child.stdout = new EventEmitter();
			child.stderr = new EventEmitter();
			child.stdin = { writable: true, write(s) { writes.push({ child, s }); } };
			child.killed = false;
			child.kill = () => {
				child.killed = true;
			};
			children.push(child);
			return child;
		},
	});
	const stdinLines = (child = children.at(-1)) =>
		writes
			.filter((w) => w.child === child)
			.map((w) => w.s)
			.join("")
			.split("\n")
			.filter(Boolean)
			.map(JSON.parse);
	const workerLine = (obj, child = children.at(-1)) =>
		child.stdout.emit("data", `${JSON.stringify(obj)}\n`);
	const SESSION_ID = "sess-1";
	const sessionCtx = () => ({
		isIdle: () => true,
		sessionManager: { getSessionId: () => SESSION_ID, getSessionFile: () => "/tmp/sess-1.jsonl", getEntries: () => [] },
	});
	return { handlers, children, writes, sentMessages, sentUser, stdinLines, workerLine, SESSION_ID, sessionCtx, tool, event: (name, arg, ctx) => handlers.get(name)?.(arg, ctx) };
}

// The REAL worker stdout shape: the generic emitter nests every payload
// under `message` — there is NO top-level presentationId/outcome.
const DELIVER = (presentationId = 7) => ({
	kind: "deliver",
	message: {
		customType: "autonomy-notification-presentation",
		content: "the exact server body",
		display: true,
		details: {
			schema: 1,
			scope: "scope-1",
			recipient: "rhea",
			actorId: "uuid-1",
			renderVersion: 1,
			digest: "ab".repeat(32),
			presentationId,
			contentOfferId: null,
			summaryOfferId: null,
		},
	},
});

test("deliver is sent through pi.sendMessage custom message, steer + triggerTurn, never gated on isIdle", () => {
	const f = fixture();
	f.event("session_start", { reason: "startup" }, f.sessionCtx());
	f.workerLine(DELIVER(7));

	assert.equal(f.sentMessages.length, 1);
	const { message, options } = f.sentMessages[0];
	assert.equal(message.customType, "autonomy-notification-presentation");
	assert.equal(message.content, "the exact server body", "the body is never rerendered");
	assert.equal(message.display, true);
	assert.equal(message.details.sessionId, f.SESSION_ID, "the supervisor binds the current session id");
	assert.equal(message.details.presentationId, 7);
	assert.equal(options.deliverAs, "steer");
	assert.equal(options.triggerTurn, true);
	// sendUserMessage is NEVER used as the delivery/receipt path.
	assert.equal(f.sentUser.length, 0);
});

test("the transient one-outstanding guard suppresses an un-acked duplicate and releases after the ack outcome", () => {
	const f = fixture();
	f.event("session_start", { reason: "startup" }, f.sessionCtx());
	f.workerLine(DELIVER(7));
	f.workerLine(DELIVER(7));
	assert.equal(f.sentMessages.length, 1, "the duplicate outstanding id is not re-enqueued");

	f.workerLine({ kind: "ack", message: { presentationId: 7, outcome: "acknowledged" } });
	f.workerLine(DELIVER(7));
	assert.equal(f.sentMessages.length, 2, "after the ack outcome the id can be delivered again");

	// 'refused' is NOT a validated outcome: the guard stays.
	f.workerLine({ kind: "ack", message: { presentationId: 7, outcome: "refused" } });
	f.workerLine(DELIVER(7));
	assert.equal(f.sentMessages.length, 2, "a refused ack never releases the guard");
});

test("deliver without a current session id is refused rather than delivered unacknowledgeable", () => {
	const f = fixture();
	f.event("session_start", { reason: "startup" }, { isIdle: () => true, sessionManager: { getSessionId: () => null, getEntries: () => [] } });
	f.workerLine(DELIVER(7));
	assert.equal(f.sentMessages.length, 0);
});

test("session identity and startup reconciliation are actually wired to the worker", () => {
	const f = fixture();
	f.event("session_start", { reason: "startup" }, f.sessionCtx());
	const lines = f.stdinLines();
	assert.ok(lines.some((l) => l.event === "session" && l.sessionId === f.SESSION_ID && l.sessionFile === "/tmp/sess-1.jsonl"), "session_start binds the session identity");
	assert.ok(lines.some((l) => l.event === "reconcile"), "session_start requests startup reconciliation");
});

test("agent_settled forwards reconciliation against the bound session", () => {
	const f = fixture();
	f.event("session_start", { reason: "startup" }, f.sessionCtx());
	const before = f.stdinLines().filter((l) => l.event === "reconcile").length;
	f.event("agent_settled", {}, f.sessionCtx());
	const after = f.stdinLines().filter((l) => l.event === "reconcile").length;
	assert.equal(after, before + 1, "agent_settled forwards a reconcile event");
});

test("heartbeat delivery is untouched by SSE handling (generation fencing still applies)", () => {
	const f = fixture();
	f.event("session_start", { reason: "startup" }, f.sessionCtx());
	// heartbeat kind still routes through the heartbeat path: a stale
	// generation is rejected, a current one delivered via sendUserMessage.
	f.workerLine({ kind: "heartbeat", message: "beat", generation: 99 });
	assert.equal(f.sentUser.length, 0, "stale generation dropped");
	f.workerLine({ kind: "heartbeat", message: "beat", generation: 0 });
	assert.equal(f.sentUser.length, 1, "current-generation heartbeat delivers as before");
});

// ── the ONE integration-shaped check: REAL worker stdout → supervisor handler ──

const sha256Hex = (text) => crypto.createHash("sha256").update(text, "utf8").digest("hex");

/**
 * Spawn the actual worker (default SSE mode) against a loopback fake daemon,
 * and feed its RAW stdout lines through the supervisor VM's stdout handler —
 * the exact seam the fabricated-peer tests cannot cover. Cleanup is
 * registered IMMEDIATELY after spawn; every wait is hard-bounded so the
 * test can never hang.
 */
test("integration: real worker stdout through the supervisor handler — exact-body sendMessage and real-ack guard release", async (t) => {
	const BODY = "the exact integration body";
	const fake = createServer((req, res) => {
		let raw = "";
		req.on("data", (c) => (raw += c));
		req.on("end", () => {
			const respond = (status, payload) => {
				res.writeHead(status, { "content-type": "application/json" });
				res.end(JSON.stringify(payload));
			};
			if (req.url === "/whoami") respond(200, { user: "rhea", actor_id: "6f1c2a34-0000-4000-8000-0000000000a1" });
			else if (req.url === "/notifications/lease/status") respond(200, { epoch: 0, owner: null });
			else if (req.url === "/notifications/lease/claim") {
				const body = JSON.parse(raw);
				respond(200, { outcome: "granted", epoch: 1, runtime_id: body.runtime_id, grant_secret: "ab".repeat(32), deadline_remaining_ms: 30_000 });
			} else if (req.url === "/notifications/presentation/stream") {
				res.writeHead(200, { "content-type": "text/event-stream" });
				res.write(`event: presentation\nid: 7\ndata: ${JSON.stringify({ presentation_id: 7, content_offer_id: null, summary_offer_id: null, body: BODY, render_version: 1, digest: sha256Hex(BODY) })}\n\n`);
				// connection stays open; test lifetime is bounded by the child kill
			} else if (req.url === "/notifications/presentation/acknowledge") {
				respond(200, { outcome: "acknowledged" });
			} else respond(404, { error: "unexpected" });
		});
	});
	await new Promise((r) => fake.listen(0, "127.0.0.1", r));

	const f = fixture();
	f.event("session_start", { reason: "startup" }, f.sessionCtx());
	const supervisorChild = f.children[0];

	const child = spawn(process.execPath, [new URL("../../extensions/notifications.worker.mjs", import.meta.url).pathname], {
		env: {
			...process.env,
			AUTONOMY_SSE_MODE: undefined,
			AUTONOMY_SESSION_COOKIE_FILE: "",
			AUTONOMY_SSE_EXPECTED_ACTOR_ID: "",
			AUTONOMY_SSE_RENEW_INTERVAL_MS: "",
			// Default-SSE mode with the explicit scope override; identity is
			// resolved from the fake daemon's /whoami (user "rhea", actor_id
			// "6f1c2a34-0000-4000-8000-0000000000a1"), matching the qualifying disk fixture below.
			AUTONOMY_BASE: `http://127.0.0.1:${fake.address().port}`,
			AUTONOMY_SSE_SCOPE: "scope-1",
			AUTONOMY_SSE_RECONNECT_BACKOFF_MS: "30",
			AUTONOMY_TOKEN: "test-only-token-not-real",
			AUTONOMY_HEARTBEAT_MS: "0",
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
	// Cleanup registered IMMEDIATELY: kill the child and close the server.
	t.after(() => {
		child.kill();
		fake.close();
		fake.closeAllConnections?.();
	});

	// Bounded collection of the real worker's stdout lines.
	const realLines = [];
	let buf = "";
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (c) => {
		buf += c;
		let i;
		while ((i = buf.indexOf("\n")) !== -1) {
			realLines.push(buf.slice(0, i));
			buf = buf.slice(i + 1);
		}
	});
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", () => {});
	const waitForLine = (needle, timeoutMs = 8000) =>
		new Promise((resolve, reject) => {
			const existing = realLines.find((l) => l.includes(needle));
			if (existing) return resolve(existing);
			const timer = setTimeout(() => {
				clearInterval(poll);
				reject(new Error(`bounded wait exceeded ${timeoutMs}ms for ${needle}; lines: ${realLines.join(" | ").slice(0, 1500)}`));
			}, timeoutMs);
			const poll = setInterval(() => {
				const found = realLines.find((l) => l.includes(needle));
				if (found) {
					clearTimeout(timer);
					clearInterval(poll);
					resolve(found);
				}
			}, 25);
		});

	// 1. The real deliver line, fed RAW into the supervisor handler.
	const deliverLine = await waitForLine('"kind":"deliver"');
	supervisorChild.stdout.emit("data", `${deliverLine}\n`);
	assert.equal(f.sentMessages.length, 1, "the real nested envelope delivers through pi.sendMessage");
	assert.equal(f.sentMessages[0].message.content, BODY, "the EXACT server body reaches sendMessage");
	assert.equal(f.sentMessages[0].message.details.sessionId, f.SESSION_ID, "the supervisor binds the current session id");
	assert.equal(f.sentMessages[0].message.details.presentationId, 7);

	// 2. Qualifying disk bytes exist for the real worker's reconcile.
	const dir = mkdtempSync(join(tmpdir(), "sse-ipc-fix-"));
	const sessionFile = join(dir, "session.jsonl");
	const details = {
		schema: 1,
		scope: "scope-1",
		recipient: "rhea",
		actorId: "6f1c2a34-0000-4000-8000-0000000000a1",
		sessionId: f.SESSION_ID,
		presentationId: 7,
		renderVersion: 1,
		digest: sha256Hex(BODY),
		contentOfferId: null,
		summaryOfferId: null,
	};
	writeFileSync(
		sessionFile,
		[
			JSON.stringify({ type: "session", id: f.SESSION_ID, version: 1 }),
			JSON.stringify({ type: "custom_message", id: "m1", customType: "autonomy-notification-presentation", content: BODY, display: true, details }),
		].join("\n") + "\n",
	);
	child.stdin.write(`${JSON.stringify({ event: "session", sessionId: f.SESSION_ID, sessionFile })}\n`);
	child.stdin.write(`${JSON.stringify({ event: "reconcile" })}\n`);

	// 3. The REAL ack line, fed RAW into the supervisor handler.
	const ackLine = await waitForLine('"kind":"ack"');
	assert.ok(ackLine.includes('"message":{"presentationId":7'), "the real ack payload is nested under message");
	supervisorChild.stdout.emit("data", `${ackLine}\n`);

	// 4. A reconnect replay of the SAME id (the same real deliver line) now
	// delivers again — proving the REAL acknowledged line released the guard.
	supervisorChild.stdout.emit("data", `${deliverLine}\n`);
	assert.equal(f.sentMessages.length, 2, "the real acknowledged line released the transient guard");
});
