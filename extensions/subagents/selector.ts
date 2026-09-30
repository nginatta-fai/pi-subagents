import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { fuzzyFilter, Input, Key, matchesKey, SelectList, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentConfig } from "./agents.ts";
import type { AgentPriority, AgentSettingsOverride, SubagentSelection } from "./selection.ts";
import { formatPriority, supportsServiceTier, supportsUltrafast } from "./priority.ts";

interface SelectorOptions {
	agents: AgentConfig[];
	selection: SubagentSelection;
	models: Model<Api>[];
	resolveModel?: (provider: string, id: string) => Model<Api> | undefined;
	parentModel?: Model<Api>;
	parentThinking?: ThinkingLevel;
	theme: Theme;
	keybindings: Pick<KeybindingsManager, "matches" | "getKeys">;
	requestRender: () => void;
	onChange: (selection: SubagentSelection) => void;
	onSave: (selection: SubagentSelection) => void;
	onClose: () => void;
}

type MenuItem = {
	id: string;
	label: string;
	value: string;
	description?: string;
	values?: () => string[];
	currentToken?: () => string;
	choose?: (value: string) => void;
	activate?: () => void;
};

const AGENT_DEFAULT = "@agent-default";
const PARENT_INHERIT = "@inherit-parent";

function modelRef(model: Model<Api> | undefined): string | undefined {
	return model ? `${model.provider}/${model.id}` : undefined;
}

