import type { AnthropicMessagesCompat, Api, Model, ModelInputLimits, OpenAIResponsesCompat, ProviderClassifier, ProviderStreams } from "@earendil-works/pi-ai";
import { createModels, createProvider, type MutableModels } from "@earendil-works/pi-ai/models";
import { getBuiltinClassifierModels, getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ModelRef } from "@earendil-works/pi-durable";
import { type Static, Type } from "typebox";
import type { Env } from "../channels/types.ts";
import { markView } from "../memory/memory.ts";

/**
 * `[providers.<name>]` in config.toml: an endpoint, the pi-ai api it speaks (`anthropic-messages`, `openai-responses`,
 * `openai-completions`, `typesafe-system-one`, `openai-decisions`, ...), and the env variable with its key. A gateway is
 * one provider per api it serves. A model is `<provider>/<model id>`, and the id is sent as written, so a gateway's own
 * `<vendor>/<model>` ids work unchanged.
 */
export const ProviderSchema = Type.Object(
	{
		api: Type.String({ pattern: "^[a-z0-9-]+$" }),
		url: Type.String({ pattern: "^https?://" }),
		keyEnv: Type.String({ pattern: "^[A-Z_][A-Z0-9_]*$" }),
		headers: Type.Optional(Type.Record(Type.String(), Type.String())),
	},
	{ additionalProperties: false },
);
export type ProviderConfig = Static<typeof ProviderSchema>;

/** pi-ai's own client for an api, from `@earendil-works/pi-ai/api/<api>.lazy`. An unknown api fails the import. */
async function apiClient(api: string): Promise<{ readonly kind: "chat"; readonly client: ProviderStreams } | { readonly kind: "classifier"; readonly client: ProviderClassifier }> {
	const module = (await import(`@earendil-works/pi-ai/api/${api}.lazy`)) as Record<string, () => ProviderStreams | ProviderClassifier>;
	const factory = Object.values(module)[0]!;
	const client = factory();
	return "classify" in client ? { kind: "classifier", client: client as ProviderClassifier } : { kind: "chat", client: client as ProviderStreams };
}

const ModelOverrideSchema = Type.Object(
	{
		contextWindow: Type.Optional(Type.Integer({ minimum: 1 })),
		maxTokens: Type.Optional(Type.Integer({ minimum: 1 })),
		/** Seconds a prompt cache entry lives: the short (default) and long retention. */
		promptCache: Type.Optional(Type.Object({ short: Type.Integer({ minimum: 1 }), long: Type.Integer({ minimum: 1 }) }, { additionalProperties: false })),
	},
	{ additionalProperties: false },
);
type ModelOverride = Static<typeof ModelOverrideSchema>;

/**
 * `[models]` in config.toml: names for `<provider>/<id>`. brain (root and definitions without a model), fast (bulk
 * reading) and memory (the view's summary lines) are required. classifier names the decision model for `classify` and
 * gates. Every other name is the owner's own, for a definition or a tool call to use.
 */
export const ModelsSchema = Type.Object(
	{
		brain: Type.String({ minLength: 3 }),
		fast: Type.String({ minLength: 3 }),
		memory: Type.String({ minLength: 3 }),
		classifier: Type.Optional(Type.String({ minLength: 3 })),
		/** Limits of a model pi-ai's catalog does not know, by `<provider>/<id>`. */
		overrides: Type.Optional(Type.Record(Type.String({ minLength: 3 }), ModelOverrideSchema)),
	},
	{ additionalProperties: Type.String({ minLength: 3 }) },
);
type ModelsConfig = Static<typeof ModelsSchema>;

export function providerEndpoint(name: string, providers: Readonly<Record<string, ProviderConfig>> | undefined): { baseUrl: string; keyEnv: string } {
	const config = providers?.[name];
	if (config === undefined) throw new Error(`Provider "${name}" is not in [providers]. Configured: ${Object.keys(providers ?? {}).join(", ") || "none"}.`);
	return { baseUrl: config.url.replace(/\/$/, ""), keyEnv: config.keyEnv };
}

/** The models mochi talks to, resolved once from config. */
export interface ModelSetup {
	readonly models: MutableModels;
	readonly fast: ModelRef;
	readonly memory: ModelRef;
	/** `[models] classifier`; absent, `classify` and classify steps fail with a clear error. */
	readonly classifier?: ModelRef;
	/** A name from `[models]`, or `provider/id`. */
	ref(name: string): ModelRef;
	/** One line per provider whose key is not set, for the setup report. */
	readonly missing: readonly string[];
}

