/** Resolve fixture peers from the selected SDK, independent of npm's hoisting layout. */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { findPackageJSON } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const sdkRoot = resolve(process.env.PI_SDK_ROOT ?? join(
	execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(),
	"@earendil-works/pi-coding-agent",
));

export function resolveSdkExport(packageName, subpath = ".", root = sdkRoot) {
	try {
		const manifest = packageName === "@earendil-works/pi-coding-agent"
			? join(root, "package.json")
			: findPackageJSON(packageName, pathToFileURL(join(root, "package.json")));
		if (!manifest) throw new Error(`package ${packageName} is not resolvable`);
		const pkg = JSON.parse(readFileSync(manifest, "utf8"));
		const key = Object.keys(pkg.exports ?? {}).find((key) => key === subpath ||
			(key.includes("*") && subpath.startsWith(key.split("*")[0]) && subpath.endsWith(key.split("*")[1])));
		const entry = pkg.exports?.[key];
		let target = typeof entry === "string" ? entry : entry?.import;
		if (typeof target !== "string") throw new Error(`no public import export ${subpath}`);
		if (key.includes("*")) {
			const [prefix, suffix] = key.split("*");
			target = target.replace("*", subpath.slice(prefix.length, suffix ? -suffix.length : undefined));
		}
		return pathToFileURL(resolve(dirname(manifest), target)).href;
	} catch (error) {
		throw new Error(`SDK fixture cannot resolve ${packageName}/${subpath} from ${root}. Set PI_SDK_ROOT to a compatible installed Pi SDK; no packages are installed by this fixture.`, { cause: error });
	}
}

async function importSdkExport(packageName, subpath = ".") {
	const url = resolveSdkExport(packageName, subpath);
	try { return await import(url); }
	catch (error) {
		throw new Error(`SDK fixture cannot import ${packageName}/${subpath} at ${url}. Verify PI_SDK_ROOT and the installed package's public exports before running these checks.`, { cause: error });
	}
}

export const sdk = await importSdkExport("@earendil-works/pi-coding-agent");
export const faux = await importSdkExport("@earendil-works/pi-ai", "./providers/faux");
for (const name of ["createAgentSession", "SessionManager", "SettingsManager", "DefaultResourceLoader", "ModelRuntime"]) {
	if (!sdk[name]) throw new Error(`SDK fixture requires ${name} from ${sdkRoot}; qualify this installed SDK before running consumer tests.`);
}
if (typeof faux.fauxProvider !== "function") throw new Error(`SDK fixture requires the public faux provider export from ${sdkRoot}.`);
