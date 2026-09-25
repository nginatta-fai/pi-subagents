import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getEventListeners } from "node:events";
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

function usePiSubprocessStub(t: TestContext, stubPath: string, fixturePath: string) {
	const previousScript = process.argv[1];
	const previousFixture = process.env.PI_SUBAGENT_FIXTURE_PATH;
	const previousDepth = process.env.PI_SUBAGENT_DEPTH;
	process.argv[1] = stubPath;
	process.env.PI_SUBAGENT_FIXTURE_PATH = fixturePath;
	delete process.env.PI_SUBAGENT_DEPTH;
	t.after(() => {
		process.argv[1] = previousScript;
		if (previousFixture === undefined) delete process.env.PI_SUBAGENT_FIXTURE_PATH;
		else process.env.PI_SUBAGENT_FIXTURE_PATH = previousFixture;
		if (previousDepth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
		else process.env.PI_SUBAGENT_DEPTH = previousDepth;
	});
}

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

test("live previews track streamed responses, tool completion, model waits, and elapsed time", async (t) => {
	const harness = extensionHarness(t);
	await harness.emit("session_start");
	const fixturePath = path.join(harness.root, "events.json");
	const stubPath = path.join(harness.root, "pi-stub.mjs");
	const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const assistant = (text: string, stopReason: "toolUse" | "stop") => ({
		role: "assistant", content: text ? [{ type: "text", text }] : [{ type: "toolCall", id: "call-1", name: "grep", arguments: { pattern: "needle", path: "." } }],
		api: "test", provider: "test", model: "test", usage, stopReason, timestamp: Date.now(),
	});
	const recentResponse = `EARLY_START\n${"x\n".repeat(20 * 1024)}\nEXPANDED_ONLY_MARKER\n${"y\n".repeat(10)}RECENT_END_MARKER`;
	const accumulatedMessage = `ACCUMULATED_ASSISTANT_MESSAGE_START${"a".repeat(64 * 1024)}ACCUMULATED_ASSISTANT_MESSAGE_END`;
	const longGrepPattern = "long-grep-argument\n".repeat(500);
	const deltas = Array.from({ length: Math.ceil(recentResponse.length / 80) }, (_, index) => recentResponse.slice(index * 80, (index + 1) * 80)).filter(Boolean);
	const toolResult = (toolCallId: string, toolName: string) => ({
		role: "toolResult", toolCallId, toolName, content: [{ type: "text", text: `${toolName} complete` }], isError: false, timestamp: Date.now(),
	});
	const events: any[] = [
		{ type: "agent_start" },
		{ type: "turn_start" },
		{ type: "message_end", message: assistant(accumulatedMessage, "toolUse") },
		{ type: "message_end", message: assistant(accumulatedMessage, "toolUse") },
		{ type: "message_start", message: { role: "assistant" } },
		{ type: "message_update", usage, assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } },
		{ type: "message_update", usage, assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "PRIVATE_REASONING_DO_NOT_RENDER" } },
		{ type: "message_update", usage, assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "Draft response" } },
		{ type: "message_end", message: assistant("", "toolUse") },
		{ type: "tool_execution_start", toolCallId: "call-1", toolName: "grep", args: { pattern: longGrepPattern, path: "." } },
		{ type: "tool_execution_start", toolCallId: "call-2", toolName: "read", args: { path: "file.ts" } },
		{ type: "tool_execution_update", toolCallId: "call-1", toolName: "grep", args: {}, partialResult: { content: [{ type: "text", text: "GREP_OLD_SNAPSHOT" }] } },
		{ type: "tool_execution_update", toolCallId: "call-1", toolName: "grep", args: {}, partialResult: { content: [{ type: "text", text: "GREP_CURRENT_SNAPSHOT" }] } },
		{ type: "tool_execution_update", toolCallId: "call-2", toolName: "read", args: {}, partialResult: { content: [{ type: "text", text: `${"READ_PROGRESS_LINE\n".repeat(1_000)}READ_RECENT_TAIL` }] } },
		{ type: "tool_execution_update", toolCallId: "unknown-call", toolName: "bash", args: {}, partialResult: { content: [{ type: "text", text: "MISATTRIBUTED_OUTPUT" }] } },
		{ type: "tool_execution_end", toolCallId: "call-1", toolName: "grep", result: { content: [] }, isError: false },
		{ type: "tool_execution_end", toolCallId: "call-2", toolName: "read", result: { content: [] }, isError: false },
		{ type: "message_end", message: toolResult("call-1", "grep") },
		{ type: "message_end", message: toolResult("call-2", "read") },
		{ type: "turn_end", message: assistant("", "toolUse"), toolResults: [toolResult("call-1", "grep"), toolResult("call-2", "read")] },
		{ type: "turn_start" },
		{ type: "message_start", message: { role: "assistant" } },
		{ type: "message_update", usage, assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } },
		{ type: "message_update", usage, assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "ANOTHER_PRIVATE_THOUGHT" } },
		...deltas.map((delta) => ({ type: "message_update", usage, assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta } })),
		{ type: "message_end", message: assistant(recentResponse, "stop") },
		{ type: "turn_end", message: assistant(recentResponse, "stop"), toolResults: [] },
		{ type: "agent_end", messages: [], willRetry: false },
		{ type: "compaction_start", reason: "threshold" },
		{ type: "compaction_end", reason: "threshold", result: {}, aborted: false, willRetry: false },
		{ type: "agent_settled" },
	].map((event, index) => ({
		delay: event.type === "turn_start" && index > 1 ? 1_300 :
			event.type === "message_update" && (event.assistantMessageEvent?.type === "thinking_delta" || event.assistantMessageEvent?.delta?.includes("RECENT_END_MARKER")) ? 100 :
			event.type === "tool_execution_update" && event.partialResult?.content?.[0]?.text === "GREP_CURRENT_SNAPSHOT" ? 100 : 0,
		event,
	}));
	fs.writeFileSync(fixturePath, JSON.stringify(events));
	fs.writeFileSync(stubPath, `import fs from "node:fs";\nconst events = JSON.parse(fs.readFileSync(process.env.PI_SUBAGENT_FIXTURE_PATH, "utf8"));\nfor (const item of events) { if (item.delay) await new Promise(resolve => setTimeout(resolve, item.delay)); process.stdout.write(JSON.stringify(item.event) + "\\n"); }\n`);
	usePiSubprocessStub(t, stubPath, fixturePath);

	const previews: string[] = [];
	const updates: any[] = [];
	const renderContext = {
		args: { agent: "worker", task: "Exercise the live preview" }, toolCallId: "live-preview",
		invalidate() {}, lastComponent: undefined, state: undefined, cwd: harness.root,
		executionStarted: true, argsComplete: true, isPartial: true, expanded: false, showImages: false, isError: false,
	};
	let streamedResponseRendered = false;
	let compactPreview = "";
	let expandedPreview = "";
	const result = await harness.tool.execute(
		"live-preview",
		{ agent: "worker", task: "Exercise the live preview" },
		undefined,
		(update: any) => {
			updates.push(update);
			const rendered = harness.tool.renderResult!(update, { expanded: false, isPartial: true }, theme, renderContext).render(120).join("\n");
			previews.push(rendered);
			if (update.details.liveText?.includes("RECENT_END_MARKER")) {
				streamedResponseRendered = rendered.includes("RECENT_END_MARKER");
				compactPreview = rendered;
				expandedPreview = harness.tool.renderResult!(update, { expanded: true, isPartial: true }, theme, renderContext).render(120).join("\n");
			}
		},
		harness.ctx,
	);
	assert.ok(streamedResponseRendered, `the running renderer should show the recent streamed response tail before it becomes a completed timeline item; live tails: ${updates.filter((update) => update.details.liveText?.includes("RECENT_END_MARKER")).map((update) => update.details.liveText.slice(-40)).join(" | ")}; rendered: ${compactPreview}`);
	assert.doesNotMatch(compactPreview, /EARLY_START/, "collapsed live text should favor the recent tail");
	assert.doesNotMatch(compactPreview, /EXPANDED_ONLY_MARKER/, "collapsed live text should remain compact");
	assert.match(expandedPreview, /EXPANDED_ONLY_MARKER/, "expanded live view should reveal additional streamed text");
	assert.ok(Buffer.byteLength(compactPreview, "utf8") < 1_300, "collapsed live output should stay bounded");
	assert.ok(Buffer.byteLength(expandedPreview, "utf8") < 4_000, "expanded live output should stay bounded");
	assert.ok(updates.every((update) => Buffer.byteLength(update.details.liveText ?? "", "utf8") <= 16 * 1024), "retained streamed text should stay bounded even for long responses");
	assert.ok(updates.every((update) => update.details.messages.length === 0 && update.details.timeline.length === 0), "partial updates must not forward accumulated transcripts or timelines");
	const completedMessages = JSON.stringify(result.details.messages);
	assert.ok(completedMessages.includes("ACCUMULATED_ASSISTANT_MESSAGE_START") && completedMessages.includes("ACCUMULATED_ASSISTANT_MESSAGE_END"), "completed results should retain the full bounded assistant transcript");
	assert.ok(JSON.stringify(result.details.timeline).includes("grep /long-grep-argument"), "completed results should retain the bounded tool timeline");
	const lineCount = (text: string) => text.split("\n").length;
	const oneActiveTool = updates.find((update) => update.details.liveStatus === "running tools" && update.details.activeTools.length === 1)!;
	const oneActiveToolPreview = harness.tool.renderResult!(oneActiveTool, { expanded: false, isPartial: true }, theme, renderContext).render(120).join("\n");
	assert.ok(lineCount(oneActiveToolPreview) <= 10, "multiline tool arguments should display as one bounded activity label");
	const grepProgress = updates.find((update) => update.details.liveToolProgress?.toolCallId === "call-1" && update.details.liveToolProgress.text === "GREP_CURRENT_SNAPSHOT")!;
	const grepProgressPreview = harness.tool.renderResult!(grepProgress, { expanded: false, isPartial: true }, theme, renderContext).render(120).join("\n");
	assert.ok(lineCount(grepProgressPreview) <= 12, "tool-progress labels should be whitespace-normalized and bounded");
	assert.ok(lineCount(compactPreview) <= 10, "collapsed streamed text should show at most four recent lines");
	assert.ok(lineCount(expandedPreview) <= 26, "expanded streamed text should show at most twenty recent lines");
	assert.ok(previews.every((preview) => !preview.includes("PRIVATE_REASONING") && !preview.includes("ANOTHER_PRIVATE_THOUGHT")), "thinking content must never appear in the preview");
	assert.ok(updates.some((update) => update.details.liveStatus === "waiting for model" && update.details.durationMs >= 1_000), "a genuinely silent model wait should receive elapsed-time updates");
	assert.ok(updates.filter((update) => update.details.liveStatus === "responding").length < deltas.length, "rapid text deltas should be throttled rather than forwarding one update per delta");
	assert.ok(updates.some((update) => update.details.liveStatus === "thinking"), "thinking phase should be signaled without exposing its contents");
	assert.ok(updates.some((update) => update.details.liveStatus === "responding" && update.details.liveText.includes("RECENT_END_MARKER")), "streamed text should be marked as a response");
	assert.ok(updates.some((update) => update.details.durationMs >= 1_000), "elapsed time should refresh during a silent model wait");
	assert.ok(updates.some((update) => update.details.liveStatus === "running tools" && update.details.activeTools.length === 2), "overlapping tools should both be represented as active");
	assert.ok(updates.some((update) => update.details.liveStatus === "running tools" && update.details.activeTools.length === 1 && update.details.activeTools[0] === "read file.ts"), "completing one tool must not clear its concurrent sibling");
	assert.ok(updates.some((update) => update.details.liveToolProgress?.toolCallId === "call-1" && update.details.liveToolProgress.text === "GREP_CURRENT_SNAPSHOT"), "tool progress should use the latest snapshot for its matching active call");
	assert.ok(updates.some((update) => update.details.liveToolProgress?.toolCallId === "call-2" && update.details.liveToolProgress.text.endsWith("READ_RECENT_TAIL")), "concurrent tool progress should remain scoped to its own call ID and show the latest snapshot tail");
	const readProgress = updates.find((update) => update.details.liveToolProgress?.toolCallId === "call-2");
	assert.ok(Buffer.byteLength(readProgress.details.liveToolProgress.text, "utf8") <= 8 * 1024, "live tool output should remain bounded");
	const readProgressPreview = harness.tool.renderResult!(readProgress, { expanded: false, isPartial: true }, theme, renderContext).render(120).join("\n");
	assert.ok(lineCount(readProgressPreview) <= 10, "collapsed tool output should show at most four recent lines");
	const expandedReadProgressPreview = harness.tool.renderResult!(readProgress, { expanded: true, isPartial: true }, theme, renderContext).render(120).join("\n");
	assert.ok(lineCount(expandedReadProgressPreview) <= 26, "expanded tool output should show at most twenty recent lines");
	assert.match(readProgressPreview, /output from read file\.ts \[call-2\]/);
	assert.match(readProgressPreview, /READ_RECENT_TAIL/);
	assert.ok(!updates.some((update) => update.details.liveToolProgress?.text?.includes("GREP_OLD_SNAPSHOTGREP_CURRENT_SNAPSHOT")), "snapshot updates must replace rather than blindly concatenate");
	assert.ok(!updates.some((update) => update.details.liveToolProgress?.text?.includes("MISATTRIBUTED_OUTPUT")), "unknown tool call IDs must not be displayed");
	assert.ok(updates.some((update) => update.details.activeTools.length === 0 && !update.details.liveToolProgress), "completed tools must no longer expose their progress as active");
	const continuingUpdate = updates.find((update) => update.details.liveStatus === "continuing" && update.details.activeTools.length === 0);
	assert.ok(continuingUpdate, "completed tools should transition to model continuation, not remain active");
	const continuingPreview = harness.tool.renderResult!(continuingUpdate, { expanded: false, isPartial: true }, theme, renderContext).render(120).join("\n");
	assert.match(continuingPreview, /continuing/);
	assert.match(continuingPreview, /after read file\.ts/);
	assert.doesNotMatch(continuingPreview, /→ read file\.ts/, "completed tools must not still be shown as executing");
	assert.equal(result.details.status, "completed");
	assert.ok(updates.some((update) => update.details.liveStatus === "compacting"), "compaction after agent_end should be visible as compaction, not a stuck finishing phase");
	const expandedResultPreview = harness.tool.renderResult!(result, { expanded: true, isPartial: false }, theme, renderContext).render(120).join("\n");
	assert.match(expandedResultPreview, /RECENT_END_MARKER/);
	assert.match(expandedResultPreview, /long-grep-argument/, "expanded completed output should retain the bounded full tool timeline");
	const updateCount = updates.length;
	await new Promise((resolve) => setTimeout(resolve, 1_100));
	assert.equal(updates.length, updateCount, "the elapsed-time timer must stop after the child exits");
});

