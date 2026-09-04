/**
 * notifications — poll the autonomy daemon's notification long-poll and wake the
 * agent when items arrive.
 *
 * WHY: pi has no self-wake primitive. The Claude-harness Monitor tasks could
 * message the orchestrator and force a turn; pi tools are synchronous and jobs
 * are poll-only. The daemon's notification system IS the machine's wake path —
 * it owns deduplication and noise reduction (Michael's design: subscribed posts
 * arrive LOW, mentions/replies always HIGH) — so this extension is a thin
 * cadence-poller, not logic. Every notification wakes, including our own posts;
 * the server filters.
 *
 * MECHANICS: `GET /notifications?timeout=S` (X-Auth-User header) holds up to S
 * seconds and answers as soon as anything undelivered arrives for the actor:
 * `{high: [{place, sender, text, resource_key, handle}], low: {summary, items},
 * retracted}`. Items are delivered ONCE per fetch (cursor is server-side);
 * `/notifications/list` is the durable view. On wake we `pi.sendUserMessage`,
 * which starts a turn when idle and queues as followUp while streaming.
 *
 * SUBAGENTS MUST NOT RUN THIS: a seat polling the actor's queue consumes the
 * actor's batch. Detection matches harness-context.ts: subagents are spawned
 * with --append-system-prompt, so `systemPromptOptions.appendSystemPrompt` set
 * ⇒ do not poll.
 *
 * Config via env: AUTONOMY_BASE (default http://127.0.0.1:4600),
 * AUTONOMY_ACTOR (default "iris" — per-session identity is a TODO when two
 * guests share a machine), AUTONOMY_WAKE_COOLDOWN_MS (default 30000),
 * AUTONOMY_HEARTBEAT_MS (default 300000 — 5-minute self-wake so the agent
 * re-checks queue status and plans next steps even with no feed traffic;
 * 0 disables). Michael's ruling 2026-09-04: the heartbeat keeps overnight
 * autonomous work on the rails.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const BASE = process.env.AUTONOMY_BASE ?? "http://127.0.0.1:4600";
const ACTOR = process.env.AUTONOMY_ACTOR ?? "iris";
const POLL_HOLD_SECONDS = 20;
const WAKE_COOLDOWN_MS = Number(process.env.AUTONOMY_WAKE_COOLDOWN_MS ?? 30_000);
const ERROR_BACKOFF_MS = 5_000;
const HEARTBEAT_MS = Number(process.env.AUTONOMY_HEARTBEAT_MS ?? 300_000);

interface NotificationItem {
	place?: string;
	sender?: string;
	text?: string;
	resource_key?: string;
}

/// Post-t:264 wire shape (deployed 2026-09-04): persistent items stay in the
/// queue until explicitly dismissed, LOW notifications are reduced to per-place
/// counts, and `total` is the recipient's full live count across both urgencies.
interface LongPollResponse {
	priority_notifications?: NotificationItem[];
	summary?: Record<string, number>;
	total?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function renderItem(item: NotificationItem, tier: string): string {
	const place = item.place ? ` @ ${item.place}` : "";
	const key = item.resource_key ? ` (${item.resource_key})` : "";
	return `- [${tier}] ${item.sender ?? "?"}${place}${key}: ${item.text ?? "(no text)"}`;
}

function render(
	data: LongPollResponse,
	priority: NotificationItem[],
	summary: Record<string, number>,
): string {
	const lines: string[] = [];
	for (const item of priority) lines.push(renderItem(item, "HIGH"));
	const places = Object.entries(summary ?? {});
	for (const [place, count] of places) lines.push(`- [low] ${place}: ${count}`);
	if (data.total !== undefined) lines.push(`total unattended: ${data.total}`);
	if (lines.length === 0) {
		// Shape changed under us again (the endpoint keeps evolving — t:264
		// was itself a reshape). Wake anyway with a raw dump so the agent can
		// adapt at source.
		return `autonomy notifications: response shape not recognized — inspecting raw:\n${JSON.stringify(data).slice(0, 2000)}`;
	}
	const head = `autonomy notifications (${priority.length} high, ${places.length} places, total ${data.total ?? "?"}):`;
	return `${head}\n${lines.join("\n")}`;
}

export default function (pi: ExtensionAPI) {
	let running = false;

	pi.on("session_start", async (event) => {
		// Match harness-context.ts: subagents are spawned with --append-system-prompt.
		const isSubagent = Boolean(event.systemPromptOptions?.appendSystemPrompt);
		if (isSubagent || running) return;
		running = true;

		const controller = new AbortController();
		pi.on("session_shutdown", async () => {
			running = false;
			controller.abort();
		});

		void (async () => {
			let lastWake = 0;
			let backlog: string[] = [];

			// Heartbeat: periodic self-wake. sendUserMessage starts a turn when
			// idle; while streaming it queues as followUp, so a tick never
			// interrupts work in flight — it only guarantees the agent revisits
			// queue status at least every HEARTBEAT_MS.
			if (HEARTBEAT_MS > 0) {
				const heartbeat = setInterval(() => {
					if (!running) {
						clearInterval(heartbeat);
						return;
					}
					const message =
						"[heartbeat] 5-minute check: run queue-watch, compare against the overnight plan, " +
						"do the next unblocked step or dispatch/report on a worker. If everything is truly " +
						"blocked and there is genuinely nothing to plan, end this turn immediately — do not pad.";
					try {
						pi.sendUserMessage(message);
					} catch {
						pi.sendUserMessage(message, { streamingBehavior: "followUp" });
					}
				}, HEARTBEAT_MS);
			}

			while (running) {
				try {
					const res = await fetch(`${BASE}/notifications?timeout=${POLL_HOLD_SECONDS}`, {
						headers: { "X-Auth-User": ACTOR },
						signal: controller.signal,
					});
					if (!res.ok) throw new Error(`HTTP ${res.status}`);
					const data = (await res.json()) as LongPollResponse;
					const priority = (data.priority_notifications ?? []).filter((n) => n.sender !== ACTOR);
					const summary = Object.fromEntries(
						Object.entries(data.summary ?? {}).filter(([place]) => !place.startsWith(`${ACTOR}/`)),
					);
					// Own-echo rows are consumed (delivery cursor advances) but never
					// wake — Michael's ruling: own posts should not alert. The service
					// store has no sender exclusion at write (verified at source), so
					// the filter lives here until it moves server-side.
					const trivial = priority.length === 0 && Object.keys(summary).length === 0
						&& (data.total === undefined || data.total === 0);
					if (trivial) continue;

					const now = Date.now();
					if (now - lastWake < WAKE_COOLDOWN_MS) {
						// Cooldown: buffer the lines so nothing rendered is lost — the
						// next wake carries them. (The durable list holds regardless.)
						for (const item of priority) backlog.push(renderItem(item, "HIGH"));
						for (const [place, count] of Object.entries(summary)) backlog.push(`- [low] ${place}: ${count}`);
						continue;
					}
					lastWake = now;
					const buffered = backlog.splice(0);
					const message =
						buffered.length > 0
							? `autonomy notifications (buffered during cooldown):\n${buffered.join("\n")}`
							: render(data, priority, summary);
					try {
						pi.sendUserMessage(message);
					} catch {
						// streaming right now — docs require an explicit delivery mode
						pi.sendUserMessage(message, { streamingBehavior: "followUp" });
					}
				} catch (err) {
					if (controller.signal.aborted) break;
					// Daemon down or transient — back off and keep the loop alive.
					console.error(`[notifications] poll failed: ${err}; retrying in ${ERROR_BACKOFF_MS}ms`);
					await sleep(ERROR_BACKOFF_MS);
				}
			}
		})();
	});
}
