import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACTOR_ID, header, receipt, appendSizedRecord } from "./fixtures/large-session.mjs";
import { MAX_SESSION_RECORD_BYTES, MAX_SESSION_RECEIPTS, RECEIPT_READ_CHUNK_BYTES, readQualifyingReceipts } from "../../extensions/notifications.sse.protocol.mjs";

const line = (entry) => `${JSON.stringify(entry)}\n`;
function owned(t, data = line(header()) + line(receipt())) {
	const dir = fs.mkdtempSync(join(tmpdir(), "sse-reader-owned-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const file = join(dir, "session.jsonl");
	fs.writeFileSync(file, data);
	return { file, dir, read: () => readQualifyingReceipts(file, "owned-session", "owned-scope", "rhea", ACTOR_ID) };
}

function interceptRead(t, action, { failClose = false, readLimit } = {}) {
	const originalRead = fs.readSync;
	const originalClose = fs.closeSync;
	let readerFd;
	let calls = 0;
	let closes = 0;
	fs.readSync = (...args) => {
		readerFd = args[0];
		if (readLimit) args[3] = Math.min(args[3], readLimit);
		const count = originalRead(...args);
		action(++calls, args[0], count);
		return count;
	};
	fs.closeSync = (fd) => {
		if (fd !== readerFd) return originalClose(fd);
		closes++;
		const result = originalClose(fd);
		if (failClose) throw Object.assign(new Error("owned injected close failure"), { code: "EIO" });
		return result;
	};
	syncBuiltinESMExports();
	t.after(() => { fs.readSync = originalRead; fs.closeSync = originalClose; syncBuiltinESMExports(); });
	return () => closes;
}

test("LF framing and split UTF8 codepoints preserve exact body/digest/null-versus-zero", (t) => {
	const body = "receipt 🌱漢字";
	const text = line(receipt(body));
	const unicode = Buffer.byteLength(text.slice(0, text.indexOf("🌱")));
	const prefix = line(header());
	const padding = RECEIPT_READ_CHUNK_BYTES - Buffer.byteLength(prefix) - unicode - 1;
	// JSONL blank whitespace is valid; the four-byte emoji crosses the read boundary.
	const f = owned(t, prefix + " ".repeat(padding) + text);
	const read = f.read();
	assert.equal(read.ok, true);
	assert.equal(read.receipts.length, 1);
	assert.equal(read.receipts[0].digest, receipt(body).details.digest);
	assert.equal(read.receipts[0].contentOfferId, null);
	assert.equal(read.receipts[0].summaryOfferId, 0);
	const lfBoundary = owned(t, prefix + " ".repeat(RECEIPT_READ_CHUNK_BYTES - Buffer.byteLength(prefix) - 1) + "\n" + text);
	assert.equal(lfBoundary.read().receipts.length, 1, "LF exactly at a chunk edge retains the next complete record");
});

test("valid JSON without final LF is not evidence; append beyond the initial snapshot waits for another pass", (t) => {
	const f = owned(t, line(header()) + JSON.stringify(receipt()));
	const closes = interceptRead(t, (n) => { if (n === 1) fs.appendFileSync(f.file, "\n"); });
	assert.deepEqual(f.read(), { ok: true, receipts: [] });
	assert.equal(closes(), 1);
	const next = f.read();
	assert.equal(next.ok, true);
	assert.equal(next.receipts.length, 1);
	assert.equal(closes(), 2);
});

test("a malformed partial tail is not parsed until its LF arrives, then invalidates the entire pass", (t) => {
	const f = owned(t, Buffer.concat([Buffer.from(line(header()) + line(receipt())), Buffer.from([0x22, 0xff])]));
	assert.equal(f.read().ok, true);
	assert.equal(f.read().receipts.length, 1);
	fs.appendFileSync(f.file, "\n");
	assert.equal(f.read().ok, false);
	assert.deepEqual(f.read().receipts, []);
});

test("malformed complete JSON/UTF8/non-entry records after a valid receipt discard all authority", (t) => {
	for (const tail of [Buffer.from("{bad JSON}\n"), Buffer.from([0x22, 0xff, 0x22, 0x0a]), Buffer.from("null\n"), Buffer.from("{}\n"), Buffer.from('{"type":0}\n')]) {
		const f = owned(t, Buffer.concat([Buffer.from(line(header()) + line(receipt())), tail]));
		assert.deepEqual(f.read(), { ok: false, reason: "unparseable line (refusing the whole file)", receipts: [] });
	}
});

test("BOM-prefixed JSON remains refused while BOM-only whitespace remains ignorable", (t) => {
	for (const data of ["\ufeff" + line(header()) + line(receipt()), line(header()) + "\ufeff" + line(receipt())]) {
		const f = owned(t, data);
		assert.equal(f.read().ok, false);
		assert.deepEqual(f.read().receipts, []);
	}
	const whitespace = owned(t, line(header()) + "\ufeff\n" + line(receipt()));
	assert.equal(whitespace.read().ok, true);
	assert.equal(whitespace.read().receipts.length, 1);
});

test("record safety limit is inclusive excluding LF; oversized complete/partial records fail closed", (t) => {
	const f = owned(t);
	appendSizedRecord(f.file, MAX_SESSION_RECORD_BYTES + 1); // includes LF
	assert.equal(f.read().ok, true);
	fs.appendFileSync(f.file, line(receipt("after large record", 8)));
	assert.equal(f.read().receipts.length, 2);
	appendSizedRecord(f.file, MAX_SESSION_RECORD_BYTES + 2);
	const oversized = f.read();
	assert.equal(oversized.ok, false);
	assert.match(oversized.reason, /64 MiB/);
	assert.deepEqual(oversized.receipts, []);
	fs.truncateSync(f.file, fs.statSync(f.file).size - 1); // oversized partial tail still cannot accumulate indefinitely
	assert.equal(f.read().ok, false);
});

test("candidate count is bounded and refusal diagnostics never retain arbitrary schema/version/id payloads", (t) => {
	const f = owned(t, line(header()));
	const entry = receipt();
	entry.details.schema = { nested: "DYNAMIC_PAYLOAD".repeat(10_000) };
	entry.details.presentationId = { unsafe: "DYNAMIC_PAYLOAD" };
	fs.appendFileSync(f.file, line(entry));
	let read = f.read();
	assert.equal(read.receipts[0].reason, "unsupported metadata schema");
	assert.equal(read.receipts[0].presentationId, null);
	assert.ok(!JSON.stringify(read).includes("DYNAMIC_PAYLOAD"));
	for (const id of [0, 7, null, "DYNAMIC_PAYLOAD".repeat(10_000), { nested: "DYNAMIC_PAYLOAD".repeat(10_000) }]) {
		const foreign = receipt("owned", 7, { scope: "foreign-scope", presentationId: id });
		fs.writeFileSync(f.file, line(header()) + line(foreign));
		const refused = f.read();
		assert.equal(refused.receipts[0].reason, "scope mismatch", "this path refuses before presentationId validation");
		assert.equal(refused.receipts[0].presentationId, id === 0 || id === 7 ? id : null);
		assert.ok(!JSON.stringify(refused).includes("DYNAMIC_PAYLOAD"));
	}
	entry.details.schema = 1;
	entry.details.presentationId = 1;
	entry.details.renderVersion = { payload: "DYNAMIC_PAYLOAD" };
	fs.writeFileSync(f.file, line(header()) + line(entry));
	assert.equal(f.read().receipts[0].reason, "unsupported renderVersion");
	const candidate = { type: "custom_message", customType: entry.customType, display: false };
	const bytes = Buffer.from(line(candidate));
	fs.writeFileSync(f.file, line(header()) + line(receipt()));
	const fd = fs.openSync(f.file, "a");
	try { for (let i = 1; i < MAX_SESSION_RECEIPTS; i++) fs.writeSync(fd, bytes); }
	finally { fs.closeSync(fd); }
	read = f.read();
	assert.equal(read.ok, true);
	assert.equal(read.receipts.length, MAX_SESSION_RECEIPTS);
	assert.equal(read.receipts[0].refused, undefined, "the valid prefix must also be discarded if the next candidate exceeds the bound");
	fs.appendFileSync(f.file, bytes);
	read = f.read();
	assert.equal(read.ok, false);
	assert.match(read.reason, /100000 receipt candidates/);
	assert.deepEqual(read.receipts, []);
});

test("short reads preserve framing and close the pinned FD once", (t) => {
	const f = owned(t);
	const closes = interceptRead(t, () => {}, { readLimit: 7 });
	assert.equal(f.read().receipts.length, 1);
	assert.equal(closes(), 1);
});

test("observed early EOF after truncation discards even a parsed valid prefix", (t) => {
	const f = owned(t, line(header()) + line(receipt()) + " ".repeat(RECEIPT_READ_CHUNK_BYTES * 2));
	const closes = interceptRead(t, (n) => { if (n === 1) fs.truncateSync(f.file, 0); });
	const read = f.read();
	assert.equal(read.ok, false);
	assert.match(read.reason, /truncated during/);
	assert.deepEqual(read.receipts, []);
	assert.equal(closes(), 1);
});

for (const mutation of ["truncate", "replace", "same-size-write", "read-error", "close-error"]) {
	test(`detected ${mutation} discards parsed receipts and closes the pinned FD`, (t) => {
		const f = owned(t);
		const closes = interceptRead(t, (n) => {
			if (n !== 1) return;
			if (mutation === "truncate") fs.truncateSync(f.file, 0);
			if (mutation === "replace") {
				fs.renameSync(f.file, join(f.dir, "original.jsonl"));
				fs.writeFileSync(f.file, line(header()) + line(receipt()));
			}
			if (mutation === "same-size-write") {
				fs.writeFileSync(f.file, line(header()) + line(receipt("Old owned presentation")));
				fs.utimesSync(f.file, new Date(0), new Date(0));
			}
			if (mutation === "read-error") throw Object.assign(new Error("owned injected IO failure"), { code: "EIO" });
		}, { failClose: mutation === "close-error" });
		const read = f.read();
		assert.equal(read.ok, false);
		assert.deepEqual(read.receipts, []);
		assert.equal(closes(), 1);
	});
}

test("only the first complete nonblank entry can be the real header; duplicate headers discard a good prefix", (t) => {
	const late = owned(t, line(receipt()) + line(header()));
	assert.equal(late.read().ok, false);
	assert.match(late.read().reason, /header.*first/);
	for (const nextHeader of [header(), header("foreign-session")]) {
		const duplicate = owned(t, line(header()) + line(receipt()) + line(nextHeader));
		assert.equal(duplicate.read().ok, false);
		assert.match(duplicate.read().reason, /multiple session headers/);
		assert.deepEqual(duplicate.read().receipts, []);
	}
	const blanks = owned(t, "\n \t\n" + line(header()) + line(receipt()));
	assert.equal(blanks.read().receipts.length, 1);
});

test("legacy missing optional part references stay null, while unsafe typed references refuse", (t) => {
	const legacy = receipt();
	delete legacy.details.contentOfferId;
	delete legacy.details.summaryOfferId;
	const f = owned(t, line(header()) + line(legacy));
	assert.equal(f.read().receipts[0].contentOfferId, null);
	assert.equal(f.read().receipts[0].summaryOfferId, null);
	for (const value of ["0", -1, 0.5, Number.MAX_SAFE_INTEGER + 1, {}]) {
		const invalid = owned(t, line(header()) + line(receipt("owned", 7, { contentOfferId: value })));
		assert.equal(invalid.read().receipts[0].refused, true);
	}
});

test("a non-regular file and an absent path authorize nothing", (t) => {
	const f = owned(t);
	assert.equal(readQualifyingReceipts(f.dir, "owned-session", "owned-scope", "rhea", ACTOR_ID).ok, false);
	assert.equal(readQualifyingReceipts(join(f.dir, "absent"), "owned-session", "owned-scope", "rhea", ACTOR_ID).ok, false);
});
