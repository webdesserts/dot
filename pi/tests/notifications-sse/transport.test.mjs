/**
 * Native-H2 transport tests for the presentation-SSE worker (autonomy/t:277).
 *
 * RUNTIME UNDER TEST: Node 26.8.1 with its bundled Undici 8.10 (the H2
 * multiplexing fix landed upstream in Undici 8.8; the 26.4/Undici 8.5
 * runtime was the known-broken one). The stream goes over plain native
 * fetch — the SAME pooled connection the control requests use, upgraded
 * to HTTP/2 when the server advertises it. There is no version detection
 * and no fallback framework: on the tested runtime the H2 multiplexer
 * lets lease renewals flow underneath a held stream.
 *
 * The TLS fixture advertises BOTH h2 and http/1.1 via ALPN (the
 * production shape) and enforces REAL lease expiry: a renewal arriving
 * after the budget it must extend is refused with 410. Any transport
 * that blocks renewals therefore produces ownership loss here — no mock
 * flags, no library swaps. The fixture CA is synthetic and test-only;
 * the worker trusts it exclusively through NODE_EXTRA_CA_CERTS.
 *
 * Run: node --test pi/tests/notifications-sse/transport.test.mjs
 */

import { spawn } from "node:child_process";
import http2 from "node:http2";
import http from "node:http";
import assert from "node:assert/strict";
import { test, after } from "node:test";
import crypto from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const WORKER_PATH = new URL("../../extensions/notifications.worker.mjs", import.meta.url).pathname;
const FIXTURE_CA = fileURLToPath(new URL("./fixtures/stream-tls/ca.pem", import.meta.url));
const FIXTURE_KEY = fileURLToPath(new URL("./fixtures/stream-tls/server-key.pem", import.meta.url));
const FIXTURE_CERT = fileURLToPath(new URL("./fixtures/stream-tls/server-cert.pem", import.meta.url));

const sha256Hex = (text) => crypto.createHash("sha256").update(text, "utf8").digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const EXPECTED_ACTOR_ID = "6f1c2a34-0000-4000-8000-000000000001";
const ACTOR = "rhea";

const STREAM_PATH = "/notifications/presentation/stream";

// Last-resort cleanup: nothing spawned here may outlive the test run.
const spawnedChildren = [];
const openedServers = [];
after(() => {
	for (const child of spawnedChildren) {
		try {
			child.kill("SIGKILL");
		} catch {}
	}
	for (const server of openedServers) {
		try {
			server.close();
		} catch {}
	}
});

const presentationEvent = (res, offer) => {
	res.write(`event: presentation\ndata: ${JSON.stringify(offer)}\n\n`);
};

/** SSE response with headers flushed while the body stays open. */
const openSse = (res) => {
	res.writeHead(200, { "content-type": "text/event-stream" });
	res.flushHeaders();
};

/**
 * Synthetic TLS fixture. ALPN advertises h2 + http/1.1 (allowHTTP1), so
 * a native fetch request negotiates h2 — exactly the production shape
 * the worker sees. Lease semantics are REAL: the
 * grant expires budgetMs after the claim (and after each renewal); a
 * late or missing renewal is refused 410. `renewGoneAfter` (per claim)
 * additionally refuses renewals once that many succeeded, to exercise
 * ownership loss on demand.
 */
