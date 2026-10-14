import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { saveOutput } from "./files.ts";

const SEARCH_URL = "https://tenor.com/search/";
const MEDIA_HOST = "media.tenor.com";
const BROWSER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36";
const MAX_GIF_BYTES = 8_000_000;

type GifHit = { url: string; description: string };

const ENTITIES: Readonly<Record<string, string>> = { "&quot;": '"', "&amp;": "&", "&lt;": "<", "&gt;": ">" };

function decode(text: string): string {
	return text.replace(/&(?:quot|amp|lt|gt|#(\d+));/g, (entity, code: string | undefined) => (code === undefined ? ENTITIES[entity]! : String.fromCodePoint(Number(code))));
}

function parseTenorPage(html: string): GifHit[] {
	const hits: GifHit[] = [];
	const seen = new Set<string>();
	for (const figure of html.matchAll(/<figure class="UniversalGifListItem[\s\S]*?<\/figure>/g)) {
		const image = /<img src="(https:\/\/media\.tenor\.com\/[^"]+\.gif)"[^>]*alt="([^"]*)"/.exec(figure[0]);
		if (image === null) continue;
		const url = image[1]!;
		if (seen.has(url)) continue;
		seen.add(url);
		hits.push({ url, description: decode(image[2]!).replace(/``/g, '"').trim() });
	}
	return hits;
}

export function gifFns(workDir: string): ToolRegistration[] {
	return [
		defineTool({
			name: "gif_search",
			description: "Search Tenor for GIFs. Each hit has a url and a description of what it shows. Pick the one that fits, then save it with gif_save.",
			parameters: Type.Object({ query: Type.String({ minLength: 1, maxLength: 100 }), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })) }),
			structuredOutputSchema: Type.Array(Type.Object({ url: Type.String(), description: Type.String() })),
			replay: "safe",
			execute: async ({ query, limit }, _api, context) => {
				const slug = query.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
				if (slug === "") throw new Error("The GIF query needs letters or digits.");
				const response = await fetch(`${SEARCH_URL}${slug}-gifs`, { headers: { "user-agent": BROWSER_AGENT }, signal: context.abortSignal ?? null });
				if (!response.ok) throw new Error(`Tenor search failed with HTTP ${response.status}.`);
				const hits = parseTenorPage(await response.text());
				if (hits.length === 0) throw new Error("Tenor returned no GIFs for that query; its page layout may have changed.");
				return { structuredOutput: hits.slice(0, limit ?? 8) };
			},
		}),
		defineTool({
			name: "gif_save",
			description: "Download a gif_search url into the work directory. Send the returned path with a standalone attach: <path> line.",
			parameters: Type.Object({ url: Type.String({ minLength: 1 }) }),
			structuredOutputSchema: Type.Object({ path: Type.String() }),
			replay: "unsafe",
			execute: async ({ url }, _api, context) => {
				const parsed = new URL(url);
				if (parsed.protocol !== "https:" || parsed.hostname !== MEDIA_HOST || !parsed.pathname.endsWith(".gif")) throw new Error(`Only https://${MEDIA_HOST} .gif URLs from gif_search can be saved.`);
				const response = await fetch(parsed, { headers: { "user-agent": BROWSER_AGENT }, signal: context.abortSignal ?? null });
				if (!response.ok) throw new Error(`GIF download failed with HTTP ${response.status}.`);
				const bytes = new Uint8Array(await response.arrayBuffer());
				if (bytes.length > MAX_GIF_BYTES) throw new Error(`The GIF is ${bytes.length} bytes, over the ${MAX_GIF_BYTES} byte limit. Pick another.`);
				return { structuredOutput: await saveOutput(workDir, "gif", bytes) };
			},
		}),
	];
}
