import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { Models } from "@earendil-works/pi-ai";
import { FirecrawlClient } from "./client.ts";
import { extractFirecrawlContent } from "./content.ts";

const realFetch = globalThis.fetch;
const sentBodies: unknown[] = [];

afterEach(() => {
	globalThis.fetch = realFetch;
	sentBodies.length = 0;
});

function fetchThatNeverResolves(): void {
	globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
		sentBodies.push(JSON.parse(String(init?.body)));
		return new Promise<Response>(() => {});
	}) as typeof fetch;
}

async function elapsed(work: () => Promise<unknown>): Promise<{ error: unknown; milliseconds: number }> {
	const start = performance.now();
	try {
		await work();
	} catch (error) {
		return { error, milliseconds: performance.now() - start };
	}
	throw new Error("expected the call to reject");
}

test("scrape rejects with a timeout Error at its deadline when fetch never resolves", async () => {
	fetchThatNeverResolves();
	const client = new FirecrawlClient("fc-test", "http://firecrawl.invalid");
	const request = { url: "https://navigoseminars.com", formats: ["markdown", "html"] as ["markdown", "html"], onlyMainContent: true as const, timeout: 150 };
	const { error, milliseconds } = await elapsed(() => client.scrape(request, undefined, 200));
	assert.ok(error instanceof Error);
	assert.notEqual(error.name, "AbortError");
	assert.equal(error.message, "Firecrawl scrape timed out after 0.2s for https://navigoseminars.com.");
	assert.ok(milliseconds < 1000, `took ${milliseconds}ms`);
	assert.deepEqual(sentBodies[0], request);
});

test("search and map time out with the same clear Error", async () => {
	fetchThatNeverResolves();
	const client = new FirecrawlClient("fc-test", "http://firecrawl.invalid");
	const search = await elapsed(() => client.search({ query: "pi", limit: 5, sources: ["web"], highlights: false }, undefined, 100));
	assert.match(String(search.error), /Firecrawl search timed out after 0\.1s for "pi"\./);
	const map = await elapsed(() => client.map({ url: "https://a.dev", limit: 10 }, undefined, 100));
	assert.match(String(map.error), /Firecrawl map timed out after 0\.1s for https:\/\/a\.dev\./);
});

test("an abort from the caller stays an abort, not a timeout", async () => {
	fetchThatNeverResolves();
	const client = new FirecrawlClient("fc-test", "http://firecrawl.invalid");
	const caller = new AbortController();
	setTimeout(() => caller.abort(), 50);
	const { error } = await elapsed(() => client.map({ url: "https://a.dev", limit: 10 }, caller.signal, 5000));
	assert.ok(error instanceof DOMException);
	assert.equal(error.name, "AbortError");
});

test("extraction rejects with a timeout Error when the model never answers", async () => {
	const models = {
		getModel: () => ({ maxTokens: 1000, contextWindow: 100_000 }),
		completeSimple: () => new Promise(() => {}),
	} as unknown as Models;
	const options = { models, model: { provider: "faux", modelId: "slow" }, url: "https://a.dev", markdown: "page", instruction: "summarise", timeoutMs: 100 };
	const { error, milliseconds } = await elapsed(() => extractFirecrawlContent(options as never));
	assert.ok(error instanceof Error);
	assert.equal(error.message, "Extraction timed out after 0.1s for https://a.dev.");
	assert.ok(milliseconds < 1000, `took ${milliseconds}ms`);
});