function makeTlsFixture({ budgetMs = 1200, renewGoneAfter = null, onStreamConnection } = {}) {
	const requests = []; // every request that reached a handler
	const streamConns = []; // one entry per presentation-stream connection
	const deniedRenewals = []; // renew requests refused 410 (real expiry)
	const acks = [];
	const sockets = new Set();
	const sessions = new Set();
	let lease = null; // {runtimeId, deadline} — REAL server-side expiry
	let renewalsSinceClaim = 0;
	let streamConnectionCount = 0;

	const server = http2.createSecureServer({
		key: readFileSync(FIXTURE_KEY),
		cert: readFileSync(FIXTURE_CERT),
		allowHTTP1: true, // ALPN advertises h2 + http/1.1: the exact production shape
	});

	server.on("request", (req, res) => {
		const isH2 = res.stream !== undefined;
		const alpn = isH2
			? res.stream.session.socket.alpnProtocol || "h2"
			: req.socket.alpnProtocol || "http/1.1";
		const proto = alpn === "h2" ? "h2" : "http/1.1";
		const remotePort = isH2 ? res.stream.session.socket.remotePort : req.socket.remotePort;
		let raw = "";
		req.on("data", (c) => (raw += c));
		req.on("end", () => {
			requests.push({ url: req.url, method: req.method, proto, remotePort, at: Date.now(), body: raw });
			const respond = (status, payload) => {
				const payloadText = JSON.stringify(payload);
				res.writeHead(status, {
					"content-type": "application/json",
					"content-length": Buffer.byteLength(payloadText),
				});
				res.end(payloadText);
			};
			if (req.url === "/whoami" && req.method === "GET") {
				respond(200, { user: ACTOR, actor_id: EXPECTED_ACTOR_ID });
			} else if (req.url === "/notifications/lease/status") {
				respond(200, { epoch: 1, owner: null });
			} else if (req.url === "/notifications/lease/claim") {
				const body = JSON.parse(raw);
				lease = { runtimeId: body.runtime_id, deadline: Date.now() + budgetMs };
				renewalsSinceClaim = 0;
				respond(200, {
					outcome: "granted",
					epoch: 2,
					runtime_id: body.runtime_id,
					grant_secret: "ab".repeat(32), // fixture-only synthetic grant — never a real secret
					deadline_remaining_ms: budgetMs,
				});
			} else if (req.url === "/notifications/lease/renew") {
				const body = JSON.parse(raw);
				const expired = !lease || body.runtime_id !== lease.runtimeId || Date.now() > lease.deadline;
				const refused = renewGoneAfter !== null && renewalsSinceClaim >= renewGoneAfter;
				if (expired || refused) {
					deniedRenewals.push({ at: Date.now(), reason: expired ? "expired" : "scripted" });
					res.writeHead(410);
					res.end();
					return;
				}
				renewalsSinceClaim += 1;
				lease.deadline = Date.now() + budgetMs;
				respond(200, { outcome: "renewed", deadline_remaining_ms: budgetMs });
			} else if (req.url === STREAM_PATH && req.method === "POST") {
				const conn = { index: ++streamConnectionCount, proto, remotePort, openedAt: Date.now(), closedAt: null };
				streamConns.push(conn);
				res.on("close", () => {
					conn.closedAt = Date.now();
				});
				// The script owns the ENTIRE response: status, hold, frames.
				onStreamConnection(res, conn);
			} else if (req.url === "/notifications/presentation/acknowledge") {
				acks.push(JSON.parse(raw));
				respond(200, { outcome: "acknowledged" });
			} else {
				respond(404, {});
			}
		});
	});
	server.on("connection", (s) => {
		sockets.add(s);
		s.on("close", () => sockets.delete(s));
	});
	server.on("session", (s) => {
		sessions.add(s);
		s.on("close", () => sessions.delete(s));
	});

	return {
		server,
		requests,
		streamConns,
		deniedRenewals,
		acks,
		sockets,
		sessions,
		streamCount: () => streamConnectionCount,
	};
}

async function listen(server) {
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	return server.address().port;
}

async function stopFixture(fixture) {
	// Destroy live H2 sessions and raw sockets FIRST: server.close() only
	// completes once every connection is gone, and a lingering session
	// would hang the awaited close. Bounded either way — cleanup may never
	// wedge the test run.
	for (const session of fixture.sessions ?? []) session.destroy();
	for (const socket of fixture.sockets ?? []) socket.destroy();
	await Promise.race([
		new Promise((r) => fixture.server.close(r)),
		sleep(2000),
	]);
}

