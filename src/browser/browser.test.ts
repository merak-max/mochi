import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { browse, browserFns } from "./browser.ts";
import { BrowserClient } from "./client.ts";
import { acquireProfile } from "./profile.ts";

function fake(profile: string, outputs = ["Completed."]) {
	const requests: { path: string; method: string; body: unknown; signal: AbortSignal | null | undefined }[] = [];
	let active = 0;
	let maximum = 0;
	let next = 0;
	const fetcher: typeof fetch = async (input, init) => {
		const path = new URL(String(input)).pathname;
		const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined;
		requests.push({ path, method: init?.method ?? "GET", body, signal: init?.signal });
		await setImmediate();
		if (path.endsWith("/scrape")) {
			active++;
			maximum = Math.max(maximum, active);
			return Response.json({ success: true, data: { metadata: { scrapeId: `job ${++next}` } } });
		}
		if (init?.method === "DELETE") { active--; return Response.json({ success: true }); }
		return Response.json({ success: true, output: outputs.shift() ?? "Completed.", interactiveLiveViewUrl: "https://live.example/takeover" });
	};
	return { deps: { apiKey: "test-secret", profile, fetch: fetcher }, requests, maximum: () => maximum };
}

test("scrape inherits the persistent writable profile and prompt interact is stopped", async () => {
	const f = fake("request-shape");
	assert.deepEqual(await browse(f.deps, { url: "https://example.com", task: "Read heading." }), { output: "Completed." });
	assert.deepEqual(f.requests.map((r) => [r.path, r.method]), [
		["/v2/scrape", "POST"], ["/v2/scrape/job%201/interact", "POST"], ["/v2/scrape/job%201/interact", "DELETE"],
	]);
	assert.deepEqual(f.requests[0]?.body, { url: "https://example.com/", formats: ["markdown"], profile: { name: "request-shape", saveChanges: true } });
	assert.match(JSON.stringify(f.requests[1]?.body), /Read heading/);
	assert.equal(JSON.stringify(f.requests[1]?.body).includes("saveChanges"), false);
	assert.equal(browserFns(f.deps)[0]?.replay, "once");
});

test("only explicit unfinished work causes another prompt, capped at three", async () => {
	const f = fake("continue", ["MOCHI_CONTINUE Click next.", "MOCHI_CONTINUE Still working.", "MOCHI_CONTINUE Not done."]);
	assert.deepEqual(await browse(f.deps, { url: "https://example.com", task: "Read heading." }), { output: "Stopped after three prompt calls with unfinished work. Not done." });
	assert.equal(f.requests.filter((r) => r.method === "POST" && r.path.endsWith("interact")).length, 3);
	assert.equal(f.requests.at(-1)?.method, "DELETE");
});

test("two clients sharing a profile never create simultaneous savers", async () => {
	const f = fake("one-saver");
	await Promise.all([
		browse(f.deps, { url: "https://example.com", task: "First." }),
		browse({ ...f.deps }, { url: "https://example.com", task: "Second." }),
	]);
	assert.equal(f.maximum(), 1);
	assert.equal(f.requests.length, 6);
	assert.deepEqual(f.requests.map((r) => r.method), ["POST", "POST", "DELETE", "POST", "POST", "DELETE"]);
});

test("an interrupted interaction still deletes with an independent cleanup signal", async () => {
	const f = fake("abort");
	const controller = new AbortController();
	const fetcher: typeof fetch = async (url, init) => {
		if (init?.method === "POST" && String(url).endsWith("interact")) {
			controller.abort(new Error("cancelled"));
			throw controller.signal.reason;
		}
		return f.deps.fetch(url, init);
	};
	await assert.rejects(browse({ ...f.deps, fetch: fetcher }, { url: "https://example.com", task: "Read." }, controller.signal), /cancelled/);
	assert.equal(f.requests.at(-1)?.method, "DELETE");
	assert.equal(f.requests.at(-1)?.signal?.aborted, false);
});

test("human takeover keeps its saver reserved until the cleanup timer fires", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const f = fake("human", ["MOCHI_NEEDS_HUMAN Sign in."]);
	assert.deepEqual(await browse(f.deps, { url: "https://example.com", task: "Read." }), { output: "Sign in.", liveViewUrl: "https://live.example/takeover" });
	assert.equal(f.requests.some((r) => r.method === "DELETE"), false);
	const queued = browse(f.deps, { url: "https://example.com", task: "Next." });
	await setImmediate();
	assert.equal(f.requests.length, 2);
	t.mock.timers.tick(290_000);
	await queued;
	assert.equal(f.maximum(), 1);
	assert.equal(f.requests.length, 6);
});

test("keepOpen returns the interactive link and stops automatically", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const f = fake("keep-open");
	assert.deepEqual(await browse(f.deps, { url: "https://example.com", task: "Read.", keepOpen: true }), { output: "Completed.", liveViewUrl: "https://live.example/takeover" });
	t.mock.timers.tick(290_000);
	await setImmediate();
	assert.equal(f.requests.at(-1)?.method, "DELETE");
});

test("a cancelled queued saver never starts and does not strand the next waiter", async () => {
	const first = await acquireProfile("queue");
	const controller = new AbortController();
	const cancelled = acquireProfile("queue", controller.signal);
	const next = acquireProfile("queue");
	controller.abort(new Error("cancelled"));
	await assert.rejects(cancelled, /cancelled/);
	await first.stop(async () => {});
	await (await next).stop(async () => {});
});

test("invalid responses fail at the network boundary and release after cleanup", async () => {
	const f = fake("invalid");
	const fetcher: typeof fetch = async (url, init) => {
		if (init?.method === "POST" && String(url).endsWith("interact")) return Response.json({ success: true, output: 42 });
		return f.deps.fetch(url, init);
	};
	await assert.rejects(browse({ ...f.deps, fetch: fetcher }, { url: "https://example.com", task: "Read." }), /Invalid Firecrawl browser response/);
	assert.equal(f.requests.at(-1)?.method, "DELETE");
});

test("standalone sessions use the same writable profile and TTLs", async () => {
	const requests: { url: string; init: RequestInit | undefined }[] = [];
	const fetcher: typeof fetch = async (url, init) => {
		requests.push({ url: String(url), init });
		return Response.json(init?.method === "DELETE" ? { success: true } : { success: true, id: "session", cdpUrl: "wss://cdp.example", expiresAt: "2026-10-06T22:00:00Z" });
	};
	const client = new BrowserClient({ apiKey: "test", profile: "standalone", fetch: fetcher });
	const session = await client.createSession();
	await client.stopSession(session.id);
	assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), { ttl: 600, activityTtl: 300, profile: { name: "standalone", saveChanges: true } });
	assert.equal(requests[1]?.url, "https://api.firecrawl.dev/v2/interact/session");
	assert.equal(requests[1]?.init?.method, "DELETE");
});

test("unsafe URLs and missing credentials make no request", async () => {
	const f = fake("configuration");
	await assert.rejects(browse(f.deps, { url: "file:///tmp/example", task: "Read." }), /HTTP/);
	await assert.rejects(browse({ ...f.deps, apiKey: undefined }, { url: "https://example.com", task: "Read." }), /API_KEY/);
	await assert.rejects(browse({ ...f.deps, profile: undefined }, { url: "https://example.com", task: "Read." }), /PROFILE/);
	assert.equal(f.requests.length, 0);
});