/**
 * pi-ai requires a price on every model and multiplies each response's tokens by it. mochi carries no prices: the model
 * provider bills, so every model gets this one.
 */
const NO_PRICE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** pi-ai's catalog entry for a decision model id, from whichever provider lists it, for its limits. */
function classifierCatalog(id: string): object | undefined {
	for (const provider of getBuiltinProviders()) {
		const found = getBuiltinClassifierModels(provider).find((model) => model.id === id);
		if (found !== undefined) return found;
	}
	return undefined;
}

/** pi-ai's catalog entry for an id on this wire, from whichever provider lists it, by the id's last path part, so a gateway's `<vendor>/<model>` id finds the vendor's entry. */
function catalog(wire: Api, id: string): Model<Api> | undefined {
	const bare = id.slice(id.lastIndexOf("/") + 1);
	for (const provider of getBuiltinProviders()) {
		const found = getBuiltinModels(provider).find((model) => model.id === bare && model.api === wire);
		if (found !== undefined) return found as Model<Api>;
	}
	return undefined;
}

/** A model the catalog does not know: `[models.overrides]` must give its limits. */
function plain(id: string, api: Api, provider: string, override: ModelOverride): Model<Api> {
	if (override.contextWindow === undefined || override.maxTokens === undefined) throw new Error(`pi-ai's catalog does not know ${provider}/${id}. Add [models.overrides."${provider}/${id}"] with contextWindow and maxTokens.`);
	return { id, name: id, api, provider: "", baseUrl: "", reasoning: true, input: ["text", "image"], cost: NO_PRICE, contextWindow: override.contextWindow, maxTokens: override.maxTokens };
}

/**
 * Bytes per image `read` may hand a script. The catalog allows 4.5 MB, so six screenshots pass codemode's 16 MB output
 * cap and the script fails. At 1 MB, `read` re-encodes a large photo as JPEG at the same size.
 */
const IMAGE_MAX_BYTES = 1024 * 1024;

/** The catalog's input limits, with each image held to `IMAGE_MAX_BYTES`. */
function withImageBytes(limits: ModelInputLimits | undefined): ModelInputLimits {
	const resize = limits?.images?.resize;
	const maxBytes = Math.min(resize?.maxBytes ?? IMAGE_MAX_BYTES, IMAGE_MAX_BYTES);
	return { ...limits, images: { ...limits?.images, resize: { ...resize, maxBytes } } };
}

/** Anthropic streams whose payloads get the view's cache breakpoint, after any caller's own payload hook. */
function withViewMark(streams: ProviderStreams): ProviderStreams {
	const options = <T extends { onPayload?: (payload: unknown, model: Model<Api>) => unknown }>(given: T | undefined): T => {
		const caller = given?.onPayload;
		const onPayload = async (payload: unknown, model: Model<Api>): Promise<unknown> => {
			const replaced = caller === undefined ? undefined : await caller(payload, model);
			const current = replaced ?? payload;
			return markView(current) ?? replaced;
		};
		return { ...given, onPayload } as T;
	};
	return {
		...streams,
		stream: (model, context, given) => streams.stream(model, context, options(given)),
		streamSimple: (model, context, given) => streams.streamSimple(model, context, options(given)),
	};
}

/** A model definition for `id` on a provider: the catalog's limits and quirks where it knows the model. */
function definition(id: string, config: ProviderConfig, provider: string, url: string, override: ModelOverride = {}): Model<Api> {
	const wire: Api = config.api;
	const known = catalog(wire, id);
	const base = known ?? plain(id, wire, provider, override);
	const compat =
		wire === "anthropic-messages"
			? // A tool_removal block is refused as an unknown tool, so tool changes go out as the whole current list.
				({ ...(base.compat as AnthropicMessagesCompat | undefined), supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: false } satisfies AnthropicMessagesCompat)
			: wire === "openai-responses"
				? ({ ...(base.compat as OpenAIResponsesCompat | undefined), supportsMidConvoSystemMessages: true } satisfies OpenAIResponsesCompat)
				: base.compat;
	return {
		...base,
		id,
		provider,
		baseUrl: url,
		cost: NO_PRICE,
		contextWindow: override.contextWindow ?? base.contextWindow,
		...(override.maxTokens === undefined ? {} : { maxTokens: override.maxTokens }),
		promptCache: override.promptCache ?? base.promptCache ?? (wire === "anthropic-messages" ? { short: 300, long: 3600 } : undefined),
		inputLimits: withImageBytes(base.inputLimits),
		...(compat === undefined ? {} : { compat }),
	} as Model<Api>;
}

