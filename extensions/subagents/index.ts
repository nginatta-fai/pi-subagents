import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentToolResult, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { StringEnum } from "@earendil-works/pi-ai";
import type { Message, Usage } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	type AgentConfig,
	type AgentSource,
	discoverAgents,
	formatAgentCatalog,
} from "./agents.ts";

const MAX_MODEL_OUTPUT_BYTES = 50 * 1024;
const MAX_STDERR_BYTES = 50 * 1024;
const MAX_TIMELINE_ITEMS = 100;
const MAX_TIMELINE_ITEM_BYTES = 8 * 1024;
const MAX_LIVE_TEXT_BYTES = 128 * 1024;
const MAX_JSON_EVENT_BYTES = 5 * 1024 * 1024;
const MAX_CAPTURED_MESSAGE_BYTES = 10 * 1024 * 1024;
const MAX_SUBAGENT_DEPTH = 1;

interface TerminationState {
	timer: ReturnType<typeof setTimeout>;
	force: () => void;
}

const terminationStates = new WeakMap<ChildProcess, TerminationState>();

interface DispatchDefaults {
	model?: string;
	thinking?: ThinkingLevel;
}

interface TimelineItem {
	type: "tool" | "text";
	text: string;
}

interface SubagentDetails {
	status: "running" | "completed";
	agent: string;
	description: string;
	source: AgentSource;
	task: string;
	model: string;
	thinking: ThinkingLevel;
	tools: string[] | null;
	mutating: boolean;
	startedAt: number;
	durationMs?: number;
	messages: Message[];
	timeline: TimelineItem[];
	usage: Usage;
	stderr: string;
	fullOutputPath?: string;
}

interface ChildResult {
	exitCode: number;
	aborted: boolean;
	messages: Message[];
	timeline: TimelineItem[];
	stderr: string;
	usage: Usage;
	model: string;
	thinking: ThinkingLevel;
	startedAt: number;
	durationMs: number;
	outputLimitError?: string;
}

type UpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function addUsage(total: Usage, usage: Usage): void {
	total.input += usage.input || 0;
	total.output += usage.output || 0;
	total.cacheRead += usage.cacheRead || 0;
	total.cacheWrite += usage.cacheWrite || 0;
	total.totalTokens += usage.totalTokens || 0;
	total.cost.input += usage.cost?.input || 0;
	total.cost.output += usage.cost?.output || 0;
	total.cost.cacheRead += usage.cost?.cacheRead || 0;
	total.cost.cacheWrite += usage.cost?.cacheWrite || 0;
	total.cost.total += usage.cost?.total || 0;
	if (usage.reasoning !== undefined) total.reasoning = (total.reasoning ?? 0) + usage.reasoning;
	if (usage.cacheWrite1h !== undefined) total.cacheWrite1h = (total.cacheWrite1h ?? 0) + usage.cacheWrite1h;
}

function formatTokenCount(count: number): string {
	if (count < 1_000) return String(count);
	if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
	return `${Math.round(count / 1_000)}k`;
}

function formatUsage(usage: Usage): string {
	const tokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	const parts = [`${formatTokenCount(tokens)} tokens`];
	if (usage.cost.total > 0) parts.push(`$${usage.cost.total.toFixed(4)}`);
	return parts.join(" · ");
}

function isUsage(value: unknown): value is Usage {
	if (!value || typeof value !== "object") return false;
	const usage = value as Record<string, unknown>;
	const cost = usage.cost;
	if (!cost || typeof cost !== "object") return false;
	const numericUsageFields = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"];
	const numericCostFields = ["input", "output", "cacheRead", "cacheWrite", "total"];
	return (
		numericUsageFields.every((field) => typeof usage[field] === "number") &&
		numericCostFields.every(
			(field) => typeof (cost as Record<string, unknown>)[field] === "number",
		)
	);
}

function isAssistantMessage(value: unknown): value is Extract<Message, { role: "assistant" }> {
	if (!value || typeof value !== "object") return false;
	const message = value as Record<string, unknown>;
	if (message.role !== "assistant" || !Array.isArray(message.content)) return false;
	const validContent = message.content.every((part) => {
		if (!part || typeof part !== "object") return false;
		const content = part as Record<string, unknown>;
		if (content.type === "text") return typeof content.text === "string";
		return content.type === "thinking" || content.type === "toolCall";
	});
	return validContent && typeof message.stopReason === "string" && isUsage(message.usage);
}

