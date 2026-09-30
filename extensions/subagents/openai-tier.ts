import { clampThinkingLevel } from "@earendil-works/pi-ai";
import type { Api, ApiStreamOptions, Model, Provider, SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import { buildBaseOptions } from "@earendil-works/pi-ai/api/simple-options";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
			// Native streamSimple drops API-specific serviceTier while building its base options.
			const reasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
			return provider.stream(model, context, applyServiceTier({
				...buildBaseOptions(model, context, options, options?.apiKey),
				toolChoice: options?.toolChoice,
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
