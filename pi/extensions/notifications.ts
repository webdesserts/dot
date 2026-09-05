/**
 * Autonomy notification transport adapter for Pi.
 *
 * One worker per parent session; native subagents must not consume its queue.
 * Use /reload or restart/resume after changing either file. A file watcher is
 * unnecessary: Pi reloads extensions without discarding the conversation.
 * Delivery policy belongs to Autonomy, not this process supervisor.
 */
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const WORKER_PATH = path.join(
	path.dirname(realpathSync(fileURLToPath(import.meta.url))),
	"notifications.worker.mjs",
);
const RESPAWN_DELAY_MS = 2_000;

export default function (pi) {
	// pi-subagents marks its background runtime explicitly; session_start does
	// not carry the systemPromptOptions used by before_agent_start.
	if (process.env.PI_SUBAGENT_CHILD === "1") return;

	let running = false;
	let child = null;
	let respawnTimer = null;

	const send = (message) => {
		if (!message) return;
		try {
			pi.sendUserMessage(message, { deliverAs: "steer" });
		} catch (err) {
			console.error(`[notifications] send failed: ${err}`);
		}
	};

	const spawnWorker = () => {
		if (!running || child) return;
		const spawned = spawn(process.execPath, [WORKER_PATH], {
			env: process.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		child = spawned;
		let stdoutBuf = "";
		spawned.stdout.on("data", (chunk) => {
			if (child !== spawned || !running) return;
			stdoutBuf += chunk;
			let idx;
			while ((idx = stdoutBuf.indexOf("\n")) !== -1) {
				const line = stdoutBuf.slice(0, idx);
				stdoutBuf = stdoutBuf.slice(idx + 1);
				if (!line) continue;
				try {
					const parsed = JSON.parse(line);
					if ((parsed.kind === "wake" || parsed.kind === "heartbeat") && typeof parsed.message === "string") {
						send(parsed.message);
					}
				} catch {
					send(line);
				}
			}
		});
		spawned.stderr.on("data", (chunk) => console.error(`[notifications.worker] ${chunk}`));
		const exited = (reason) => {
			// An old child's late exit must not clear a replacement's handle or
			// schedule another worker. Error followed by exit also runs only once.
			if (child !== spawned) return;
			child = null;
			if (!running) return;
			console.error(`[notifications.worker] stopped (${reason}); retry in ${RESPAWN_DELAY_MS}ms`);
			respawnTimer = setTimeout(() => {
				respawnTimer = null;
				spawnWorker();
			}, RESPAWN_DELAY_MS);
		};
		spawned.on("exit", exited);
		spawned.on("error", exited);
	};

	pi.on("session_start", () => {
		if (running) return;
		running = true;
		spawnWorker();
	});
	pi.on("session_shutdown", () => {
		running = false;
		if (respawnTimer) clearTimeout(respawnTimer);
		respawnTimer = null;
		const stopped = child;
		child = null;
		stopped?.kill();
	});
	const forward = (name) => () => {
		if (child?.stdin?.writable) child.stdin.write(`${JSON.stringify({ event: name })}\n`);
	};
	pi.on("agent_start", forward("agent_start"));
	pi.on("agent_end", forward("agent_end"));
}
