import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, type Theme, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import subagentsExtension from "../extensions/subagents/index.ts";
import type { AgentConfig } from "../extensions/subagents/agents.ts";
import { createSubagentSelector } from "../extensions/subagents/selector.ts";
import { loadSelection, parseSelection, restoreSelection, saveSelection, SELECTION_ENTRY_TYPE } from "../extensions/subagents/selection.ts";

const keybindings = new KeybindingsManager({
	...TUI_KEYBINDINGS,
	"app.models.save": { defaultKeys: "ctrl+s" },
	"app.models.enableAll": { defaultKeys: "ctrl+a" },
	"app.models.clearAll": { defaultKeys: "ctrl+x" },
});
setKeybindings(keybindings);
const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as Theme;
const agents = ["reviewer", "scout", "worker"].map((name): AgentConfig => ({
	name, description: `Role of ${name}`, model: "test/model", thinking: "low",
	mutating: name === "worker", systemPrompt: "Test", source: "bundled", filePath: `${name}.md`,
}));
const keys = { enter: "\r", down: "\x1b[B", up: "\x1b[A", all: "\x01", none: "\x18", save: "\x13", escape: "\x1b", clear: "\x03" };

function temporaryDirectory(t: TestContext) {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-test-"));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	return directory;
}

function sessionEntry(disabledAgents: string[]) {
	return { type: "custom", customType: SELECTION_ENTRY_TYPE, data: { disabledAgents } };
}

test("selection defaults, normalization, validation, and atomic persistence", (t) => {
	const filePath = path.join(temporaryDirectory(t), "agent", "subagents.json");
	assert.deepEqual(loadSelection(filePath), { disabledAgents: [] });
	saveSelection(filePath, { disabledAgents: ["worker", "scout", "worker"] });
	assert.deepEqual(loadSelection(filePath), { disabledAgents: ["scout", "worker"] });
	assert.deepEqual(fs.readdirSync(path.dirname(filePath)), ["subagents.json"]);
	saveSelection(filePath, { disabledAgents: [] });
	assert.deepEqual(loadSelection(filePath), { disabledAgents: [] });
	for (const invalid of [null, {}, { disabledAgents: "worker" }, { disabledAgents: [1] }, { disabledAgents: ["../worker"] }]) {
		assert.throws(() => parseSelection(invalid), /disabledAgents must/);
	}
	fs.writeFileSync(filePath, "{invalid json");
	assert.throws(() => loadSelection(filePath), /Could not read/);
});

test("restores only the last selection on the active branch, including all-enabled and unavailable names", () => {
	const defaults = { disabledAgents: ["worker"] };
	assert.deepEqual(restoreSelection([], defaults), defaults);
	assert.deepEqual(restoreSelection([sessionEntry(["scout"]), sessionEntry([])], defaults), { disabledAgents: [] });
	assert.deepEqual(restoreSelection([sessionEntry(["custom-agent"])], defaults), { disabledAgents: ["custom-agent"] });
	assert.deepEqual(restoreSelection([sessionEntry(["scout"])], defaults), { disabledAgents: ["scout"] });
});

test("picker toggles, searches, applies all/none to search matches, saves, and retains changes on close", () => {
	let disabled: string[] = [];
	let saved: string[] | undefined;
	let closed = false;
	let renderRequests = 0;
	const picker = createSubagentSelector({
		agents, disabledAgents: new Set(), theme, keybindings,
		requestRender: () => { renderRequests++; },
		onChange: (names) => { disabled = names; },
		onSave: (names) => { saved = names; },
		onClose: () => { closed = true; },
	});
	picker.handleInput(keys.down);
	picker.handleInput(keys.enter);
	assert.deepEqual(disabled, ["scout"]);
	picker.handleInput(keys.up);
	picker.handleInput(keys.enter);
	assert.deepEqual(disabled, ["reviewer", "scout"]);
	picker.handleInput("worker");
	picker.handleInput(keys.none);
	assert.deepEqual(disabled, ["reviewer", "scout", "worker"]);
	picker.handleInput(keys.all);
	assert.deepEqual(disabled, ["reviewer", "scout"]);
	picker.handleInput(keys.clear); // Clear search without closing.
	assert.equal(closed, false);
	picker.handleInput(keys.none);
	assert.deepEqual(disabled, ["reviewer", "scout", "worker"]);
	picker.handleInput(keys.save);
	assert.deepEqual(saved, disabled);
	assert.match(picker.render(100).join("\n"), /Saved as defaults/);
	picker.handleInput(keys.escape);
	assert.equal(closed, true);
	assert.equal(disabled.length, 3);
	assert.ok(renderRequests > 0);
});

