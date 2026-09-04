/**
 * notifications — autonomy-daemon wake bridge for pi (supervisor shim).
 *
 * ARCHITECTURE (2026-09-04): pi sessions are always resumed — resumed
 * sessions restore their extension SNAPSHOT, so code in this file is frozen
 * at whatever session first loaded it. To keep the bridge updatable without
 * ever requiring a fresh session, this file is a deliberately boring
 * SUPERVISOR: it spawns `notifications.worker.mjs` (read fresh from disk at
 * every spawn) as a child process, forwards pi lifecycle events to the
 * child's stdin, and delivers the child's stdout wake messages through
 * `pi.sendUserMessage` with { streamingBehavior: "steer" } (never bare —
 * bare calls are refused and DROPPED while the agent is busy).
 *
 * ALL bridge logic lives in the worker: polling, filtering, wake-diff
 * signatures, cooldown/backlog, rendering, the idle heartbeat. Updating the
 * bridge = edit the worker file, then either restart the session or
 * `pkill -f notifications.worker` (this supervisor respawns it within
 * RESPAWN_DELAY_MS with the new code). The supervisor itself should never
 * need to change; if it does, that's the one exception that needs a fresh
 * session.
 *
 * SUBAGENTS MUST NOT SPAWN THE WORKER: subagents are spawned with
 * --append-system-prompt (matches harness-context.ts's detection), and a
 * seat polling the actor's queue would consume the actor's batch.
 *
 * Config via env (inherited by the worker): AUTONOMY_BASE,
 * AUTONOMY_ACTOR, AUTONOMY_TOKEN, AUTONOMY_WAKE_COOLDOWN_MS,
 * AUTONOMY_HEARTBEAT_MS.
 */

import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const WORKER_PATH = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"notifications.worker.mjs",
);
const RESPAWN_DELAY_MS = 2_000;

export default function (pi) {
	let running = false;
	let child = null;
	let watcher = null;
	let respawnTimer = null;

	const send = (message) => {
		if (!message) return;
		try {
			// steer: injected in-between rounds of a running turn (Michael's
			// ruling). NEVER bare — while busy the runtime refuses and DROPS.
			pi.sendUserMessage(message, { streamingBehavior: "steer" });
		} catch (err) {
			console.error(`[notifications] send failed: ${err}`);
		}
	};

	const spawnWorker = () => {
		if (!running) return;
		if (child) return;
		child = spawn(process.execPath, [WORKER_PATH], {
			env: process.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdoutBuf = "";
		child.stdout.on("data", (chunk) => {
			stdoutBuf += chunk;
			let idx;
			while ((idx = stdoutBuf.indexOf("\n")) !== -1) {
				const line = stdoutBuf.slice(0, idx);
				stdoutBuf = stdoutBuf.slice(idx + 1);
				if (!line) continue;
				try {
					const parsed = JSON.parse(line);
					if (parsed.kind === "wake" || parsed.kind === "heartbeat") send(parsed.message);
				} catch {
					// non-JSON line — surface it as a wake so nothing is lost
					send(line);
				}
			}
		});
		child.stderr.on("data", (chunk) => {
			console.error(`[notifications.worker] ${chunk}`);
		});
		child.on("exit", (code) => {
			child = null;
			if (!running) return;
			console.error(`[notifications.worker] exited (${code}); respawn in ${RESPAWN_DELAY_MS}ms`);
			respawnTimer = setTimeout(spawnWorker, RESPAWN_DELAY_MS);
		});
	};

	const killWorker = () => {
		if (child) {
			try {
				child.kill();
			} catch {}
			child = null;
		}
	};

	// Hot-swap: when the worker file changes on disk, respawn so the new
	// code loads without touching the session.
	const armWatcher = () => {
		try {
			watcher = watch(WORKER_PATH, () => {
				console.error("[notifications] worker file changed — respawning");
				killWorker();
				spawnWorker();
			});
		} catch (err) {
			console.error(`[notifications] fs.watch unavailable: ${err}`);
		}
	};

	pi.on("session_start", async (event) => {
		const isSubagent = Boolean(event.systemPromptOptions?.appendSystemPrompt);
		if (isSubagent || running) return;
		running = true;

		pi.on("session_shutdown", async () => {
			running = false;
			if (watcher) watcher.close();
			if (respawnTimer) clearTimeout(respawnTimer);
			killWorker();
		});

		// Forward lifecycle events to the worker's stdin (the heartbeat's
		// turn-end re-arm needs agent_start/agent_end visibility).
		const forward = (name) => (payload) => {
			if (child?.stdin?.writable) {
				child.stdin.write(`${JSON.stringify({ event: name })}\n`);
			}
		};
		pi.on("agent_start", forward("agent_start"));
		pi.on("agent_end", forward("agent_end"));

		spawnWorker();
		armWatcher();
	});
}