/** A searchable, branch-local agent settings picker. Closing keeps every change. */
export function createSubagentSelector(options: SelectorOptions) {
	const { agents, theme, keybindings: kb } = options;
	const disabled = new Set(options.selection.disabledAgents);
	const overrides: Record<string, AgentSettingsOverride> = Object.fromEntries(
		Object.entries(options.selection.agentOverrides ?? {}).map(([name, value]) => [name, { ...value }]),
	);
	const models = [...new Map(options.models.map((model) => [modelRef(model)!, model])).values()];
	const rootSearch = new Input();
	const settingsSearch = new Input();
	const modelSearch = new Input();
	let stage: "root" | "settings" | "models" = "root";
	let selectedAgentName: string | undefined;
	let selectedRootName: string | undefined;
	let selectedSettingId = "enabled";
	let filteredAgents = agents;
	let rootList: SelectList;
	let filteredSettings: MenuItem[] = [];
	let filteredModels: { token: string; label: string; description: string }[] = [];
	let selectedSettingIndex = 0;
	let selectedModelIndex = 0;
	let status = "Changes apply to this session immediately.";

	const key = (action: Parameters<KeybindingsManager["getKeys"]>[0]) => kb.getKeys(action).join("/") || "unbound";
	const selectedAgent = () => agents.find((agent) => agent.name === selectedAgentName);
	const agentOverride = () => (selectedAgentName ? overrides[selectedAgentName] : undefined);
	const effectiveModelRef = (agent = selectedAgent()): string | undefined => {
		if (!agent) return undefined;
		const override = overrides[agent.name];
		if (Object.hasOwn(override ?? {}, "model")) return override?.model ?? modelRef(options.parentModel);
		return agent.model ?? modelRef(options.parentModel);
	};
	const effectiveModel = (agent = selectedAgent()): Model<Api> | undefined => {
		const reference = effectiveModelRef(agent);
		if (!reference) return undefined;
		const separator = reference.indexOf("/");
		if (separator < 1 || separator === reference.length - 1) return undefined;
		const provider = reference.slice(0, separator);
		const id = reference.slice(separator + 1);
		return reference === modelRef(options.parentModel)
			? options.parentModel
			: options.resolveModel?.(provider, id);
	};
	const requestedThinking = (agent = selectedAgent()): ThinkingLevel | undefined => {
		if (!agent) return undefined;
		const override = overrides[agent.name];
		if (Object.hasOwn(override ?? {}, "thinking")) return override?.thinking ?? options.parentThinking;
		return agent.thinking ?? options.parentThinking;
	};
	const effectiveThinking = (agent = selectedAgent()): ThinkingLevel | undefined => {
		const requested = requestedThinking(agent);
		const model = effectiveModel(agent);
		return requested && model ? clampThinkingLevel(model, requested) : requested;
	};
	const effectivePriority = (agent = selectedAgent()): AgentPriority | undefined => {
		if (!agent) return undefined;
		const override = overrides[agent.name];
		if (override?.priority) return override.priority;
		return agent.priority ?? (agent.fast === undefined ? undefined : agent.fast ? "fast" : "default");
	};
	const snapshot = (): SubagentSelection => {
		const normalizedOverrides = Object.fromEntries(
			Object.entries(overrides).filter(([, value]) => Object.keys(value).length).map(([name, value]) => [name, { ...value }]),
		);
		return {
			disabledAgents: [...disabled].sort(),
			...(Object.keys(normalizedOverrides).length ? { agentOverrides: normalizedOverrides } : {}),
		};
	};
	const changed = (message = "Applied to this session; not saved as defaults.") => {
		options.onChange(snapshot());
		status = message;
		refreshRoot();
		refreshSettings();
	};
	const setOverride = (name: string, field: keyof AgentSettingsOverride, value: string | null | undefined) => {
		const next = { ...(overrides[name] ?? {}) };
		if (value === undefined) delete next[field];
		else (next as Record<string, unknown>)[field] = value;
		if (Object.keys(next).length) overrides[name] = next;
		else delete overrides[name];
	};
	const applyModelChoice = (token: string) => {
		const agent = selectedAgent();
		if (!agent) return;
		const previousPriority = effectivePriority(agent);
		if (token === AGENT_DEFAULT) setOverride(agent.name, "model", undefined);
		else if (token === PARENT_INHERIT) setOverride(agent.name, "model", null);
		else setOverride(agent.name, "model", token);
		const resetUltrafast = previousPriority === "ultrafast" && !supportsUltrafast(effectiveModel());
		if (resetUltrafast) setOverride(agent.name, "priority", "default");
		const message = resetUltrafast
			? "Ultrafast reset to default because the selected model is not eligible."
			: "Applied to this session; not saved as defaults.";
		stage = "settings";
		settingsSearch.focused = true;
		modelSearch.focused = false;
		changed(message);
	};

	function refreshRoot(selectedName = rootList?.getSelectedItem()?.value ?? selectedRootName) {
		filteredAgents = fuzzyFilter(agents, rootSearch.getValue(), (agent) => {
			const model = effectiveModel(agent);
			const reference = effectiveModelRef(agent) ?? "inherit parent model";
			const thinking = effectiveThinking(agent) ?? "inherit parent thinking";
			const priority = formatPriority(effectivePriority(agent), model, reference);
			return `${agent.name} ${agent.description} ${reference} ${thinking} ${priority}`;
		});
		rootList = new SelectList(
			filteredAgents.map((agent) => {
				const model = effectiveModelRef(agent) ?? "no model";
				const thinking = effectiveThinking(agent) ?? "inherit thinking";
				const priority = formatPriority(effectivePriority(agent), effectiveModel(agent), model);
				return {
					value: agent.name,
					label: `${disabled.has(agent.name) ? "[ ]" : "[x]"} ${agent.name}`,
					description: `${model} · ${thinking} · priority: ${priority}`,
				};
			}),
			8,
			{
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("muted", text),
			},
		);
		const index = filteredAgents.findIndex((agent) => agent.name === selectedName);
		rootList.setSelectedIndex(Math.max(0, index));
		selectedRootName = rootList.getSelectedItem()?.value;
	}

	function settingsItems(): MenuItem[] {
		const agent = selectedAgent();
		if (!agent) return [];
		const override = agentOverride();
		const targetModel = effectiveModel(agent);
		const supportedThinking = targetModel ? getSupportedThinkingLevels(targetModel) : [];
		const thinkingToken = () => Object.hasOwn(override ?? {}, "thinking")
			? override?.thinking === null ? PARENT_INHERIT : override?.thinking ?? AGENT_DEFAULT
			: AGENT_DEFAULT;
		const thinkingRequest = requestedThinking(agent);
		const thinkingEffective = effectiveThinking(agent);
		const thinkingLabel = Object.hasOwn(override ?? {}, "thinking")
			? override?.thinking === null ? `inherit parent (${options.parentThinking ?? "off"})` : String(override?.thinking)
			: agent.thinking ?? `inherit parent (${options.parentThinking ?? "off"})`;
		const thinkingValue = thinkingRequest !== thinkingEffective
			? `${thinkingLabel} (effective ${thinkingEffective ?? "off"})`
			: thinkingLabel;
		const priorityToken = () => override?.priority ?? AGENT_DEFAULT;
		const priorityValues = () => {
			const values = [AGENT_DEFAULT, "default"];
			if (supportsServiceTier(targetModel)) values.push("fast");
			if (supportsUltrafast(targetModel)) values.push("ultrafast");
			return values;
		};
		const currentPriority = effectivePriority(agent);
		const priorityDescription = currentPriority === "ultrafast"
			? supportsUltrafast(targetModel)
				? "API GPT-6 Astra only; uses 6x Standard token prices. Host cost estimates may exclude tier premiums."
				: "Unsupported for this model and will not be applied. Codex Astra is not verified."
			: currentPriority === "fast" && !supportsServiceTier(targetModel)
				? "Unsupported for this model; fast priority is sent only to OpenAI Responses models."
				: "default sends service_tier=default; fast sends service_tier=priority.";
		return [
			{
				id: "enabled", label: "Enabled", value: disabled.has(agent.name) ? "disabled" : "enabled",
				description: "Enable or disable this agent for new invocations.",
				values: () => ["enabled", "disabled"],
				currentToken: () => disabled.has(agent.name) ? "disabled" : "enabled",
				choose: (value) => {
					if (value === "disabled") disabled.add(agent.name);
					else disabled.delete(agent.name);
					changed();
				},
			},
			{
				id: "model", label: "Model", value: effectiveModelRef(agent) ?? "inherit parent model",
				description: "Choose an available model, use the agent-file default, or inherit the parent model.",
				activate: openModelPicker,
			},
			{
				id: "thinking", label: "Reasoning effort",
				value: thinkingValue,
				description: `Supported by the selected model: ${supportedThinking.join(", ") || "no model available"}.`,
				values: () => [AGENT_DEFAULT, PARENT_INHERIT, ...supportedThinking],
				currentToken: thinkingToken,
				choose: (value) => {
					setOverride(agent.name, "thinking", value === AGENT_DEFAULT ? undefined : value === PARENT_INHERIT ? null : value);
					changed();
				},
			},
			{
				id: "priority", label: "Priority",
				value: formatPriority(currentPriority, targetModel, effectiveModelRef(agent)),
				description: priorityDescription,
				values: priorityValues,
				currentToken: priorityToken,
				choose: (value) => {
					setOverride(agent.name, "priority", value === AGENT_DEFAULT ? undefined : value);
					changed();
				},
			},
			{
				id: "reset", label: "Reset to agent-file defaults", value: "reset",
				description: "Remove this agent's session overrides without changing its Markdown file.",
				activate: () => {
					delete overrides[agent.name];
					changed("Reset to agent-file defaults for this session.");
				},
			},
		];
	}

	function refreshSettings() {
		const items = settingsItems();
		const query = settingsSearch.getValue().trim().toLowerCase();
		filteredSettings = query ? items.filter((item) => item.label.toLowerCase().includes(query)) : items;
		const index = filteredSettings.findIndex((item) => item.id === selectedSettingId);
		selectedSettingIndex = index < 0 ? 0 : index;
	}

	function modelChoices(agent: AgentConfig): { token: string; label: string; description: string }[] {
		return [
			{ token: AGENT_DEFAULT, label: "Agent-file default", description: agent.model ?? `inherit parent (${modelRef(options.parentModel) ?? "no model"})` },
			{ token: PARENT_INHERIT, label: "Inherit parent model", description: modelRef(options.parentModel) ?? "No parent model" },
			...models.map((model) => ({ token: modelRef(model)!, label: `${model.provider}/${model.id}`, description: model.name })),
		];
	}

	function currentModelToken(agent: AgentConfig): string {
		const override = overrides[agent.name];
		return Object.hasOwn(override ?? {}, "model")
			? override?.model === null ? PARENT_INHERIT : override?.model ?? AGENT_DEFAULT
			: AGENT_DEFAULT;
	}

	function openModelPicker() {
		const agent = selectedAgent();
		if (!agent) return;
		modelSearch.setValue("");
		filteredModels = modelChoices(agent);
		selectedModelIndex = Math.max(0, filteredModels.findIndex((item) => item.token === currentModelToken(agent)));
		stage = "models";
		settingsSearch.focused = false;
		modelSearch.focused = true;
	}

	function filterModels() {
		const agent = selectedAgent();
		if (!agent) return;
		filteredModels = fuzzyFilter(modelChoices(agent), modelSearch.getValue(), (item) => `${item.label} ${item.description}`);
		const index = filteredModels.findIndex((item) => item.token === currentModelToken(agent));
		selectedModelIndex = index < 0 ? 0 : index;
	}

	function refreshRootFocus() {
		rootSearch.focused = stage === "root";
		settingsSearch.focused = stage === "settings";
		modelSearch.focused = stage === "models";
	}

	function selectedMenuItem(): MenuItem | undefined {
		return filteredSettings[selectedSettingIndex];
	}

	function selectSetting(index: number) {
		if (!filteredSettings.length) return;
		selectedSettingIndex = (index + filteredSettings.length) % filteredSettings.length;
		selectedSettingId = filteredSettings[selectedSettingIndex]?.id ?? selectedSettingId;
	}

	function cycleSelected(direction: 1 | -1) {
		const item = selectedMenuItem();
		if (!item) return;
		if (item.activate) {
			if (direction === 1) item.activate();
			return;
		}
		const values = item.values?.() ?? [];
		if (!values.length || !item.choose) return;
		const currentIndex = values.indexOf(item.currentToken?.() ?? item.value);
		const startIndex = currentIndex === -1 ? (direction === 1 ? -1 : 0) : currentIndex;
		item.choose(values[(startIndex + direction + values.length) % values.length]!);
	}

	function viewportStart(length: number, selectedIndex: number): number {
		return Math.max(0, Math.min(selectedIndex - 3, length - 8));
	}

	function renderMenu(
		title: string,
		input: Input,
		items: readonly { label: string; value: string; description?: string }[],
		selectedIndex: number,
		hint: string,
		width: number,
		extra: string[] = [],
	) {
		const lines = [
			...new Text(theme.fg("accent", theme.bold(title)), 0, 0).render(width),
			"",
			...input.render(width),
			"",
		];
		if (!items.length) lines.push(theme.fg("muted", "No matching settings"));
		else {
			const start = viewportStart(items.length, selectedIndex);
			for (let index = start; index < Math.min(start + 8, items.length); index++) {
				const item = items[index]!;
				const selected = index === selectedIndex;
				const prefix = selected ? theme.fg("accent", "› ") : "  ";
				const available = Math.max(1, width - visibleWidth(prefix) - visibleWidth(item.value) - 3);
				const label = truncateToWidth(item.label, available, "…");
				lines.push(truncateToWidth(`${prefix}${selected ? theme.fg("accent", label) : label}  ${theme.fg("muted", item.value)}`, width));
			}
			const selected = items[selectedIndex];
			if (selected?.description) {
				lines.push("", ...new Text(theme.fg("muted", selected.description), 0, 0).render(width));
			}
		}
		lines.push("", theme.fg("muted", status));
		if (extra.length) lines.push("", ...extra);
		lines.push("", theme.fg("dim", hint));
		return lines.map((line) => truncateToWidth(line, width));
	}

	function isSpace(data: string): boolean {
		return data === " " || matchesKey(data, Key.space);
	}

	function shouldActivate(data: string, query: string): boolean {
		const space = isSpace(data);
		return (!space && (kb.matches(data, "tui.select.confirm") || matchesKey(data, Key.enter))) ||
			matchesKey(data, Key.right) || (space && query.length === 0);
	}

	function refreshRootList() {
		refreshRoot(selectedRootName);
		selectedRootName = rootList.getSelectedItem()?.value;
	}
	refreshRoot();
	refreshSettings();
	refreshRootFocus();

	return {
		get focused() {
			return stage === "root" ? rootSearch.focused : stage === "settings" ? settingsSearch.focused : modelSearch.focused;
		},
		set focused(value: boolean) {
			if (stage === "root") rootSearch.focused = value;
			else if (stage === "settings") settingsSearch.focused = value;
			else modelSearch.focused = value;
		},
		invalidate() {
			rootSearch.invalidate();
			settingsSearch.invalidate();
			modelSearch.invalidate();
			rootList.invalidate();
		},
		render(width: number) {
			if (stage === "models") {
				const selected = filteredModels[selectedModelIndex];
				const start = viewportStart(filteredModels.length, selectedModelIndex);
				const lines = [
					...new Text(theme.fg("accent", theme.bold("Choose model")), 0, 0).render(width),
					"",
					...modelSearch.render(width),
					"",
					...(filteredModels.length ? filteredModels.slice(start, start + 8).map((item, index) => {
						const absoluteIndex = start + index;
						const prefix = absoluteIndex === selectedModelIndex ? theme.fg("accent", "› ") : "  ";
						return truncateToWidth(`${prefix}${absoluteIndex === selectedModelIndex ? theme.fg("accent", item.label) : item.label}`, width);
					}) : [theme.fg("muted", "No matching models")]),
					...(selected?.description ? ["", theme.fg("muted", selected.description)] : []),
					"", theme.fg("muted", status),
					"",
					theme.fg("dim", `Type to search · ${key("tui.select.up")}/${key("tui.select.down")} navigate · ${key("tui.select.confirm")}/Space choose · ${key("app.models.save")} save · ${key("tui.select.cancel")} back`),
				];
				return lines.map((line) => truncateToWidth(line, width));
			}
			if (stage === "settings") {
				const items = filteredSettings.map((item) => ({ label: item.label, value: item.value, description: item.description }));
				const extra = effectivePriority() === "ultrafast"
					? [theme.fg("warning", "Ultrafast uses 6x Standard token prices on API GPT-6 Astra; host estimates may exclude tier premiums. Codex Astra is unverified.")]
					: [];
				return renderMenu(
					`${selectedAgentName} settings`, settingsSearch, items, selectedSettingIndex,
					`Type to search · ${key("tui.select.up")}/${key("tui.select.down")} navigate · ←/→/${key("tui.select.confirm")}/Space change/open · ${key("tui.select.cancel")} back · ${key("app.models.save")} save`,
					width, extra,
				);
			}
			const enabledCount = agents.filter((agent) => !disabled.has(agent.name)).length;
			const selected = agents.find((agent) => agent.name === rootList.getSelectedItem()?.value);
			return [
				...new Text(theme.fg("accent", theme.bold("Subagent Configuration")), 0, 0).render(width),
				...new Text(theme.fg("muted", `${status} ${key("app.models.save")} saves defaults.`), 0, 0).render(width),
				"",
				...rootSearch.render(width),
				"",
				...(filteredAgents.length ? rootList.render(width) : [theme.fg("muted", "No matching subagents")]),
				"",
				...new Text(theme.fg("muted", selected?.description ?? ""), 0, 0).render(width),
				"",
				...new Text(theme.fg("dim", [
					`${key("tui.select.up")}/${key("tui.select.down")} navigate`, "type to search",
					`${key("tui.select.confirm")}/→/Space settings`,
					`${key("app.models.enableAll")} all`, `${key("app.models.clearAll")} none`,
					`${key("app.models.save")} save`, `${key("tui.select.cancel")} close`,
					"Ctrl+C clear/back", `${enabledCount}/${agents.length} enabled`,
				].join(" · ")), 0, 0).render(width),
			].map((line) => truncateToWidth(line, width));
		},
		handleInput(data: string) {
			if (kb.matches(data, "app.models.save")) {
				try {
					options.onSave(snapshot());
					status = "Saved as defaults for new sessions.";
				} catch (error) {
					status = `Save failed: ${error instanceof Error ? error.message : String(error)}`;
				}
				options.requestRender();
				return;
			}

			if (stage === "root") {
				if (kb.matches(data, "app.models.enableAll") || kb.matches(data, "app.models.clearAll")) {
					const enable = kb.matches(data, "app.models.enableAll");
					for (const agent of filteredAgents) {
						if (enable) disabled.delete(agent.name);
						else disabled.add(agent.name);
					}
					changed();
				} else if (matchesKey(data, Key.ctrl("c")) && rootSearch.getValue()) {
					rootSearch.setValue("");
					refreshRootList();
				} else if (kb.matches(data, "tui.select.cancel")) {
					options.onClose();
					return;
				} else if (kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.down")) {
					rootList.handleInput(data);
					selectedRootName = rootList.getSelectedItem()?.value;
				} else if (shouldActivate(data, rootSearch.getValue())) {
					const name = rootList.getSelectedItem()?.value;
					if (name) {
						selectedRootName = name;
						selectedAgentName = name;
						selectedSettingId = "enabled";
						settingsSearch.setValue("");
						stage = "settings";
						refreshSettings();
						refreshRootFocus();
					}
				} else {
					rootSearch.handleInput(data);
					refreshRootList();
				}
			} else if (stage === "models") {
				if (kb.matches(data, "tui.select.cancel") || matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || matchesKey(data, Key.left)) {
					stage = "settings";
					refreshRootFocus();
				} else if (kb.matches(data, "tui.select.up")) {
					if (filteredModels.length) selectedModelIndex = (selectedModelIndex + filteredModels.length - 1) % filteredModels.length;
				} else if (kb.matches(data, "tui.select.down")) {
					if (filteredModels.length) selectedModelIndex = (selectedModelIndex + 1) % filteredModels.length;
				} else if (shouldActivate(data, modelSearch.getValue())) {
					const selected = filteredModels[selectedModelIndex];
					if (selected) applyModelChoice(selected.token);
				} else {
					modelSearch.handleInput(data);
					filterModels();
				}
			} else {
				if (kb.matches(data, "tui.select.cancel") || matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
					stage = "root";
					refreshRootFocus();
				} else if (kb.matches(data, "tui.select.up")) {
					selectSetting(selectedSettingIndex - 1);
				} else if (kb.matches(data, "tui.select.down")) {
					selectSetting(selectedSettingIndex + 1);
				} else if (matchesKey(data, Key.left)) {
					cycleSelected(-1);
				} else if (shouldActivate(data, settingsSearch.getValue())) {
					cycleSelected(1);
				} else {
					settingsSearch.handleInput(data);
					refreshSettings();
				}
			}
			refreshRootFocus();
			options.requestRender();
		},
	};
}
