/** Owned LF fixtures written in reusable bounded buffers, never one archive-sized JS string. */
import { constants } from "node:buffer";
import { closeSync, openSync, statSync, writeSync } from "node:fs";
import crypto from "node:crypto";
import { CUSTOM_TYPE } from "../../../extensions/notifications.sse.protocol.mjs";

export const LARGE_SESSION_BYTES = Math.max(540 * 1024 * 1024, constants.MAX_STRING_LENGTH + 1024 * 1024);
export const ACTOR_ID = "6f1c2a34-0000-4000-8000-000000000001";
export const digest = (text) => crypto.createHash("sha256").update(text, "utf8").digest("hex");
export const header = (sessionId = "owned-session") => ({ type: "session", id: sessionId, version: 3,
	timestamp: "2026-10-22T00:00:00.000Z", cwd: "/owned-fixture" });
export function receipt(body = "old owned presentation", id = 7, { sessionId = "owned-session", scope = "owned-scope", ...details } = {}) {
	return { type: "custom_message", id: `receipt-${id}`, parentId: null, timestamp: "2026-10-22T00:00:00.000Z",
		customType: CUSTOM_TYPE, display: true, content: body,
		details: { schema: 1, scope, recipient: "rhea", actorId: ACTOR_ID, sessionId,
			presentationId: id, renderVersion: 1, digest: digest(body), contentOfferId: null, summaryOfferId: 0, ...details } };
}

export function appendPadding(file, targetBytes = LARGE_SESSION_BYTES) {
	const fd = openSync(file, "a");
	const size = 64 * 1024;
	const prefix = Buffer.from('{"type":"custom","id":"pad-000000000000","parentId":null,"timestamp":"2026-10-22T00:00:00.000Z","customType":"owned-padding","data":"');
	const suffix = Buffer.from('"}\n');
	const record = Buffer.alloc(size, 0x78);
	prefix.copy(record);
	suffix.copy(record, size - suffix.length);
	try {
		let bytes = statSync(file).size;
		while (bytes < targetBytes) {
			record.write(String(bytes).padStart(12, "0"), prefix.indexOf("000000000000"), 12, "ascii");
			let offset = 0;
			while (offset < record.length) offset += writeSync(fd, record, offset, record.length - offset);
			bytes += record.length;
		}
		return bytes;
	} finally { closeSync(fd); }
}

export function appendSizedRecord(file, bytes) {
	const fd = openSync(file, "a");
	const prefix = Buffer.from('{"type":"custom","data":"');
	const suffix = Buffer.from('"}\n');
	const filler = Buffer.alloc(64 * 1024, 0x78);
	try {
		writeSync(fd, prefix);
		let remaining = bytes - prefix.length - suffix.length;
		while (remaining > 0) {
			const count = Math.min(remaining, filler.length);
			remaining -= writeSync(fd, filler, 0, count);
		}
		writeSync(fd, suffix);
	} finally { closeSync(fd); }
}
