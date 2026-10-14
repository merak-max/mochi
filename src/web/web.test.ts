import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import type { ModelRef } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { FAUX, newFaux } from "../test-support.ts";
import { webFns } from "./web.ts";

const BASE = "https://firecrawl.test/v2";

interface SeenRequest {
	path: string;
	body: Record<string, unknown>;
	headers: Record<string, string>;
}

type Reply = { status?: number; body: unknown; headers?: Record<string, string> } | ((request: SeenRequest) => Response);

/** Replaces `globalThis.fetch` for one test: each call takes the next reply (the last one repeats) and is recorded. */
function mockFirecrawl(t: { mock: { method: typeof test.mock.method } }, ...replies: Reply[]) {
	const requests: SeenRequest[] = [];
	t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
		init?.signal?.throwIfAborted();
		const request = { path: String(input).replace(BASE, ""), body: JSON.parse(String(init?.body)), headers: { ...(init?.headers as Record<string, string>) } };
		requests.push(request);
		const reply = replies[Math.min(requests.length - 1, replies.length - 1)]!;
		if (typeof reply === "function") return reply(request);
		return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200, headers: { "content-type": "application/json", ...reply.headers } });
	});
	return requests;
}

function web(options: { apiKey?: string | null; fast?: ModelRef } = {}) {
	const faux = newFaux();
	const models = createModels();
	models.setProvider(faux.provider);
	const apiKey = options.apiKey === null ? undefined : (options.apiKey ?? "fc-test");
	const fns = new Map(webFns({ apiKey, models, fast: options.fast ?? FAUX, baseUrl: BASE }).map((fn) => [fn.name, fn]));
	const call = async (name: string, args: unknown, ctx: Context = context) => (await fns.get(name)!.execute(args as never, { callId: "c1" } as never, ctx)).structuredOutput;
	return { faux, call };
}

const ok = (data: unknown) => ({ body: { success: true, data } });
const PAGE_HTML = `<html><head><title>Doc</title></head><body><nav>Menu Home About</nav><article><h1>Compaction</h1><p>${"Compaction runs in the background when the context nears its limit. ".repeat(8)}</p><pre><code class="language-js">const keep = 'this code';</code></pre></article><footer>Footer links</footer></body></html>`;

test("web_search sends compact defaults with the key and returns deduped hits", async (t) => {
	const requests = mockFirecrawl(t, ok({ web: [{ url: "https://a.dev/", title: "A", description: "first" }, { url: "https://a.dev", title: "A again" }, { url: "https://b.dev" }, { url: "https://b.dev/A" }, { url: "https://b.dev/a" }] }));
	assert.deepEqual(await web().call("web_search", { query: " pi durable ", limit: 3 }), [
		{ title: "A", url: "https://a.dev/", snippet: "first" },
		{ title: "Untitled", url: "https://b.dev", snippet: "" },
		{ title: "Untitled", url: "https://b.dev/A", snippet: "" },
		{ title: "Untitled", url: "https://b.dev/a", snippet: "" },
	]);
	assert.equal(requests[0]?.path, "/search");
	assert.equal(requests[0]?.headers.Authorization, "Bearer fc-test");
	assert.deepEqual(requests[0]?.body, { query: "pi durable", limit: 3, sources: ["web"], highlights: false });
});

test("web_search passes domain filters and recency, and refuses bad input before any request", async (t) => {
	const requests = mockFirecrawl(t, ok({ web: [] }));
	const { call } = web();
	await call("web_search", { query: "fares", includeDomains: ["kayak.com"], recency: "week" });
	assert.deepEqual(requests[0]?.body, { query: "fares", limit: 5, sources: ["web"], highlights: false, includeDomains: ["kayak.com"], tbs: "qdr:w" });
	await assert.rejects(call("web_search", { query: "x", includeDomains: ["a.com"], excludeDomains: ["b.com"] }), /cannot be used together/);
	await assert.rejects(call("web_search", { query: "  " }), /cannot be blank/);
	assert.equal(requests.length, 1);
});