test("picker handles no matches, focus, scrolling, narrow widths, wide text, and failed saves", () => {
	let changes = 0;
	const picker = createSubagentSelector({
		agents: Array.from({ length: 15 }, (_, index) => ({ ...agents[0], name: `agent-${index}`, description: "検証 🔎 ".repeat(10) })),
		disabledAgents: new Set(), theme, keybindings, requestRender() {}, onClose() {},
		onChange: () => { changes++; },
		onSave: () => { throw new Error("read-only filesystem"); },
	});
	picker.focused = true;
	assert.ok(picker.render(80).join("\n").includes(CURSOR_MARKER));
	picker.handleInput(keys.up);
	assert.match(picker.render(80).join("\n"), /15\/15/);
	for (const width of [1, 10, 40, 80]) {
		picker.invalidate();
		assert.ok(picker.render(width).every((line) => visibleWidth(line) <= width));
	}
	picker.handleInput("nonexistent");
	picker.handleInput(keys.enter);
	assert.equal(changes, 0);
	assert.match(picker.render(80).join("\n"), /No matching subagents/);
	picker.handleInput(keys.save);
	assert.match(picker.render(100).join("\n"), /Save failed: read-only filesystem/);
	picker.focused = false;
	assert.equal(picker.focused, false);
});

function extensionHarness(t: TestContext, defaults?: string[]) {
	const root = temporaryDirectory(t);
	const agentDir = path.join(root, "agent");
	const selectionPath = path.join(agentDir, "subagents.json");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(() => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	});
	if (defaults) saveSelection(selectionPath, { disabledAgents: defaults });
	let branch: ReturnType<typeof sessionEntry>[] = [];
	let activeTools = ["read", "bash"];
	let inputKeys: string[] = [];
	let customCalls = 0;
	const notifications: string[] = [];
	const tools = new Map<string, ToolDefinition<any, any>>();
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
	const events = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const pi = {
		registerTool(tool: ToolDefinition<any, any>) {
			if (!tools.has(tool.name)) activeTools.push(tool.name);
			tools.set(tool.name, tool);
		},
		registerCommand(name: string, command: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) {
			commands.set(name, command);
		},
		on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
			events.set(name, handler);
			return () => events.delete(name);
		},
		getActiveTools: () => [...activeTools],
		setActiveTools: (names: string[]) => { activeTools = names; },
		appendEntry: (_type: string, data: { disabledAgents: string[] }) => branch.push(sessionEntry(data.disabledAgents)),
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd: root, mode: "tui", hasUI: true,
		isProjectTrusted: () => false,
		sessionManager: { getBranch: () => branch },
		ui: {
			notify: (message: string) => notifications.push(message),
			custom: async (factory: (...args: any[]) => ReturnType<typeof createSubagentSelector>) => {
				customCalls++;
				const component = factory({ requestRender() {} }, theme, keybindings, () => undefined);
				for (const input of inputKeys) component.handleInput(input);
			},
		},
	} as unknown as ExtensionCommandContext;
	subagentsExtension(pi);
	return {
		ctx, pi, root, agentDir, selectionPath, notifications,
		get tool() { return tools.get("subagent")!; },
		get activeTools() { return activeTools; },
		get customCalls() { return customCalls; },
		get branch() { return branch; },
		setBranch: (entries: typeof branch) => { branch = entries; },
		emit: (name: string) => events.get(name)?.({}, ctx),
		command: (inputs: string[] = [], args = "") => {
			inputKeys = inputs;
			return commands.get("subagents")!.handler(args, ctx);
		},
	};
}

