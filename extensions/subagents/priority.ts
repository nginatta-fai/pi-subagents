import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentPriority } from "./selection.ts";

export function supportsServiceTier(model: Model<Api> | undefined): boolean {
	return !!model && (
		(model.provider === "openai" && model.api === "openai-responses") ||
		(model.provider === "openai-codex" && model.api === "openai-codex-responses")
	);
}

export function supportsUltrafast(model: Model<Api> | undefined): boolean {
	if (!model || model.provider !== "openai" || model.id !== "gpt-6-astra" || model.api !== "openai-responses") return false;
	try {
		const url = new URL(model.baseUrl);
		return url.protocol === "https:" && !url.username && !url.password && !url.port &&
			["api.openai.com", "us.api.openai.com"].includes(url.hostname) &&
			(url.pathname === "/v1" || url.pathname === "/v1/") && !url.search && !url.hash;
	} catch {
		return false;
	}
}

export function formatPriority(priority: AgentPriority | undefined, model?: Model<Api>, modelReference?: string): string {
	if (priority === undefined) return "unchanged";
	const provider = model?.provider ?? modelReference?.split("/", 1)[0];
	if (priority === "ultrafast") {
		if (model) return supportsUltrafast(model) ? "ultrafast" : "ultrafast (unsupported; not applied)";
		if (provider && provider !== "openai") return "ultrafast (unsupported; not applied)";
		return "ultrafast (API GPT-6 Astra eligibility required)";
	}
	if (priority === "fast") {
		if (model) return supportsServiceTier(model) ? "fast" : "fast (unsupported; not applied)";
		if (provider && provider !== "openai" && provider !== "openai-codex") return "fast (unsupported; not applied)";
		return "fast (OpenAI Responses only)";
	}
	if (model) return supportsServiceTier(model) ? "default" : "default (no OpenAI tier)";
	if (provider && provider !== "openai" && provider !== "openai-codex") return "default (no OpenAI tier)";
	return "default (OpenAI Responses only)";
}

export function wireServiceTier(priority: AgentPriority | undefined): "priority" | "default" | "ultrafast" | undefined {
	if (priority === "fast") return "priority";
	return priority;
}
