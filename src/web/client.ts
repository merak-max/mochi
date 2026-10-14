import type { JsonValue } from "@earendil-works/chord";

const FIRECRAWL_V2_BASE_URL = "https://api.firecrawl.dev/v2";
/** Free plans allow about 12 requests a minute, and a script's `Promise.all` reaches that fast. */
const MAX_RATE_LIMIT_RETRIES = 3;
const MAX_RATE_LIMIT_WAIT_SECONDS = 30;
const DEFAULT_RATE_LIMIT_WAIT_SECONDS = 5;

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
	records?: number | undefined;
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

function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason);
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal?.reason);
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, milliseconds);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/** Firecrawl v2 search, scrape, map and Alexandria, reading only the fields mochi uses. */
export class FirecrawlClient {
	readonly #apiKey: string;
	readonly #baseUrl: string;

	constructor(apiKey: string, baseUrl = FIRECRAWL_V2_BASE_URL) {
		this.#apiKey = apiKey;
		this.#baseUrl = baseUrl.replace(/\/+$/, "");
	}

	async search(options: SearchRequest, signal?: AbortSignal): Promise<SearchHit[]> {
		const hits = records(data(await this.#request("search", options, signal), "search").web);
		return hits.flatMap((hit) => (typeof hit.url === "string" ? [{ url: hit.url, title: text(hit.title), description: text(hit.description) }] : []));
	}

	async scrape(options: ScrapeRequest, signal?: AbortSignal): Promise<ScrapedPage> {
		const page = data(await this.#request("scrape", options, signal), "scrape");
		const metadata = record(page.metadata) ?? {};
		return {
			markdown: text(page.markdown),
			html: text(page.html),
			status: number(metadata.statusCode) ?? 0,
			error: text(metadata.error) ?? text(metadata.title),
		};
	}

	async map(options: { url: string; search?: string; limit: number }, signal?: AbortSignal): Promise<string[]> {
		const links = records(success(await this.#request("map", options, signal), "map").links);
		return links.flatMap((link) => (typeof link.url === "string" ? [link.url] : []));
	}

	/**
	 * Runs one Alexandria tool through /scrape. Discovery (firecrawl/find-tools) is free; every other tool charges its listed credits.
	 * One `x-request-id` covers the rate-limit retries, so Firecrawl replays a retried call instead of billing it twice.
	 */
	async alexandria(call: AlexandriaCall, signal?: AbortSignal): Promise<AlexandriaResult> {
		const label = `alexandria ${call.provider}/${call.capability}`;
		const headers = { "x-request-id": crypto.randomUUID() };
		const response = data(await this.#request("scrape", { alexandria: [call] }, signal, headers), label);
		const result = records(response.alexandria)[0];
		if (result === undefined) throw new Error(`Firecrawl returned no result for ${label}.`);
		const error = record(result.error);
		if (error !== undefined) throw new Error(`Firecrawl ${label} failed (${text(error.code) ?? "error"}): ${text(error.message) ?? "no message"}.`);
		const cost = number(result.creditsCost) ?? number(response.creditsCost) ?? 0;
		return { data: (result.data ?? null) as JsonValue, creditsCost: cost, records: number(result.records) };
	}

	async #request(endpoint: string, body: object, signal?: AbortSignal, headers: Record<string, string> = {}): Promise<unknown> {
		for (let attempt = 0; ; attempt++) {
			signal?.throwIfAborted();
			let response: Response;
			try {
				response = await fetch(`${this.#baseUrl}/${endpoint}`, {
					method: "POST",
					headers: { Authorization: `Bearer ${this.#apiKey}`, "Content-Type": "application/json", ...headers },
					body: JSON.stringify(body),
					signal: signal ?? null,
				});
			} catch (error) {
				if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) throw error;
				throw new Error("Firecrawl transport request failed.");
			}
			let payload: unknown;
			try {
				payload = await response.json();
			} catch {
				signal?.throwIfAborted();
				throw new Error(`Firecrawl returned a non-JSON response (HTTP ${response.status}).`);
			}
			if (response.ok) return payload;
			if (response.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
				const wait = retryAfterSeconds(payload, response) ?? DEFAULT_RATE_LIMIT_WAIT_SECONDS;
				if (wait <= MAX_RATE_LIMIT_WAIT_SECONDS) {
					await sleep(wait * 1000 + 250, signal);
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
