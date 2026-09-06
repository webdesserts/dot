/**
 * Behavioral tests for the opt-in SSE presentation worker
 * (pi/extensions/notifications.worker.mjs in AUTONOMY_SSE_MODE=1).
 *
 * Each test spawns the real worker as a child process pointed at a local
 * fake daemon that speaks the actual t276 wire protocol: GET /whoami,
 * POST /notifications/lease/{status,claim}, POST
 * /notifications/presentation/stream (SSE over chunked writes) and POST
 * /notifications/presentation/acknowledge. No live daemon, no real
 * credentials. Bounded cadences come from env, never TEST_CADENCE.
 *
 * Run: node --test pi/tests/notifications-sse/worker.test.mjs
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import assert from "node:assert/strict";
import { test } from "node:test";
import crypto from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CUSTOM_TYPE, METADATA_SCHEMA_VERSION } from "../../extensions/notifications.sse.protocol.mjs";

const WORKER_PATH = new URL("../../extensions/notifications.worker.mjs", import.meta.url).pathname;
const sha256Hex = (text) => crypto.createHash("sha256").update(text, "utf8").digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const EXPECTED_ACTOR_ID = "6f1c2a34-0000-4000-8000-000000000001";
const ACTOR = "rhea";
const SCOPE = "test-backend-scope";

/**
 * The fake daemon. Every request is recorded ({method, url, headers, body}).
 * `onStream(req, res, connectionIndex)` lets a test script each SSE
 * connection; by default the connection just stays open.
 */
function makeFakeServer({ onStream } = {}) {
	const requests = [];
	let streamConnections = 0;
	const acks = [];
	const server = createServer((req, res) => {
		let raw = "";
		req.on("data", (c) => (raw += c));
		req.on("end", () => {
			const record = { method: req.method, url: req.url, headers: req.headers, body: raw };
			requests.push(record);
			const respond = (status, payload) => {
				res.writeHead(status, { "content-type": "application/json" });
				res.end(JSON.stringify(payload));
			};
			if (req.url === "/whoami" && req.method === "GET") {
				respond(200, { user: ACTOR, actor_id: EXPECTED_ACTOR_ID });
			} else if (req.url === "/notifications/lease/status") {
				respond(200, { epoch: 0, owner: null });
			} else if (req.url === "/notifications/lease/claim") {
				const body = JSON.parse(raw);
				respond(200, {
					outcome: "granted",
					epoch: 1,
					runtime_id: body.runtime_id,
					grant_secret: "ab".repeat(32),
					deadline_remaining_ms: 30_000,
				});
			} else if (req.url === "/notifications/presentation/stream" && req.method === "POST") {
				streamConnections += 1;
				res.writeHead(200, { "content-type": "text/event-stream" });
				if (onStream) onStream(record, res, streamConnections);
				else res.end();
			} else if (req.url === "/notifications/presentation/acknowledge") {
				acks.push(JSON.parse(raw));
				respond(200, { outcome: "acknowledged" });
			} else {
				respond(404, { error: "unexpected endpoint" });
			}
		});
	});
	return { server, requests, acks, streamCount: () => streamConnections };
}

async function listen(server) {
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	return server.address().port;
}