function assistantText(message: Message): string {
	if (message.role !== "assistant") return "";
	return message.content
		.filter((part): part is Extract<(typeof message.content)[number], { type: "text" }> => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
}

function getFinalOutput(messages: Message[]): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const text = assistantText(messages[index]);
		if (text) return text;
	}
	return "";
}

function getLastAssistant(messages: Message[]): Extract<Message, { role: "assistant" }> | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role === "assistant") return message;
	}
	return undefined;
}

function describeToolCall(toolName: string, args: unknown): string {
	const values = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
	if (toolName === "read") return `read ${String(values.path ?? "...")}`;
	if (toolName === "grep") return `grep /${String(values.pattern ?? "")}/ in ${String(values.path ?? ".")}`;
	if (toolName === "find") return `find ${String(values.pattern ?? "*")} in ${String(values.path ?? ".")}`;
	if (toolName === "ls") return `ls ${String(values.path ?? ".")}`;
	if (toolName === "bash") {
		const command = String(values.command ?? "...").replace(/\s+/g, " ");
		return `$ ${command.length > 100 ? `${command.slice(0, 100)}…` : command}`;
	}
	if (toolName === "edit" || toolName === "write") return `${toolName} ${String(values.path ?? "...")}`;
	return toolName;
}

function appendBoundedTail(current: string, chunk: string, maxBytes: number): string {
	const combined = current + chunk;
	const buffer = Buffer.from(combined, "utf8");
	if (buffer.byteLength <= maxBytes) return combined;
	return `[earlier stderr omitted]\n${buffer.subarray(buffer.byteLength - maxBytes).toString("utf8")}`;
}

function truncateUtf8Head(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	let truncated = text.slice(0, maxBytes);
	while (Buffer.byteLength(truncated, "utf8") > maxBytes) truncated = truncated.slice(0, -1);
	return truncated;
}

function truncateUtf8Tail(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	let truncated = text.slice(-maxBytes);
	while (Buffer.byteLength(truncated, "utf8") > maxBytes) truncated = truncated.slice(1);
	return truncated;
}

function pushTimeline(timeline: TimelineItem[], item: TimelineItem): void {
	const boundedText = truncateUtf8Head(item.text, MAX_TIMELINE_ITEM_BYTES);
	timeline.push({
		...item,
		text: boundedText === item.text ? item.text : `${boundedText}\n[activity item truncated]`,
	});
	if (timeline.length > MAX_TIMELINE_ITEMS) timeline.shift();
}

function truncateForModel(output: string): { text: string; fullOutputPath?: string } {
	const bytes = Buffer.byteLength(output, "utf8");
	if (bytes <= MAX_MODEL_OUTPUT_BYTES) return { text: output };

	const fullOutputPath = path.join(os.tmpdir(), `pi-subagent-output-${randomUUID()}.md`);
	fs.writeFileSync(fullOutputPath, output, { encoding: "utf8", mode: 0o600 });
	const suffix = `\n\n[Output truncated. Full output: ${fullOutputPath}]`;
	const text = truncateUtf8Head(
		output,
		MAX_MODEL_OUTPUT_BYTES - Buffer.byteLength(suffix, "utf8"),
	);
	return { text: `${text}${suffix}`, fullOutputPath };
}

async function createPromptFile(agent: AgentConfig): Promise<{ directory: string; filePath: string }> {
	const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-prompt-"));
	const filePath = path.join(directory, `${agent.name}.md`);
	await fs.promises.writeFile(filePath, agent.systemPrompt, { encoding: "utf8", mode: 0o600 });
	return { directory, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const executable = path.basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(executable)) return { command: process.execPath, args };
	return { command: "pi", args };
}

function signalProcessTree(child: ChildProcess, pid: number, force: boolean): void {
	try {
		if (process.platform === "win32") {
			const killer = spawn(
				"taskkill",
				["/PID", String(pid), "/T", ...(force ? ["/F"] : [])],
				{ stdio: "ignore", windowsHide: true },
			);
			killer.unref();
		} else {
			// Signal the saved process group even if its leader has already exited;
			// detached descendants may still belong to that group.
			process.kill(-pid, force ? "SIGKILL" : "SIGTERM");
		}
	} catch {
		if (child.exitCode !== null || child.signalCode !== null) return;
		try {
			child.kill(force ? "SIGKILL" : "SIGTERM");
		} catch {
			// The process may have exited between the status check and the signal.
		}
	}
}

