import { Type, type Static, type TSchema } from "typebox";
import { parseWith } from "../parse.ts";

const Success = Type.Object({ success: Type.Literal(true) }, { additionalProperties: true });
const Scrape = Type.Object({ success: Type.Literal(true), data: Type.Object({ metadata: Type.Object({ scrapeId: Type.String({ minLength: 1 }) }, { additionalProperties: true }) }, { additionalProperties: true }) }, { additionalProperties: true });
const Interaction = Type.Object({
	success: Type.Literal(true),
	output: Type.String(),
	liveViewUrl: Type.Optional(Type.String()),
	interactiveLiveViewUrl: Type.Optional(Type.String()),
	killed: Type.Optional(Type.Boolean()),
	exitCode: Type.Optional(Type.Integer()),
}, { additionalProperties: true });
const Session = Type.Object({
	success: Type.Literal(true),
	id: Type.String({ minLength: 1 }),
	cdpUrl: Type.String({ minLength: 1 }),
	liveViewUrl: Type.Optional(Type.String()),
	interactiveLiveViewUrl: Type.Optional(Type.String()),
	expiresAt: Type.String(),
}, { additionalProperties: true });
export type BrowserSession = Static<typeof Session>;

export interface BrowserDeps {
	readonly apiKey: string | undefined;
	readonly profile: string | undefined;
	readonly baseUrl?: string;
	readonly fetch?: typeof fetch;
}

export class BrowserClient {
	readonly profile: string;
	readonly key: string;
	readonly #deps: BrowserDeps;

	constructor(deps: BrowserDeps) {
		if (!deps.apiKey?.trim()) throw new Error("Browser is not configured: FIRECRAWL_API_KEY is unset.");
		if (!deps.profile?.trim()) throw new Error("Browser is not configured: FIRECRAWL_PROFILE is unset.");
		this.#deps = deps;
		this.profile = deps.profile.trim();
		this.key = `${(deps.baseUrl ?? "https://api.firecrawl.dev/v2").replace(/\/+$/, "")}/${this.profile}`;
	}

	async scrape(url: string, signal?: AbortSignal): Promise<string> {
		const result = await this.#request("scrape", "POST", {
			url, formats: ["markdown"], profile: { name: this.profile, saveChanges: true },
		}, Scrape, signal);
		return result.data.metadata.scrapeId;
	}

	interact(id: string, prompt: string, signal?: AbortSignal): Promise<Static<typeof Interaction>> {
		return this.#request(`scrape/${encodeURIComponent(id)}/interact`, "POST", { prompt }, Interaction, signal);
	}

	stopScrape(id: string): Promise<Static<typeof Success>> {
		return this.#request(`scrape/${encodeURIComponent(id)}/interact`, "DELETE", undefined, Success);
	}

	createSession(signal?: AbortSignal): Promise<BrowserSession> {
		return this.#request("interact", "POST", { ttl: 600, activityTtl: 300, profile: { name: this.profile, saveChanges: true } }, Session, signal);
	}

	stopSession(id: string): Promise<Static<typeof Success>> {
		return this.#request(`interact/${encodeURIComponent(id)}`, "DELETE", undefined, Success);
	}

	async #request<S extends TSchema>(path: string, method: string, body: object | undefined, schema: S, signal?: AbortSignal): Promise<Static<S>> {
		const timeout = AbortSignal.timeout(method === "DELETE" ? 30_000 : 240_000);
		const response = await (this.#deps.fetch ?? fetch)(`${(this.#deps.baseUrl ?? "https://api.firecrawl.dev/v2").replace(/\/+$/, "")}/${path}`, {
			method,
			headers: { Authorization: `Bearer ${this.#deps.apiKey}`, "Content-Type": "application/json" },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
			signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
		});
		if (method === "DELETE" && response.status === 404) return parseWith(schema, { success: true }, "expired browser session");
		if (!response.ok) throw new Error(`Firecrawl browser HTTP ${response.status}.`);
		return parseWith(schema, await response.json(), "Firecrawl browser response");
	}
}
