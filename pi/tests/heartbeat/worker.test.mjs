/**
 * Behavioral tests for the goal-heartbeat worker
 * (pi/extensions/notifications.worker.mjs) in the LEGACY long-poll mode
 * (explicit AUTONOMY_SSE_MODE=0; SSE presentation streaming is the
 * worker's default transport and is covered by
 * tests/notifications-sse/worker.test.mjs).
 *
 * Each test spawns the worker as a real child process and points it at a
 * local fake HTTP server that scripts long-poll responses. No live daemon,
 * no credentials. The ambient cadence is shortened via
 * AUTONOMY_HEARTBEAT_MS in fixtures that exercise ambient behavior.
 *
 * Run: node --test tests/heartbeat/worker.test.mjs   (from the repo root)
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import assert from "node:assert/strict";
import { test } from "node:test";

const WORKER_PATH = new URL("../../extensions/notifications.worker.mjs", import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Fake long-poll daemon. `script` is a list of entries:
 *   { status = 200, body = null, delay = 40 }
 * A 200 entry with a body becomes the sticky response — once the script is
 * exhausted, every further poll re-serves the last 200 body (modeling the
 * daemon's persistent-row re-offer). A script-less server answers {} (a
 * genuinely empty response). Every request's url + headers are recorded.
 */
function makeFakeServer(script = []) {
	let idx = 0;
	let last = null;
	const requests = [];
	const server = createServer((req, res) => {
		let raw = "";
		req.on("data", (c) => (raw += c));
		req.on("end", () => {
			requests.push({ url: req.url, headers: req.headers, body: raw });
			const entry =
				idx < script.length
					? script[idx++]
					: last ?? { status: 200, body: {}, delay: 40 };
			if (entry.status === 200 && entry.body !== null) last = entry;
			const { status = 200, body = null, delay = 40 } = entry;
			setTimeout(() => {
				res.writeHead(status, { "content-type": "application/json" });
				res.end(body === null ? "" : JSON.stringify(body));
			}, delay);
		});
	});
	return { server, requests };
}

async function listen(server) {
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	return server.address().port;
}

