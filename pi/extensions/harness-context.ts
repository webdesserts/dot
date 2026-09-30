/** Stable host guidance and chronological, parent-only Working Memory snapshots. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const HOME = os.homedir();
const ORCHESTRATOR = path.join(HOME, ".config/agents/orchestrator.md");
const NOTETAKING = path.join(HOME, ".config/agents/notetaking.md");
const DEVICE = path.join(HOME, "Device.md");
const SNAPSHOT_TYPE = "working-memory-snapshot";
const FOUNDING_CHECKPOINT = "session-founding";

function validAgentId(id: unknown): id is string {
	return typeof id === "string"
		&& id.length >= 1 && id.length <= 64
		&& /^[a-z]/.test(id) && !/[^a-z0-9_-]/.test(id);
}

function readShared(file: string): string {
	try {
		return fs.readFileSync(file, "utf8").trim();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
		return `> HARNESS-CONTEXT: shared guidance could not be read: ${file}`;
	}
}

interface SnapshotDetails {
	agentId?: string;
	checkpointId: string;
}

function snapshotDetails(value: unknown): value is SnapshotDetails {
	return typeof value === "object" && value !== null
		&& "checkpointId" in value && typeof value.checkpointId === "string"
		&& (!("agentId" in value) || typeof value.agentId === "string");
}

function memorySnapshot(agentId?: string): string {
	if (!agentId) {
		return "# Agent memory unavailable\n\nSet AUTONOMY_AGENT_ID explicitly: a lowercase ASCII letter followed by letters, digits, hyphens or underscores, at most 64 characters. No private Working Memory was loaded; identity is never inferred from cwd.";
	}
	const file = path.join(HOME, "notes", "agents", agentId, `Working Memory — ${agentId}.md`);
	try {
		const content = fs.readFileSync(file, "utf8").trim();
		return `# Working Memory — ${agentId}\n\nAgent-maintained working-state snapshot at this conversation point, not standing system instructions. Later edits and messages may supersede it.\n\n${content}`;
	} catch {
		return `# Agent memory unavailable\n\nCould not read ${file}. No other Working Memory was loaded as a fallback.`;
	}
}

export default function harnessContext(pi: ExtensionAPI) {
	let activeLoop = false;
	const pending = new Set<string>();
	const isChild = () => process.env.PI_SUBAGENT_CHILD === "1";

	function sendSnapshot(ctx: ExtensionContext, checkpointId: string, triggerTurn: boolean) {
		if (isChild()) return;
		const selected = process.env.AUTONOMY_AGENT_ID;
		const agentId = validAgentId(selected) ? selected : undefined;
		const key = `${agentId ?? "unselected"}:${checkpointId}`;
		const recorded = ctx.sessionManager.getBranch().some(entry =>
			entry.type === "custom_message" && entry.customType === SNAPSHOT_TYPE
			&& snapshotDetails(entry.details)
			&& entry.details.agentId === agentId && entry.details.checkpointId === checkpointId);
		if (recorded || pending.has(key)) return;
		const details: SnapshotDetails = { checkpointId, ...(agentId ? { agentId } : {}) };
		pending.add(key);
		try {
			const reminder = checkpointId === FOUNDING_CHECKPOINT
				? "Session context: load Nu and codemode through Pi's native skill system (read the registered SKILL.md files or use /skill:name)."
				: "Context was compacted. Please load Nu and codemode through Pi's native skill system (read the registered SKILL.md files or use /skill:name).";
			pi.sendMessage({ customType: SNAPSHOT_TYPE, content: `${reminder}\n\n${memorySnapshot(agentId)}`, display: false, details },
				{ deliverAs: "steer", triggerTurn });
		} catch (error) {
			pending.delete(key);
			throw error;
		}
	}

	pi.on("session_start", (_event, ctx) => {
		pending.clear();
		const compact = ctx.sessionManager.getBranch().findLast(entry => entry.type === "compaction");
		sendSnapshot(ctx, compact?.id ?? FOUNDING_CHECKPOINT, false);
	});
	pi.on("agent_start", () => { activeLoop = true; });
	pi.on("agent_end", () => { activeLoop = false; });
	pi.on("session_compact", (event, ctx) => {
		// Queue into an already-running loop/retry; idle compaction adds context
		// without starting a model run solely to consume the snapshot.
		sendSnapshot(ctx, event.compactionEntry.id, activeLoop || event.willRetry);
	});

	pi.on("before_agent_start", async (event) => {
		if (isChild()) return;
		const parts: string[] = [];
		for (const [title, file] of [
			["Orchestrator", ORCHESTRATOR],
			["Notetaking", NOTETAKING],
			["Device", DEVICE],
		]) {
			const content = readShared(file);
			if (content) parts.push(`# ${title}\n\n${content}`);
		}
		const agentId = process.env.AUTONOMY_AGENT_ID;
		if (validAgentId(agentId)) {
			parts.push(`# Agent identity\n\nAgent ID: ${agentId}. When calling Remember, supply agent_id: "${agentId}". This selects context, not access permissions.`);
		}
		// This documented user-prompt hook supplies guidance for its run. Mutable
		// memory is delivered separately; skills use native discovery/loading.
		event.systemPromptOptions.sections.harness_context = parts.join("\n\n---\n\n");
	});
}