function terminateProcess(child: ChildProcess): void {
	if (terminationStates.has(child) || !child.pid) return;
	const pid = child.pid;
	const state = {} as TerminationState;
	state.force = () => {
		if (terminationStates.get(child) !== state) return;
		clearTimeout(state.timer);
		child.off("close", state.force);
		terminationStates.delete(child);
		signalProcessTree(child, pid, true);
	};
	state.timer = setTimeout(state.force, 5_000);
	state.timer.unref();
	terminationStates.set(child, state);
	// If the group leader exits during the grace period, force-kill its saved
	// process group immediately before the numeric pid can be reused.
	child.once("close", state.force);
	signalProcessTree(child, pid, false);
}

async function runChildAgent(
	agent: AgentConfig,
	task: string,
	cwd: string,
	projectTrusted: boolean,
	defaults: DispatchDefaults,
	signal: AbortSignal | undefined,
	onUpdate: UpdateCallback | undefined,
	activeChildren: Set<ChildProcess>,
): Promise<ChildResult> {
	if (signal?.aborted) throw new Error(`Subagent "${agent.name}" was aborted before it started`);

	const depth = Number.parseInt(process.env.PI_SUBAGENT_DEPTH ?? "0", 10) || 0;
	if (depth >= MAX_SUBAGENT_DEPTH) {
		throw new Error(`Subagent depth limit (${MAX_SUBAGENT_DEPTH}) reached`);
	}

	const model = agent.model ?? defaults.model;
	const thinking = agent.thinking ?? defaults.thinking ?? "off";
	if (!model) throw new Error(`Agent "${agent.name}" has no model and the parent session has no active model`);

	const prompt = await createPromptFile(agent);
	const args = [
		"--mode",
		"json",
		"--print",
		"--no-session",
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
	];
	if (projectTrusted) args.push("--approve");
	args.push("--model", model, "--thinking", thinking);
	if (agent.tools !== undefined) {
		if (agent.tools.length === 0) args.push("--no-tools");
		else args.push("--tools", agent.tools.join(","));
	}
	args.push("--append-system-prompt", prompt.filePath, "--", `Task: ${task}`);

	const messages: Message[] = [];
	const timeline: TimelineItem[] = [];
	const usage = emptyUsage();
	const startedAt = Date.now();
	let stderr = "";
	let liveText = "";
	let statusText = "starting";
	let lastUpdateAt = 0;
	let aborted = false;

	const makeDetails = (status: "running" | "completed"): SubagentDetails => ({
		status,
		agent: agent.name,
		description: agent.description,
		source: agent.source,
		task,
		model,
		thinking,
		tools: agent.tools ?? null,
		mutating: agent.mutating,
		startedAt,
		durationMs: status === "completed" ? Date.now() - startedAt : undefined,
		messages: [...messages],
		timeline: [...timeline],
		usage: { ...usage, cost: { ...usage.cost } },
		stderr,
	});

	const emitUpdate = (force = false) => {
		if (!onUpdate) return;
		const now = Date.now();
		if (!force && now - lastUpdateAt < 75) return;
		lastUpdateAt = now;
		const preview = liveText.trim() || statusText;
		onUpdate({
			content: [{ type: "text", text: preview || "running" }],
			details: makeDetails("running"),
		});
	};

	try {
		const invocation = getPiInvocation(args);
		const child = spawn(invocation.command, invocation.args, {
			cwd,
			detached: process.platform !== "win32",
			env: {
				...process.env,
				PI_SUBAGENT_DEPTH: String(depth + 1),
				PI_SUBAGENT_PARENT_SESSION_ID: process.env.PI_SESSION_ID ?? "",
			},
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});
		activeChildren.add(child);

		let stdoutBuffer = "";
		let settled = false;
		let spawnError: Error | undefined;
		let outputLimitError: string | undefined;
		let capturedMessageBytes = 0;

		const failForOutputLimit = (message: string) => {
			if (outputLimitError) return;
			outputLimitError = message;
			terminateProcess(child);
		};

		const processLine = (line: string) => {
			if (!line.trim() || outputLimitError) return;
			if (Buffer.byteLength(line, "utf8") > MAX_JSON_EVENT_BYTES) {
				failForOutputLimit(`Subagent JSON event exceeded ${MAX_JSON_EVENT_BYTES} bytes`);
				return;
			}
			let event: any;
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}

			if (event.type === "message_update") {
				const assistantEvent = event.assistantMessageEvent;
				if (assistantEvent?.type === "text_delta" && typeof assistantEvent.delta === "string") {
					liveText += assistantEvent.delta;
					if (Buffer.byteLength(liveText, "utf8") > MAX_LIVE_TEXT_BYTES) {
						liveText = `[earlier live output omitted]\n${truncateUtf8Tail(liveText, MAX_LIVE_TEXT_BYTES)}`;
					}
					statusText = "responding";
					emitUpdate();
				}
				return;
			}

			if (event.type === "tool_execution_start") {
				if (typeof event.toolName !== "string") {
					failForOutputLimit("Subagent emitted an invalid tool execution event");
					return;
				}
				const description = truncateUtf8Head(
					describeToolCall(event.toolName, event.args),
					MAX_TIMELINE_ITEM_BYTES,
				);
				pushTimeline(timeline, { type: "tool", text: description });
				statusText = description;
				liveText = "";
				emitUpdate(true);
				return;
			}

			if (event.type === "message_end" && event.message) {
				if (event.message.role !== "assistant") return;
				if (!isAssistantMessage(event.message)) {
					failForOutputLimit("Subagent emitted an invalid assistant message");
					return;
				}
				const message = event.message;
				if (message.role === "assistant") {
					capturedMessageBytes += Buffer.byteLength(JSON.stringify(message), "utf8");
					if (capturedMessageBytes > MAX_CAPTURED_MESSAGE_BYTES) {
						failForOutputLimit(
							`Captured subagent messages exceeded ${MAX_CAPTURED_MESSAGE_BYTES} bytes`,
						);
						return;
					}
					messages.push(message);
					addUsage(usage, message.usage);
					const text = assistantText(message);
					if (text) pushTimeline(timeline, { type: "text", text });
					liveText = "";
					statusText = message.stopReason === "toolUse" ? "using tools" : "finishing";
				}
				emitUpdate(true);
			}
		};

		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk) => {
			if (outputLimitError) return;
			stdoutBuffer += typeof chunk === "string" ? chunk : chunk.toString();
			const lines = stdoutBuffer.split("\n");
			stdoutBuffer = lines.pop() ?? "";
			for (const line of lines) processLine(line);
			if (Buffer.byteLength(stdoutBuffer, "utf8") > MAX_JSON_EVENT_BYTES) {
				failForOutputLimit(`Subagent JSON event exceeded ${MAX_JSON_EVENT_BYTES} bytes`);
				stdoutBuffer = "";
			}
		});
		child.stderr?.on("data", (chunk) => {
			const text = typeof chunk === "string" ? chunk : chunk.toString();
			stderr = appendBoundedTail(stderr, text, MAX_STDERR_BYTES);
		});

		const abortHandler = () => {
			aborted = true;
			terminateProcess(child);
		};
		if (signal?.aborted) abortHandler();
		else signal?.addEventListener("abort", abortHandler, { once: true });

		const exitCode = await new Promise<number>((resolve) => {
			const finish = (code: number) => {
				if (settled) return;
				settled = true;
				resolve(code);
			};
			child.on("error", (error) => {
				spawnError = error;
				finish(1);
			});
			child.on("close", (code) => finish(code ?? 1));
		});

		signal?.removeEventListener("abort", abortHandler);
		activeChildren.delete(child);
		if (stdoutBuffer.trim()) processLine(stdoutBuffer);
		if (spawnError) stderr = appendBoundedTail(stderr, spawnError.message, MAX_STDERR_BYTES);
		if (outputLimitError) stderr = appendBoundedTail(stderr, outputLimitError, MAX_STDERR_BYTES);

		return {
			exitCode,
			aborted,
			messages,
			timeline,
			stderr,
			usage,
			model,
			thinking,
			startedAt,
			durationMs: Date.now() - startedAt,
			outputLimitError,
		};
	} finally {
		await fs.promises.rm(prompt.directory, { recursive: true, force: true }).catch(() => undefined);
	}
}