function startWorker(port, extraEnv = {}) {
	const child = spawn(process.execPath, [WORKER_PATH], {
		env: {
			...process.env,
			AUTONOMY_SSE_MODE: "1",
			AUTONOMY_BASE: `http://127.0.0.1:${port}`,
			AUTONOMY_ACTOR: ACTOR,
			AUTONOMY_SSE_EXPECTED_ACTOR_ID: EXPECTED_ACTOR_ID,
			AUTONOMY_SSE_SCOPE: SCOPE,
			AUTONOMY_SSE_RENEW_INTERVAL_MS: "60000",
			AUTONOMY_SSE_RECONNECT_BACKOFF_MS: "30",
			AUTONOMY_TOKEN: "test-only-token-not-real",
			AUTONOMY_HEARTBEAT_MS: "0",
			...extraEnv,
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
	const lines = [];
	const stderr = [];
	let buf = "";
	const waiters = [];
	const consider = (line) => {
		lines.push(line);
		for (let i = waiters.length - 1; i >= 0; i--) {
			const w = waiters[i];
			if (w.match(line)) {
				waiters.splice(i, 1);
				clearTimeout(w.timer);
				w.resolve(line);
			}
		}
	};
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (c) => {
		buf += c;
		let i;
		while ((i = buf.indexOf("\n")) !== -1) {
			consider(buf.slice(0, i));
			buf = buf.slice(i + 1);
		}
	});
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (c) => stderr.push(c));
	const waitFor = (match, label, timeoutMs = 5000) =>
		new Promise((resolve, reject) => {
			const existing = lines.find(match);
			if (existing) return resolve(existing);
			const w = { match, resolve, timer: null };
			w.timer = setTimeout(() => {
				const idx = waiters.indexOf(w);
				if (idx !== -1) waiters.splice(idx, 1);
				reject(new Error(`timed out waiting for ${label}; lines so far: ${lines.join(" | ").slice(0, 2000)}; stderr: ${stderr.join("").slice(0, 1000)}`));
			}, timeoutMs);
			waiters.push(w);
		});
	const send = (obj) => child.stdin.write(`${JSON.stringify(obj)}\n`);
	return { child, lines, stderr, waitFor, send };
}

const writeSessionFile = (body, presentationId) => {
	const dir = mkdtempSync(join(tmpdir(), "sse-worker-session-"));
	const file = join(dir, "session.jsonl");
	const details = {
		schema: METADATA_SCHEMA_VERSION,
		scope: SCOPE,
		recipient: ACTOR,
		actorId: EXPECTED_ACTOR_ID,
		sessionId: "sess-1",
		presentationId,
		renderVersion: 1,
		digest: sha256Hex(body),
		contentOfferId: null,
		summaryOfferId: null,
	};
	writeFileSync(
		file,
		[
			JSON.stringify({ type: "session", id: "sess-1", version: 1 }),
			JSON.stringify({ type: "custom_message", id: "m1", customType: CUSTOM_TYPE, content: body, display: true, details }),
		].join("\n") + "\n",
	);
	return file;
};

const presentationEvent = (res, offer) => {
	res.write(`event: presentation\nid: ${offer.presentation_id}\ndata: ${JSON.stringify(offer)}\n\n`);
};

const OFFER = {
	presentation_id: 7,
	content_offer_id: null,
	summary_offer_id: null,
	body: "the exact server-rendered body",
	render_version: 1,
	get digest() {
		return sha256Hex(this.body);
	},
};

// ── the full stream → custom message → disk receipt → ack path ──────────

test("SSE worker: identity, claim-before-stream, delivery, reconciliation, ack", async (t) => {
	let streamRes = null;
	const fake = makeFakeServer({
		onStream: (req, res) => {
			streamRes = res;
			presentationEvent(res, OFFER);
		},
	});
	const port = await listen(fake.server);
	const w = startWorker(port);
	t.after(() => {
		w.child.kill();
		fake.server.close();
		fake.server.closeAllConnections?.();
	});

	// Claim happens BEFORE the stream opens, with takeover:false.
	const deliverLine = await w.waitFor((l) => l.includes('"kind":"deliver"'), "deliver message");
	const deliver = JSON.parse(deliverLine);
	assert.equal(deliver.kind, "deliver");
	assert.equal(deliver.message.customType, CUSTOM_TYPE);
	assert.equal(deliver.message.content, OFFER.body, "the body must be the EXACT server body");
	assert.equal(deliver.message.display, true);
	assert.equal(deliver.message.details.presentationId, 7);
	assert.equal(deliver.message.details.renderVersion, 1);
	assert.equal(deliver.message.details.digest, sha256Hex(OFFER.body));
	assert.equal(deliver.message.details.scope, SCOPE);
	assert.equal(deliver.message.details.recipient, ACTOR);
	assert.equal(deliver.message.details.actorId, EXPECTED_ACTOR_ID, "the stable actor id is bound");
	assert.equal(deliver.message.details.contentOfferId, null);
	assert.equal(deliver.message.details.summaryOfferId, null);

	const whoami = fake.requests.find((r) => r.url === "/whoami");
	assert.equal(whoami.headers["x-auth-user"], ACTOR);
	assert.equal(whoami.headers.authorization, "Bearer test-only-token-not-real");
	const claimRec = fake.requests.find((r) => r.url === "/notifications/lease/claim");
	assert.ok(claimRec, "claim must happen before the stream");
	const claimBody = JSON.parse(claimRec.body);
	assert.equal(claimBody.takeover, false, "never automatic takeover");
	assert.equal(claimBody.expected_epoch, 0);
	assert.ok(/notifications-pi-/.test(claimBody.runtime_id));
	const streamReq = fake.requests.find((r) => r.url === "/notifications/presentation/stream");
	assert.ok(claimRec, "stream opened");
	const streamBody = JSON.parse(streamReq.body);
	assert.deepEqual(Object.keys(streamBody).sort(), ["epoch", "grant_secret", "runtime_id"]);
	assert.equal(streamBody.runtime_id, claimBody.runtime_id);
	assert.ok(!("last-event-id" in streamReq.headers), "Last-Event-ID is never sent");

	// Simulate the supervisor's SDK delivery: qualifying disk bytes exist.
	const sessionFile = writeSessionFile(OFFER.body, 7);
	w.send({ event: "session", sessionId: "sess-1", sessionFile });
	w.send({ event: "reconcile" });

	await w.waitFor((l) => l.includes('"kind":"ack"'), "ack outcome");
	assert.equal(fake.acks.length, 1, "exactly one acknowledge for the qualifying receipt");
	assert.deepEqual(fake.acks[0], { presentation_id: 7, expected_digest: sha256Hex(OFFER.body) });

	streamRes?.end();
});

// ── reconnect with the same outstanding offer, no Last-Event-ID ─────────

test("SSE worker: EOF reconnects under valid ownership and replays the outstanding offer", async (t) => {
	const fake = makeFakeServer({
		onStream: (req, res) => {
			presentationEvent(res, OFFER);
			res.end(); // server closes: replay-on-reconnect is the durable path
		},
	});
	const port = await listen(fake.server);
	const w = startWorker(port);
	t.after(() => {
		w.child.kill();
		fake.server.close();
		fake.server.closeAllConnections?.();
	});

	// First delivery from connection 1.
	await w.waitFor((l) => l.includes('"kind":"deliver"'), "first deliver");
	// Reconnect happens with bounded backoff and the SAME outstanding offer replays.
	await w.waitFor((l) => l.includes('"kind":"deliver"') && w.lines.filter((x) => x.includes('"kind":"deliver"')).length >= 2, "second deliver", 8000);
	assert.ok(fake.streamCount() >= 2, "the stream was reopened");

	const streamReqs = fake.requests.filter((r) => r.url === "/notifications/presentation/stream");
	for (const r of streamReqs) {
		assert.ok(!("last-event-id" in r.headers), "Last-Event-ID is never an authority");
	}
	// Reconnect reused the SAME proof (valid ownership — no new claim needed).
	const claims = fake.requests.filter((r) => r.url === "/notifications/lease/claim");
	assert.equal(claims.length, 1, "no second claim while ownership is still valid");
	const statuses = fake.requests.filter((r) => r.url === "/notifications/lease/status");
	assert.equal(statuses.length, 1, "no status polling between reconnects");
});

// ── malformed-frame refusal ──────────────────────────────────────────────

test("SSE worker: a malformed presentation frame is refused with no delivery and no ack", async (t) => {
	let sentMalformed = false;
	const fake = makeFakeServer({
		onStream: (req, res) => {
			if (!sentMalformed) {
				sentMalformed = true;
				res.write("event: presentation\ndata: this is not json at all\n\n");
			}
			presentationEvent(res, { ...OFFER, presentation_id: 9, digest: sha256Hex(OFFER.body) });
		},
	});
	const port = await listen(fake.server);
	const w = startWorker(port);
	t.after(() => {
		w.child.kill();
		fake.server.close();
		fake.server.closeAllConnections?.();
	});

	// Only the VALID offer (id 9) is ever delivered.
	await w.waitFor((l) => l.includes('"kind":"deliver"'), "valid deliver");
	await sleep(150);
	const delivers = w.lines.filter((l) => l.includes('"kind":"deliver"')).map((l) => JSON.parse(l));
	assert.equal(delivers.length, 1);
	assert.equal(delivers[0].message.details.presentationId, 9);
	assert.ok(w.lines.some((l) => l.includes("[notifications.sse]") && l.includes("refused")), "a visible static refusal was emitted");
	// No reconcile ran, so nothing was acked — the malformed frame authorizes nothing.
	assert.equal(fake.acks.length, 0);
});

// ── identity prerequisite gate ───────────────────────────────────────────

test("SSE worker: an actor_id mismatch is a visible prerequisite failure with no claim and no legacy fallback", async (t) => {
	const fake = makeFakeServer({});
	const port = await listen(fake.server);
	const w = startWorker(port, { AUTONOMY_SSE_EXPECTED_ACTOR_ID: "someone-else-entirely" });
	t.after(() => {
		w.child.kill();
		fake.server.close();
		fake.server.closeAllConnections?.();
	});

	const line = await w.waitFor((l) => l.includes("[notifications.sse]") && l.toLowerCase().includes("identity"), "identity failure");
	assert.ok(line, "the mismatch is visible");
	// No ownership claim, no stream, and NO legacy long-poll fallback.
	await sleep(200);
	assert.equal(fake.requests.filter((r) => r.url === "/notifications/lease/claim").length, 0);
	assert.equal(fake.requests.filter((r) => r.url.startsWith("/notifications?timeout")).length, 0);
});

// ── missing config: visible failure, no legacy fallback, heartbeat armed ──

test("SSE worker: missing config is a visible prerequisite failure and never falls back to legacy polling", async (t) => {
	const fake = makeFakeServer({});
	const port = await listen(fake.server);
	const w = startWorker(port, { AUTONOMY_SSE_EXPECTED_ACTOR_ID: "" });
	t.after(() => {
		w.child.kill();
		fake.server.close();
		fake.server.closeAllConnections?.();
	});

	const line = await w.waitFor((l) => l.includes("PREREQUISITE FAILURE"), "prerequisite failure");
	assert.match(line, /renewal interval|actor id|scope|origin|credentials/);
	await sleep(200);
	// Nothing at all was consumed: no SSE lease/stream activity AND no
	// legacy /notifications?timeout= long-poll.
	assert.equal(fake.requests.length, 0, "no consumption of any kind after a config refusal");
});
