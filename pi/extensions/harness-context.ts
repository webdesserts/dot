/**
 * Load shared host guidance and the selected agent's current Working Memory.
 * AUTONOMY_AGENT_ID is an explicit per-process convention, independent of cwd.
 * Native children use their handoff instead of automatically loading parent memory.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const HOME = os.homedir();
const ORCHESTRATOR = path.join(HOME, ".config/agents/orchestrator.md");
const NOTETAKING = path.join(HOME, ".config/agents/notetaking.md");
const DEVICE = path.join(HOME, "Device.md");

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

export default function harnessContext(pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event) => {
		if (process.env.PI_SUBAGENT_CHILD === "1") return;

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
		if (!validAgentId(agentId)) {
			parts.push("# Agent memory unavailable\n\nSet AUTONOMY_AGENT_ID explicitly: a lowercase ASCII letter followed by letters, digits, hyphens or underscores, at most 64 characters. No private Working Memory was loaded; identity is never inferred from cwd.");
		} else {
			parts.push(`# Agent identity\n\nAgent ID: ${agentId}. When calling Remember, supply agent_id: \"${agentId}\". This selects context, not access permissions.`);
			const file = path.join(HOME, "notes", "agents", agentId, `Working Memory — ${agentId}.md`);
			try {
				const content = fs.readFileSync(file, "utf8").trim();
				parts.push(`# Working Memory — ${agentId} (reread this turn)\n\n${content}`);
			} catch {
				parts.push(`# Agent memory unavailable\n\nCould not read ${file}. No other Working Memory was loaded as a fallback.`);
			}
		}

		return { systemPrompt: `${event.systemPrompt}\n\n${parts.join("\n\n---\n\n")}` };
	});
}