test("command immediately updates schema, catalogue, and routing; stale tool calls cannot dispatch disabled agents", async (t) => {
	const harness = extensionHarness(t);
	await harness.emit("session_start");
	const originalTool = harness.tool;
	assert.deepEqual(originalTool.parameters.properties.agent.enum, ["reviewer", "scout", "worker"]);
	assert.match(originalTool.promptSnippet!, /use worker by default/);
	await harness.command(["worker", keys.enter, keys.escape]);
	assert.deepEqual(harness.tool.parameters.properties.agent.enum, ["reviewer", "scout"]);
	assert.doesNotMatch(harness.tool.description, /- worker:/);
	assert.doesNotMatch(harness.tool.promptSnippet!, /worker/);
	assert.doesNotMatch(harness.tool.promptGuidelines!.join("\n"), /call subagent with the worker/);
	assert.match(harness.tool.promptGuidelines!.join("\n"), /Implement code changes directly/);
	await assert.rejects(originalTool.execute("call", { agent: "worker", task: "test" }, undefined, undefined, harness.ctx), /is disabled/);
	assert.equal(fs.existsSync(harness.selectionPath), false, "session toggles must not write global defaults");
	assert.deepEqual(harness.branch.at(-1)?.data.disabledAgents, ["worker"]);
	await harness.command([], "list");
	assert.match(harness.notifications.at(-1)!, /\[disabled\] - worker:/);
});

test("all off removes the tool, all on restores it, and other tool selections remain untouched", async (t) => {
	const harness = extensionHarness(t);
	await harness.emit("session_start");
	await harness.command([keys.none, keys.escape]);
	assert.deepEqual(harness.activeTools, ["read", "bash"]);
	assert.deepEqual(harness.tool.promptGuidelines, []);
	await harness.command([keys.all, keys.escape]);
	assert.deepEqual(harness.activeTools, ["read", "bash", "subagent"]);
	harness.pi.setActiveTools(["read"]); // Simulate an independent /tools selection.
	await harness.command(["scout", keys.enter, keys.escape]);
	assert.deepEqual(harness.activeTools, ["read"]);
});

test("saved defaults, reload/resume, tree navigation, and session replacement restore the appropriate selection", async (t) => {
	const harness = extensionHarness(t, ["scout"]);
	await harness.emit("session_start");
	assert.deepEqual(harness.tool.parameters.properties.agent.enum, ["reviewer", "worker"]);
	await harness.command(["worker", keys.enter, keys.save, keys.escape]);
	assert.deepEqual(loadSelection(harness.selectionPath).disabledAgents, ["scout", "worker"]);
	// New global defaults must not override an explicit selection in a resumed branch.
	saveSelection(harness.selectionPath, { disabledAgents: [] });
	await harness.emit("session_start");
	assert.deepEqual(harness.tool.parameters.properties.agent.enum, ["reviewer"]);
	harness.setBranch([sessionEntry(["reviewer"])]);
	await harness.emit("session_tree");
	assert.deepEqual(harness.tool.parameters.properties.agent.enum, ["scout", "worker"]);
	harness.setBranch([]);
	await harness.emit("session_shutdown");
	await harness.emit("session_start");
	assert.deepEqual(harness.tool.parameters.properties.agent.enum, ["reviewer", "scout", "worker"]);
});

test("invalid defaults fail closed with a warning; non-TUI mode lists without opening custom UI", async (t) => {
	const harness = extensionHarness(t, []);
	fs.writeFileSync(harness.selectionPath, "{bad json");
	await harness.emit("session_start");
	assert.deepEqual(harness.activeTools, ["read", "bash"]);
	assert.match(harness.notifications[0], /Could not read/);
	harness.ctx.mode = "rpc";
	await harness.command();
	assert.equal(harness.customCalls, 0);
	assert.match(harness.notifications.at(-1)!, /\[disabled\]/);
});