test("web_fetch cleans with Defuddle and passes maxAge only when given", async (t) => {
	const requests = mockFirecrawl(t, ok({ markdown: "raw markdown", html: PAGE_HTML, metadata: { title: "Doc", statusCode: 200 } }));
	const { call } = web();
	const page = String(await call("web_fetch", { url: "https://docs.dev/c" }));
	assert.match(page, /Compaction runs in the background/);
	assert.match(page, /const keep = 'this code'/);
	assert.ok(!page.includes("raw markdown") && !page.includes("Footer links"));
	assert.deepEqual(requests[0]?.body, { url: "https://docs.dev/c", formats: ["markdown", "html"], onlyMainContent: true });
	await call("web_fetch", { url: "https://docs.dev/c", maxAge: 0 });
	await call("web_fetch", { url: "https://docs.dev/c", maxAge: 60_000 });
	assert.deepEqual([requests[1]?.body.maxAge, requests[2]?.body.maxAge], [0, 60_000]);
});

test("web_fetch falls back to Firecrawl Markdown without HTML, and fails on a source HTTP error", async (t) => {
	mockFirecrawl(t, ok({ markdown: "# Only markdown", metadata: { statusCode: 200 } }), ok({ metadata: { statusCode: 404, title: "Not Found" } }));
	const { call } = web();
	assert.equal(await call("web_fetch", { url: "https://docs.dev/m" }), "# Only markdown");
	await assert.rejects(call("web_fetch", { url: "https://docs.dev/x" }), /HTTP 404\): Not Found/);
});

test("web_fetch instruction is answered by the fast model in one Firecrawl request", async (t) => {
	const requests = mockFirecrawl(t, ok({ html: PAGE_HTML, metadata: { statusCode: 200 } }));
	const { call, faux } = web();
	let prompt = "";
	faux.setResponses([
		(ctx) => {
			prompt = JSON.stringify(ctx.messages);
			return fauxAssistantMessage("Background compaction near the limit.");
		},
	]);
	assert.equal(await call("web_fetch", { url: "https://docs.dev/c", instruction: "When does compaction run?" }), "Background compaction near the limit.");
	assert.equal(requests.length, 1);
	assert.match(prompt, /<instruction>When does compaction run\?<\/instruction>/);
	assert.doesNotMatch(prompt, /<schema>/);
});

