import { Type, type Static, type TSchema } from "typebox";
import { parseWith } from "../parse.ts";

const Success = Type.Object({ success: Type.Literal(true) }, { additionalProperties: true });
const Scrape = Type.Object({ success: Type.Literal(true), data: Type.Object({ metadata: Type.Object({ scrapeId: Type.String({ minLength: 1 }) }, { additionalProperties: true }) }, { additionalProperties: true }) }, { additionalProperties: true });
const Text = Type.Optional(Type.Union([Type.String(), Type.Null()]));
// Firecrawl marks every field but success and killed nullable; output is null when the agent ran out of time or failed.
const Interaction = Type.Object({
	success: Type.Boolean(),
	output: Text,
	result: Text,
	error: Text,
	liveViewUrl: Text,
	interactiveLiveViewUrl: Text,
	killed: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
	exitCode: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
}, { additionalProperties: true });
export type InteractionResult = Static<typeof Interaction>;
const Session = Type.Object({
	success: Type.Literal(true),
	id: Type.String({ minLength: 1 }),
	cdpUrl: Type.String({ minLength: 1 }),
	expiresAt: Type.String(),
}, { additionalProperties: true });

export interface BrowserDeps {
	readonly apiKey: string | undefined;
	/** The env variable the key comes from, for the error that names it. */
	readonly keyEnv: string;
	readonly profile?: string;
	readonly baseUrl: string;
}

export class BrowserClient {
	readonly key: string;
	readonly #profile: string;
	readonly #baseUrl: string;
	readonly #deps: BrowserDeps;

	constructor(deps: BrowserDeps) {
		if (!deps.apiKey?.trim()) throw new Error(`Browser is not configured: ${deps.keyEnv} is unset.`);
		if (!deps.profile?.trim()) throw new Error("Browser is not configured: set [web] browserProfile in config.toml.");
		this.#deps = deps;
		this.#profile = deps.profile.trim();
		this.#baseUrl = deps.baseUrl.replace(/\/+$/, "");
		this.key = `${this.#baseUrl}/${this.#profile}`;
	}

	async scrape(url: string, signal?: AbortSignal): Promise<string> {
		const result = await this.#request("scrape", "POST", {
			url, formats: ["markdown"], profile: { name: this.#profile, saveChanges: true },
		}, Scrape, signal);
		return result.data.metadata.scrapeId;
	}

	interact(id: string, prompt: string, signal?: AbortSignal): Promise<InteractionResult> {
		return this.#request(`scrape/${encodeURIComponent(id)}/interact`, "POST", { prompt, timeout: 300 }, Interaction, signal);
	}

	stopScrape(id: string): Promise<Static<typeof Success>> {
		return this.#request(`scrape/${encodeURIComponent(id)}/interact`, "DELETE", undefined, Success);
	}

	createSession(signal?: AbortSignal): Promise<Static<typeof Session>> {
		return this.#request("interact", "POST", { ttl: 600, activityTtl: 300, profile: { name: this.#profile, saveChanges: true } }, Session, signal);
	}

	stopSession(id: string): Promise<Static<typeof Success>> {
		return this.#request(`interact/${encodeURIComponent(id)}`, "DELETE", undefined, Success);
	}

	async #request<S extends TSchema>(path: string, method: string, body: object | undefined, schema: S, signal?: AbortSignal): Promise<Static<S>> {
		const timeout = AbortSignal.timeout(method === "DELETE" ? 30_000 : 330_000);
		const response = await fetch(`${this.#baseUrl}/${path}`, {
			method,
			headers: { Authorization: `Bearer ${this.#deps.apiKey}`, "Content-Type": "application/json" },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
			signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
		});
		if (method === "DELETE" && response.status === 404) return parseWith(schema, { success: true }, "expired browser session");
		if (!response.ok) throw new Error(`Firecrawl browser HTTP ${response.status}: ${(await response.text().catch(() => "")).slice(0, 500)}`);
		return parseWith(schema, await response.json(), "Firecrawl browser response");
	}
}
