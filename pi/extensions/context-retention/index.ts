/** Native-summary retention policy; see README.md for its version-qualified mutation contract. */
import { VERSION, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerRetention } from "./hooks.ts";

export default function contextRetention(pi: ExtensionAPI) {
	registerRetention(pi, VERSION);
}
