/**
 * Shared hermeticity helpers for context-controls tests: owned-directory
 * worker cleanup, original-env capture/restore, and awaited worker exit.
 * ORIGINAL_ENV is captured at module load — before any test mutates env —
 * so teardown restores the true originals, not a previous test's fakes.
 */
import { execFileSync } from "node:child_process";

export const killStrayWorkers = (dir) => {
	try {
		const out = execFileSync("ps", ["-eo", "pid,command"], { encoding: "utf8" });
		for (const line of out.split("\n")) {
			if (line.includes("notifications.worker.mjs") && line.includes(dir)) {
				const pid = Number.parseInt(line.trim().split(/\s+/)[0], 10);
				if (Number.isFinite(pid)) {
					try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
				}
			}
		}
	} catch { /* ps unavailable: nothing to clean */ }
};

const ORIGINAL_ENV = {
	base: process.env.AUTONOMY_BASE,
	poll: process.env.AUTONOMY_POLL_INTERVAL_MS,
	timeout: process.env.AUTONOMY_FETCH_TIMEOUT_MS,
	hb: process.env.AUTONOMY_HEARTBEAT_MS,
	backoff: process.env.AUTONOMY_ERROR_BACKOFF_MS,
	child: process.env.PI_SUBAGENT_CHILD,
};

export const setFakeAutonomyEnv = (base) => {
	process.env.AUTONOMY_BASE = base;
	process.env.AUTONOMY_POLL_INTERVAL_MS = "50";
	process.env.AUTONOMY_FETCH_TIMEOUT_MS = "2000";
	process.env.AUTONOMY_HEARTBEAT_MS = "0";
	process.env.AUTONOMY_ERROR_BACKOFF_MS = "200";
};

export const restoreOriginalEnv = () => {
	for (const [k, v] of Object.entries({
		AUTONOMY_BASE: ORIGINAL_ENV.base,
		AUTONOMY_POLL_INTERVAL_MS: ORIGINAL_ENV.poll,
		AUTONOMY_FETCH_TIMEOUT_MS: ORIGINAL_ENV.timeout,
		AUTONOMY_HEARTBEAT_MS: ORIGINAL_ENV.hb,
		AUTONOMY_ERROR_BACKOFF_MS: ORIGINAL_ENV.backoff,
	})) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	if (ORIGINAL_ENV.child === undefined) delete process.env.PI_SUBAGENT_CHILD;
	else process.env.PI_SUBAGENT_CHILD = ORIGINAL_ENV.child;
};

/** True when no notification worker spawned under `dir` remains alive. */
export const workersAlive = (dir) => {
	try {
		const out = execFileSync("ps", ["-eo", "pid,command"], { encoding: "utf8" });
		return out.split("\n").filter((l) => l.includes("notifications.worker.mjs") && l.includes(dir)).length;
	} catch {
		return -1; // ps unavailable: unknown
	}
};

/** Await exit of every notification worker spawned under `dir`. */
export async function awaitWorkerExit(dir, ms = 5000) {
	const start = Date.now();
	for (;;) {
		const alive = workersAlive(dir);
		if (alive === 0) return true;
		if (alive < 0) return false;
		if (Date.now() - start > ms) return false;
		await new Promise((r) => setTimeout(r, 100));
	}
}