export default function subagentsExtension(pi: ExtensionAPI) {
	const activeChildren = new Set<ChildProcess>();
	const temporaryOutputs = new Set<string>();
	let mutatingQueue: Promise<void> = Promise.resolve();
	let toolRegistered = false;
	let runtimeActive = true;

	const enqueueMutating = <T,>(
		operation: () => Promise<T>,
		signal: AbortSignal | undefined,
	): Promise<T> => {
		const queued = mutatingQueue.then(() => {
			if (!runtimeActive) throw new Error("Subagent runtime is shutting down");
			if (signal?.aborted) throw new Error("Subagent was aborted while waiting for the writer queue");
			return operation();
		});
		mutatingQueue = queued.then(
			() => undefined,
			() => undefined,
		);

		if (!signal) return queued;
		return new Promise<T>((resolve, reject) => {
			let settled = false;
			const finish = (callback: () => void) => {
				if (settled) return;
				settled = true;
				signal.removeEventListener("abort", abortHandler);
				callback();
			};
			const abortHandler = () =>
				finish(() => reject(new Error("Subagent was aborted while waiting for the writer queue")));
			if (signal.aborted) {
				abortHandler();
				return;
			}
			signal.addEventListener("abort", abortHandler, { once: true });
			queued.then(
				(value) => finish(() => resolve(value)),
				(error) => finish(() => reject(error)),
			);
		});
	};

	pi.registerCommand("subagents", {
		description: "List configured subagents",
		handler: async (_args, ctx) => {
			const discovery = discoverAgents(ctx.cwd, ctx.isProjectTrusted());
			const catalog = discovery.agents.length ? formatAgentCatalog(discovery.agents) : "No agents found.";
			const diagnostics = discovery.diagnostics.length
				? `\n\nConfiguration warnings:\n${discovery.diagnostics.map((item) => `- ${item}`).join("\n")}`
				: "";
			ctx.ui.notify(`${catalog}${diagnostics}`, discovery.diagnostics.length ? "warning" : "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		if (toolRegistered) return;
		toolRegistered = true;

		const discovery = discoverAgents(ctx.cwd, ctx.isProjectTrusted());
		const agentNames = discovery.agents.map((agent) => agent.name);
		const catalog = discovery.agents.length ? formatAgentCatalog(discovery.agents) : "- No valid agents discovered";
		const agentSchema = StringEnum(agentNames.length ? agentNames : ["unavailable"], {
			description: "Specialized agent to invoke",
		});

		pi.registerTool({
			name: "subagent",
			label: "Subagent",
			description: [
				"Delegate a self-contained task to one specialized agent running in an isolated Pi process and context window.",
				"Choose the agent from this catalog:",
				catalog,
			].join("\n"),
			promptSnippet: `Delegate specialized work to: ${agentNames.join(", ") || "configured subagents"}`,
			promptGuidelines: [
				"Use subagent proactively when specialized investigation, independent review, or isolated implementation would materially improve the result; the user does not need to request delegation.",
				"Give subagent a self-contained task with the relevant goal, constraints, and expected output.",
				"Use scout for broad codebase reconnaissance, reviewer for an independent quality/security pass, and worker for delegated implementation.",
				"Do not invoke a mutating subagent in parallel with another subagent operating on the same working tree.",
			],
			parameters: Type.Object({
				agent: agentSchema,
				task: Type.String({
					description: "Complete, self-contained task assigned by the main agent",
					minLength: 1,
				}),
			}),
			executionMode: "parallel",

			async execute(_toolCallId, params, signal, onUpdate, executionCtx) {
				const fresh = discoverAgents(executionCtx.cwd, executionCtx.isProjectTrusted());
				const agent = fresh.agents.find((candidate) => candidate.name === params.agent);
				if (!agent) {
					const available = fresh.agents.map((candidate) => candidate.name).join(", ") || "none";
					throw new Error(`Unknown subagent "${params.agent}". Available agents: ${available}`);
				}

				const defaults: DispatchDefaults = {
					model: executionCtx.model
						? `${executionCtx.model.provider}/${executionCtx.model.id}`
						: undefined,
					thinking: executionCtx.thinkingLevel,
				};
				const run = () =>
					runChildAgent(
						agent,
						params.task,
						executionCtx.cwd,
						executionCtx.isProjectTrusted(),
						defaults,
						signal,
						onUpdate,
						activeChildren,
					);
				const childResult = await (agent.mutating ? enqueueMutating(run, signal) : run());
				const lastAssistant = getLastAssistant(childResult.messages);
				if (childResult.outputLimitError) {
					throw new Error(`Subagent "${agent.name}" failed: ${childResult.outputLimitError}`);
				}
				if (childResult.aborted || lastAssistant?.stopReason === "aborted") {
					throw new Error(`Subagent "${agent.name}" was aborted`);
				}
				if (!lastAssistant) {
					throw new Error(
						`Subagent "${agent.name}" failed without producing a final assistant response${childResult.stderr.trim() ? `: ${childResult.stderr.trim()}` : ""}`,
					);
				}
				if (childResult.exitCode !== 0 || lastAssistant.stopReason === "error") {
					const reason =
						lastAssistant?.errorMessage ||
						childResult.stderr.trim() ||
						`child process exited with code ${childResult.exitCode}`;
					throw new Error(`Subagent "${agent.name}" failed: ${reason}`);
				}

				const output = getFinalOutput(childResult.messages) || "(Subagent completed without a text response.)";
				const truncated = truncateForModel(output);
				if (truncated.fullOutputPath) temporaryOutputs.add(truncated.fullOutputPath);
				const details: SubagentDetails = {
					status: "completed",
					agent: agent.name,
					description: agent.description,
					source: agent.source,
					task: params.task,
					model: childResult.model,
					thinking: childResult.thinking,
					tools: agent.tools ?? null,
					mutating: agent.mutating,
					startedAt: childResult.startedAt,
					durationMs: childResult.durationMs,
					messages: childResult.messages,
					timeline: childResult.timeline,
					usage: childResult.usage,
					stderr: childResult.stderr,
					fullOutputPath: truncated.fullOutputPath,
				};

				return {
					content: [{ type: "text", text: truncated.text }],
					details,
					usage: childResult.usage,
				};
			},

			renderCall(args, theme) {
				const task = args.task.length > 100 ? `${args.task.slice(0, 100)}…` : args.task;
				return new Text(
					`${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", args.agent)}\n${theme.fg("dim", task)}`,
					0,
					0,
				);
			},

			renderResult(result, { expanded, isPartial }, theme) {
				const details = result.details as SubagentDetails | undefined;
				if (!details) {
					const content = result.content[0];
					return new Text(content?.type === "text" ? content.text : "", 0, 0);
				}

				const running = isPartial || details.status === "running";
				const icon = running ? theme.fg("warning", "⏳") : theme.fg("success", "✓");
				const duration = details.durationMs === undefined ? "" : ` · ${(details.durationMs / 1_000).toFixed(1)}s`;
				const header = `${icon} ${theme.fg("accent", theme.bold(details.agent))} ${theme.fg("muted", `${details.model}:${details.thinking}${duration}`)}`;

				if (running) {
					const last = details.timeline[details.timeline.length - 1];
					return new Text(`${header}\n${theme.fg("dim", last?.text ?? "starting…")}`, 0, 0);
				}

				const finalOutput = getFinalOutput(details.messages);
				if (expanded) {
					const container = new Container();
					container.addChild(new Text(header, 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "Task"), 0, 0));
					container.addChild(new Text(theme.fg("dim", details.task), 0, 0));
					if (details.timeline.some((item) => item.type === "tool")) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("muted", "Activity"), 0, 0));
						for (const item of details.timeline.filter((entry) => entry.type === "tool")) {
							container.addChild(new Text(`${theme.fg("muted", "→ ")}${theme.fg("toolOutput", item.text)}`, 0, 0));
						}
					}
					if (finalOutput) {
						container.addChild(new Spacer(1));
						container.addChild(new Markdown(finalOutput, 0, 0, getMarkdownTheme()));
					}
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("dim", formatUsage(details.usage)), 0, 0));
					return container;
				}

				const preview = finalOutput
					.split("\n")
					.slice(0, 10)
					.join("\n")
					.slice(0, 1_500);
				return new Text(
					`${header}\n${theme.fg("toolOutput", preview || "(no output)")}\n${theme.fg("dim", `${formatUsage(details.usage)} · Ctrl+O to expand`)}`,
					0,
					0,
				);
			},
		});

		if (discovery.diagnostics.length && ctx.hasUI) {
			ctx.ui.notify(
				`Subagent configuration warnings:\n${discovery.diagnostics.join("\n")}`,
				"warning",
			);
		}
	});

	pi.on("session_shutdown", async () => {
		runtimeActive = false;
		for (const child of activeChildren) terminateProcess(child);
		activeChildren.clear();
		await Promise.all(
			[...temporaryOutputs].map((filePath) =>
				fs.promises.rm(filePath, { force: true }).catch(() => undefined),
			),
		);
		temporaryOutputs.clear();
	});
}