test("web_fetch schema goes to the fast model, not Firecrawl, and needs an instruction", async (t) => {
	const requests = mockFirecrawl(t, ok({ html: PAGE_HTML, metadata: { statusCode: 200 } }));
	const { call, faux } = web();
	const schema = { type: "object", properties: { trigger: { type: "string" } } };
	let prompt = "";
	let system = "";
	faux.setResponses([
		(ctx) => {
			prompt = JSON.stringify(ctx.messages);
			system = JSON.stringify(ctx);
			return fauxAssistantMessage('{"trigger":"context nears its limit"}');
		},
	]);
	assert.equal(await call("web_fetch", { url: "https://docs.dev/c", instruction: "When?", schema }), '{"trigger":"context nears its limit"}');
	assert.match(prompt, /<schema>\{\\"type\\":\\"object\\"/);
	assert.match(system, /matches the given JSON Schema/);
	assert.deepEqual(requests[0]?.body.formats, ["markdown", "html"]);
	await assert.rejects(call("web_fetch", { url: "https://docs.dev/c", schema }), /schema needs an instruction/);
	await assert.rejects(call("web_fetch", { url: "https://docs.dev/c", instruction: "  ", schema }), /schema needs an instruction/);
	assert.equal(requests.length, 1);
});

test("web_fetch instruction fails loudly instead of returning the page", async (t) => {
	mockFirecrawl(t, ok({ html: PAGE_HTML, metadata: { statusCode: 200 } }));
	const failing = web();
	failing.faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider down" })]);
	await assert.rejects(failing.call("web_fetch", { url: "https://docs.dev/c", instruction: "When?" }), /Extraction model faux\/faux-1 failed: provider down/);
	const silent = web();
	silent.faux.setResponses([fauxAssistantMessage("  ")]);
	await assert.rejects(silent.call("web_fetch", { url: "https://docs.dev/c", instruction: "When?" }), /returned no text/);
	await assert.rejects(web({ fast: { provider: "faux", modelId: "missing" } }).call("web_fetch", { url: "https://docs.dev/c", instruction: "When?" }), /faux\/missing is not known/);
});

test("web_fetch instruction on an empty page fails, and a long page says the model saw only part of it", async (t) => {
	const long = `# Start\n\n${"word ".repeat(30_000)}\n\nEND`;
	mockFirecrawl(t, ok({ metadata: { statusCode: 200 } }), ok({ markdown: long, metadata: { statusCode: 200 } }));
	const { call, faux } = web();
	await assert.rejects(call("web_fetch", { url: "https://docs.dev/empty", instruction: "When?" }), /no page content/);
	let prompt = "";
	faux.setResponses([
		(ctx) => {
			prompt = JSON.stringify(ctx.messages);
			return fauxAssistantMessage("answer");
		},
	]);
	const answer = String(await call("web_fetch", { url: "https://docs.dev/long", instruction: "When?" }));
	assert.match(answer, /^\[The model saw only the first and last parts of this long page/);
	assert.match(answer, /answer$/);
	assert.match(prompt, /Middle of page omitted for focused extraction; 150014 chars total/);
});

test("web_map returns URLs and the missing key fails before any request", async (t) => {
	const requests = mockFirecrawl(t, { body: { success: true, links: [{ url: "https://a.dev/1", title: "One" }, { url: "https://a.dev/2" }, { title: "no url" }] } });
	assert.deepEqual(await web().call("web_map", { url: "https://a.dev", search: "docs" }), ["https://a.dev/1", "https://a.dev/2"]);
	assert.deepEqual(requests[0]?.body, { url: "https://a.dev", limit: 100, search: "docs" });
	await assert.rejects(web({ apiKey: null }).call("web_map", { url: "https://a.dev" }), /FIRECRAWL_API_KEY is unset/);
	assert.equal(requests.length, 1);
});

test("a 429 waits for retry_after_seconds or Retry-After, then succeeds", async (t) => {
	const requests = mockFirecrawl(
		t,
		{ status: 429, body: { success: false, error: "Rate limit", retry_after_seconds: 0 } },
		{ status: 429, body: { success: false, error: "Rate limit" }, headers: { "retry-after": "0" } },
		ok({ web: [{ url: "https://a.dev", title: "A" }] }),
	);
	assert.deepEqual(await web().call("web_search", { query: "x" }), [{ title: "A", url: "https://a.dev", snippet: "" }]);
	assert.equal(requests.length, 3);
});

test("a 429 with a long wait fails at once with the server message", async (t) => {
	const requests = mockFirecrawl(t, { status: 429, body: { success: false, error: "Rate limit exceeded", retry_after_seconds: 600 } });
	await assert.rejects(web().call("web_search", { query: "x" }), /Firecrawl HTTP 429: Rate limit exceeded/);
	assert.equal(requests.length, 1);
});

test("an abort during a 429 wait cancels the call", async (t) => {
	mockFirecrawl(t, { status: 429, body: { success: false, retry_after_seconds: 20 } });
	const controller = new AbortController();
	const pending = web().call("web_search", { query: "x" }, { ...context, abortSignal: controller.signal } as Context);
	setTimeout(() => controller.abort(new Error("stop waiting")), 20);
	await assert.rejects(pending, /stop waiting/);
});

test("a pre-aborted call never reaches Firecrawl, and a non-JSON reply names its status", async (t) => {
	const requests = mockFirecrawl(t, () => new Response("Bad Gateway", { status: 502 }));
	await assert.rejects(web().call("web_search", { query: "x" }, { ...context, abortSignal: AbortSignal.abort(new Error("user cancelled")) } as Context), /user cancelled/);
	assert.equal(requests.length, 0);
	await assert.rejects(web().call("web_search", { query: "x" }), /non-JSON response \(HTTP 502\)/);
});

test("web_find_tools sends a free firecrawl/find-tools call and follows next", async (t) => {
	const next = { provider: "firecrawl", capability: "find-tools", options: { limit: 2, query: "podcasts", offset: 2 } };
	const item = { id: "particle/podcasts/episodes/search", provider: "particle", capability: "podcasts/episodes/search", description: "Find episodes", creditsCost: 15, next };
	const requests = mockFirecrawl(t, ok({ alexandria: [{ provider: "firecrawl", capability: "find-tools", creditsCost: 0, data: { level: "tools", items: [item], total: 52, next } }], creditsCost: 0 }));
	const { call } = web();
	assert.deepEqual(await call("web_find_tools", { query: " podcasts ", providers: ["particle"], limit: 2 }), { level: "tools", total: 52, items: [item], next });
	assert.equal(requests[0]?.path, "/scrape");
	assert.deepEqual(requests[0]?.body, { alexandria: [{ provider: "firecrawl", capability: "find-tools", options: { limit: 2, query: "podcasts", providers: ["particle"] } }] });
	await call("web_find_tools", { next });
	assert.deepEqual(requests[1]?.body, { alexandria: [next] });
	await assert.rejects(call("web_find_tools", { next: { provider: "particle", capability: "podcasts/episodes/search" } }), /next must be a firecrawl\/find-tools request/);
});

test("web_alexandria sends one idempotency key across 429 retries and returns data with its credit cost", async (t) => {
	const requests = mockFirecrawl(
		t,
		{ status: 429, body: { success: false, error: "Rate limit", retry_after_seconds: 0 } },
		ok({ alexandria: [{ provider: "particle", capability: "podcasts/episodes/search", creditsCost: 15, data: { episodes: [{ id: "e1" }] } }], creditsCost: 15 }),
	);
	const { call } = web();
	assert.deepEqual(await call("web_alexandria", { tool: "particle/podcasts/episodes/search", options: { keyword_search: "AI agents" } }), {
		data: { episodes: [{ id: "e1" }] },
		creditsCost: 15,
	});
	assert.deepEqual(requests[1]?.body, { alexandria: [{ provider: "particle", capability: "podcasts/episodes/search", options: { keyword_search: "AI agents" } }] });
	const ids = requests.map((request) => request.headers["x-request-id"]);
	assert.match(ids[0] ?? "", /^[0-9a-f-]{36}$/);
	assert.equal(ids[1], ids[0]);
	await call("web_alexandria", { tool: "particle/podcasts/episodes/search" });
	assert.notEqual(requests[2]?.headers["x-request-id"], ids[0]);
	await assert.rejects(call("web_alexandria", { tool: "particle" }), /provider\/capability/);
	assert.equal(requests.length, 3);
});

test("web_alexandria reports a tool's error and a terms URL", async (t) => {
	mockFirecrawl(
		t,
		ok({ alexandria: [{ provider: "x", capability: "b", error: { code: "invalid_option", message: "b does not take bogus." } }], creditsCost: 0 }),
		{ status: 403, body: { success: false, error: "Terms required", requiresAction: { url: "https://firecrawl.dev/terms/x" } } },
	);
	const { call } = web();
	await assert.rejects(call("web_alexandria", { tool: "x/b", options: { bogus: 1 } }), /invalid_option.*does not take bogus/);
	await assert.rejects(call("web_alexandria", { tool: "x/b" }), /HTTP 403: Terms required\. An org admin must accept the provider terms at https:\/\/firecrawl\.dev\/terms\/x/);
});
