import { clampThinkingLevel, getSystemMessageText } from "@earendil-works/pi-ai";
import type { Api, ApiStreamOptions, Model, Provider, SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import { calculateContextTokens, estimateTokens, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { supportsUltrafast } from "./priority.ts";

function withServiceTier<TApi extends Api>(provider: Provider<TApi>, api: TApi, requestedTier: "priority" | "default" | "ultrafast"): Provider<TApi> {
	const tierFor = (model: Model<Api>) => requestedTier === "ultrafast"
		? supportsUltrafast(model) ? "ultrafast" : undefined
		: requestedTier;
	const applyServiceTier = (options: ApiStreamOptions<TApi>, serviceTier: string) => ({
		...options,
		serviceTier,
		// OpenAI APIs apply samplingParams after named options, so keep all configured
		// sampling values while making the explicitly selected tier authoritative.
		samplingParams: { ...options.samplingParams, service_tier: serviceTier },
	}) as ApiStreamOptions<TApi>;

	return {
		...provider,
		stream<T extends TApi>(model: Model<T>, context: TranscriptContext, options?: ApiStreamOptions<T>) {
			const serviceTier = tierFor(model);
			if (model.api !== api || serviceTier === undefined) return provider.stream(model, context, options);
			return provider.stream(model, context, applyServiceTier(options ?? {} as ApiStreamOptions<TApi>, serviceTier) as ApiStreamOptions<T>);
		},
		streamSimple(model: Model<TApi>, context: TranscriptContext, options?: SimpleStreamOptions) {
			const serviceTier = tierFor(model);
			if (model.api !== api || serviceTier === undefined) return provider.streamSimple(model, context, options);
			// Native streamSimple drops the named serviceTier needed for usage pricing.
			// Adapt only OpenAI's simple options here, using host-mapped public exports
			// rather than api/simple-options (which isolated Pi packages cannot import).
			const reasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
			let maxTokens = options?.maxTokens ?? model.maxTokens;
			if (model.contextWindow <= 0) maxTokens = Math.max(1, maxTokens);
			else {
				let contextTokens = 0;
				let lastUsageIndex = -1;
				let latestTimestamp = Number.NEGATIVE_INFINITY;
				for (let index = 0; index < context.messages.length; index++) {
					const message = context.messages[index];
					const usageTokens = message.role === "assistant" && message.timestamp >= latestTimestamp &&
						message.stopReason !== "error" && message.stopReason !== "aborted"
						? calculateContextTokens(message.usage) : 0;
					if (usageTokens > 0) {
						contextTokens = usageTokens;
						lastUsageIndex = index;
					}
					latestTimestamp = Math.max(latestTimestamp, message.timestamp);
				}
				// Estimate only the tail not already covered by native usage.
				for (let index = lastUsageIndex + 1; index < context.messages.length; index++) {
					const message = context.messages[index];
					if (message.role === "system") {
						contextTokens += Math.ceil(getSystemMessageText(message).length / 4);
						if (message.toolsAdded?.length) contextTokens += Math.ceil(JSON.stringify(message.toolsAdded).length / 4);
						if (message.toolsRemoved?.length) contextTokens += Math.ceil(JSON.stringify(message.toolsRemoved).length / 4);
					} else contextTokens += estimateTokens(message);
				}
				// Match the native simple request's context safety margin and output cap.
				maxTokens = Math.min(maxTokens, Math.max(1, model.contextWindow - contextTokens - 4096));
			}
			return provider.stream(model, context, applyServiceTier({
				...options,
				maxTokens,
				samplingParams: { ...model.samplingParams, ...options?.samplingParams },
				reasoningEffort: reasoning === "off" ? undefined : reasoning,
			} as ApiStreamOptions<TApi>, serviceTier));
		},
	};
}

export default function openAITierExtension(pi: ExtensionAPI) {
	const requestedTier = process.env.PI_SUBAGENTS_OPENAI_SERVICE_TIER;
	if (requestedTier !== "priority" && requestedTier !== "default" && requestedTier !== "ultrafast") return;

	const wrappedProviders = new Set<string>();
	pi.on("session_start", (_event, ctx) => {
		const providers = requestedTier === "ultrafast"
			? [["openai", "openai-responses"]] as const
			: [["openai", "openai-responses"], ["openai-codex", "openai-codex-responses"]] as const;
		for (const [providerId, api] of providers) {
			if (wrappedProviders.has(providerId)) continue;
			const provider = ctx.modelRegistry.getProvider(providerId);
			if (!provider) continue;
			pi.registerProvider(withServiceTier(provider, api, requestedTier));
			wrappedProviders.add(providerId);
		}
	});
}
