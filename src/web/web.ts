import type { JsonValue } from "@earendil-works/chord";
import { type Models, Type } from "@earendil-works/pi-ai";
import { defineTool, type ModelRef, type ToolRegistration } from "@earendil-works/pi-durable";
import { type AlexandriaCall, FirecrawlClient, type SearchRequest } from "./client.ts";
import { cleanFirecrawlHtml, extractFirecrawlContent } from "./content.ts";

const EXTRACT_CHARS = 12_000;
const RECENCY = ["hour", "day", "week", "month", "year"] as const;
const FIND_TOOLS = { provider: "firecrawl", capability: "find-tools" } as const;

export interface WebDeps {
	/** `FIRECRAWL_API_KEY`; absent, every web function fails with a clear error. Bash never gets it. */
	readonly apiKey: string | undefined;
	readonly models: Models;
	/** Runs web_fetch's `instruction`. */
	readonly fast: ModelRef;
	readonly baseUrl?: string;
}

/** Firecrawl v2 search, fetch, map and Alexandria on mochi's own key, as script functions. */
export function webFns(deps: WebDeps): readonly ToolRegistration[] {
	const client = (): FirecrawlClient => {
		if (deps.apiKey === undefined) throw new Error("Firecrawl is not configured: FIRECRAWL_API_KEY is unset.");
		return new FirecrawlClient(deps.apiKey, deps.baseUrl);
	};
	return [
		defineTool({
			name: "web_search",
			description: "Firecrawl web search: title, URL and snippet per hit.",
			parameters: Type.Object({
				query: Type.String(),
				limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
				includeDomains: Type.Optional(Type.Array(Type.String(), { maxItems: 20 })),
				excludeDomains: Type.Optional(Type.Array(Type.String(), { maxItems: 20 })),
				recency: Type.Optional(Type.Union(RECENCY.map((key) => Type.Literal(key)))),
			}),
			structuredOutputSchema: Type.Array(Type.Object({ title: Type.String(), url: Type.String(), snippet: Type.String() })),
			replay: "safe",
			execute: async ({ query, limit, includeDomains, excludeDomains, recency }, _api, context) => {
				if (includeDomains && excludeDomains) throw new Error("includeDomains and excludeDomains cannot be used together.");
				const request: SearchRequest = {
					query: query.trim(),
					limit: limit ?? 5,
					sources: ["web"],
					...(includeDomains === undefined ? {} : { includeDomains }),
					...(excludeDomains === undefined ? {} : { excludeDomains }),
					...(recency === undefined ? {} : { tbs: `qdr:${recency[0]}` }),
				};
				const seen = new Set<string>();
				const hits = (await client().search(request, context.abortSignal)).filter((hit) => {
					const key = hit.url.trim().replace(/\/$/, "");
					if (key === "" || seen.has(key)) return false;
					seen.add(key);
					return true;
				});
				return { structuredOutput: hits.map((hit) => ({ title: hit.title?.trim() || "Untitled", url: hit.url, snippet: hit.description?.trim() ?? "" })) };
			},
		}),
		defineTool({
			name: "web_fetch",
			description: "Clean page text. With instruction, only what it asks for, extracted on the fast model.",
			parameters: Type.Object({ url: Type.String(), instruction: Type.Optional(Type.String()) }),
			structuredOutputSchema: Type.String(),
			replay: "safe",
			execute: async ({ url, instruction }, _api, context) => {
				const signal = context.abortSignal;
				const page = await client().scrape(url, signal);
				if (page.status >= 400) throw new Error(`Page fetch failed (HTTP ${page.status}): ${page.error ?? "source returned an error"}. URL: ${url}`);
				const markdown = (page.html === undefined ? undefined : await cleanFirecrawlHtml(page.html, url)) ?? page.markdown ?? "";
				if (!instruction?.trim() || markdown === "") return { structuredOutput: markdown };
				const extracted = await extractFirecrawlContent({ models: deps.models, model: deps.fast, url, markdown, instruction, maxOutput: EXTRACT_CHARS, ...(signal === undefined ? {} : { signal }) });
				return extracted === undefined ? { structuredOutput: markdown } : { structuredOutput: extracted.text, usage: extracted.usage };
			},
		}),
		defineTool({
			name: "web_map",
			description: "Discover URLs on a site, optionally ranked by a search term.",
			parameters: Type.Object({ url: Type.String(), search: Type.Optional(Type.String()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })) }),
			structuredOutputSchema: Type.Array(Type.String()),
			replay: "safe",
			execute: async ({ url, search, limit }, _api, context) => {
				return { structuredOutput: await client().map({ url, limit: limit ?? 100, ...(search === undefined ? {} : { search }) }, context.abortSignal) };
			},
		}),
		defineTool({
			name: "web_find_tools",
			description:
				"Free. Browse or search Firecrawl Alexandria, a catalogue of paid data tools. Items carry id (provider/capability for web_alexandria), description, creditsCost and next; pass an item's or the page's next back as next for its inputs or the next page.",
			parameters: Type.Object({
				query: Type.Optional(Type.String()),
				providers: Type.Optional(Type.Array(Type.String())),
				limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
				next: Type.Optional(Type.Object({ provider: Type.String(), capability: Type.String(), options: Type.Optional(Type.Record(Type.String(), Type.Unknown())) })),
			}),
			structuredOutputSchema: Type.Object({ level: Type.String(), total: Type.Number(), items: Type.Array(Type.Record(Type.String(), Type.Unknown())), next: Type.Unknown() }),
			replay: "safe",
			execute: async ({ query, providers, limit, next }, _api, context) => {
				let call: AlexandriaCall;
				if (next === undefined) {
					const options: Record<string, unknown> = { limit: limit ?? 10 };
					if (query !== undefined && query.trim() !== "") options.query = query.trim();
					if (providers !== undefined) options.providers = providers;
					call = { ...FIND_TOOLS, options };
				} else {
					if (next.provider !== FIND_TOOLS.provider || next.capability !== FIND_TOOLS.capability) throw new Error("next must be a firecrawl/find-tools request from an earlier web_find_tools result.");
					call = { ...FIND_TOOLS, options: next.options ?? {} };
				}
				const result = await client().alexandria(call, context.abortSignal);
				const page = result.data as { level?: JsonValue; total?: JsonValue; items?: JsonValue[]; next?: JsonValue } | null;
				return {
					structuredOutput: {
						level: typeof page?.level === "string" ? page.level : "",
						total: typeof page?.total === "number" ? page.total : 0,
						items: Array.isArray(page?.items) ? page.items : [],
						next: page?.next ?? null,
					},
				};
			},
		}),
		defineTool({
			name: "web_alexandria",
			description:
				"SPENDS MONEY: runs one Firecrawl Alexandria data tool and charges its listed credits. tool is the provider/capability id from web_find_tools; read its options there first. Returns { data, creditsCost }.",
			parameters: Type.Object({ tool: Type.String(), options: Type.Optional(Type.Record(Type.String(), Type.Unknown())) }),
			structuredOutputSchema: Type.Object({ data: Type.Unknown(), creditsCost: Type.Number() }),
			replay: "unsafe",
			execute: async ({ tool, options }, _api, context) => {
				const id = tool.trim();
				const slash = id.indexOf("/");
				if (slash <= 0 || slash === id.length - 1) throw new Error(`tool must be provider/capability, like particle/podcasts/episodes/search. Got: ${tool}`);
				const call: AlexandriaCall = { provider: id.slice(0, slash), capability: id.slice(slash + 1), options: options ?? {} };
				const result = await client().alexandria(call, context.abortSignal);
				return { structuredOutput: { data: result.data, creditsCost: result.creditsCost } };
			},
		}),
	];
}
