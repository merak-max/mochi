import type { JsonValue } from "@earendil-works/chord";
import { setTimeout as sleep } from "node:timers/promises";

/** Free plans allow about 12 requests a minute, and a script's `Promise.all` reaches that fast. */
const MAX_RATE_LIMIT_RETRIES = 3;
const MAX_RATE_LIMIT_WAIT_SECONDS = 30;
const DEFAULT_RATE_LIMIT_WAIT_SECONDS = 5;
const SEARCH_TIMEOUT_MS = 20_000;
export const DEFAULT_TIMEOUT_MS = 60_000;

export interface SearchRequest {
	query: string;
	limit: number;
	sources: ["web"];
	highlights: false;
	includeDomains?: string[] | undefined;
	excludeDomains?: string[] | undefined;
	tbs?: string | undefined;
}

export interface SearchHit {
	url: string;
	title?: string | undefined;
	description?: string | undefined;
}

interface ScrapeRequest {
	url: string;
	formats: ["markdown", "html"];
	onlyMainContent: true;
	/** Firecrawl's own limit in milliseconds; keep it under the client deadline so Firecrawl gives up first. */
	timeout: number;
	maxAge?: number | undefined;
}

interface ScrapedPage {
	markdown?: string | undefined;
	html?: string | undefined;
	/** The source's HTTP status, 0 when Firecrawl gives none. */
	status: number;
	/** The source's error, else its page title. */
	error?: string | undefined;
}

/** One Alexandria request: a catalogue tool by provider and capability, with its options. */
export interface AlexandriaCall {
	provider: string;
	capability: string;
	options?: Record<string, unknown> | undefined;
}

interface AlexandriaResult {
	data: JsonValue;
	/** Credits this call charged; 0 for discovery. */
	creditsCost: number;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
	typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const number = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined);
const records = (value: unknown): Record<string, unknown>[] =>
	(Array.isArray(value) ? value : []).flatMap((item) => {
		const each = record(item);
		return each === undefined ? [] : [each];
	});

function success(payload: unknown, label: string): Record<string, unknown> {
	const response = record(payload);
	if (response === undefined) throw new Error(`Firecrawl returned an invalid ${label} response.`);
	if (response.success !== true) throw new Error(`Firecrawl ${label} failed: ${text(response.error) ?? "unsuccessful response"}.`);
	return response;
}

function data(payload: unknown, label: string): Record<string, unknown> {
	const value = record(success(payload, label).data);
	if (value === undefined) throw new Error(`Firecrawl returned an invalid ${label} data response.`);
	return value;
}

function retryAfterSeconds(payload: unknown, response: Response): number | undefined {
	const fromBody = number(record(payload)?.retry_after_seconds);
	if (fromBody !== undefined) return fromBody;
	const header = response.headers.get("retry-after");
	if (header === null) return undefined;
	const seconds = Number(header);
	return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

/** Settles with `work`, or rejects as soon as `signal` aborts, even when `work` ignores the signal. */
export function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(signal.reason);
			return;
		}
		const onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
	});
}

/** Firecrawl v2 search, scrape, map and Alexandria, reading only the fields mochi uses. */
export class FirecrawlClient {
	readonly #apiKey: string;
	readonly #baseUrl: string;

	constructor(apiKey: string, baseUrl: string) {
		this.#apiKey = apiKey;
		this.#baseUrl = baseUrl.replace(/\/+$/, "");
	}

	async search(options: SearchRequest, signal?: AbortSignal): Promise<SearchHit[]> {
		const payload = await this.#requestWithDeadline("search", options, signal, SEARCH_TIMEOUT_MS, "search", `"${options.query}"`);
		const hits = records(data(payload, "search").web);
		return hits.flatMap((hit) => (typeof hit.url === "string" ? [{ url: hit.url, title: text(hit.title), description: text(hit.description) }] : []));
	}

	async scrape(options: ScrapeRequest, signal: AbortSignal | undefined, timeoutMs: number): Promise<ScrapedPage> {
		const payload = await this.#requestWithDeadline("scrape", options, signal, timeoutMs, "scrape", options.url);
		const page = data(payload, "scrape");
		const metadata = record(page.metadata) ?? {};
		return {
			markdown: text(page.markdown),
			html: text(page.html),
			status: number(metadata.statusCode) ?? 0,
			error: text(metadata.error) ?? text(metadata.title),
		};
	}