export async function createModelSetup(input: { readonly providers: Record<string, ProviderConfig> | undefined; readonly models: ModelsConfig | undefined; readonly env: Env }): Promise<ModelSetup> {
	const providers = input.providers;
	if (providers === undefined || Object.keys(providers).length === 0) throw new Error("config.toml has no [providers]. Add one, for example [providers.anthropic] with api = \"anthropic-messages\".");
	const clients = new Map<string, Awaited<ReturnType<typeof apiClient>>>();
	for (const [name, config] of Object.entries(providers)) clients.set(name, await apiClient(config.api));
	const chosen = input.models;
	if (chosen === undefined) throw new Error("config.toml has no [models]. It needs brain, fast and memory, each <provider>/<id>.");
	const named: Record<string, string> = {};
	for (const [name, value] of Object.entries(chosen)) if (name !== "classifier" && name !== "overrides" && typeof value === "string") named[name] = value;
	const split = (full: string): { provider: string; id: string } => {
		const slash = full.indexOf("/");
		if (slash <= 0) throw new Error(`Model ${full} is not <provider>/<id>.`);
		const provider = full.slice(0, slash);
		if (!Object.hasOwn(providers, provider)) throw new Error(`Model ${full} names provider "${provider}", which is not in [providers]. Configured: ${Object.keys(providers).join(", ")}.`);
		return { provider, id: full.slice(slash + 1) };
	};
	const models = createModels();
	const missing: string[] = [];
	let classifier: ModelRef | undefined;
	// Each provider serves the ids named so far; a model first named at run time re-registers its provider with it.
	const served = new Map<string, Set<string>>(Object.keys(providers).map((name) => [name, new Set<string>()]));
	const register = (name: string): void => {
		const config = providers[name]!;
		const keyEnv = config.keyEnv;
		const apiKey = input.env[keyEnv]?.trim() ?? "";
		const url = config.url.replace(/\/$/, "");
		models.setProvider(
			createProvider<Api>({
				id: name,
				name,
				auth: { apiKey: { name: keyEnv, resolve: async () => ({ auth: { apiKey, ...(config.headers === undefined ? {} : { headers: config.headers }) }, source: keyEnv }) } },
				models: [...served.get(name)!].map((id) => definition(id, config, name, url, chosen.overrides?.[`${name}/${id}`])),
				api: config.api === "anthropic-messages" ? withViewMark(clients.get(name)!.client as ProviderStreams) : (clients.get(name)!.client as ProviderStreams),
			}),
		);
	};
	for (const full of Object.values(named)) {
		const { provider, id } = split(full);
		served.get(provider)!.add(id);
	}
	for (const [name, config] of Object.entries(providers)) {
		if (!input.env[config.keyEnv]?.trim()) missing.push(`${name}: ${config.keyEnv} is not set`);
		if (clients.get(name)!.kind === "chat") register(name);
	}
	if (chosen.classifier !== undefined) {
		const { provider, id } = split(chosen.classifier);
		const config = providers[provider]!;
		const found = clients.get(provider)!;
		if (found.kind !== "classifier") throw new Error(`[models] classifier ${chosen.classifier}: provider "${provider}" has api "${config.api}", which is a chat api, not a decision api.`);
		const keyEnv = config.keyEnv;
		const baseUrl = config.url.replace(/\/$/, "");
		const apiKey = input.env[keyEnv]?.trim() ?? "";
		const known = classifierCatalog(id);
		models.setProvider(
			createProvider<Api>({
				id: provider,
				name: provider,
				auth: { apiKey: { name: keyEnv, resolve: async () => ({ auth: { apiKey, ...(config.headers === undefined ? {} : { headers: config.headers }) }, source: keyEnv }) } },
				models: [{ ...(known ?? { name: id, input: ["text"], contextWindow: 8192 }), cost: NO_PRICE, id, provider, baseUrl, api: config.api, type: "classifier" } as never],
				classifiers: { [config.api]: found.client },
			}),
		);
		classifier = { provider, modelId: id };
	}
	const ref = (nameOrFull: string): ModelRef => {
		const full = Object.hasOwn(named, nameOrFull) ? named[nameOrFull]! : nameOrFull;
		if (!full.includes("/")) throw new Error(`Unknown model "${nameOrFull}". Use a name from [models] (${Object.keys(named).join(", ")}) or <provider>/<id>.`);
		const { provider, id } = split(full);
		if (!served.get(provider)!.has(id)) {
			served.get(provider)!.add(id);
			register(provider);
		}
		return { provider, modelId: id };
	};
	return { models, fast: ref("fast"), memory: ref("memory"), ...(classifier === undefined ? {} : { classifier }), ref, missing };
}