test("retry and compaction lifecycle events keep live phases truthful", async (t) => {
	const harness = extensionHarness(t);
	await harness.emit("session_start");
	const fixturePath = path.join(harness.root, "events.json");
	const stubPath = path.join(harness.root, "pi-stub.mjs");
	const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const assistant = (text: string, stopReason: "error" | "stop") => ({
		role: "assistant", content: [{ type: "text", text }], api: "test", provider: "test", model: "test", usage, stopReason, timestamp: Date.now(),
	});
	const failed = assistant("temporary failure", "error");
	const recovered = assistant("recovered", "stop");
	const events = [
		{ type: "agent_start" },
		{ type: "turn_start" },
		{ type: "message_start", message: { role: "assistant" } },
		{ type: "message_end", message: failed },
		{ type: "turn_end", message: failed, toolResults: [] },
		{ type: "agent_end", messages: [failed], willRetry: true },
		{ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 1_000, errorMessage: "temporary failure" },
		{ type: "turn_start" },
		{ type: "message_start", message: { role: "assistant" } },
		{ type: "message_update", usage, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "recovered" } },
		{ type: "message_end", message: recovered },
		{ type: "auto_retry_end", success: true, attempt: 1 },
		{ type: "turn_end", message: recovered, toolResults: [] },
		{ type: "agent_end", messages: [recovered], willRetry: false },
		{ type: "agent_settled" },
	];
	fs.writeFileSync(fixturePath, JSON.stringify(events));
	fs.writeFileSync(stubPath, `import fs from "node:fs";\nfor (const event of JSON.parse(fs.readFileSync(process.env.PI_SUBAGENT_FIXTURE_PATH, "utf8"))) process.stdout.write(JSON.stringify(event) + "\\n");\n`);
	usePiSubprocessStub(t, stubPath, fixturePath);
	const updates: any[] = [];
	const result = await harness.tool.execute("retry-preview", { agent: "worker", task: "Exercise retry phases" }, undefined, (update: any) => updates.push(update), harness.ctx);
	assert.ok(updates.some((update) => update.details.liveStatus === "retrying / backoff"), "automatic retry delay should not appear as a generic model wait");
	assert.equal(result.details.status, "completed");
});

