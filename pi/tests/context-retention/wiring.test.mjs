import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";

test("dots settings select retention for parents and native children", async () => {
	const settings = JSON.parse(await readFile(new URL("../../settings.json", import.meta.url), "utf8"));
	assert.equal(settings.extensions.filter((path) => path === "extensions/context-retention").length, 1);
	assert.equal(settings.subagents.defaultSubagentOnlyExtensions.filter((path) => path === "~/.pi/agent/extensions/context-retention").length, 1);
	assert.ok((await stat(new URL("../../extensions/context-retention/index.ts", import.meta.url))).isFile());
});
