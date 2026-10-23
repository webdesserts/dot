import { readFileSync, statSync } from "node:fs";
import { readQualifyingReceipts } from "../../../extensions/notifications.sse.protocol.mjs";
import { ACTOR_ID } from "./large-session.mjs";

const [mode, file] = process.argv.slice(2);
let result;
if (mode === "whole-string") {
	try { readFileSync(file, "utf8"); result = { unexpectedSuccess: true }; }
	catch (error) { result = { errorCode: error.code }; }
} else {
	const read = readQualifyingReceipts(file, "owned-session", "owned-scope", "rhea", ACTOR_ID);
	result = { ok: read.ok, reason: read.reason, receipts: read.receipts };
}
console.log(JSON.stringify({ bytes: statSync(file).size, ...result, peakRssKiB: process.resourceUsage().maxRSS }));