test("mutating writer queue reports waiting, dispatch time, and abort cleanup", async (t) => {
	const harness = extensionHarness(t);
	await harness.emit("session_start");
	const fixturePath = path.join(harness.root, "events.json");
	const stubPath = path.join(harness.root, "pi-stub.mjs");
	const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const message = { role: "assistant", content: [{ type: "text", text: "writer complete" }], api: "test", provider: "test", model: "test", usage, stopReason: "stop", timestamp: Date.now() };
	const events = {
		delayTask: "hold writer", delayMs: 2_400,
		events: [
			{ type: "agent_start" }, { type: "turn_start" }, { type: "message_start", message: { role: "assistant" } },
			{ type: "message_end", message }, { type: "turn_end", message, toolResults: [] },
			{ type: "agent_end", messages: [message], willRetry: false }, { type: "agent_settled" },
		],
	};
	fs.writeFileSync(fixturePath, JSON.stringify(events));
	fs.writeFileSync(stubPath, `import fs from "node:fs";\nconst fixture = JSON.parse(fs.readFileSync(process.env.PI_SUBAGENT_FIXTURE_PATH, "utf8"));\nif ((process.argv.at(-1) ?? "").includes(fixture.delayTask)) await new Promise(resolve => setTimeout(resolve, fixture.delayMs));\nfor (const event of fixture.events) process.stdout.write(JSON.stringify(event) + "\\n");\n`);
	usePiSubprocessStub(t, stubPath, fixturePath);

	const firstRun = harness.tool.execute("writer-one", { agent: "worker", task: "hold writer" }, undefined, undefined, harness.ctx);
	await new Promise((resolve) => setTimeout(resolve, 50));
	const dispatchedUpdates: any[] = [];
	const secondRun = harness.tool.execute("writer-two", { agent: "worker", task: "dispatch after writer" }, undefined, (update: any) => dispatchedUpdates.push(update), harness.ctx);
	const [, dispatchedResult] = await Promise.all([firstRun, secondRun]);
	assert.ok(dispatchedUpdates.some((update) => update.details.liveStatus === "queued"), "a waiting writer should show a queued phase");
	assert.ok(dispatchedResult.details.queuedDurationMs >= 1_000, "queued wait should be measured separately from child runtime");
	assert.ok(dispatchedUpdates.some((update) => update.details.liveStatus !== "queued"), "dispatch should transition out of the queued phase");

	const abortingFirst = harness.tool.execute("writer-three", { agent: "worker", task: "hold writer" }, undefined, undefined, harness.ctx);
	await new Promise((resolve) => setTimeout(resolve, 50));
	const controller = new AbortController();
	const abortedUpdates: any[] = [];
	const abortingSecond = harness.tool.execute("writer-four", { agent: "worker", task: "abort while queued" }, controller.signal, (update: any) => abortedUpdates.push(update), harness.ctx);
	await new Promise((resolve) => setTimeout(resolve, 1_050));
	const sawQueued = abortedUpdates.some((update) => update.details.liveStatus === "queued");
	controller.abort();
	await assert.rejects(abortingSecond, /aborted while waiting for the writer queue/);
	const updatesAfterAbort = abortedUpdates.length;
	await abortingFirst;
	await new Promise((resolve) => setTimeout(resolve, 1_050));
	assert.ok(sawQueued, "a queued writer should receive periodic progress before cancellation");
	assert.equal(abortedUpdates.length, updatesAfterAbort, "queue progress timer should stop immediately after abort");
});

