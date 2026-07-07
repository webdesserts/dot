/**
 * harness-context — inject the orchestrator's live context into the system prompt.
 *
 * WHY: opencode dropped re-injected instructions + Working Memory on compaction.
 * pi's system prompt is NOT a session entry — it's re-assembled per turn and sent
 * straight in the payload, so compaction (which only operates on the append-only
 * entry tree) can never touch it. Appending here = structurally compaction-exempt,
 * permanently, with zero config.
 *
 * Files are read FRESH FROM DISK every turn (single source of truth = the dots
 * repo + the notes vault; no duplicated copies to go stale). Working Memory in
 * particular changes constantly mid-session, so re-reading each turn is required.
 *
 * PORTABLE: paths are resolved from os.homedir(), so this works unchanged on any
 * machine in the fleet (umbra=nir, charon/rhea=michael). Device.md is the
 * per-machine seam — each machine supplies its own ~/Device.md.
 *
 * Subagents are spawned with --append-system-prompt (their role prompt); they get
 * live Working Memory only, NOT the full orchestrator doctrine.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const HOME = os.homedir();
const ORCHESTRATOR = path.join(HOME, ".config/agents/orchestrator.md");
const NOTETAKING = path.join(HOME, ".dots/webdesserts-private/obsidian-memory/notetaking.md");
const DEVICE = path.join(HOME, "Device.md");
const WORKING_MEMORY = path.join(HOME, "notes/Working Memory.md");

function readSafe(p: string): string {
	try {
		return fs.readFileSync(p, "utf-8").trim();
	} catch {
		return "";
	}
}

export default function harnessContext(pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event) => {
		// Heuristic: spawned role subagents carry an appended system prompt.
		const isSubagent = Boolean(event.systemPromptOptions?.appendSystemPrompt);

		const parts: string[] = [];

		if (!isSubagent) {
			const orchestrator = readSafe(ORCHESTRATOR);
			const notetaking = readSafe(NOTETAKING);
			const device = readSafe(DEVICE);
			if (orchestrator) parts.push(`# Orchestrator\n\n${orchestrator}`);
			if (notetaking) parts.push(`# Notetaking\n\n${notetaking}`);
			if (device) parts.push(`# Device\n\n${device}`);
		}

		// Working Memory: injected for the orchestrator AND every subagent.
		const workingMemory = readSafe(WORKING_MEMORY);
		if (workingMemory) {
			parts.push(`# Working Memory (live — re-read from disk every turn)\n\n${workingMemory}`);
		}

		if (parts.length === 0) return;

		return {
			systemPrompt: `${event.systemPrompt}\n\n${parts.join("\n\n---\n\n")}`,
		};
	});
}
