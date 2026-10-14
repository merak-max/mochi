import type { AnthropicMessagesCompat, Api, Model, OpenAIResponsesCompat } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { typesafeSystemOneApi } from "@earendil-works/pi-ai/api/typesafe-system-one.lazy";
import { createModels, createProvider, type MutableModels } from "@earendil-works/pi-ai/models";
import { getBuiltinClassifierModel, getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import type { ModelRef } from "@earendil-works/pi-durable";
import { type Static, Type } from "typebox";
import type { Env } from "../notes/secrets.ts";
import { JEV } from "./classifier.ts";

/**
 * `[providers.<name>]` in config.toml: an endpoint, the wire protocol it speaks, and the env variable with its key.
 *   anthropic  Anthropic Messages (Anthropic, or a gateway's Anthropic route)
 *   responses  OpenAI Responses (OpenAI, Azure, or a gateway's OpenAI route)
 *   chat       OpenAI chat completions (OpenRouter, Ollama, vLLM, LiteLLM, most gateways)
 * A gateway such as Bifrost or LiteLLM is one provider per protocol it serves. A model is `<provider>/<model id>`,
 * and the id is sent as written, so a gateway's own ids (`anthropic/claude-opus-5-5`) work unchanged.
 */
export const ProviderSchema = Type.Object(
	{
		api: Type.Union([Type.Literal("anthropic"), Type.Literal("responses"), Type.Literal("chat")]),
		url: Type.Optional(Type.String({ pattern: "^https?://" })),
		keyEnv: Type.Optional(Type.String({ pattern: "^[A-Z_][A-Z0-9_]*$" })),
		headers: Type.Optional(Type.Record(Type.String(), Type.String())),
	},
	{ additionalProperties: false },
);
type ProviderConfig = Static<typeof ProviderSchema>;

const ModelOverrideSchema = Type.Object(
	{
		cost: Type.Optional(Type.Object({ input: Type.Number(), output: Type.Number(), cacheRead: Type.Number(), cacheWrite: Type.Number() }, { additionalProperties: false })),
		contextWindow: Type.Optional(Type.Integer({ minimum: 1 })),
		maxTokens: Type.Optional(Type.Integer({ minimum: 1 })),
		/** Seconds a prompt cache entry lives: the short (default) and long retention. */
		promptCache: Type.Optional(Type.Object({ short: Type.Integer({ minimum: 1 }), long: Type.Integer({ minimum: 1 }) }, { additionalProperties: false })),
	},
	{ additionalProperties: false },
);
type ModelOverride = Static<typeof ModelOverrideSchema>;

/** `[models]` in config.toml: the brain and fast models, and short names for the rest. */
export const ModelsSchema = Type.Object(
	{
		brain: Type.Optional(Type.String({ minLength: 3 })),
		fast: Type.Optional(Type.String({ minLength: 3 })),
		/** The strongest model, for an agent that asks for `strongest`. Default: the brain. */
		strongest: Type.Optional(Type.String({ minLength: 3 })),
		/** `sonnet = "anthropic/claude-sonnet-5-5"`: names an agent file or a trigger may use. */
		aliases: Type.Optional(Type.Record(Type.String({ pattern: "^[a-z0-9-]+$" }), Type.String({ minLength: 3 }))),
		/** Facts about a model pi-ai's catalog does not know, by `<provider>/<id>`: dollars per million tokens and limits. */
		overrides: Type.Optional(Type.Record(Type.String({ minLength: 3 }), ModelOverrideSchema)),
	},
	{ additionalProperties: false },
);
type ModelsConfig = Static<typeof ModelsSchema>;

const DEFAULTS = {
	anthropic: { url: "https://api.anthropic.com", keyEnv: "ANTHROPIC_API_KEY" },
	responses: { url: "https://api.openai.com/v1", keyEnv: "OPENAI_API_KEY" },
	chat: { url: "https://api.openai.com/v1", keyEnv: "OPENAI_API_KEY" },
} as const;

/** The models mochi talks to, resolved once from config. `ref` turns a tier, alias or `provider/id` into a model. */
export interface ModelSetup {
	readonly models: MutableModels;
	readonly brain: ModelRef;
	readonly fast: ModelRef;
	/** `brain` (or `default`), `fast`, `strongest`, an alias, or `provider/id`. */
	ref(name: string): ModelRef;
	/** One line per provider whose key is not set, for the setup report. */
	readonly missing: readonly string[];
}

/** No `[providers]`: Anthropic with ANTHROPIC_API_KEY, else OpenAI with OPENAI_API_KEY. */
function defaultProviders(env: Env): Record<string, ProviderConfig> {
	if (!env.ANTHROPIC_API_KEY && env.OPENAI_API_KEY) return { openai: { api: "responses" } };
	return { anthropic: { api: "anthropic" } };
}

function defaultModels(providers: Record<string, ProviderConfig>): Required<Pick<ModelsConfig, "brain" | "fast">> {
	const [name, provider] = Object.entries(providers)[0]!;
	if (provider.api === "anthropic") return { brain: `${name}/claude-opus-5-5`, fast: `${name}/claude-haiku-5-5` };
	return { brain: `${name}/gpt-6-sol`, fast: `${name}/gpt-6-luna` };
}

/** Opus serves 1M, but compaction is relative to `contextWindow`: 200k compacts near 150k instead of 950k. */
const CONTEXT_WINDOW = 200_000;

/** pi-ai's catalog entry for an id, looked up by its last path part, so `anthropic/claude-opus-5-5` finds Opus. */
function catalog(provider: "anthropic" | "openai", id: string): Model<Api> | undefined {
	const bare = id.slice(id.lastIndexOf("/") + 1);
	try {
		return getBuiltinModel(provider, bare as never) as Model<Api>;
	} catch {
		return undefined;
	}
}

function plain(id: string, api: Api): Model<Api> {
	return { id, name: id, api, provider: "", baseUrl: "", reasoning: true, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: CONTEXT_WINDOW, maxTokens: 64_000 };
}

/** A model definition for `id` on a provider: the catalog's prices, limits and quirks where it knows the model. */
function definition(id: string, config: ProviderConfig, provider: string, url: string, override: ModelOverride = {}): Model<Api> {
	const wire: Api = config.api === "anthropic" ? "anthropic-messages" : config.api === "responses" ? "openai-responses" : "openai-completions";
	const known = catalog(config.api === "anthropic" ? "anthropic" : "openai", id);
	const base = known === undefined || known.api !== wire ? { ...plain(id, wire), ...(known === undefined ? {} : { cost: known.cost, contextWindow: known.contextWindow, maxTokens: known.maxTokens, reasoning: known.reasoning }) } : known;
	const compat =
		wire === "anthropic-messages"
			? ({ ...(base.compat as AnthropicMessagesCompat | undefined), supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true } satisfies AnthropicMessagesCompat)
			: wire === "openai-responses"
				? ({ ...(base.compat as OpenAIResponsesCompat | undefined), supportsMidConvoSystemMessages: true } satisfies OpenAIResponsesCompat)
				: base.compat;
	return {
		...base,
		id,
		provider,
		baseUrl: url,
		contextWindow: Math.min(override.contextWindow ?? base.contextWindow, CONTEXT_WINDOW),
		...(override.cost === undefined ? {} : { cost: override.cost }),
		...(override.maxTokens === undefined ? {} : { maxTokens: override.maxTokens }),
		promptCache: override.promptCache ?? base.promptCache ?? (wire === "anthropic-messages" ? { short: 300, long: 3600 } : undefined),
		...(compat === undefined ? {} : { compat }),
	} as Model<Api>;
}

export function createModelSetup(input: { readonly providers?: Record<string, ProviderConfig>; readonly models?: ModelsConfig; readonly env: Env; readonly openRouterKey?: string }): ModelSetup {
	const providers = input.providers !== undefined && Object.keys(input.providers).length > 0 ? input.providers : defaultProviders(input.env);
	const chosen = { ...defaultModels(providers), ...input.models };
	const aliases = chosen.aliases ?? {};
	const named: Record<string, string> = { brain: chosen.brain, default: chosen.brain, fast: chosen.fast, strongest: chosen.strongest ?? chosen.brain, ...aliases };
	const split = (full: string): { provider: string; id: string } => {
		const slash = full.indexOf("/");
		if (slash <= 0) throw new Error(`Model ${full} is not <provider>/<id>.`);
		const provider = full.slice(0, slash);
		if (!Object.hasOwn(providers, provider)) throw new Error(`Model ${full} names provider "${provider}", which is not in [providers]. Configured: ${Object.keys(providers).join(", ")}.`);
		return { provider, id: full.slice(slash + 1) };
	};
	const models = createModels();
	const missing: string[] = [];
	// Each provider serves the ids named so far; a model first named at run time re-registers its provider with it.
	const served = new Map<string, Set<string>>(Object.keys(providers).map((name) => [name, new Set<string>()]));
	const register = (name: string): void => {
		const config = providers[name]!;
		const keyEnv = config.keyEnv ?? DEFAULTS[config.api].keyEnv;
		const apiKey = input.env[keyEnv]?.trim() ?? "";
		const url = (config.url ?? DEFAULTS[config.api].url).replace(/\/$/, "");
		models.setProvider(
			createProvider<Api>({
				id: name,
				name,
				auth: { apiKey: { name: keyEnv, resolve: async () => ({ auth: { apiKey, ...(config.headers === undefined ? {} : { headers: config.headers }) }, source: keyEnv }) } },
				models: [...served.get(name)!].map((id) => definition(id, config, name, url, chosen.overrides?.[`${name}/${id}`])),
				api: config.api === "anthropic" ? anthropicMessagesApi() : config.api === "responses" ? openAIResponsesApi() : openAICompletionsApi(),
			}),
		);
	};
	for (const full of Object.values(named)) {
		const { provider, id } = split(full);
		served.get(provider)!.add(id);
	}
	for (const [name, config] of Object.entries(providers)) {
		const keyEnv = config.keyEnv ?? DEFAULTS[config.api].keyEnv;
		if (!input.env[keyEnv]?.trim()) missing.push(`${name}: ${keyEnv} is not set`);
		register(name);
	}
	if (input.openRouterKey !== undefined) {
		const apiKey = input.openRouterKey;
		models.setProvider(
			createProvider<Api>({
				id: JEV.provider,
				name: "OpenRouter (classifiers)",
				auth: { apiKey: { name: "OPENROUTER_API_KEY", resolve: async () => ({ auth: { apiKey }, source: "OPENROUTER_API_KEY" }) } },
				models: [getBuiltinClassifierModel(JEV.provider, JEV.modelId)],
				classifiers: { "typesafe-system-one": typesafeSystemOneApi() },
			}),
		);
	}
	const ref = (nameOrFull: string): ModelRef => {
		const full = Object.hasOwn(named, nameOrFull) ? named[nameOrFull]! : nameOrFull;
		if (!full.includes("/")) throw new Error(`Unknown model "${nameOrFull}". Use brain, fast, strongest, ${Object.keys(aliases).join(", ") || "an alias from [models.aliases]"}, or <provider>/<id>.`);
		const { provider, id } = split(full);
		if (!served.get(provider)!.has(id)) {
			served.get(provider)!.add(id);
			register(provider);
		}
		return { provider, modelId: id };
	};
	return { models, brain: ref("brain"), fast: ref("fast"), ref, missing };
}