test("live preview timers and abort listeners are cleaned up on session shutdown", async (t) => {
	const harness = extensionHarness(t);
	await harness.emit("session_start");
	const stubPath = path.join(harness.root, "silent-pi-stub.mjs");
	fs.writeFileSync(stubPath, "await new Promise(resolve => setTimeout(resolve, 10000));\n");
	usePiSubprocessStub(t, stubPath, path.join(harness.root, "unused-fixture.json"));

	const controller = new AbortController();
	const initialAbortListeners = getEventListeners(controller.signal, "abort").length;
	const updates: any[] = [];
	const running = harness.tool.execute(
		"shutdown-preview",
		{ agent: "worker", task: "Wait for session shutdown" },
		controller.signal,
		(update: any) => updates.push(update),
		harness.ctx,
	);
	await new Promise((resolve) => setTimeout(resolve, 1_100));
	assert.ok(updates.some((update) => update.details.durationMs >= 1_000), "the active child should receive elapsed-time updates");
	assert.equal(getEventListeners(controller.signal, "abort").length, initialAbortListeners + 2, "the queue and child should each register abort cleanup while running");
	await harness.emit("session_shutdown");
	await assert.rejects(running, /failed without producing a final assistant response/);
	assert.equal(getEventListeners(controller.signal, "abort").length, initialAbortListeners, "shutdown should release the child abort listener");
	const updateCount = updates.length;
	await new Promise((resolve) => setTimeout(resolve, 1_100));
	assert.equal(updates.length, updateCount, "the elapsed-time timer must stop after shutdown");
});