/** Spawn the REAL worker against the TLS fixture, trusting only the fixture CA. */
function startTlsWorker(port, { extraCa = FIXTURE_CA } = {}) {
	const env = {
		...process.env,
		AUTONOMY_SSE_MODE: "",
		AUTONOMY_SESSION_COOKIE_FILE: "",
		AUTONOMY_SSE_EXPECTED_ACTOR_ID: "",
		AUTONOMY_SSE_SCOPE: "",
		AUTONOMY_SSE_RENEW_INTERVAL_MS: "",
		AUTONOMY_SSE_TRACE_FILE: "",
		AUTONOMY_BASE: `https://localhost:${port}`,
		AUTONOMY_SSE_RECONNECT_BACKOFF_MS: "50",
		AUTONOMY_TOKEN: "test-only-token-not-real",
		AUTONOMY_HEARTBEAT_MS: "0",
	};
	if (extraCa) env.NODE_EXTRA_CA_CERTS = extraCa;
	else delete env.NODE_EXTRA_CA_CERTS;
	const child = spawn(process.execPath, [WORKER_PATH], { env, stdio: ["pipe", "pipe", "pipe"] });
	spawnedChildren.push(child);
	const lines = [];
	const stderr = [];
	let buf = "";
	const waiters = [];
	const consider = (line) => {
		lines.push(line);
		for (let i = waiters.length - 1; i >= 0; i--) {
			if (waiters[i].match(line)) {
				const w = waiters.splice(i, 1)[0];
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
	const waitFor = (match, label, timeoutMs = 8000) =>
		new Promise((resolve, reject) => {
			const existing = lines.find(match);
			if (existing) return resolve(existing);
			const w = { match, resolve, timer: null };
			w.timer = setTimeout(() => {
				const idx = waiters.indexOf(w);
				if (idx !== -1) waiters.splice(idx, 1);
				reject(
					new Error(
						`timed out waiting for ${label}; lines so far: ${lines.join(" | ").slice(0, 2000)}; stderr: ${stderr.join("").slice(0, 1000)}`,
					),
				);
			}, timeoutMs);
			waiters.push(w);
		});
	return { child, lines, waitFor, send: (obj) => child.stdin.write(`${JSON.stringify(obj)}\n`) };
}

async function stopWorker(w) {
	if (w.child.exitCode !== null) return;
	const exited = new Promise((r) => w.child.once("exit", r));
	w.child.kill("SIGTERM");
	const timer = setTimeout(() => w.child.kill("SIGKILL"), 1500);
	await exited;
	clearTimeout(timer);
}

/** Qualifying disk receipt for the delivery the supervisor would render. */
const writeSessionFile = (body, presentationId, scope) => {
	const dir = mkdtempSync(join(tmpdir(), "sse-transport-session-"));
	const file = join(dir, "session.jsonl");
	const details = {
		schema: 1,
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
			JSON.stringify({ type: "custom_message", id: "m1", customType: "autonomy-notification-presentation", content: body, display: true, details }),
		].join("\n") + "\n",
	);
	return file;
};

const offerFor = (presentationId, body) => ({
	presentation_id: presentationId,
	content_offer_id: null,
	summary_offer_id: null,
	body,
	render_version: 1,
	get digest() {
		return sha256Hex(this.body);
	},
});

// ── THE RUNTIME CONTRACT: held stream vs. lease renewals on an ─────────
// H2-advertising TLS server, both over plain native fetch. On the
// tested runtime (Node 26.8.1 / Undici 8.10) the H2 multiplexer carries
// the renewals underneath the held stream; with REAL expiry semantics,
// any blocked/late renewal would be refused 410 — zero denials is the
// whole point.

test("native H2 transport: a held SSE stream shares the pooled connection while >=3 lease budgets renew underneath it", { timeout: 30000 }, async (t) => {
	const budgetMs = 1200; // derived renewal delay: one third = 400ms
	const OFFER_A = offerFor(7, "the initial server-rendered body");
	const OFFER_B = offerFor(8, "a genuinely new arrival after the initial offer");
	const fixture = makeTlsFixture({
		budgetMs,
		onStreamConnection: (res, conn) => {
			if (conn.index === 1) {
				// Hold the stream across several lease budgets, then deliver
				// the initial offer and end cleanly.
				openSse(res);
				setTimeout(() => {
					presentationEvent(res, OFFER_A);
					res.end();
				}, 3 * budgetMs + 200);
			} else {
				// A new arrival on a later connection.
				openSse(res);
				presentationEvent(res, OFFER_B);
				res.end();
			}
		},
	});
	const port = await listen(fixture.server);
	const w = startTlsWorker(port);
	t.after(async () => {
		await stopWorker(w);
		await stopFixture(fixture);
	});

	// The initial offer is delivered from the held stream.
	const deliverA = await w.waitFor((l) => l.includes('"kind":"deliver"'), "first deliver");
	assert.equal(JSON.parse(deliverA).message.details.presentationId, OFFER_A.presentation_id);

	// Qualifying disk bytes exist → serialized reconciliation acks it.
	const sessionFile = writeSessionFile(OFFER_A.body, OFFER_A.presentation_id, `https://localhost:${port}`);
	w.send({ event: "session", sessionId: "sess-1", sessionFile });
	w.send({ event: "reconcile" });
	await w.waitFor((l) => l.includes('"kind":"ack"'), "qualifying recorded ack");
	assert.equal(fixture.acks.length, 1, "exactly one acknowledge for the qualifying receipt");
	assert.deepEqual(fixture.acks[0], {
		presentation_id: OFFER_A.presentation_id,
		expected_digest: OFFER_A.digest,
	});

	// A genuinely new arrival after the initial offer is delivered too.
	await w.waitFor(
		(l) => {
			try {
				const p = JSON.parse(l);
				return p.kind === "deliver" && p.message.details.presentationId === OFFER_B.presentation_id;
			} catch {
				return false;
			}
		},
		"second deliver (new arrival)",
	);

	// THE CORE: renewals reached the server and completed while the stream
	// was held. With REAL expiry semantics, any blocked/late renewal would
	// have been refused 410 — zero denials is the whole point.
	const stream1 = fixture.streamConns[0];
	assert.ok(stream1, "one stream connection was made");
	assert.ok(
		stream1.closedAt - stream1.openedAt >= 3 * budgetMs,
		"the held stream spans at least three elapsed lease budgets",
	);
	const renewalsDuringHold = fixture.requests.filter(
		(r) => r.url === "/notifications/lease/renew" && r.at >= stream1.openedAt && r.at <= stream1.closedAt,
	);
	assert.ok(
		renewalsDuringHold.length >= 3,
		`>=3 renewal sequences must complete during the held stream (got ${renewalsDuringHold.length})`,
	);
	const sequences = renewalsDuringHold.map((r) => JSON.parse(r.body).sequence);
	assert.deepEqual(sequences, sequences.slice().sort((a, b) => a - b), "renewal sequences increase");
	assert.ok(sequences.every((s, i) => s === i + 1), "the exact next sequence, no gaps");
	for (let i = 1; i < renewalsDuringHold.length; i++) {
		const gap = renewalsDuringHold[i].at - renewalsDuringHold[i - 1].at;
		assert.ok(gap < budgetMs, `each renewal completed well inside its budget (gap ${gap}ms)`);
	}
	assert.equal(fixture.deniedRenewals.length, 0, "no ownership loss under real expiry semantics");

	// The stream went over native fetch and negotiated HTTP/2 with the
	// ALPN h2+http/1.1 fixture — the shared-connection production shape.
	assert.equal(stream1.proto, "h2", "the stream uses native HTTP/2 via ALPN");
	const controlPorts = new Set(
		fixture.requests.filter((r) => r.url !== STREAM_PATH).map((r) => r.remotePort),
	);
	assert.ok(controlPorts.size > 0, "control requests completed on their own schedule");
	assert.ok(
		controlPorts.has(stream1.remotePort),
		"control renewals multiplex over the SAME connection as the held stream",
	);

	// No ownership-loss stream_error anywhere.
	assert.ok(
		!w.lines.some((l) => l.includes("stream_error")),
		"no ownership-loss stream_error was seen",
	);
});

// ── redirect refusal: never followed, destination never contacted ────────

test("stream transport: a redirect response is refused — the destination is never contacted and nothing is forwarded", { timeout: 20000 }, async (t) => {
	const destinationRequests = [];
	const destination = http.createServer((req, res) => {
		destinationRequests.push(req.url);
		res.end();
	});
	const destinationPort = await listen(destination);
	const fixture = makeTlsFixture({
		onStreamConnection: (res) => {
			res.writeHead(302, { location: `http://127.0.0.1:${destinationPort}/credential-catcher` });
			res.end();
		},
	});
	const port = await listen(fixture.server);
	const w = startTlsWorker(port);
	t.after(async () => {
		await stopWorker(w);
		await stopFixture(fixture);
		destination.close();
	});

	// The refusal is a visible static-class failure — never a silent retry
	// against the redirect destination.
	await w.waitFor(
		(l) => l.includes('"kind":"wake"') && l.includes("[notifications.sse]"),
		"visible refusal wake",
	);
	await sleep(400);
	assert.equal(destinationRequests.length, 0, "the redirect destination was never contacted");
	assert.equal(w.child.exitCode, null, "the worker keeps running");
});

// ── TLS verification still fails closed ──────────────────────────────────

test("stream transport: TLS errors still fail closed — no request is sent without a verifiable chain", { timeout: 20000 }, async (t) => {
	const fixture = makeTlsFixture({ onStreamConnection: (res) => openSse(res) });
	const port = await listen(fixture.server);
	const w = startTlsWorker(port, { extraCa: null }); // NO fixture CA trust
	t.after(async () => {
		await stopWorker(w);
		await stopFixture(fixture);
	});

	await w.waitFor(
		(l) => l.includes('"kind":"wake"') && l.includes("[notifications.sse]"),
		"visible TLS failure wake",
	);
	await sleep(300);
	assert.equal(fixture.requests.length, 0, "no HTTP request reached the server (TLS failed first)");
	assert.equal(w.child.exitCode, null, "the worker keeps running");
});

// ── ownership drop closes the stream promptly; control keeps working ──
// The abort path must not wedge anything (abort-after-headers must make
// the body iteration REJECT, never masquerade as a clean end).

test("ownership drop aborts the held stream promptly and control requests keep completing", { timeout: 30000 }, async (t) => {
	const OFFER_C = offerFor(12, "delivery after honest re-acquisition");
	const fixture = makeTlsFixture({
		budgetMs: 900, // derived renewal delay: 300ms
		renewGoneAfter: 2, // the third renewal is refused 410 → dropLease
		onStreamConnection: (res, conn) => {
			openSse(res);
			if (conn.index > 1) {
				presentationEvent(res, OFFER_C);
				res.end();
			} // the first stream stays open until ownership is dropped
		},
	});
	const port = await listen(fixture.server);
	const w = startTlsWorker(port);
	t.after(async () => {
		await stopWorker(w);
		await stopFixture(fixture);
	});

	// After the 410, ownership is dropped, the held stream is aborted, and
	// the worker honestly re-acquires and delivers the new arrival.
	await w.waitFor(
		(l) => {
			try {
				const p = JSON.parse(l);
				return p.kind === "deliver" && p.message.details.presentationId === OFFER_C.presentation_id;
			} catch {
				return false;
			}
		},
		"delivery after re-acquisition",
		12000,
	);

	const firstDenial = fixture.deniedRenewals[0];
	assert.ok(firstDenial, "the scripted ownership loss happened");
	const stream1 = fixture.streamConns[0];
	assert.ok(stream1?.closedAt !== null, "the held stream connection closed");
	assert.ok(
		stream1.closedAt - firstDenial.at < 1000,
		`the stream was released promptly after the drop (${stream1.closedAt - firstDenial.at}ms)`,
	);
	// Control requests completed AFTER the abort (nothing is wedged).
	const controlAfter = fixture.requests.filter(
		(r) => r.url !== STREAM_PATH && r.at > firstDenial.at,
	);
	assert.ok(
		controlAfter.some((r) => r.url === "/notifications/lease/claim"),
		"re-acquisition (whoami/status/claim) completed after the abort",
	);
});