	async map(options: { url: string; search?: string; limit: number }, signal?: AbortSignal): Promise<string[]> {
		const payload = await this.#requestWithDeadline("map", options, signal, DEFAULT_TIMEOUT_MS, "map", options.url);
		const links = records(success(payload, "map").links);
		return links.flatMap((link) => (typeof link.url === "string" ? [link.url] : []));
	}

	/**
	 * Runs one Alexandria tool through /scrape. Discovery (firecrawl/find-tools) is free; every other tool charges its listed credits.
	 * One `x-request-id` covers the rate-limit retries, so Firecrawl replays a retried call instead of billing it twice.
	 */
	async alexandria(call: AlexandriaCall, signal?: AbortSignal): Promise<AlexandriaResult> {
		const tool = `${call.provider}/${call.capability}`;
		const label = `alexandria ${tool}`;
		const headers = { "x-request-id": crypto.randomUUID() };
		const payload = await this.#requestWithDeadline("scrape", { alexandria: [call] }, signal, DEFAULT_TIMEOUT_MS, "alexandria", tool, headers);
		const response = data(payload, label);
		const result = records(response.alexandria)[0];
		if (result === undefined) throw new Error(`Firecrawl returned no result for ${label}.`);
		const error = record(result.error);
		if (error !== undefined) throw new Error(`Firecrawl ${label} failed (${text(error.code) ?? "error"}): ${text(error.message) ?? "no message"}.`);
		const cost = number(result.creditsCost) ?? number(response.creditsCost) ?? 0;
		return { data: (result.data ?? null) as JsonValue, creditsCost: cost };
	}

	/**
	 * One deadline covers the whole call, rate-limit waits included. When the deadline fires, and not the caller's signal,
	 * this throws a plain Error, so a script can catch it and keep its other results.
	 */
	async #requestWithDeadline(
		endpoint: string,
		body: object,
		signal: AbortSignal | undefined,
		timeoutMs: number,
		label: string,
		target: string,
		headers: Record<string, string> = {},
	): Promise<unknown> {
		const deadline = AbortSignal.timeout(timeoutMs);
		const combined = signal === undefined ? deadline : AbortSignal.any([signal, deadline]);
		try {
			return await untilAborted(this.#request(endpoint, body, combined, headers), combined);
		} catch (error) {
			if (deadline.aborted && !signal?.aborted) throw new Error(`Firecrawl ${label} timed out after ${timeoutMs / 1000}s for ${target}.`);
			throw error;
		}
	}

	async #request(endpoint: string, body: object, signal: AbortSignal, headers: Record<string, string>): Promise<unknown> {
		for (let attempt = 0; ; attempt++) {
			signal.throwIfAborted();
			let response: Response;
			try {
				response = await fetch(`${this.#baseUrl}/${endpoint}`, {
					method: "POST",
					headers: { Authorization: `Bearer ${this.#apiKey}`, "Content-Type": "application/json", ...headers },
					body: JSON.stringify(body),
					signal,
				});
			} catch (error) {
				if (signal.aborted || (error instanceof DOMException && error.name === "AbortError")) throw error;
				throw new Error("Firecrawl transport request failed.");
			}
			let payload: unknown;
			try {
				payload = await response.json();
			} catch {
				signal.throwIfAborted();
				throw new Error(`Firecrawl returned a non-JSON response (HTTP ${response.status}).`);
			}
			if (response.ok) return payload;
			if (response.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
				const wait = retryAfterSeconds(payload, response) ?? DEFAULT_RATE_LIMIT_WAIT_SECONDS;
				if (wait <= MAX_RATE_LIMIT_WAIT_SECONDS) {
					await sleep(wait * 1000 + 250, undefined, { signal });
					continue;
				}
			}
			const failure = record(payload);
			const termsUrl = text(record(failure?.requiresAction)?.url);
			const action = termsUrl === undefined ? "" : ` An org admin must accept the provider terms at ${termsUrl}.`;
			throw new Error(`Firecrawl HTTP ${response.status}: ${text(failure?.error) ?? "request failed"}.${action}`);
		}
	}
}
