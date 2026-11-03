/** Native-summary retention policy; see README.md for its mutation contract. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerRetention } from "./hooks.ts";

export default function contextRetention(pi: ExtensionAPI) {
	registerRetention(pi);
}
