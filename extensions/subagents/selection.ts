import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export const SELECTION_ENTRY_TYPE = "subagents-selection";
export type AgentPriority = "default" | "fast" | "ultrafast";

export interface AgentSettingsOverride {
	model?: string | null;
	thinking?: ThinkingLevel | null;
	priority?: AgentPriority;
}

export interface SubagentSelection {
	disabledAgents: string[];
	agentOverrides?: Record<string, AgentSettingsOverride>;
}

const THINKING_LEVELS = new Set<ThinkingLevel>([
	"off", "minimal", "low", "medium", "high", "xhigh", "max",
]);
const PRIORITIES = new Set<AgentPriority>(["default", "fast", "ultrafast"]);

export function parseSelection(data: unknown): SubagentSelection {
	const record = data && typeof data === "object" && !Array.isArray(data)
		? data as Record<string, unknown>
		: undefined;
	const names = record?.disabledAgents;
	if (!Array.isArray(names) || names.some((name) => typeof name !== "string" || !/^[A-Za-z0-9_-]+$/.test(name))) {
		throw new Error("disabledAgents must be an array of agent names");
	}

	const rawOverrides = record?.agentOverrides;
	if (rawOverrides === undefined) return { disabledAgents: [...new Set(names as string[])].sort() };
	if (!rawOverrides || typeof rawOverrides !== "object" || Array.isArray(rawOverrides)) {
		throw new Error("agentOverrides must be an object keyed by agent name");
	}
	const overrides: Array<[string, AgentSettingsOverride]> = [];
	for (const [name, raw] of Object.entries(rawOverrides)) {
		if (!/^[A-Za-z0-9_-]+$/.test(name) || !raw || typeof raw !== "object" || Array.isArray(raw)) {
			throw new Error("agentOverrides must contain valid agent settings objects");
		}
		const value = raw as Record<string, unknown>;
		if (Object.keys(value).some((key) => !["model", "thinking", "priority"].includes(key))) {
			throw new Error(`agentOverrides.${name} contains an unknown setting`);
		}
		const normalized: AgentSettingsOverride = {};
		if (Object.hasOwn(value, "model")) {
			const reference = value.model;
			const separator = typeof reference === "string" ? reference.indexOf("/") : -1;
			if (reference !== null && (typeof reference !== "string" || separator < 1 || separator === reference.length - 1 || /\s/.test(reference))) {
				throw new Error(`agentOverrides.${name}.model must be a provider/model reference or null`);
			}
			normalized.model = reference as string | null;
		}
		if (Object.hasOwn(value, "thinking")) {
			if (value.thinking !== null && (typeof value.thinking !== "string" || !THINKING_LEVELS.has(value.thinking as ThinkingLevel))) {
				throw new Error(`agentOverrides.${name}.thinking is invalid`);
			}
			normalized.thinking = value.thinking as ThinkingLevel | null;
		}
		if (Object.hasOwn(value, "priority")) {
			if (typeof value.priority !== "string" || !PRIORITIES.has(value.priority as AgentPriority)) {
				throw new Error(`agentOverrides.${name}.priority is invalid`);
			}
			normalized.priority = value.priority as AgentPriority;
		}
		if (!Object.keys(normalized).length) continue;
		overrides.push([name, normalized]);
	}
	const normalizedOverrides = Object.fromEntries(overrides.sort(([a], [b]) => a.localeCompare(b)));
	return {
		disabledAgents: [...new Set(names as string[])].sort(),
		...(Object.keys(normalizedOverrides).length ? { agentOverrides: normalizedOverrides } : {}),
	};
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
