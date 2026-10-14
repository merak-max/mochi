import { type Models, Type } from "@earendil-works/pi-ai";
import { defineTool, type ModelRef, type ToolRegistration } from "@earendil-works/pi-durable";
import { FirecrawlClient, type SearchRequest } from "./client.ts";
import { cleanFirecrawlHtml, extractFirecrawlContent } from "./content.ts";

const EXTRACT_CHARS = 12_000;
const RECENCY = ["hour", "day", "week", "month", "year"] as const;

interface WebDeps {
	readonly apiKey: string | undefined;
	readonly models: Models;
	readonly fast: ModelRef;
	readonly baseUrl?: string;
}

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
	];
}
