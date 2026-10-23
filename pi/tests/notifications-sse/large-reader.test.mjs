import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { constants } from "node:buffer";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { appendPadding, header, receipt } from "./fixtures/large-session.mjs";

const PROBE = fileURLToPath(new URL("./fixtures/read-probe.mjs", import.meta.url));

test("a valid archive beyond Node's whole-string limit yields disk receipts with bounded reader memory", { timeout: 90_000 }, (t) => {
	const dir = mkdtempSync(join(tmpdir(), "sse-large-owned-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const file = join(dir, "session.jsonl");
	writeFileSync(file, `${JSON.stringify(header())}\n${JSON.stringify(receipt())}\n`);
	const bytes = appendPadding(file);
	assert.ok(bytes > constants.MAX_STRING_LENGTH && bytes > 537_000_000);
	const probe = (mode) => JSON.parse(execFileSync(process.execPath,
		["--max-old-space-size=256", PROBE, mode, file], { encoding: "utf8", timeout: 60_000, maxBuffer: 16 * 1024 }));
	const originalPrimitive = probe("whole-string");
	assert.equal(originalPrimitive.errorCode, "ERR_STRING_TOO_LONG", "the actual old whole-UTF8 primitive fails at this size");
	const result = probe("receipts");
	t.diagnostic(JSON.stringify({ bytes, maxStringLength: constants.MAX_STRING_LENGTH,
		wholeStringError: originalPrimitive.errorCode, oldPeakRssKiB: originalPrimitive.peakRssKiB,
		readerPeakRssKiB: result.peakRssKiB, readerOk: result.ok }));
	assert.equal(result.ok, true, "the actual receipt reader must not materialize the whole archive");
	assert.equal(result.receipts.length, 1);
	assert.equal(result.receipts[0].presentationId, 7);
	assert.equal(result.receipts[0].summaryOfferId, 0);
	assert.ok(result.peakRssKiB < 256 * 1024, "flat small-record archive scan stays under the owned process memory budget");
});
