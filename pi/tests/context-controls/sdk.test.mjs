import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveSdkExport } from "./sdk.mjs";

for (const layout of ["hoisted", "nested"]) {
	test(`selected SDK peer resolution follows public exports in ${layout} dependency layout`, async (t) => {
		const dir = await mkdtemp(join(tmpdir(), "sdk-resolution-"));
		t.after(() => rm(dir, { recursive: true, force: true }));
		const sdk = join(dir, "node_modules/@earendil-works/pi-coding-agent");
		const peer = join(layout === "nested" ? sdk : dir, "node_modules/@earendil-works/pi-ai");
		await mkdir(sdk, { recursive: true });
		await mkdir(join(peer, "providers"), { recursive: true });
		await writeFile(join(sdk, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", type: "module", exports: { ".": { import: "./index.mjs" } } }));
		await writeFile(join(sdk, "index.mjs"), "export {};");
		await writeFile(join(peer, "package.json"), JSON.stringify({ name: "@earendil-works/pi-ai", type: "module", exports: {
			".": { import: "./index.mjs" }, "./providers/*": { import: "./providers/*.mjs" },
		} }));
		await writeFile(join(peer, "index.mjs"), "export {};");
		await writeFile(join(peer, "providers/faux.mjs"), "export {};");
		assert.equal(resolveSdkExport("@earendil-works/pi-ai", "./providers/faux", sdk), pathToFileURL(join(peer, "providers/faux.mjs")).href);
		assert.equal(resolveSdkExport("@earendil-works/pi-coding-agent", ".", sdk), pathToFileURL(join(sdk, "index.mjs")).href);
		assert.throws(() => resolveSdkExport("@earendil-works/pi-ai", "./missing", sdk), /SDK fixture cannot resolve.*PI_SDK_ROOT/);
	});
}
