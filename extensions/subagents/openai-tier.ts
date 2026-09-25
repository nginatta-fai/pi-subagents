import { clampThinkingLevel } from "@earendil-works/pi-ai";
import type { Api, ApiStreamOptions, Model, Provider, SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import { buildBaseOptions } from "@earendil-works/pi-ai/api/simple-options";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function withServiceTier<TApi extends Api>(provider: Provider<TApi>, api: TApi, serviceTier: "priority" | "default"): Provider<TApi> {
	const applyServiceTier = (options: ApiStreamOptions<TApi>) => ({
		...options,
		serviceTier,
		// OpenAI APIs apply samplingParams after named options, so keep all configured
		// sampling values while making the explicitly selected tier authoritative.
		samplingParams: { ...options.samplingParams, service_tier: serviceTier },
	}) as ApiStreamOptions<TApi>;

	return {
		...provider,
		stream<T extends TApi>(model: Model<T>, context: TranscriptContext, options?: ApiStreamOptions<T>) {
			if (model.api !== api) return provider.stream(model, context, options);
			return provider.stream(model, context, applyServiceTier(options ?? {} as ApiStreamOptions<TApi>) as ApiStreamOptions<T>);
		},
		streamSimple(model: Model<TApi>, context: TranscriptContext, options?: SimpleStreamOptions) {
			if (model.api !== api) return provider.streamSimple(model, context, options);
			// Native streamSimple drops API-specific serviceTier while building its base options.
			const reasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
			return provider.stream(model, context, applyServiceTier({
				...buildBaseOptions(model, context, options, options?.apiKey),
				toolChoice: options?.toolChoice,
				reasoningEffort: reasoning === "off" ? undefined : reasoning,
			} as ApiStreamOptions<TApi>));
		},
	};
}

export default function openAITierExtension(pi: ExtensionAPI) {
	const requestedTier = process.env.PI_SUBAGENTS_OPENAI_SERVICE_TIER;
	if (requestedTier !== "priority" && requestedTier !== "default") return;

	const wrappedProviders = new Set<string>();
	pi.on("session_start", (_event, ctx) => {
		for (const [providerId, api] of [
			["openai", "openai-responses"],
			["openai-codex", "openai-codex-responses"],
		] as const) {
			if (wrappedProviders.has(providerId)) continue;
			const provider = ctx.modelRegistry.getProvider(providerId);
			if (!provider) continue;
			pi.registerProvider(withServiceTier(provider, api, requestedTier));
			wrappedProviders.add(providerId);
		}
	});
}
