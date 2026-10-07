import type { AnthropicMessagesCompat, Api, Model, OpenAIResponsesCompat } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { typesafeSystemOneApi } from "@earendil-works/pi-ai/api/typesafe-system-one.lazy";
import { createModels, createProvider, type MutableModels } from "@earendil-works/pi-ai/models";
import { getBuiltinClassifierModel, getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import type { ModelRef } from "@earendil-works/pi-durable";
import { JEV } from "./classifier.ts";

const BIFROST = "https://bifrost.shau.me";

export const OPUS: ModelRef = { provider: "bifrost-anthropic", modelId: "claude-opus-5-5" };
export const FAST: ModelRef = { provider: "bifrost-openai", modelId: "azure/gpt-6-luna" };

/**
 * A model id as agents/models.json writes it, on mochi's Bifrost routes: `anthropic/<id>` is served by the Anthropic
 * route and `azure/<id>` by the OpenAI route under its full id. Any other `provider/id` is used as written.
 */
export function bifrostRef(id: string): ModelRef {
	const slash = id.indexOf("/");
	if (slash <= 0) throw new Error(`Model id ${id} is not provider/id.`);
	const provider = id.slice(0, slash);
	if (provider === "anthropic") return { provider: OPUS.provider, modelId: id.slice(slash + 1) };
	if (provider === "azure") return { provider: FAST.provider, modelId: id };
	return { provider, modelId: id.slice(slash + 1) };
}

const opus: Model<"anthropic-messages"> = {
	id: OPUS.modelId,
	name: "Claude Opus 5.5",
	api: "anthropic-messages",
	provider: OPUS.provider,
	baseUrl: `${BIFROST}/anthropic`,
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
	// Opus serves 1M, but pi-durable compacts relative to this value: 200k puts background compaction at ~150k and
	// blocking at ~184k instead of ~950k, so the owner's single thread never resends a near-1M transcript.
	contextWindow: 200_000,
	maxTokens: 128_000,
	thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
	promptCache: { short: 300, long: 3600 },
	compat: {
		supportsMidConvoEffort: true,
		supportsMidConvoSystemMessages: true,
		supportsMidConvoToolChanges: true,
		forceAdaptiveThinking: true,
		supportsTemperature: false,
		supportsStrictTools: true,
	} satisfies AnthropicMessagesCompat,
};

const luna: Model<"openai-responses"> = {
	id: FAST.modelId,
	name: "GPT-6 Luna",
	api: "openai-responses",
	provider: FAST.provider,
	baseUrl: `${BIFROST}/openai/v1`,
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
	contextWindow: 272_000,
	maxTokens: 128_000,
	thinkingLevelMap: { off: "none", minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
	promptCache: { short: 1800, long: 1800 },
	compat: {
		supportsMidConvoSystemMessages: true,
		supportsToolSearch: true,
		supportsOpenAIGrammarTools: true,
		supportsExplicitPromptCacheMode: true,
	} satisfies OpenAIResponsesCompat,
};

/** A catalog Claude model served through Bifrost's Anthropic route. */
function onBifrost(model: Model<"anthropic-messages">): Model<"anthropic-messages"> {
	return { ...model, provider: OPUS.provider, baseUrl: `${BIFROST}/anthropic` };
}

/**
 * Both Bifrost routes authenticate with the virtual key in `x-bf-vk`. The pi-ai clients refuse to send without an
 * API key, so they get a placeholder that is not a credential.
 */
function bifrostAuth(virtualKey: string) {
	return {
		apiKey: {
			name: "Bifrost virtual key",
			resolve: async () => ({ auth: { apiKey: "bifrost", headers: { "x-bf-vk": virtualKey } }, source: "BIFROST_VIRTUAL_KEY" }),
		},
	};
}

/**
 * Bifrost is not known to relay System One classifier requests, so Jev goes to OpenRouter directly. Without
 * `OPENROUTER_API_KEY` the provider is absent and every gate passes.
 */
function openRouterClassifier(apiKey: string) {
	return createProvider<Api>({
		id: JEV.provider,
		name: "OpenRouter (classifiers)",
		auth: { apiKey: { name: "OpenRouter API key", resolve: async () => ({ auth: { apiKey }, source: "OPENROUTER_API_KEY" }) } },
		models: [getBuiltinClassifierModel(JEV.provider, JEV.modelId)],
		classifiers: { "typesafe-system-one": typesafeSystemOneApi() },
	});
}

export function createBifrostModels(virtualKey: string, openRouterKey?: string): MutableModels {
	const models = createModels();
	models.setProvider(
		createProvider<Api>({
			id: OPUS.provider,
			name: "Bifrost (Anthropic)",
			auth: bifrostAuth(virtualKey),
			models: [opus, onBifrost(getBuiltinModel("anthropic", "claude-sonnet-5-5")), onBifrost(getBuiltinModel("anthropic", "claude-fable-5-1"))],
			api: anthropicMessagesApi(),
		}),
	);
	models.setProvider(
		createProvider<Api>({
			id: FAST.provider,
			name: "Bifrost (OpenAI)",
			auth: bifrostAuth(virtualKey),
			models: [luna],
			api: openAIResponsesApi(),
		}),
	);
	if (openRouterKey !== undefined) models.setProvider(openRouterClassifier(openRouterKey));
	return models;
}