test("live preview timers are cleaned up after child abort and spawn failure", async (t) => {
	const harness = extensionHarness(t);
	await harness.emit("session_start");
	const stubPath = path.join(harness.root, "slow-pi-stub.mjs");
	fs.writeFileSync(stubPath, "await new Promise(resolve => setTimeout(resolve, 10000));\n");
	const previousScript = process.argv[1];
	const previousDepth = process.env.PI_SUBAGENT_DEPTH;
	const previousPath = process.env.PATH;
	process.argv[1] = stubPath;
	delete process.env.PI_SUBAGENT_DEPTH;
	t.after(() => {
		process.argv[1] = previousScript;
		if (previousDepth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
		else process.env.PI_SUBAGENT_DEPTH = previousDepth;
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
	});

	const controller = new AbortController();
	const abortUpdates: any[] = [];
	const abortedRun = harness.tool.execute(
		"abort-preview",
		{ agent: "worker", task: "Wait until aborted" },
		controller.signal,
		(update: any) => abortUpdates.push(update),
		harness.ctx,
	);
	await new Promise((resolve) => setTimeout(resolve, 1_100));
	assert.ok(abortUpdates.some((update) => update.details.durationMs >= 1_000), "the timer should update while the child is silent");
	controller.abort();
	await assert.rejects(abortedRun, /was aborted/);
	const abortUpdateCount = abortUpdates.length;
	await new Promise((resolve) => setTimeout(resolve, 1_100));
	assert.equal(abortUpdates.length, abortUpdateCount, "the elapsed-time timer must stop after abort");

	const emptyPath = path.join(harness.root, "empty-path");
	fs.mkdirSync(emptyPath);
	process.argv[1] = path.join(harness.root, "does-not-exist.mjs");
	process.env.PATH = emptyPath;
	const spawnUpdates: any[] = [];
	await assert.rejects(
		harness.tool.execute(
			"spawn-error-preview",
			{ agent: "worker", task: "Exercise a missing child executable" },
			undefined,
			(update: any) => spawnUpdates.push(update),
			harness.ctx,
		),
		/failed without producing a final assistant response/,
	);
	const spawnUpdateCount = spawnUpdates.length;
	await new Promise((resolve) => setTimeout(resolve, 1_100));
	assert.equal(spawnUpdates.length, spawnUpdateCount, "the elapsed-time timer must stop after spawn failure");
});