test("disabled state applies by name to custom/trusted overrides without loading untrusted project agents", async (t) => {
	const harness = extensionHarness(t, ["helper"]);
	const directory = path.join(harness.root, ".pi", "agents");
	fs.mkdirSync(directory, { recursive: true });
	fs.writeFileSync(path.join(directory, "helper.md"), "---\nname: helper\ndescription: Trusted helper\ntools: []\n---\nHelp.\n");
	await harness.emit("session_start");
	assert.doesNotMatch(harness.tool.description, /Trusted helper/);
	harness.ctx.isProjectTrusted = () => true;
	await harness.emit("session_start");
	assert.doesNotMatch(harness.tool.description, /Trusted helper/);
	await harness.command(["helper", keys.enter, keys.escape]);
	assert.match(harness.tool.description, /Trusted helper/);
	assert.ok(harness.tool.parameters.properties.agent.enum.includes("helper"));
});

test("a queued worker invocation is checked again after being disabled", async (t) => {
	const harness = extensionHarness(t);
	await harness.emit("session_start");
	const previousDepth = process.env.PI_SUBAGENT_DEPTH;
	process.env.PI_SUBAGENT_DEPTH = "1"; // Safety: no real child or model request even if the guard regresses.
	t.after(() => {
		if (previousDepth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
		else process.env.PI_SUBAGENT_DEPTH = previousDepth;
	});
	const pending = harness.tool.execute("call", { agent: "worker", task: "test" }, undefined, undefined, harness.ctx);
	const rejected = assert.rejects(pending, /is disabled/);
	await harness.command(["worker", keys.enter, keys.escape]);
	await rejected;
});

test("Pi runtime refreshes tool definitions and system instructions without reload or model requests", async (t) => {
	const harness = extensionHarness(t);
	const settingsManager = SettingsManager.inMemory({});
	const resourceLoader = new DefaultResourceLoader({
		cwd: harness.root, agentDir: harness.agentDir, settingsManager,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [subagentsExtension],
	});
	await resourceLoader.reload();
	assert.deepEqual(resourceLoader.getExtensions().errors, []);
	const modelRuntime = await ModelRuntime.create({
		authPath: path.join(harness.agentDir, "auth.json"), modelsPath: null,
		modelsStorePath: path.join(harness.agentDir, "models-cache.json"),
		allowModelNetwork: false, refreshOnCreate: false,
	});
	const { session } = await createAgentSession({
		cwd: harness.root, agentDir: harness.agentDir, settingsManager, resourceLoader, modelRuntime,
		sessionManager: SessionManager.inMemory(harness.root),
	});
	t.after(() => session.dispose());
	let inputKeys = ["worker", keys.enter, keys.escape];
	const errors: string[] = [];
	await session.bindExtensions({
		mode: "tui",
		onError: (error) => { errors.push(error.error); },
		uiContext: {
			...harness.ctx.ui,
			custom: async (factory) => {
				const component = await factory({ requestRender() {} } as any, theme, keybindings as any, () => undefined);
				for (const input of inputKeys) component.handleInput?.(input);
				return undefined as any;
			},
		},
	});
	assert.ok(session.getActiveToolNames().includes("subagent"));
	assert.match(session.systemPrompt, /call subagent with the worker/);
	await session.prompt("/subagents");
	assert.doesNotMatch(session.systemPrompt, /call subagent with the worker/);
	assert.match(session.systemPrompt, /Implement code changes directly/);
	const tool = session.agent.state.tools.find((item) => item.name === "subagent")!;
	assert.deepEqual((tool.parameters as any).properties.agent.enum, ["reviewer", "scout"]);
	inputKeys = [keys.none, keys.escape];
	await session.prompt("/subagents");
	assert.ok(!session.getActiveToolNames().includes("subagent"));
	assert.doesNotMatch(session.systemPrompt, /Use enabled subagents/);
	inputKeys = [keys.all, keys.escape];
	await session.prompt("/subagents");
	assert.ok(session.getActiveToolNames().includes("subagent"));
	assert.match(session.systemPrompt, /call subagent with the worker/);
	assert.deepEqual(errors, []);
});
