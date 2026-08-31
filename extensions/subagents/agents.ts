import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	CONFIG_DIR_NAME,
	getAgentDir,
	parseFrontmatter,
} from "@earendil-works/pi-coding-agent";

export type AgentSource = "bundled" | "user" | "project";

export interface AgentConfig {
	name: string;
	description: string;
	model?: string;
	thinking?: ThinkingLevel;
	tools?: string[];
	mutating: boolean;
	systemPrompt: string;
	source: AgentSource;
	filePath: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	diagnostics: string[];
	bundledAgentsDir: string;
	userAgentsDir: string;
	projectAgentsDir: string | null;
}

type AgentFrontmatter = {
	name?: unknown;
	description?: unknown;
	model?: unknown;
	thinking?: unknown;
	tools?: unknown;
	mutating?: unknown;
};

const BUNDLED_AGENTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "agents");

const THINKING_LEVELS = new Set<ThinkingLevel>([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);

function isDirectory(candidate: string): boolean {
	try {
		return fs.statSync(candidate).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let current = path.resolve(cwd);
	while (true) {
		const candidate = path.join(current, CONFIG_DIR_NAME, "agents");
		if (isDirectory(candidate)) return candidate;

		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

function parseTools(value: unknown): { tools?: string[]; error?: string } {
	if (value === undefined) return { tools: undefined };

	const raw = Array.isArray(value)
		? value
		: typeof value === "string"
			? value.split(",")
			: null;
	if (!raw) return { error: "tools must be a YAML array or comma-separated string" };
	if (raw.some((tool) => typeof tool !== "string")) {
		return { error: "every tools entry must be a string" };
	}

	const tools = [...new Set(raw.map((tool) => (tool as string).trim()).filter(Boolean))];
	return { tools };
}

function loadAgentsFromDir(
	dir: string,
	source: AgentSource,
): { agents: AgentConfig[]; diagnostics: string[] } {
	const agents: AgentConfig[] = [];
	const diagnostics: string[] = [];
	if (!isDirectory(dir)) return { agents, diagnostics };

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch (error) {
		return {
			agents,
			diagnostics: [`Could not read ${dir}: ${error instanceof Error ? error.message : String(error)}`],
		};
	}

	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		try {
			const content = fs.readFileSync(filePath, "utf8");
			const { frontmatter, body } = parseFrontmatter<AgentFrontmatter>(content);

			if (typeof frontmatter.name !== "string" || !/^[A-Za-z0-9_-]+$/.test(frontmatter.name)) {
				diagnostics.push(`${filePath}: name is required and may contain only letters, numbers, _ and -`);
				continue;
			}
			if (typeof frontmatter.description !== "string" || !frontmatter.description.trim()) {
				diagnostics.push(`${filePath}: description is required`);
				continue;
			}
			if (frontmatter.model !== undefined && typeof frontmatter.model !== "string") {
				diagnostics.push(`${filePath}: model must be a string`);
				continue;
			}
			if (
				frontmatter.thinking !== undefined &&
				(typeof frontmatter.thinking !== "string" ||
					!THINKING_LEVELS.has(frontmatter.thinking as ThinkingLevel))
			) {
				diagnostics.push(`${filePath}: thinking must be off, minimal, low, medium, high, xhigh, or max`);
				continue;
			}
			if (frontmatter.mutating !== undefined && typeof frontmatter.mutating !== "boolean") {
				diagnostics.push(`${filePath}: mutating must be true or false`);
				continue;
			}
			if (!body.trim()) {
				diagnostics.push(`${filePath}: the Markdown body must contain the agent system prompt`);
				continue;
			}

			const parsedTools = parseTools(frontmatter.tools);
			if (parsedTools.error) {
				diagnostics.push(`${filePath}: ${parsedTools.error}`);
				continue;
			}

			// Omitted tools use Pi's defaults, which include edit/write. Shell tools can
			// also mutate the working tree, regardless of what the role prompt says.
			const hasMutationCapableTools =
				parsedTools.tools === undefined ||
				parsedTools.tools.some((tool) =>
					["bash", "powershell", "edit", "write"].includes(tool),
				);
			if (frontmatter.mutating === false && hasMutationCapableTools) {
				diagnostics.push(
					`${filePath}: mutating: false cannot override mutation-capable tools; the agent will be serialized`,
				);
			}

			agents.push({
				name: frontmatter.name,
				description: frontmatter.description.trim(),
				model:
					typeof frontmatter.model === "string" && frontmatter.model.trim()
						? frontmatter.model.trim()
						: undefined,
				thinking: frontmatter.thinking as ThinkingLevel | undefined,
				tools: parsedTools.tools,
				mutating: hasMutationCapableTools || frontmatter.mutating === true,
				systemPrompt: body.trim(),
				source,
				filePath,
			});
		} catch (error) {
			diagnostics.push(`${filePath}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	return { agents, diagnostics };
}

/**
 * Discover package-bundled agents, user overrides, and—when trusted—the nearest
 * project overrides. Later scopes override earlier scopes by agent name.
 */
export function discoverAgents(cwd: string, includeProject: boolean): AgentDiscoveryResult {
	const bundledAgentsDir = BUNDLED_AGENTS_DIR;
	const userAgentsDir = path.join(getAgentDir(), "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);
	const bundled = loadAgentsFromDir(bundledAgentsDir, "bundled");
	const user = loadAgentsFromDir(userAgentsDir, "user");
	const project =
		includeProject && projectAgentsDir
			? loadAgentsFromDir(projectAgentsDir, "project")
			: { agents: [], diagnostics: [] };

	const byName = new Map<string, AgentConfig>();
	for (const agent of bundled.agents) byName.set(agent.name, agent);
	for (const agent of user.agents) byName.set(agent.name, agent);
	for (const agent of project.agents) byName.set(agent.name, agent);

	return {
		agents: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
		diagnostics: [...bundled.diagnostics, ...user.diagnostics, ...project.diagnostics],
		bundledAgentsDir,
		userAgentsDir,
		projectAgentsDir,
	};
}

export function formatAgentCatalog(agents: AgentConfig[]): string {
	return agents
		.map((agent) => {
			const model = agent.model ?? "inherit parent model";
			const thinking = agent.thinking ?? "inherit parent thinking";
			const tools =
				agent.tools === undefined
					? "Pi defaults"
					: agent.tools.length === 0
						? "none"
						: agent.tools.join(", ");
			return `- ${agent.name}: ${agent.description} [model: ${model}; thinking: ${thinking}; tools: ${tools}; ${agent.mutating ? "may mutate files" : "read-only"}]`;
		})
		.join("\n");
}
