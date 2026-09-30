import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type ServerConfig = Parameters<ExtensionAPI["registerMcpServer"]>[1];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isServerConfig(value: unknown): value is ServerConfig {
	return isRecord(value) && (typeof value.command === "string" || typeof value.url === "string");
}

/** Select existing parent banks without adding them to the shared child MCP configuration. */
export default function mcpProfiles(pi: ExtensionAPI) {
	if (process.env.PI_SUBAGENT_CHILD === "1") return;

	pi.registerFlag("mcp-config", {
		description: "Select the existing Iris or Peri parent-only native MCP profile",
		type: "string",
	});

	pi.on("session_start", () => {
		const identity = process.env.AUTONOMY_AGENT_ID;
		const selected = pi.getFlag("mcp-config");
		if (selected === undefined && identity !== "iris" && identity !== "peri") return;
		if (identity !== "iris" && identity !== "peri") {
			throw new Error("Parent MCP profile requires explicit Iris or Peri identity");
		}
		const expected = join(homedir(), ".pi", "agent", `mcp-${identity}.json`);
		if (selected !== undefined && (typeof selected !== "string" || realpathSync(selected) !== realpathSync(expected))) {
			throw new Error("Parent MCP profile does not match this agent identity");
		}
		const profile: unknown = JSON.parse(readFileSync(expected, "utf8"));
		if (!isRecord(profile) || !isRecord(profile.mcpServers)) {
			throw new Error("Invalid parent MCP profile");
		}
		const shared = new Set(["obsidian-memory", "nushell", "brave-search"]);
		const bankNames = identity === "iris" ? ["hindsight-iris", "hindsight-shared"] : ["hindsight-peri"];
		const banks = new Map<string, ServerConfig>();
		for (const [name, config] of Object.entries(profile.mcpServers)) {
			if (shared.has(name)) continue;
			if (!bankNames.includes(name) || !isServerConfig(config)) {
				throw new Error("Unexpected server in parent MCP profile");
			}
			banks.set(name, config);
		}
		if (bankNames.some((name) => !banks.has(name))) throw new Error("Parent MCP profile is missing an expected bank");
		for (const [name, config] of banks) pi.registerMcpServer(name, config);
	});
}
