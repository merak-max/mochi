import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { FAUX, newFaux } from "../test-support.ts";
import { webFns } from "./web.ts";

/** A stand-in Firecrawl v2 API that records request bodies. */
async function fakeFirecrawl(t: { after(fn: () => void): void }, routes: Record<string, unknown>) {
	const requests: { path: string; body: unknown; auth: string | undefined }[] = [];
	const server = createServer((request, response) => {
		let body = "";
		request.on("data", (chunk) => (body += chunk));
		request.on("end", () => {
			requests.push({ path: request.url ?? "", body: JSON.parse(body), auth: request.headers.authorization });
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify(routes[request.url ?? ""] ?? { success: false, error: "no route" }));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => server.close());
	return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

function web(baseUrl: string, apiKey: string | null = "fc-test") {
	const faux = newFaux();
	const models = createModels();
	models.setProvider(faux.provider);
	const fns = new Map(webFns({ apiKey: apiKey ?? undefined, models, fast: FAUX, baseUrl }).map((fn) => [fn.name, fn]));
	return { faux, call: async (name: string, args: unknown) => (await fns.get(name)!.execute(args as never, {} as never, context)).structuredOutput };
}

test("web_search returns deduped hits and sends the Firecrawl request with the key", async (t) => {
	const api = await fakeFirecrawl(t, {
		"/search": { success: true, data: { web: [{ url: "https://a.dev/", title: "A", description: "first" }, { url: "https://a.dev", title: "A again" }, { url: "https://b.dev" }] } },
	});
	assert.deepEqual(await web(api.baseUrl).call("web_search", { query: " pi durable ", limit: 3 }), [
		{ title: "A", url: "https://a.dev/", snippet: "first" },
		{ title: "Untitled", url: "https://b.dev", snippet: "" },
	]);
	assert.deepEqual(api.requests[0], { path: "/search", auth: "Bearer fc-test", body: { query: "pi durable", limit: 3, sources: ["web"] } });
});

test("web_search passes domain filters and recency to Firecrawl and refuses both domain lists", async (t) => {
	const api = await fakeFirecrawl(t, { "/search": { success: true, data: { web: [] } } });
	const { call } = web(api.baseUrl);
	await call("web_search", { query: "fares", includeDomains: ["kayak.com"], recency: "week" });
	assert.deepEqual(api.requests[0]?.body, { query: "fares", limit: 5, sources: ["web"], includeDomains: ["kayak.com"], tbs: "qdr:w" });
	await assert.rejects(call("web_search", { query: "x", includeDomains: ["a.com"], excludeDomains: ["b.com"] }), /cannot be used together/);
});

test("web_fetch cleans with Defuddle, extracts on the fast model with an instruction, and fails on HTTP errors", async (t) => {
	const html = `<html><head><title>Doc</title></head><body><nav>Menu Home About</nav><article><h1>Compaction</h1><p>${"Compaction runs in the background when the context nears its limit. ".repeat(8)}</p></article><footer>Footer links</footer></body></html>`;
	const api = await fakeFirecrawl(t, { "/scrape": { success: true, data: { markdown: "raw markdown", html, metadata: { title: "Doc", statusCode: 200 } } } });
	const { call, faux } = web(api.baseUrl);
	const page = String(await call("web_fetch", { url: "https://docs.dev/c" }));
	assert.match(page, /Compaction runs in the background/);
	assert.ok(!page.includes("raw markdown") && !page.includes("Footer links"));
	assert.deepEqual((api.requests[0]?.body as { formats: string[] }).formats, ["markdown", "html"]);

	faux.setResponses([fauxAssistantMessage("Background compaction near the limit.")]);
	assert.equal(await call("web_fetch", { url: "https://docs.dev/c", instruction: "When does compaction run?" }), "Background compaction near the limit.");

	const broken = await fakeFirecrawl(t, { "/scrape": { success: true, data: { metadata: { statusCode: 404, title: "Not Found" } } } });
	await assert.rejects(web(broken.baseUrl).call("web_fetch", { url: "https://docs.dev/x" }), /HTTP 404/);
	await assert.rejects(web(api.baseUrl, null).call("web_map", { url: "https://a.dev" }), /FIRECRAWL_API_KEY is unset/);
});

test("web_find_tools sends a free firecrawl/find-tools call and follows next", async (t) => {
	const next = { provider: "firecrawl", capability: "find-tools", options: { limit: 2, query: "podcasts", offset: 2 } };
	const item = { id: "particle/podcasts/episodes/search", provider: "particle", capability: "podcasts/episodes/search", description: "Find episodes", creditsCost: 15, next };
	const api = await fakeFirecrawl(t, {
		"/scrape": { success: true, data: { alexandria: [{ provider: "firecrawl", capability: "find-tools", creditsCost: 0, data: { level: "tools", items: [item], total: 52, next } }], creditsCost: 0 } },
	});
	const { call } = web(api.baseUrl);
	assert.deepEqual(await call("web_find_tools", { query: " podcasts ", providers: ["particle"], limit: 2 }), { level: "tools", total: 52, items: [item], next });
	assert.deepEqual(api.requests[0], {
		path: "/scrape",
		auth: "Bearer fc-test",
		body: { alexandria: [{ provider: "firecrawl", capability: "find-tools", options: { limit: 2, query: "podcasts", providers: ["particle"] } }] },
	});
	await call("web_find_tools", { next });
	assert.deepEqual(api.requests[1]?.body, { alexandria: [next] });
	await assert.rejects(call("web_find_tools", { next: { provider: "particle", capability: "podcasts/episodes/search" } }), /next must be a firecrawl\/find-tools request/);
});

test("web_alexandria splits the tool id, returns data with its credit cost, and reports tool errors", async (t) => {
	const api = await fakeFirecrawl(t, {
		"/scrape": { success: true, data: { alexandria: [{ provider: "particle", capability: "podcasts/episodes/search", creditsCost: 15, data: { episodes: [{ id: "e1" }] } }], creditsCost: 15 } },
	});
	assert.deepEqual(await web(api.baseUrl).call("web_alexandria", { tool: "particle/podcasts/episodes/search", options: { keyword_search: "AI agents" } }), {
		data: { episodes: [{ id: "e1" }] },
		creditsCost: 15,
	});
	assert.deepEqual(api.requests[0]?.body, { alexandria: [{ provider: "particle", capability: "podcasts/episodes/search", options: { keyword_search: "AI agents" } }] });
	await assert.rejects(web(api.baseUrl).call("web_alexandria", { tool: "particle" }), /provider\/capability/);

	const failing = await fakeFirecrawl(t, {
		"/scrape": { success: true, data: { alexandria: [{ provider: "x", capability: "b", error: { code: "invalid_option", message: "b does not take bogus." } }], creditsCost: 0 } },
	});
	await assert.rejects(web(failing.baseUrl).call("web_alexandria", { tool: "x/b", options: { bogus: 1 } }), /invalid_option.*does not take bogus/);
});
