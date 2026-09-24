import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

export const SELECTION_ENTRY_TYPE = "subagents-selection";

export interface SubagentSelection {
	disabledAgents: string[];
}

export function parseSelection(data: unknown): SubagentSelection {
	const names = data && typeof data === "object"
		? (data as Record<string, unknown>).disabledAgents
		: undefined;
	if (!Array.isArray(names) || names.some((name) => typeof name !== "string" || !/^[A-Za-z0-9_-]+$/.test(name))) {
		throw new Error("disabledAgents must be an array of agent names");
	}
	return { disabledAgents: [...new Set(names as string[])].sort() };
}

export function loadSelection(filePath: string): SubagentSelection {
	try {
		return parseSelection(JSON.parse(fs.readFileSync(filePath, "utf8")));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { disabledAgents: [] };
		throw new Error(`Could not read ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export function saveSelection(filePath: string, selection: SubagentSelection): void {
	const normalized = parseSelection(selection);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
	try {
		fs.writeFileSync(temporaryPath, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600, flag: "wx" });
		fs.renameSync(temporaryPath, filePath);
	} finally {
		fs.rmSync(temporaryPath, { force: true });
	}
}

/** Only the active branch participates; abandoned branch selections must not leak. */
export function restoreSelection(
	entries: readonly { type: string; customType?: string; data?: unknown }[],
	defaults: SubagentSelection,
): SubagentSelection {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type === "custom" && entry.customType === SELECTION_ENTRY_TYPE) {
			return parseSelection(entry.data);
		}
	}
	return parseSelection(defaults);
}
