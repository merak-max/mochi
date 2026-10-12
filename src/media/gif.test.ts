import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { gifFns, parseTenorPage } from "./gif.ts";
import { tempDir } from "../test-support.ts";

const PAGE = `<figure class="UniversalGifListItem clickable" data-index="0"><a href="/view/a"><div class="Gif"><picture><img src="https://media.tenor.com/A1AAAAM/happy-tears.gif" width="180" alt="a man is crying and saying \`\` so proud of you \`\` ." loading="lazy"></picture></div></a></figure>
<figure class="UniversalGifListItem clickable" data-index="1"><a href="/view/b"><div class="Gif"><picture><img src="https://media.tenor.com/B2AAAAM/clap.gif" width="180" alt="a man applauds in front of a sign that says &quot;i&#039;m proud&quot;" loading="lazy"></picture></div></a></figure>
<figure class="UniversalGifListItem clickable" data-index="2"><a href="/view/a"><div class="Gif"><picture><img src="https://media.tenor.com/A1AAAAM/happy-tears.gif" alt="duplicate"></picture></div></a></figure>`;

const call = {} as never;

it("parses Tenor results into url and description, once each", () => {
	assert.deepEqual(parseTenorPage(PAGE), [
		{ url: "https://media.tenor.com/A1AAAAM/happy-tears.gif", description: 'a man is crying and saying " so proud of you " .' },
		{ url: "https://media.tenor.com/B2AAAAM/clap.gif", description: 'a man applauds in front of a sign that says "i\'m proud"' },
	]);
});

it("searches the slugged Tenor page and saves only Tenor GIFs", async () => {
	const workDir = await tempDir();
	const asked: string[] = [];
	const network = (async (url: string | URL) => {
		asked.push(String(url));
		if (String(url).startsWith("https://tenor.com/")) return new Response(PAGE);
		return new Response(new Uint8Array([71, 73, 70]));
	}) as typeof fetch;
	const [search, save] = gifFns({ workDir, fetch: network });
	const hits = await search!.run({ query: "Proud of you!", limit: 1 }, call, BACKGROUND_CONTEXT);
	assert.equal(asked[0], "https://tenor.com/search/proud-of-you-gifs");
	assert.equal((hits.value as unknown[]).length, 1);
	const saved = (await save!.run({ url: "https://media.tenor.com/A1AAAAM/happy-tears.gif" }, call, BACKGROUND_CONTEXT)).value as { path: string };
	assert.match(saved.path, /^out\/.+\.gif$/);
	assert.deepEqual([...(await readFile(join(workDir, saved.path)))], [71, 73, 70]);
	await assert.rejects(save!.run({ url: "https://evil.example/x.gif" }, call, BACKGROUND_CONTEXT), /Only https:\/\/media.tenor.com/);
});
