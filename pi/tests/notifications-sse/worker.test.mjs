/**
 * Behavioral tests for the default-on SSE presentation worker
 * (pi/extensions/notifications.worker.mjs; an explicit
 * AUTONOMY_SSE_MODE=0 opts out into the legacy long-poll).
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
import { mkdtempSync, writeFileSync, readFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CUSTOM_TYPE, METADATA_SCHEMA_VERSION } from "../../extensions/notifications.sse.protocol.mjs";

const WORKER_PATH = new URL("../../extensions/notifications.worker.mjs", import.meta.url).pathname;
const sha256Hex = (text) => crypto.createHash("sha256").update(text, "utf8").digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const EXPECTED_ACTOR_ID = "6f1c2a34-0000-4000-8000-000000000001";
const ACTOR = "rhea";
// Explicit scope-override fixture (the DEFAULT scope is the trusted origin).
const SCOPE = "test-backend-scope";

/**
 * The fake daemon. Every request is recorded ({method, url, headers, body, at}).
 * `onStream(req, res, connectionIndex)` lets a test script each SSE
 * connection; by default the connection just stays open. `whoami` and
 * `claimDeadlineMs` let a test script the identity response and the
 * server's lease budget.
 */
function makeFakeServer({ onStream, whoami, claimDeadlineMs = 30_000, renewGone = false, claimConflictAfter = null, ackBehavior = null } = {}) {
	const requests = [];
	let streamConnections = 0;
	let claims = 0;
	const acks = [];
	const server = createServer((req, res) => {
		let raw = "";
		req.on("data", (c) => (raw += c));
		req.on("end", () => {
			const record = { method: req.method, url: req.url, headers: req.headers, body: raw, at: Date.now() };
			requests.push(record);
			const respond = (status, payload) => {
				res.writeHead(status, { "content-type": "application/json" });
				res.end(JSON.stringify(payload));
			};
			if (req.url === "/whoami" && req.method === "GET") {
				respond(200, whoami ?? { user: ACTOR, actor_id: EXPECTED_ACTOR_ID });
			} else if (req.url === "/notifications/lease/status") {
				respond(200, { epoch: 0, owner: null });
			} else if (req.url === "/notifications/lease/claim") {
				const body = JSON.parse(raw);
				claims += 1;
				if (claimConflictAfter !== null && claims > claimConflictAfter) {
					res.writeHead(409);
					res.end();
					return;
				}
				respond(200, {
					outcome: "granted",
					epoch: 1,
					runtime_id: body.runtime_id,
					grant_secret: "ab".repeat(32),
					deadline_remaining_ms: claimDeadlineMs,
				});
			} else if (req.url === "/notifications/lease/renew") {
				if (renewGone) {
					res.writeHead(410);
					res.end();
					return;
				}
				respond(200, { outcome: "renewed", deadline_remaining_ms: claimDeadlineMs });
			} else if (req.url === "/notifications/presentation/stream" && req.method === "POST") {
				streamConnections += 1;
				res.writeHead(200, { "content-type": "text/event-stream" });
				if (onStream) onStream(record, res, streamConnections);
				else res.end();
			} else if (req.url === "/notifications/presentation/acknowledge") {
				acks.push(JSON.parse(raw));
				if (ackBehavior && ackBehavior() === "destroy") {
					// Transport outage: the connection dies before a response — the
					// exact uncertainty the identical-request retry exists for.
					req.socket.destroy();
					return;
				}
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
			AUTONOMY_SSE_MODE: undefined,
			AUTONOMY_SESSION_COOKIE_FILE: "",
			AUTONOMY_SSE_EXPECTED_ACTOR_ID: "",
			AUTONOMY_SSE_SCOPE: "",
			AUTONOMY_SSE_RENEW_INTERVAL_MS: "",
			// Opt-in diagnostics stay off unless a test explicitly enables them.
			AUTONOMY_SSE_TRACE_FILE: "",
			// Minimal default-SSE setup: trusted origin + credential only.
			// Identity (ActorId + handle), scope and renewal derive at runtime.
			AUTONOMY_BASE: `http://127.0.0.1:${port}`,
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

const writeSessionFile = (body, presentationId, scope) => {
	const dir = mkdtempSync(join(tmpdir(), "sse-worker-session-"));
	const file = join(dir, "session.jsonl");
	const details = {
		schema: METADATA_SCHEMA_VERSION,
		scope,
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

test("SSE worker: minimal config, whoami-derived identity, origin-derived scope, claim-before-stream, delivery, reconciliation, ack", async (t) => {
	let streamRes = null;
	const fake = makeFakeServer({
		onStream: (req, res) => {
			streamRes = res;
			presentationEvent(res, OFFER);
		},
	});
	const port = await listen(fake.server);
	const origin = `http://127.0.0.1:${port}`;
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
	assert.equal(deliver.message.details.scope, origin, "scope defaults to the trusted origin");
	assert.equal(
		deliver.message.details.recipient,
		ACTOR,
		"the receipt handle is derived from the validated whoami response",
	);
	assert.equal(
		deliver.message.details.actorId,
		EXPECTED_ACTOR_ID,
		"the stable actor id is derived from whoami, not separately configured",
	);
	assert.equal(deliver.message.details.contentOfferId, null);
	assert.equal(deliver.message.details.summaryOfferId, null);

	// The FIRST whoami relies on the actual credential only — never a
	// fabricated actor header; the validated identity is used consistently
	// afterwards.
	const whoami = fake.requests.find((r) => r.url === "/whoami");
	assert.equal(whoami.headers["x-auth-user"], undefined);
	assert.equal(whoami.headers.authorization, "Bearer test-only-token-not-real");
	const claimRec = fake.requests.find((r) => r.url === "/notifications/lease/claim");
	assert.ok(claimRec, "claim must happen before the stream");
	assert.equal(claimRec.headers["x-auth-user"], ACTOR, "subsequent calls carry the whoami-derived handle");
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
	const sessionFile = writeSessionFile(OFFER.body, 7, origin);
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

// ── recorded-receipt replay suppression (t276 late-frame fix) ────────────

// A delayed SAME frame (same connection or reconnect) must not produce a
// second custom_message once a fully qualifying recorded receipt exists.
test("SSE worker: a delayed same offer is not re-delivered once its qualifying receipt is recorded", async (t) => {
	let streamRes = null;
	const fake = makeFakeServer({
		onStream: (req, res) => {
			streamRes = res;
			presentationEvent(res, OFFER); // connection stays open
		},
	});
	const port = await listen(fake.server);
	const origin = `http://127.0.0.1:${port}`;
	const w = startWorker(port);
	t.after(() => {
		w.child.kill();
		fake.server.close();
		fake.server.closeAllConnections?.();
	});

	// First delivery of A.
	await w.waitFor((l) => l.includes('"kind":"deliver"'), "first deliver");

	// The supervisor renders it and qualifying disk bytes are recorded; the
	// offer is acknowledged (idempotently).
	const sessionFile = writeSessionFile(OFFER.body, 7, origin);
	w.send({ event: "session", sessionId: "sess-1", sessionFile });
	w.send({ event: "reconcile" });
	await w.waitFor((l) => l.includes('"kind":"ack"'), "ack outcome");

	// A delayed SAME frame arrives on the SAME connection.
	presentationEvent(streamRes, OFFER);
	await sleep(300);

	const delivers = w.lines.filter((l) => l.includes('"kind":"deliver"'));
	assert.equal(delivers.length, 1, "no second deliver for a recorded qualifying receipt");
	// Every ack is truthful and idempotent for this exact receipt.
	assert.ok(fake.acks.length >= 1 && fake.acks.length <= 2, `acks: ${JSON.stringify(fake.acks)}`);
	for (const ack of fake.acks) {
		assert.deepEqual(ack, { presentation_id: 7, expected_digest: sha256Hex(OFFER.body) });
	}
});

// IDs are immutable: a same-ID offer whose evidence differs must not be
// suppressed by the recorded receipt — and must not be dressed up as a
// "new revision" either; it simply does not match.
test("SSE worker: a same-ID offer with differing evidence is not suppressed by the recorded receipt", async (t) => {
	let streamRes = null;
	const fake = makeFakeServer({
		onStream: (req, res) => {
			streamRes = res;
			presentationEvent(res, OFFER);
		},
	});
	const port = await listen(fake.server);
	const origin = `http://127.0.0.1:${port}`;
	const w = startWorker(port);
	t.after(() => {
		w.child.kill();
		fake.server.close();
		fake.server.closeAllConnections?.();
	});

	await w.waitFor((l) => l.includes('"kind":"deliver"'), "first deliver");
	const sessionFile = writeSessionFile(OFFER.body, 7, origin);
	w.send({ event: "session", sessionId: "sess-1", sessionFile });

	const changedBody = "a different server-rendered body";
	const changed = {
		presentation_id: 7,
		content_offer_id: null,
		summary_offer_id: null,
		body: changedBody,
		render_version: 1,
		digest: sha256Hex(changedBody),
	};
	presentationEvent(streamRes, changed);
	await w.waitFor(
		(l) => l.includes('"kind":"deliver"') && w.lines.filter((x) => x.includes('"kind":"deliver"')).length >= 2,
		"second deliver for the differing evidence",
	);
});

// Unqualified receipt evidence (wrong scope here) never suppresses delivery.
test("SSE worker: an unqualified recorded receipt does not suppress the delayed same offer", async (t) => {
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

	await w.waitFor((l) => l.includes('"kind":"deliver"'), "first deliver");
	// Recorded under a scope that does not qualify for this worker.
	const sessionFile = writeSessionFile(OFFER.body, 7, "some-other-scope");
	w.send({ event: "session", sessionId: "sess-1", sessionFile });

	presentationEvent(streamRes, OFFER);
	await w.waitFor(
		(l) => l.includes('"kind":"deliver"') && w.lines.filter((x) => x.includes('"kind":"deliver"')).length >= 2,
		"second deliver despite unqualified receipt",
	);
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

// Optional explicit pin: a mismatch is still a visible prerequisite failure.
test("SSE worker: an actor_id pin mismatch is a visible prerequisite failure with no claim and no legacy fallback", async (t) => {
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

// ── missing identity: visible refusal, no claim, no legacy fallback ────

test("SSE worker: a null actor_id is a visible identity refusal with no claim and no legacy fallback", async (t) => {
	const fake = makeFakeServer({ whoami: { user: null, actor_id: null } });
	const port = await listen(fake.server);
	const w = startWorker(port);
	t.after(() => {
		w.child.kill();
		fake.server.close();
		fake.server.closeAllConnections?.();
	});

	const line = await w.waitFor((l) => l.includes("[notifications.sse]") && l.toLowerCase().includes("identity"), "identity refusal");
	assert.ok(line, "the missing-identity refusal is visible");
	await sleep(200);
	assert.equal(fake.requests.filter((r) => r.url === "/notifications/lease/claim").length, 0);
	assert.equal(fake.requests.filter((r) => r.url.startsWith("/notifications?timeout")).length, 0);
});

// ── malformed identity responses refuse at the boundary ─────────────

test("SSE worker: a non-UUID ActorId or whitespace-only handle refuses visibly with no claim", async (t) => {
	// Static refusals only: the offending identity values are never reflected.
	for (const badWhoami of [
		{ user: ACTOR, actor_id: "garbage-not-a-uuid" },
		{ user: "   ", actor_id: EXPECTED_ACTOR_ID },
	]) {
		const fake = makeFakeServer({ whoami: badWhoami });
		const port = await listen(fake.server);
		const w = startWorker(port);
		t.after(() => {
			w.child.kill();
			fake.server.close();
			fake.server.closeAllConnections?.();
		});
		const line = await w.waitFor((l) => l.includes("[notifications.sse]") && l.toLowerCase().includes("identity"), "identity refusal");
		assert.ok(line, "the malformed-identity refusal is visible");
		await sleep(150);
		assert.equal(
			fake.requests.filter((r) => r.url === "/notifications/lease/claim").length,
			0,
			"no ownership use from a malformed identity",
		);
	}
});

// ── default SSE vs explicit 0 ─────────────────────────────────────

test("SSE worker: an explicit AUTONOMY_SSE_MODE=0 opts out into the legacy long-poll", async (t) => {
	const fake = makeFakeServer({});
	const port = await listen(fake.server);
	const w = startWorker(port, { AUTONOMY_SSE_MODE: "0", AUTONOMY_ACTOR: "iris" });
	t.after(() => {
		w.child.kill();
		fake.server.close();
		fake.server.closeAllConnections?.();
	});

	// The legacy loop long-polls immediately; SSE identity/lease machinery
	// is never engaged.
	await sleep(300);
	assert.ok(
		fake.requests.some((r) => r.url.startsWith("/notifications?timeout=")),
		"the legacy long-poll is the transport",
	);
	assert.equal(fake.requests.filter((r) => r.url === "/whoami").length, 0, "no SSE identity resolution");
	assert.equal(fake.requests.filter((r) => r.url.endsWith("/presentation/stream")).length, 0, "no SSE stream");
});

// ── explicit scope override replaces the origin-derived default ──────

test("SSE worker: an explicit scope override replaces the origin-derived default", async (t) => {
	const fake = makeFakeServer({ onStream: (req, res) => presentationEvent(res, OFFER) });
	const port = await listen(fake.server);
	const w = startWorker(port, { AUTONOMY_SSE_SCOPE: SCOPE });
	t.after(() => {
		w.child.kill();
		fake.server.close();
		fake.server.closeAllConnections?.();
	});

	const deliverLine = await w.waitFor((l) => l.includes('"kind":"deliver"'), "deliver");
	assert.equal(JSON.parse(deliverLine).message.details.scope, SCOPE);
});

// ── renewal derives from the server's remaining lease budget ───────────

const waitForRequest = async (fake, predicate, ms = 5000) => {
	const start = Date.now();
	for (;;) {
		const found = fake.requests.filter(predicate);
		if (found.length > 0) return found;
		if (Date.now() - start > ms) {
			throw new Error(`timed out waiting for requests; saw: ${fake.requests.map((r) => r.url).join(",")}`);
		}
		await sleep(25);
	}
};

test("SSE worker: renewal defaults from the server budget, stays serialized, never re-claims or overlaps", async (t) => {
	// Short budget (3s) → derived delay is exactly one third (1s):
	// conservatively before expiry, never a zero-delay busy loop.
	const fake = makeFakeServer({ claimDeadlineMs: 3_000 });
	const port = await listen(fake.server);
	const w = startWorker(port);
	t.after(() => {
		w.child.kill();
		fake.server.close();
		fake.server.closeAllConnections?.();
	});

	// Ownership alone is enough: no stream offer is scripted here.
	const claim = (await waitForRequest(fake, (r) => r.url === "/notifications/lease/claim"))[0];
	const renews = await waitForRequest(fake, (r) => r.url === "/notifications/lease/renew");
	assert.equal(JSON.parse(renews[0].body).sequence, 1, "the exact next sequence");
	assert.ok(renews[0].at - claim.at >= 900, "the derived delay precedes expiry, not immediate");

	// The next renewal re-arms only after the previous one completes, from
	// the server's fresh budget — and ownership is never re-claimed while
	// the lease is valid.
	await waitForRequest(fake, (r) => r.url === "/notifications/lease/renew" && JSON.parse(r.body).sequence === 2, 8000);
	assert.equal(fake.requests.filter((r) => r.url === "/notifications/lease/claim").length, 1, "no overlapping renewal or re-claim");
});

test("SSE worker: a subsecond server budget renews strictly before expiry", async (t) => {
	// 600ms budget → one third = 200ms: before expiry, where the previous
	// 1s floor would have landed after it.
	const fake = makeFakeServer({ claimDeadlineMs: 600 });
	const port = await listen(fake.server);
	const w = startWorker(port);
	t.after(() => {
		w.child.kill();
		fake.server.close();
		fake.server.closeAllConnections?.();
	});

	const claim = (await waitForRequest(fake, (r) => r.url === "/notifications/lease/claim"))[0];
	const renews = await waitForRequest(fake, (r) => r.url === "/notifications/lease/renew");
	assert.equal(JSON.parse(renews[0].body).sequence, 1, "the exact next sequence");
	const delay = renews[0].at - claim.at;
	assert.ok(delay >= 120, `the derived delay is not immediate (${delay}ms)`);
	assert.ok(delay < 600, `renewal lands before the 600ms expiry (${delay}ms)`);
});

test("SSE worker: a zero remaining budget schedules one positive renewal, then stops without a busy loop", async (t) => {
	// 0 remaining → the positive floor delay, then the 410 honestly drops
	// the lease; re-acquisition is refused (409) so the renewal chain ends.
	const fake = makeFakeServer({ claimDeadlineMs: 0, renewGone: true, claimConflictAfter: 1 });
	const port = await listen(fake.server);
	const w = startWorker(port);
	t.after(() => {
		w.child.kill();
		fake.server.close();
		fake.server.closeAllConnections?.();
	});

	const claim = (await waitForRequest(fake, (r) => r.url === "/notifications/lease/claim"))[0];
	const renews = await waitForRequest(fake, (r) => r.url === "/notifications/lease/renew");
	assert.equal(JSON.parse(renews[0].body).sequence, 1);
	const delay = renews[0].at - claim.at;
	assert.ok(delay >= 40, `the renewal delay stays strictly positive (${delay}ms)`);
	await sleep(700);
	assert.equal(
		fake.requests.filter((r) => r.url === "/notifications/lease/renew").length,
		1,
		"the lost lease ends the renewal chain — no busy loop",
	);
});

test("SSE worker: an explicit positive renewal interval overrides the server-budget derivation", async (t) => {
	const fake = makeFakeServer({ claimDeadlineMs: 3_000 });
	const port = await listen(fake.server);
	const w = startWorker(port, { AUTONOMY_SSE_RENEW_INTERVAL_MS: "60000" });
	t.after(() => {
		w.child.kill();
		fake.server.close();
		fake.server.closeAllConnections?.();
	});

	// Ownership alone is enough: no stream offer is scripted here.
	await sleep(1500); // far longer than the derived ~1s delay would take
	assert.equal(
		fake.requests.filter((r) => r.url === "/notifications/lease/renew").length,
		0,
		"the explicit interval wins over the short server budget",
	);
});

// ── missing credentials: visible failure, no legacy fallback, heartbeat armed ──

test("SSE worker: missing credentials is a visible prerequisite failure and never falls back to legacy polling", async (t) => {
	const fake = makeFakeServer({});
	const port = await listen(fake.server);
	const w = startWorker(port, { AUTONOMY_TOKEN: "" });
	t.after(() => {
		w.child.kill();
		fake.server.close();
		fake.server.closeAllConnections?.();
	});

	const line = await w.waitFor((l) => l.includes("PREREQUISITE FAILURE"), "prerequisite failure");
	assert.match(line, /credentials|origin/);

	// The trusted base origin is REQUIRED in SSE mode — no implicit
	// localhost default that an existing credential would be sent to.
	const w2 = startWorker(port, { AUTONOMY_BASE: "" });
	t.after(() => {
		w2.child.kill();
	});
	const line2 = await w2.waitFor((l) => l.includes("PREREQUISITE FAILURE"), "missing-origin failure");
	assert.match(line2, /origin/);

	await sleep(200);
	// Nothing at all was consumed: no SSE lease/stream activity AND no
	// legacy /notifications?timeout= long-poll.
	assert.equal(fake.requests.length, 0, "no consumption of any kind after a config refusal");
});

// ── error-exit amplification (t277): stream exits are classified, and ────
// only a REAL recovery (clean EOF, no failure class) re-arms the
// changed-failure rule. An error exit must never masquerade as recovery.

test("SSE worker: repeated stream_error wakes once, a changed failure wakes, only a clean end re-arms, delivery survives", async (t) => {
	let phase = "error"; // error → stream_error | frame → mid-frame refusal | clean → clean EOF + offer
	const fake = makeFakeServer({
		onStream: (req, res) => {
			if (phase === "error") {
				res.write("event: stream_error\ndata: lease lost\n\n");
				res.end();
			} else if (phase === "frame") {
				res.write("event: presentation\ndata: {partial");
				res.end();
			} else {
				presentationEvent(res, { ...OFFER, presentation_id: 11, digest: sha256Hex(OFFER.body) });
				res.end();
			}
		},
	});
	const port = await listen(fake.server);
	const w = startWorker(port);
	t.after(() => {
		w.child.kill();
		fake.server.close();
		fake.server.closeAllConnections?.();
	});
	const waitForStreams = async (count, label) => {
		const start = Date.now();
		while (fake.streamCount() < count) {
			if (Date.now() - start > 8000) throw new Error(`timed out waiting for ${label}`);
			await sleep(25);
		}
	};
	const wakes = () => w.lines.filter((l) => l.includes('"kind":"wake"'));

	// Phase 1: the SAME stream_error class on every reconnect stays ONE wake
	// while the stream is reopened repeatedly (no wake per reconnect).
	await w.waitFor((l) => l.includes("stream_error received"), "first stream_error wake");
	await waitForStreams(3, "three stream_error reconnects");
	await sleep(250); // further identical reconnects stay quiet
	assert.equal(wakes().length, 1, `repeated identical stream_error must not wake per reconnect (got ${wakes().length})`);

	// Phase 2: a CHANGED failure (mid-frame refusal) is still visible.
	phase = "frame";
	await w.waitFor((l) => l.includes("stream ended mid-frame"), "changed failure wake");
	assert.equal(wakes().length, 2, "the changed failure wakes exactly once");

	// Phase 3: a clean stream end (no failure class) is REAL recovery — and
	// a new presentation is still delivered through it.
	phase = "clean";
	await w.waitFor(
		(l) => l.includes('"kind":"deliver"') && JSON.parse(l).message.details.presentationId === 11,
		"deliver after recovery",
	);
	await sleep(250);
	assert.equal(wakes().length, 2, "recovery + delivery add no wake");

	// Phase 4: after real recovery, the same stream_error class wakes again
	// (the quiet-until-changed rule was genuinely re-armed, not stuck).
	phase = "error";
	await w.waitFor(
		() => wakes().filter((l) => l.includes("stream_error received")).length >= 2,
		"stream_error wakes again after recovery",
		8000,
	);
});

// ── opt-in bounded phase trace (t277 diagnostics) ────────────────────────

const TRACE_ALLOWED_FIELDS = new Set([
	"t", "phase", "event", "pid", "runtimeId", "epoch", "actorId", "route", "httpStatus",
	"outcome", "failureClass", "sequence", "budgetRemainingMs", "scheduledDelayMs",
	"fireLatenessMs", "durationMs", "presentationEvents", "reason",
]);

test("SSE worker: opt-in phase tracing is bounded, safe-field-only, restricted, and covers the phases", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "sse-worker-trace-"));
	const traceFile = join(dir, "trace.jsonl");
	let streamRes = null;
	const fake = makeFakeServer({
		claimDeadlineMs: 900, // derived renewal delay ~300ms: at least one timer fires
		onStream: (req, res) => {
			streamRes = res;
			presentationEvent(res, OFFER);
		},
	});
	const port = await listen(fake.server);
	const origin = `http://127.0.0.1:${port}`;
	const w = startWorker(port, { AUTONOMY_SSE_TRACE_FILE: traceFile });
	t.after(() => {
		w.child.kill();
		fake.server.close();
		fake.server.closeAllConnections?.();
	});

	await w.waitFor((l) => l.includes('"kind":"deliver"'), "deliver");
	const sessionFile = writeSessionFile(OFFER.body, 7, origin);
	w.send({ event: "session", sessionId: "sess-1", sessionFile });
	w.send({ event: "reconcile" });
	await w.waitFor((l) => l.includes('"kind":"ack"'), "ack outcome");
	await sleep(700); // let a renewal timer fire
	streamRes?.end(); // clean EOF → classified stream_end, then reconnect

	const exited = new Promise((r) => w.child.on("exit", r));
	w.child.kill("SIGTERM");
	await exited;

	const raw = readFileSync(traceFile, "utf8");
	const records = raw
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l));
	assert.ok(records.length > 0 && records.length <= 2000, "bounded record count");
	const stat = statSync(traceFile);
	assert.equal(stat.mode & 0o777, 0o600, "restrictive file permissions");
	assert.ok(stat.size <= 1_000_000, "bounded file size");
	for (const record of records) {
		for (const key of Object.keys(record)) {
			assert.ok(TRACE_ALLOWED_FIELDS.has(key), `trace record carries only safe fields (saw ${key})`);
		}
		assert.equal(typeof record.t, "number", "monotonic elapsed time");
		assert.ok(!Number.isNaN(record.t));
	}
	// No credential material of any kind ever appears.
	assert.ok(!raw.includes("ab".repeat(32)), "no grant secret in the trace");
	assert.ok(!raw.includes("test-only-token"), "no bearer credential in the trace");

	const events = new Set(records.map((r) => r.event));
	for (const expected of [
		"identity_resolved",
		"ownership_granted",
		"renew_timer_scheduled",
		"renew_timer_fired",
		"fetch_start",
		"response_headers",
		"validated_outcome",
		"stream_fetch_start",
		"stream_headers",
		"stream_open",
		"first_presentation",
		"stream_end",
	]) {
		assert.ok(events.has(expected), `trace covers ${expected}`);
	}
	const fired = records.find((r) => r.event === "renew_timer_fired");
	assert.equal(fired.sequence, 1, "the fired renewal carries its sequence");
	assert.equal(typeof fired.fireLatenessMs, "number", "timer-scheduled vs fired is distinguishable");
	assert.ok(
		records.some((r) => r.event === "stream_end" && r.outcome === "clean_eof"),
		"the clean EOF is classified as real recovery",
	);
});

test("SSE worker: tracing is disabled by default — no trace file is created without the explicit setting", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "sse-worker-notrace-"));
	const traceFile = join(dir, "trace.jsonl");
	const fake = makeFakeServer({ onStream: (req, res) => presentationEvent(res, OFFER) });
	const port = await listen(fake.server);
	const w = startWorker(port, { AUTONOMY_SSE_TRACE_FILE: "" }); // empty = unset
	t.after(() => {
		w.child.kill();
		fake.server.close();
		fake.server.closeAllConnections?.();
	});

	await w.waitFor((l) => l.includes('"kind":"deliver"'), "deliver");
	await sleep(200);
	assert.ok(!existsSync(traceFile), "no trace file is written when the setting is not configured");
});

test("SSE worker: an unusable trace path disables tracing without affecting ownership or delivery", async (t) => {
	const fake = makeFakeServer({ onStream: (req, res) => presentationEvent(res, OFFER) });
	const port = await listen(fake.server);
	const w = startWorker(port, { AUTONOMY_SSE_TRACE_FILE: "/nonexistent-t277-trace-dir/trace.jsonl" });
	t.after(() => {
		w.child.kill();
		fake.server.close();
		fake.server.closeAllConnections?.();
	});

	// Tracing fails to open, and ownership + delivery are entirely unaffected.
	const deliverLine = await w.waitFor((l) => l.includes('"kind":"deliver"'), "deliver");
	assert.equal(JSON.parse(deliverLine).message.details.presentationId, 7);
	await sleep(150);
	assert.equal(w.child.exitCode, null, "the worker keeps running normally");
});

// ── acknowledgement-outage spam bounds ───────────────────────────────────
// One transport outage must cost ONE static ack warning (no per-receipt
// ids), one attempted receipt per pass, and background-only retries —
// never a per-receipt warning for the whole batch, and never a
// whole-batch walk per agent_settled/replay event (the live 291-receipt
// failure mode).

const ACK_SPAM_BACKOFF_MS = "800"; // background ack retry base; also the reconnect base here

const writeMultiReceiptSessionFile = (specs, scope) => {
	const dir = mkdtempSync(join(tmpdir(), "sse-worker-ackspam-"));
	const file = join(dir, "session.jsonl");
	const lines = [JSON.stringify({ type: "session", id: "sess-1", version: 1 })];
	for (const spec of specs) {
		const details = {
			schema: METADATA_SCHEMA_VERSION,
			scope,
			recipient: ACTOR,
			actorId: EXPECTED_ACTOR_ID,
			sessionId: "sess-1",
			presentationId: spec.presentationId,
			renderVersion: 1,
			digest: sha256Hex(spec.body),
			contentOfferId: null,
			summaryOfferId: null,
		};
		lines.push(
			JSON.stringify({
				type: "custom_message",
				id: `m-${spec.presentationId}`,
				customType: CUSTOM_TYPE,
				content: spec.body,
				display: true,
				details,
			}),
		);
	}
	writeFileSync(file, lines.join("\n") + "\n");
	return file;
};

test("SSE worker: one ack outage warns once, stops at the first receipt, retries in the background, recovers idempotently, and re-arms", async (t) => {
	let ackBehavior = () => "destroy"; // transport outage until flipped
	const fake = makeFakeServer({
		ackBehavior: () => ackBehavior(),
		onStream: (req, res) => {
			presentationEvent(res, OFFER); // stays open: identity + ownership only
		},
	});
	const port = await listen(fake.server);
	const origin = `http://127.0.0.1:${port}`;
	const w = startWorker(port, { AUTONOMY_SSE_RECONNECT_BACKOFF_MS: ACK_SPAM_BACKOFF_MS });
	t.after(() => {
		w.child.kill();
		fake.server.close();
		fake.server.closeAllConnections?.();
	});

	await w.waitFor((l) => l.includes('"kind":"deliver"'), "deliver");
	const specs = [101, 102, 103].map((id) => ({ presentationId: id, body: `receipt body ${id}` }));
	const sessionFile = writeMultiReceiptSessionFile(specs, origin);
	w.send({ event: "session", sessionId: "sess-1", sessionFile });
	w.send({ event: "reconcile" });

	const ackWakes = () => w.lines.filter((l) => l.includes('"kind":"wake"') && l.includes("ack retries exhausted"));
	const ackReqs = () => fake.requests.filter((r) => r.url === "/notifications/presentation/acknowledge");

	// First failing pass: bounded identical retries of the FIRST receipt only.
	await w.waitFor((l) => l.includes("ack retries exhausted"), "first ack outage warning", 8000);
	const firstWarningAt = Date.now();
	await sleep(150); // let any same-pass stragglers land
	assert.equal(ackWakes().length, 1, "the WHOLE batch must produce exactly ONE warning");
	assert.ok(!/\b10[123]\b/.test(ackWakes()[0]), `the warning is static, no per-receipt id: ${ackWakes()[0]}`);
	assert.equal(ackReqs().length, 3, "only the first receipt is attempted: its 3 bounded identical retries");
	for (const r of ackReqs()) {
		assert.equal(
			r.body,
			JSON.stringify({ presentation_id: 101, expected_digest: sha256Hex("receipt body 101") }),
			"identical requests for the first receipt only",
		);
	}

	// Reconcile events during the backoff add NO requests and NO warnings.
	const before = ackReqs().length;
	for (let i = 0; i < 4; i++) w.send({ event: "reconcile" });
	await sleep(300); // well within the 800ms background bound
	assert.equal(ackReqs().length, before, "reconcile events during the backoff never reach the daemon");
	assert.equal(ackWakes().length, 1, "and they never warn");

	// Real recovery: the background pass (after the bound) acknowledges ALL
	// qualifying receipts idempotently.
	ackBehavior = () => "ok";
	await w.waitFor(
		(l) => l.includes('"kind":"ack"') && l.includes('"outcome":"acknowledged"') && l.includes("103"),
		"all receipts acknowledged by the background pass",
		10000,
	);
	assert.ok(Date.now() - firstWarningAt >= 700, "the background retry waits out the backoff bound");
	assert.deepEqual(
		fake.acks.slice(-3).map((a) => a.presentation_id),
		[101, 102, 103],
		"recovery processes every qualifying receipt",
	);
	for (const a of fake.acks.slice(-3)) {
		const spec = specs.find((s) => s.presentationId === a.presentation_id);
		assert.deepEqual(a, { presentation_id: spec.presentationId, expected_digest: sha256Hex(spec.body) });
	}
	assert.equal(ackWakes().length, 1, "recovery adds no warnings");

	// A NEW outage after real recovery warns once again (the ack warning
	// re-armed on recovery).
	ackBehavior = () => "destroy";
	w.send({ event: "reconcile" });
	await w.waitFor(() => ackWakes().length >= 2, "second outage warns again", 10000);
	assert.equal(ackWakes().length, 2, "a fresh outage after recovery warns exactly once more");
	assert.ok(!/\b10[123]\b/.test(ackWakes()[1]), "and it is static again");
});

test("SSE worker: stream and acknowledgement failure suppression are independent domains", async (t) => {
	const fake = makeFakeServer({
		ackBehavior: () => "destroy",
		onStream: (req, res) => {
			res.write("event: stream_error\ndata: lease lost\n\n");
			res.end(); // EVERY connection fails identically
		},
	});
	const port = await listen(fake.server);
	const origin = `http://127.0.0.1:${port}`;
	const w = startWorker(port, { AUTONOMY_SSE_RECONNECT_BACKOFF_MS: ACK_SPAM_BACKOFF_MS });
	t.after(() => {
		w.child.kill();
		fake.server.close();
		fake.server.closeAllConnections?.();
	});

	await w.waitFor((l) => l.includes("stream_error received"), "stream failure wake");
	const specs = [201, 202].map((id) => ({ presentationId: id, body: `receipt body ${id}` }));
	w.send({ event: "session", sessionId: "sess-1", sessionFile: writeMultiReceiptSessionFile(specs, origin) });
	w.send({ event: "reconcile" });
	await w.waitFor((l) => l.includes("ack retries exhausted"), "first ack warning", 10000);

	// Several failing ack passes and stream reconnects later, both domains
	// must still have warned EXACTLY once — neither resets the other.
	await sleep(3200);
	const streamWakes = w.lines.filter((l) => l.includes('"kind":"wake"') && l.includes("stream_error received"));
	const ackWakes = w.lines.filter((l) => l.includes('"kind":"wake"') && l.includes("ack retries exhausted"));
	assert.ok(fake.streamCount() >= 3, "the stream actually reconnected repeatedly");
	assert.equal(streamWakes.length, 1, "repeated identical stream failures stay quiet");
	assert.equal(ackWakes.length, 1, "repeated ack passes on the same outage stay quiet");
	for (const line of ackWakes) assert.ok(!/\b20[12]\b/.test(line), `no per-receipt id in the ack warning: ${line}`);
});
