import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter, Input, Key, matchesKey, SelectList, Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { AgentConfig } from "./agents.ts";

interface SelectorOptions {
	agents: AgentConfig[];
	disabledAgents: ReadonlySet<string>;
	theme: Theme;
	keybindings: Pick<KeybindingsManager, "matches" | "getKeys">;
	requestRender: () => void;
	onChange: (disabledAgents: string[]) => void;
	onSave: (disabledAgents: string[]) => void;
	onClose: () => void;
}

/** A scoped-models-style picker. Changes apply immediately; closing never rolls them back. */
export function createSubagentSelector(options: SelectorOptions) {
	const { agents, theme, keybindings: kb } = options;
	const disabled = new Set(options.disabledAgents);
	const search = new Input();
	let filtered = agents;
	let list: SelectList;
	let status = "Changes apply to this session immediately.";

	const key = (action: Parameters<KeybindingsManager["getKeys"]>[0]) => kb.getKeys(action).join("/") || "unbound";
	const refresh = (selectedName = list?.getSelectedItem()?.value) => {
		filtered = fuzzyFilter(agents, search.getValue(), (agent) =>
			`${agent.name} ${agent.description} ${agent.model ?? ""}`,
		);
		list = new SelectList(
			filtered.map((agent) => ({
				value: agent.name,
				label: `${disabled.has(agent.name) ? "[ ]" : "[x]"} ${agent.name}`,
				description: `${agent.model ?? "inherit model"} · ${agent.thinking ?? "inherit thinking"}`,
			})),
			8,
			{
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("muted", text),
			},
		);
		list.setSelectedIndex(Math.max(0, filtered.findIndex((agent) => agent.name === selectedName)));
		list.onSelect = ({ value }) => {
			if (disabled.has(value)) disabled.delete(value);
			else disabled.add(value);
			changed();
		};
	};
	const changed = () => {
		options.onChange([...disabled].sort());
		status = "Applied to this session; not saved as defaults.";
		refresh();
	};
	refresh();

	return {
		get focused() { return search.focused; },
		set focused(value: boolean) { search.focused = value; },
		invalidate() {
			search.invalidate();
			list.invalidate();
		},
		render(width: number) {
			const enabledCount = agents.filter((agent) => !disabled.has(agent.name)).length;
			const selected = agents.find((agent) => agent.name === list.getSelectedItem()?.value);
			const lines = [
				...new Text(theme.fg("accent", theme.bold("Subagent Configuration")), 0, 0).render(width),
				...new Text(theme.fg("muted", `${status} ${key("app.models.save")} saves defaults.`), 0, 0).render(width),
				"",
				...search.render(width),
				"",
				...(filtered.length ? list.render(width) : [theme.fg("muted", "No matching subagents")]),
				"",
				...new Text(theme.fg("muted", selected?.description ?? ""), 0, 0).render(width),
				"",
				...new Text(theme.fg("dim", [
					`${key("tui.select.up")}/${key("tui.select.down")} navigate`,
					"type to search",
					`${key("tui.select.confirm")} toggle`,
					`${key("app.models.enableAll")} all`,
					`${key("app.models.clearAll")} none`,
					`${key("tui.select.cancel")} close`,
					`${enabledCount}/${agents.length} enabled`,
				].join(" · ")), 0, 0).render(width),
			];
			return lines.map((line) => truncateToWidth(line, width));
		},
		handleInput(data: string) {
			if (kb.matches(data, "app.models.save")) {
				try {
					options.onSave([...disabled].sort());
					status = "Saved as defaults for new sessions.";
				} catch (error) {
					status = `Save failed: ${error instanceof Error ? error.message : String(error)}`;
				}
			} else if (kb.matches(data, "app.models.enableAll") || kb.matches(data, "app.models.clearAll")) {
				const enable = kb.matches(data, "app.models.enableAll");
				for (const agent of filtered) {
					if (enable) disabled.delete(agent.name);
					else disabled.add(agent.name);
				}
				changed();
			} else if (matchesKey(data, Key.ctrl("c")) && search.getValue()) {
				search.setValue("");
				refresh();
			} else if (kb.matches(data, "tui.select.cancel")) {
				options.onClose();
				return;
			} else if ((["tui.select.up", "tui.select.down", "tui.select.confirm"] as const).some((action) => kb.matches(data, action))) {
				list.handleInput(data);
			} else {
				search.handleInput(data);
				refresh();
			}
			options.requestRender();
		},
	};
}