function spawnWorker(port, extraEnv = {}) {
	const child = spawn(process.execPath, [WORKER_PATH], {
		env: {
			...process.env,
			AUTONOMY_SSE_MODE: "0", // legacy long-poll: what these fixtures exercise
			AUTONOMY_BASE: `http://127.0.0.1:${port}`,
			AUTONOMY_ACTOR: "iris",
			AUTONOMY_TOKEN: "",
			AUTONOMY_HEARTBEAT_MS: "0",
			AUTONOMY_ERROR_BACKOFF_MS: "50",
			AUTONOMY_POLL_INTERVAL_MS: "30",
			...extraEnv,
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
	const lines = [];
	const stderr = [];
	let buf = "";
	child.stdout.on("data", (c) => {
		buf += c;
		let i;
		while ((i = buf.indexOf("\n")) !== -1) {
			const line = buf.slice(0, i);
			buf = buf.slice(i + 1);
			if (!line.trim()) continue;
			try {
				lines.push(JSON.parse(line));
			} catch {
				lines.push({ kind: "raw", message: line });
			}
		}
	});
	child.stderr.on("data", (c) => stderr.push(String(c)));
	return { child, lines, stderr };
}

const wakes = (lines) => lines.filter((l) => l.kind === "wake").map((l) => l.message);

/** Retry `fn` until it stops throwing or `ms` elapse. */
async function waitFor(fn, ms = 3000) {
	let lastErr;
	const start = Date.now();
	while (Date.now() - start < ms) {
		try {
			const r = fn();
			if (r !== false && r !== undefined) return r;
		} catch (e) {
			lastErr = e;
		}
		await sleep(15);
	}
	throw lastErr ?? new Error("waitFor timeout");
}

/** Assert exactly `n` wakes, then wait `quietMs` more and re-assert (no extras). */
async function assertWakeCount(lines, n, quietMs = 500) {
	await waitFor(() => {
		assert.equal(wakes(lines).length, n, `expected ${n} wakes, got ${wakes(lines).length}`);
		return true;
	});
	await sleep(quietMs);
	assert.equal(wakes(lines).length, n, "unexpected extra wake during quiet window");
}

async function stopWorker(w) {
	if (w.child.exitCode === null && w.child.signalCode === null) {
		w.child.kill();
		await waitFor(() => w.child.exitCode !== null, 2000).catch(() => {});
	}
}

// ── fixtures ──────────────────────────────────────────────────────────────
const rowA = { handle: "h-1", sender: "peri", place: "feed:main", resource_key: "feed:main.m:1", text: "hello iris" };
const batchA = { priority_notifications: [rowA], summary: {}, total: 1 };
const rowSameHandleChanged = { ...rowA, text: "hello iris (edited)" };
const emptyBody = { priority_notifications: [], summary: {}, total: 0 };

// ── transport tests (notification behavior is unchanged by the heartbeat) ──

test("unchanged persistent batch wakes exactly once (repeat suppression)", async () => {
	const fake = makeFakeServer([{ body: batchA }]);
	const port = await listen(fake.server);
	const w = spawnWorker(port);
	try {
		await assertWakeCount(w.lines, 1);
		const [msg] = wakes(w.lines);
		assert.match(msg, /peri @ feed:main \(feed:main\.m:1\): hello iris/);
		assert.equal(fake.requests.length > 0, true);
		assert.equal(fake.requests[0].headers["x-auth-user"], "iris");
		assert.match(fake.requests[0].url, /timeout=20/);
	} finally {
		await stopWorker(w);
		fake.server.close();
	}
});

test("changed text under the same handle emits a change (not silently lost)", async () => {
	const fake = makeFakeServer([
		{ body: batchA },
		{ body: { ...batchA, priority_notifications: [rowSameHandleChanged] } },
	]);
	const port = await listen(fake.server);
	const w = spawnWorker(port);
	try {
		await assertWakeCount(w.lines, 2);
		const [m1, m2] = wakes(w.lines);
		assert.match(m1, /hello iris/);
		assert.match(m2, /hello iris \(edited\)/);
	} finally {
		await stopWorker(w);
		fake.server.close();
	}
});

test("empty response resets suppression, so the same persistent row reappears", async () => {
	const fake = makeFakeServer([{ body: batchA }, { body: emptyBody }, { body: batchA }]);
	const port = await listen(fake.server);
	const w = spawnWorker(port);
	try {
		await assertWakeCount(w.lines, 2);
		const [m1, m2] = wakes(w.lines);
		assert.match(m1, /hello iris/);
		assert.match(m2, /hello iris/);
	} finally {
		await stopWorker(w);
		fake.server.close();
	}
});

test("error then recovery: first failure wakes once, unchanged retries stay quiet, recovery wake lands", async () => {
	const fake = makeFakeServer([
		{ status: 500 },
		{ status: 500 },
		{ status: 500 },
		{ body: batchA },
		{ status: 500 }, // new failure AFTER recovery → wakes again
		{ body: batchA }, // recovery again (sticky would serve this anyway)
	]);
	const port = await listen(fake.server);
	const w = spawnWorker(port, { AUTONOMY_ERROR_BACKOFF_MS: "30" });
	try {
		await waitFor(() => {
			assert.ok(wakes(w.lines).filter((m) => m.includes("poll failed")).length >= 2);
			return true;
		}, 4000);
		const failures = wakes(w.lines).filter((m) => m.includes("poll failed"));
		assert.equal(failures[0].includes("HTTP 500"), true);
		assert.ok(
			wakes(w.lines).some((m) => m.includes("hello iris")),
			"recovery batch wakes",
		);
	} finally {
		await stopWorker(w);
		fake.server.close();
	}
});

test("transport pacing bounds request rate when the server answers immediately", async () => {
	const fake = makeFakeServer([{ body: batchA, delay: 5 }]);
	const port = await listen(fake.server);
	const w = spawnWorker(port, { AUTONOMY_POLL_INTERVAL_MS: "200" });
	try {
		const before = fake.requests.length;
		await sleep(1300);
		const served = fake.requests.length - before;
		assert.ok(served >= 3, `loop should keep polling, only ${served} requests in 1.3s`);
		assert.ok(served <= 10, `request rate not bounded: ${served} requests in 1.3s`);
		assert.equal(wakes(w.lines).length, 1);
	} finally {
		await stopWorker(w);
		fake.server.close();
	}
});

test("stdin shutdown: closing stdin exits the worker cleanly", async () => {
	const fake = makeFakeServer([]); // only empty responses
	const port = await listen(fake.server);
	const w = spawnWorker(port);
	try {
		await sleep(150); // let it poll a couple of times
		const exited = new Promise((resolve) => w.child.on("exit", (code) => resolve(code)));
		w.child.stdin.end();
		const code = await Promise.race([exited, sleep(2000).then(() => "TIMEOUT")]);
		assert.equal(code, 0, `expected exit code 0 on stdin end, got ${code}`);
	} finally {
		await stopWorker(w);
		fake.server.close();
	}
});

// ── heartbeat mode tests (goal / ambient / paused) ────────────────────────

const heartbeats = (lines) => lines.filter((l) => l.kind === "heartbeat");
const beats = (lines) => heartbeats(lines).map((l) => l.message);
const send = (w, event) => w.child.stdin.write(`${JSON.stringify(event)}\n`);

// Quiet window long enough to also cover the 10s ambient fallback gate: if
// goal mode wrongly allowed the fallback, a canned ambient heartbeat would
// appear here.
const FALLBACK_WINDOW_MS = 10_500;

test('goal: generation-matched deferral rearms once; stale or paused deferral stays silent', async () => {
	const fake = makeFakeServer([]);
	const port = await listen(fake.server);
	const w = spawnWorker(port);
	try {
		send(w, { event: 'enable', idleDelayMs: 80, goal: 'retry after compaction', busy: false, generation: 1 });
		await waitFor(() => beats(w.lines).length === 1);
		send(w, { event: 'heartbeat_defer', generation: 0 });
		await sleep(150);
		assert.equal(beats(w.lines).length, 1);
		send(w, { event: 'heartbeat_defer', generation: 1 });
		await waitFor(() => beats(w.lines).length === 2);
		await sleep(150);
		assert.equal(beats(w.lines).length, 2);
		send(w, { event: 'pause', generation: 2 });
		send(w, { event: 'heartbeat_defer', generation: 1 });
		send(w, { event: 'heartbeat_defer', generation: 2 });
		await sleep(150);
		assert.equal(beats(w.lines).length, 2);
	} finally {
		await stopWorker(w);
		fake.server.close();
	}
});

test("goal: enable while idle arms exactly one delayed heartbeat (no agent_end needed), echoes the generation", async () => {
	const fake = makeFakeServer([]);
	const port = await listen(fake.server);
	const w = spawnWorker(port);
	try {
		send(w, { event: "agent_end" }); // before enable: ambient fallback gate keeps it silent
		await sleep(400);
		assert.equal(beats(w.lines).length, 0, "agent_end before enable stays silent");
		// What the supervisor sends for `/hb enable` while the parent is idle:
		// a fenced enable with the busy snapshot. This MUST arm the timer —
		// no further turn is required.
		send(w, { event: "enable", idleDelayMs: 300, goal: "review the heartbeat diff", busy: false, generation: 7 });
		await waitFor(() => {
			assert.equal(beats(w.lines).length, 1);
			return true;
		});
		const [hb] = heartbeats(w.lines);
		assert.equal(hb.generation, 7, "heartbeat echoes the generation it was armed under");
		assert.match(hb.message, /review the heartbeat diff/);
		assert.match(hb.message, /heartbeat_control pause/);
		assert.match(hb.message, /never invent work or authority/);
		await sleep(FALLBACK_WINDOW_MS);
		assert.equal(beats(w.lines).length, 1, "one-shot only; the 10s ambient fallback must not run in goal mode");
	} finally {
		await stopWorker(w);
		fake.server.close();
	}
});

test("goal: enable while busy stays silent until the parent actually goes idle", async () => {
	const fake = makeFakeServer([]);
	const port = await listen(fake.server);
	const w = spawnWorker(port);
	try {
		send(w, { event: "enable", idleDelayMs: 200, goal: "ctx", busy: true, generation: 4 });
		await sleep(600);
		assert.equal(beats(w.lines).length, 0, "busy enable must not arm");
		send(w, { event: "agent_end", generation: 5 }); // transition to idle arms
		await waitFor(() => {
			assert.equal(beats(w.lines).length, 1);
			return true;
		});
		assert.equal(heartbeats(w.lines)[0].generation, 5, "re-armed under the newer generation");
	} finally {
		await stopWorker(w);
		fake.server.close();
	}
});

test("goal: agent_start cancels the pending timer", async () => {
	const fake = makeFakeServer([]);
	const port = await listen(fake.server);
	const w = spawnWorker(port);
	try {
		send(w, { event: "enable", idleDelayMs: 300, goal: "ctx", busy: false, generation: 1 });
		await sleep(100); // timer pending, not yet fired
		send(w, { event: "agent_start", generation: 2 });
		await sleep(600);
		assert.equal(beats(w.lines).length, 0, "agent_start cleared the timer");
		send(w, { event: "agent_end", generation: 3 }); // arms again
		await waitFor(() => {
			assert.equal(beats(w.lines).length, 1);
			return true;
		});
		assert.equal(heartbeats(w.lines)[0].generation, 3);
	} finally {
		await stopWorker(w);
		fake.server.close();
	}
});

test("goal: pause cancels a pending timer and silences agent_end", async () => {
	const fake = makeFakeServer([]);
	const port = await listen(fake.server);
	const w = spawnWorker(port);
	try {
		send(w, { event: "enable", idleDelayMs: 300, goal: "ctx", busy: false, generation: 1 });
		await sleep(100); // timer armed by the idle enable
		send(w, { event: "pause", generation: 2 });
		await sleep(600);
		assert.equal(beats(w.lines).length, 0, "pause cleared the pending timer");
		send(w, { event: "agent_end", generation: 3 }); // paused: must not arm
		await sleep(600);
		assert.equal(beats(w.lines).length, 0);
	} finally {
		await stopWorker(w);
		fake.server.close();
	}
});

test("goal: twelve idle cycles fire twelve heartbeats — no wake-count exhaustion", async () => {
	const fake = makeFakeServer([]);
	const port = await listen(fake.server);
	const w = spawnWorker(port);
	try {
		send(w, { event: "enable", idleDelayMs: 60, goal: "long-running approved goal", busy: false, generation: 1 });
		await waitFor(() => beats(w.lines).length === 1);
		let gen = 1;
		for (let cycle = 2; cycle <= 12; cycle++) {
			send(w, { event: "agent_start", generation: ++gen }); // the wake triggered a turn
			send(w, { event: "agent_end", generation: ++gen }); // idle again, re-arm
			await waitFor(() => beats(w.lines).length === cycle, 2000);
		}
		assert.equal(beats(w.lines).length, 12, "no exhaustion at any count boundary");
	} finally {
		await stopWorker(w);
		fake.server.close();
	}
});

test("goal: repeated agent_end keeps a single timer (exactly one heartbeat per idle cycle)", async () => {
	const fake = makeFakeServer([]);
	const port = await listen(fake.server);
	const w = spawnWorker(port);
	try {
		send(w, { event: "enable", idleDelayMs: 200, goal: "ctx", busy: false, generation: 1 });
		send(w, { event: "agent_end", generation: 2 });
		send(w, { event: "agent_end", generation: 3 }); // re-arm must clear, not duplicate
		send(w, { event: "agent_end", generation: 4 });
		await waitFor(() => {
			assert.equal(beats(w.lines).length, 1);
			return true;
		});
		await sleep(500);
		assert.equal(beats(w.lines).length, 1);
	} finally {
		await stopWorker(w);
		fake.server.close();
	}
});

test("goal: overlarge delay is rejected, never clamped into a 1ms hot timer", async () => {
	const fake = makeFakeServer([]);
	const port = await listen(fake.server);
	const w = spawnWorker(port);
	try {
		// Node clamps setTimeout > 2^31-1ms to 1ms; the worker must refuse
		// such a delay instead of emitting a hot loop of heartbeats.
		send(w, { event: "enable", idleDelayMs: 10 ** 10, goal: "ctx", busy: false, generation: 1 });
		await sleep(600);
		assert.equal(beats(w.lines).length, 0, "unschedulable delay stays silent");
	} finally {
		await stopWorker(w);
		fake.server.close();
	}
});

test("goal: crash replay while idle arms exactly one delayed wake (no further turn needed)", async () => {
	const fake = makeFakeServer([]);
	const port = await listen(fake.server);
	const w = spawnWorker(port);
	try {
		// What the supervisor sends a respawned worker after a crash while the
		// parent was idle: same state, not a fresh one. This MUST arm — a
		// crash while idle may otherwise never see another agent_end.
		send(w, { event: "init", busy: false, mode: "goal", idleDelayMs: 150, goal: "replayed goal", holdUntil: 0, ambientExpiresAt: 0, generation: 9 });
		await waitFor(() => {
			assert.equal(beats(w.lines).length, 1);
			return true;
		});
		const [hb] = heartbeats(w.lines);
		assert.equal(hb.generation, 9);
		assert.match(hb.message, /replayed goal/);
	} finally {
		await stopWorker(w);
		fake.server.close();
	}
});

test("goal: crash replay while busy consumes the snapshot and stays silent until idle", async () => {
	const fake = makeFakeServer([]);
	const port = await listen(fake.server);
	const w = spawnWorker(port);
	try {
		send(w, { event: "init", busy: true, mode: "goal", idleDelayMs: 150, goal: "busy replay", holdUntil: 0, ambientExpiresAt: 0, generation: 3 });
		await sleep(500);
		assert.equal(beats(w.lines).length, 0, "busy replay must not arm");
		send(w, { event: "agent_end", generation: 4 }); // the in-flight turn ends
		await waitFor(() => {
			assert.equal(beats(w.lines).length, 1);
			return true;
		});
		assert.equal(heartbeats(w.lines)[0].generation, 4);
	} finally {
		await stopWorker(w);
		fake.server.close();
	}
});

// ── hold: absolute deadline, heartbeat-only ───────────────────────────────

test("hold pushes a pending goal timer out to the hold deadline, then fires once", async () => {
	const fake = makeFakeServer([]);
	const port = await listen(fake.server);
	const w = spawnWorker(port);
	try {
		send(w, { event: "enable", idleDelayMs: 100, goal: "held goal", busy: false, generation: 1 });
		await sleep(30); // timer pending, not yet fired
		const holdUntil = Date.now() + 700;
		send(w, { event: "hold", holdUntil, generation: 2 });
		await sleep(300);
		assert.equal(beats(w.lines).length, 0, "no beat before the hold deadline");
		await waitFor(() => {
			assert.equal(beats(w.lines).length, 1);
			return true;
		}, 2000);
		assert.ok(Date.now() >= holdUntil - 50, "beat fired no earlier than the hold deadline");
		await sleep(400);
		assert.equal(beats(w.lines).length, 1, "hold fires exactly once, then waits for an idle transition");
	} finally {
		await stopWorker(w);
		fake.server.close();
	}
});

test("hold during a busy run: the post-agent_end wake waits for the hold deadline too", async () => {
	const fake = makeFakeServer([]);
	const port = await listen(fake.server);
	const w = spawnWorker(port);
	try {
		send(w, { event: "init", busy: true, mode: "goal", idleDelayMs: 100, goal: "busy + hold", holdUntil: 0, ambientExpiresAt: 0, generation: 1 });
		const holdUntil = Date.now() + 600;
		send(w, { event: "hold", holdUntil, generation: 2 });
		const t0 = Date.now();
		send(w, { event: "agent_end", generation: 3 }); // run ends while still held
		await waitFor(() => {
			assert.equal(beats(w.lines).length, 1);
			return true;
		}, 2000);
		assert.ok(Date.now() - t0 >= 500, "wake scheduled no earlier than the hold deadline despite idleness");
	} finally {
		await stopWorker(w);
		fake.server.close();
	}
});

test("hold after emission reschedules from the current idle state (no agent_end needed)", async () => {
	const fake = makeFakeServer([]);
	const port = await listen(fake.server);
	const w = spawnWorker(port);
	try {
		send(w, { event: "enable", idleDelayMs: 100, goal: "ctx", busy: false, generation: 1 });
		await waitFor(() => beats(w.lines).length === 1);
		// Liveness: the beat cleared the timer and there may never be another
		// agent_end. The hold must (re)schedule from the current idle state.
		const holdUntil = Date.now() + 500;
		send(w, { event: "hold", holdUntil, generation: 2 });
		await sleep(300);
		assert.equal(beats(w.lines).length, 1, "no beat before the hold deadline");
		await waitFor(() => {
			assert.equal(beats(w.lines).length, 2);
			return true;
		}, 2000);
		assert.ok(Date.now() >= holdUntil - 50, "beat fired at the hold deadline without any agent_end");
		await sleep(300);
		assert.equal(beats(w.lines).length, 2, "exactly one rescheduled wake");
	} finally {
		await stopWorker(w);
		fake.server.close();
	}
});

// ── ambient: bounded fallback, fixed expiry ───────────────────────────────

test("complete enters ambient: cadence beats inside the window, arming clamped to the expiry, silence after it", async () => {
	const fake = makeFakeServer([]);
	const port = await listen(fake.server);
	const w = spawnWorker(port, { AUTONOMY_HEARTBEAT_MS: "250" });
	try {
		send(w, { event: "enable", idleDelayMs: 60, goal: "ctx", busy: false, generation: 1 });
		await waitFor(() => beats(w.lines).length === 1);
		const expiry = Date.now() + 800;
		send(w, { event: "complete", ambientExpiresAt: expiry, generation: 2 });
		// Drive two more ambient cycles inside the window (each wake's turn ends
		// with an agent_end, which re-arms the single ambient timer).
		send(w, { event: "agent_end", generation: 3 });
		await waitFor(() => beats(w.lines).length >= 2, 2000);
		send(w, { event: "agent_end", generation: 4 });
		await waitFor(() => beats(w.lines).length >= 3, 2000);
		// Wait past the fixed expiry, then prove nothing can extend it.
		await waitFor(() => Date.now() >= expiry + 100);
		const total = beats(w.lines).length; // 3 cycles, possibly a clamped expiry beat
		send(w, { event: "agent_end", generation: 5 });
		send(w, { event: "agent_end", generation: 6 });
		await sleep(500);
		assert.equal(beats(w.lines).length, total, "no ambient beats after the fixed expiry — own wakes/agent_end cannot extend it");
	} finally {
		await stopWorker(w);
		fake.server.close();
	}
});

test("ambient expiry in the past never arms, even via init or agent_end", async () => {
	const fake = makeFakeServer([]);
	const port = await listen(fake.server);
	const w = spawnWorker(port, { AUTONOMY_HEARTBEAT_MS: "100" });
	try {
		send(w, { event: "init", busy: false, mode: "ambient", idleDelayMs: 0, goal: "", holdUntil: 0, ambientExpiresAt: Date.now() - 1, generation: 1 });
		send(w, { event: "agent_end", generation: 2 });
		await sleep(FALLBACK_WINDOW_MS);
		assert.equal(beats(w.lines).length, 0, "expired fallback stays silent, 10s fallback included");
	} finally {
		await stopWorker(w);
		fake.server.close();
	}
});

test("ambient: init waits for the fallback gate; an explicit complete arms immediately", async () => {
	const fake = makeFakeServer([]);
	const port = await listen(fake.server);
	const w = spawnWorker(port, { AUTONOMY_HEARTBEAT_MS: "200" });
	try {
		send(w, { event: "init", busy: false, mode: "ambient", idleDelayMs: 0, goal: "", holdUntil: 0, ambientExpiresAt: Date.now() + 60_000, generation: 5 });
		await sleep(200);
		assert.equal(beats(w.lines).length, 0, "ambient waits for its fallback gate after init");
		send(w, { event: "complete", ambientExpiresAt: Date.now() + 60_000, generation: 6 });
		await waitFor(() => {
			assert.equal(beats(w.lines).length, 1);
			return true;
		}, 2000);
		assert.match(beats(w.lines)[0], /\[heartbeat\] 30-minute inactivity check/);
	} finally {
		await stopWorker(w);
		fake.server.close();
	}
});

test("hold past the ambient expiry refuses to arm: no wake at expiry or after", async () => {
	const fake = makeFakeServer([]);
	const port = await listen(fake.server);
	const w = spawnWorker(port, { AUTONOMY_HEARTBEAT_MS: "250" });
	try {
		send(w, { event: "enable", idleDelayMs: 60, goal: "ctx", busy: false, generation: 1 });
		await waitFor(() => beats(w.lines).length === 1);
		const expiry = Date.now() + 600;
		send(w, { event: "complete", ambientExpiresAt: expiry, generation: 2 });
		send(w, { event: "hold", holdUntil: Date.now() + 5000, generation: 3 }); // hold reaches past the window
		send(w, { event: "agent_end", generation: 4 }); // idle; due = max(interval, hold) > expiry → refuse
		await sleep(1200);
		assert.equal(beats(w.lines).length, 1, "an ambient due time past the expiry is refused, never pulled earlier");
	} finally {
		await stopWorker(w);
		fake.server.close();
	}
});

test("hold inside the ambient window: the wake waits for the hold deadline, not the cadence", async () => {
	const fake = makeFakeServer([]);
	const port = await listen(fake.server);
	const w = spawnWorker(port, { AUTONOMY_HEARTBEAT_MS: "250" });
	try {
		send(w, { event: "enable", idleDelayMs: 60, goal: "ctx", busy: false, generation: 1 });
		await waitFor(() => beats(w.lines).length === 1);
		send(w, { event: "complete", ambientExpiresAt: Date.now() + 3000, generation: 2 });
		await waitFor(() => beats(w.lines).length === 2, 2000); // first ambient beat at ~250ms
		const holdUntil = Date.now() + 500;
		send(w, { event: "hold", holdUntil, generation: 3 });
		send(w, { event: "agent_end", generation: 4 });
		await sleep(300);
		assert.equal(beats(w.lines).length, 2, "no beat before the hold deadline despite the shorter cadence");
		await waitFor(() => {
			assert.equal(beats(w.lines).length, 3);
			return true;
		}, 2000);
		assert.ok(Date.now() >= holdUntil - 50, "ambient wake honored the hold floor");
	} finally {
		await stopWorker(w);
		fake.server.close();
	}
});

test("paused: init mode silences everything, including the 10s fallback", async () => {
	const fake = makeFakeServer([]);
	const port = await listen(fake.server);
	const w = spawnWorker(port);
	try {
		send(w, { event: "init", busy: false, mode: "paused", idleDelayMs: 0, goal: "", holdUntil: 0, ambientExpiresAt: 0, generation: 1 });
		send(w, { event: "agent_end", generation: 2 });
		await sleep(FALLBACK_WINDOW_MS);
		assert.equal(beats(w.lines).length, 0, "paused session never heartbeats");
	} finally {
		await stopWorker(w);
		fake.server.close();
	}
});

test("ambient: an untouched session (no supervisor events) still falls back on the 10s gate, bounded by expiry", async () => {
	const fake = makeFakeServer([]);
	const port = await listen(fake.server);
	const w = spawnWorker(port, { AUTONOMY_HEARTBEAT_MS: "250" });
	try {
		await waitFor(() => {
			assert.equal(beats(w.lines).length, 1, "10s fallback arms the ambient heartbeat");
			return true;
		}, 12_000);
		const [hb] = heartbeats(w.lines);
		assert.match(hb.message, /\[heartbeat\] 30-minute inactivity check/);
		assert.equal(hb.generation, 0, "ambient heartbeat carries the startup generation");
		send(w, { event: "agent_end", generation: 1 }); // re-arm within the default bounded window
		await waitFor(() => {
			assert.equal(beats(w.lines).length, 2);
			return true;
		});
	} finally {
		await stopWorker(w);
		fake.server.close();
	}
});
