import type { JsonValue } from "@earendil-works/chord";
import { type Models, type Static, Type } from "@earendil-works/pi-ai";
import { defineTool, type ModelRef, type ToolRegistration } from "@earendil-works/pi-durable";
import { type AlexandriaCall, FirecrawlClient, type SearchHit as WebHit, type SearchRequest } from "./client.ts";
import { cleanFirecrawlHtml, extractFirecrawlContent } from "./content.ts";

const EXTRACT_CHARS = 12_000;
const RECENCY = ["hour", "day", "week", "month", "year"] as const;
const literals = <T extends string>(values: readonly T[]) => Type.Union(values.map((value) => Type.Literal(value)));
const SearchHit = Type.Object({ title: Type.String(), url: Type.String(), snippet: Type.String() });
type SearchHit = Static<typeof SearchHit>;

/** Web hits deduped by URL. */
function searchHits(web: WebHit[]): SearchHit[] {
	const hits: SearchHit[] = [];
	const seen = new Set<string>();
	for (const hit of web) {
		const key = hit.url.trim().replace(/\/$/, "");
		if (key === "" || seen.has(key)) continue;
		seen.add(key);
		hits.push({ title: hit.title?.trim() || "Untitled", url: hit.url, snippet: hit.description?.trim() ?? "" });
	}
	return hits;
}
const FIND_TOOLS = { provider: "firecrawl", capability: "find-tools" } as const;

export interface WebDeps {
	/** The web service key; absent, every web function fails with a clear error naming `keyEnv`. Bash never gets it. */
	readonly apiKey: string | undefined;
	readonly keyEnv: string;
	readonly models: Models;
	/** Runs web_fetch's `instruction`. */
	readonly fast: ModelRef;
	readonly baseUrl?: string;
}

/** Web search, fetch, map and data providers on mochi's own key, as script functions. The client speaks Firecrawl's v2 API. */
export function webFns(deps: WebDeps): readonly ToolRegistration[] {
	const client = (): FirecrawlClient => {
		if (deps.apiKey === undefined) throw new Error(`Web is not configured: ${deps.keyEnv} is unset.`);
		return new FirecrawlClient(deps.apiKey, deps.baseUrl);
	};
	return [
		defineTool({
			name: "web_search",
			description:
				"Web search, 2 credits per 10 hits.",
			parameters: Type.Object({
				query: Type.String(),
				limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
				includeDomains: Type.Optional(Type.Array(Type.String())),
				excludeDomains: Type.Optional(Type.Array(Type.String())),
				recency: Type.Optional(literals(RECENCY)),
			}),
			structuredOutputSchema: Type.Array(SearchHit),
			replay: "safe",
			execute: async (args, _api, context) => {
				if (args.includeDomains && args.excludeDomains) throw new Error("includeDomains and excludeDomains cannot be used together.");
				const query = args.query.trim();
				if (query === "") throw new Error("Search query cannot be blank.");
				const request: SearchRequest = { query, limit: args.limit ?? 5, sources: ["web"], highlights: false };
				if (args.includeDomains !== undefined) request.includeDomains = args.includeDomains;
				if (args.excludeDomains !== undefined) request.excludeDomains = args.excludeDomains;
				if (args.recency !== undefined) request.tbs = `qdr:${args.recency[0]}`;
				const result = await client().search(request, context.abortSignal);
				return { structuredOutput: searchHits(result) };
			},
		}),
		defineTool({
			name: "web_fetch",
			description:
				"Clean page text, 1 credit. instruction: the fast model extracts it; schema: as JSON. maxAge 0: fresh.",
			parameters: Type.Object({
				url: Type.String(),
				instruction: Type.Optional(Type.String()),
				schema: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
				maxAge: Type.Optional(Type.Integer({ minimum: 0 })),
			}),
			structuredOutputSchema: Type.String(),
			replay: "safe",
			execute: async ({ url, instruction, schema, maxAge }, _api, context) => {
				const signal = context.abortSignal;
				const ask = instruction?.trim() ?? "";
				if (schema !== undefined && ask === "") throw new Error("schema needs an instruction that says what to extract.");
				const page = await client().scrape({ url, formats: ["markdown", "html"], onlyMainContent: true, ...(maxAge === undefined ? {} : { maxAge }) }, signal);
				if (page.status >= 400) throw new Error(`Page fetch failed (HTTP ${page.status}): ${page.error ?? "source returned an error"}. URL: ${url}`);
				const markdown = (page.html === undefined ? undefined : await cleanFirecrawlHtml(page.html, url)) ?? page.markdown ?? "";
				if (ask === "") return { structuredOutput: markdown };
				if (markdown === "") throw new Error(`Firecrawl returned no page content for ${url}, so the instruction has nothing to answer from.`);
				const extracted = await extractFirecrawlContent({ models: deps.models, model: deps.fast, url, markdown, instruction: ask, schema, maxOutput: EXTRACT_CHARS, signal });
				const notice = extracted.inputTruncated ? "[The model saw only the first and last parts of this long page. Fetch without instruction for all of it.]\n\n" : "";
				return { structuredOutput: notice + extracted.text, usage: extracted.usage };
			},
		}),
		defineTool({
			name: "web_map",
			description: "Discover URLs on a site, optionally ranked by a search term. 1 credit.",
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
