/** Conservative views of Pi-generated file inventories; archived objects are never edited. */
export function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function fileList(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((path) => typeof path === "string" && path.length > 0 && !/[\r\n]/.test(path))
		&& value.every((path, i) => i === 0 || value[i - 1] < path);
}

function nativeView(entry: unknown) {
	if (!record(entry) || !["compaction", "branch_summary"].includes(String(entry.type)) ||
		entry.fromHook === true || typeof entry.summary !== "string" || !record(entry.details) ||
		!fileList(entry.details.readFiles) || !fileList(entry.details.modifiedFiles)) return;
	const { readFiles, modifiedFiles } = entry.details;
	if (readFiles.some((path) => modifiedFiles.includes(path))) return;
	const sections = [
		readFiles.length ? `<read-files>\n${readFiles.join("\n")}\n</read-files>` : "",
		modifiedFiles.length ? `<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>` : "",
	].filter(Boolean);
	const suffix = sections.length ? `\n\n${sections.join("\n\n")}` : "";
	if (suffix && !entry.summary.endsWith(suffix)) return;
	return { entry, summary: suffix ? entry.summary.slice(0, -suffix.length) : entry.summary };
}

export function cleanEntry<T>(entry: T): T {
	const view = nativeView(entry);
	if (!view) return entry;
	const { readFiles: _read, modifiedFiles: _modified, ...details } = view.entry.details as Record<string, unknown>;
	return { ...view.entry, summary: view.summary, details } as T;
}

export function cleanSummary(summary: string, entries: readonly unknown[], type = "compaction", fromId?: unknown): string {
	for (const entry of entries) {
		if (!record(entry) || entry.type !== type || entry.summary !== summary ||
			(type === "branch_summary" && fromId !== undefined && entry.fromId !== fromId)) continue;
		const view = nativeView(entry);
		if (view) return view.summary;
	}
	return summary;
}

export function cleanMessage<T>(message: T, entries: readonly unknown[]): T {
	if (!record(message) || typeof message.summary !== "string") return message;
	const type = message.role === "compactionSummary" ? "compaction" : message.role === "branchSummary" ? "branch_summary" : undefined;
	if (!type) return message;
	const summary = cleanSummary(message.summary, entries, type, message.fromId);
	return summary === message.summary ? message : { ...message, summary };
}

function mutable(object: object, keys: string[]) {
	return keys.every((key) => {
		const descriptor = Object.getOwnPropertyDescriptor(object, key);
		return descriptor ? descriptor.writable === true : Object.isExtensible(object);
	});
}

function messages(value: unknown): boolean {
	return Array.isArray(value) && value.every((message) => record(message) && typeof message.role === "string" &&
		(!["compactionSummary", "branchSummary"].includes(message.role) || typeof message.summary === "string"));
}

/** Shape check for the source-qualified 1.4.0 preparation alias, before any mutation. */
export function supportedPreparation(value: unknown): boolean {
	if (!record(value) || typeof value.firstKeptEntryId !== "string" || !value.firstKeptEntryId ||
		typeof value.tokensBefore !== "number" || !Number.isFinite(value.tokensBefore) || value.tokensBefore < 0 ||
		typeof value.isSplitTurn !== "boolean" || !messages(value.messagesToSummarize) || !messages(value.turnPrefixMessages) ||
		(value.previousSummary !== undefined && typeof value.previousSummary !== "string") ||
		!record(value.fileOps) || !record(value.settings)) return false;
	const { fileOps, settings } = value;
	return ["read", "written", "edited"].every((key) => fileOps[key] instanceof Set &&
		[...fileOps[key]].every((path) => typeof path === "string")) &&
		typeof settings.enabled === "boolean" &&
		["reserveTokens", "keepRecentTokens"].every((key) => typeof settings[key] === "number" &&
			Number.isSafeInteger(settings[key]) && settings[key] >= 0) &&
		mutable(value, ["previousSummary", "messagesToSummarize", "turnPrefixMessages", "fileOps"]);
}

export function supportedTree(value: unknown): boolean {
	if (!record(value) || typeof value.targetId !== "string" || typeof value.userWantsSummary !== "boolean" ||
		!Array.isArray(value.entriesToSummarize)) return false;
	const entries = value.entriesToSummarize;
	return entries.every((entry, i) => record(entry) && typeof entry.id === "string" && typeof entry.type === "string" &&
		mutable(entries, [String(i)]));
}
