export interface SearchRequest {
	query: string;
	limit?: number | undefined;
	sources: ["web"];
	includeDomains?: string[] | undefined;
	excludeDomains?: string[] | undefined;
	tbs?: string | undefined;
}

interface SearchHit {
	url: string;
	title?: string | undefined;
	description?: string | undefined;
}

interface ScrapedPage {
	markdown?: string | undefined;
	html?: string | undefined;
	status: number;
	error?: string | undefined;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
	typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const hits = (value: unknown): SearchHit[] =>
	(Array.isArray(value) ? value : []).flatMap((item) => {
		const hit = record(item);
		return typeof hit?.url === "string" ? [{ url: hit.url, title: text(hit.title), description: text(hit.description) }] : [];
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

export class FirecrawlClient {
	readonly #apiKey: string;
	readonly #baseUrl: string;

	constructor(apiKey: string, baseUrl = "https://api.firecrawl.dev/v2") {
		this.#apiKey = apiKey;
		this.#baseUrl = baseUrl.replace(/\/+$/, "");
	}

	async search(options: SearchRequest, signal?: AbortSignal): Promise<SearchHit[]> {
		return hits(data(await this.#request("search", options, signal), "search").web);
	}

	async scrape(url: string, signal?: AbortSignal): Promise<ScrapedPage> {
		const page = data(await this.#request("scrape", { url, formats: ["markdown", "html"], onlyMainContent: true }, signal), "scrape");
		const metadata = record(page.metadata) ?? {};
		return {
			markdown: text(page.markdown),
			html: text(page.html),
			status: typeof metadata.statusCode === "number" ? metadata.statusCode : 0,
			error: text(metadata.error) ?? text(metadata.title),
		};
	}

	async map(options: { url: string; search?: string; limit: number }, signal?: AbortSignal): Promise<string[]> {
		return hits(success(await this.#request("map", options, signal), "map").links).map((link) => link.url);
	}

	async #request(endpoint: string, body: object, signal?: AbortSignal): Promise<unknown> {
		signal?.throwIfAborted();
		let response: Response;
		try {
			response = await fetch(`${this.#baseUrl}/${endpoint}`, {
				method: "POST",
				headers: { Authorization: `Bearer ${this.#apiKey}`, "Content-Type": "application/json" },
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
		if (!response.ok) throw new Error(`Firecrawl HTTP ${response.status}: ${text(record(payload)?.error) ?? "request failed"}.`);
		return payload;
	}
}
