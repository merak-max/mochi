import { contentText, type Models, type Usage } from "@earendil-works/pi-ai";
import type { ModelRef } from "@earendil-works/pi-durable";
import { prompt } from "../prompts.ts";
import { untilAborted } from "./client.ts";

const EXTRACTION_TIMEOUT_MS = 45_000;

/**
 * The page has to fit the extraction model's context next to the prompt and the answer. About three characters per
 * token keeps a code-heavy page inside it too. A page that is still longer keeps its head and tail.
 */
function fitToContext(markdown: string, contextWindow: number, answerTokens: number): { page: string; cut: boolean } {
	const budget = Math.max(4000, (contextWindow - answerTokens - 2000) * 3);
	if (markdown.length <= budget) return { page: markdown, cut: false };
	const marker = `\n\n[Middle of page omitted to fit the extraction model; ${markdown.length} chars total]\n\n`;
	const head = Math.floor((budget - marker.length) * 0.75);
	const tail = budget - marker.length - head;
	return { page: `${markdown.slice(0, head)}${marker}${markdown.slice(-tail)}`, cut: true };
}

/** Main content of a page as Markdown, or undefined when Defuddle finds none. */
export async function cleanFirecrawlHtml(html: string, url: string): Promise<string | undefined> {
	try {
		// Loaded on first fetch: defuddle pulls in linkedom and its parser tree.
		const { Defuddle } = await import("defuddle/node");
		const result = await Defuddle(html, url, { markdown: true, removeImages: true, useAsync: false });
		const markdown = result.contentMarkdown ?? result.content;
		return typeof markdown === "string" && markdown.trim() ? markdown.trim() : undefined;
	} catch {
		return undefined;
	}
}

interface Extracted {
	readonly text: string;
	readonly usage: Usage;
	/** The model saw the page with its middle cut out to fit its context. */
	readonly cut: boolean;
}

/** Runs `instruction` over the page on the fast model; with `schema`, the answer is one JSON value. A missing or failing model throws. */
export async function extractFirecrawlContent(options: {
	readonly models: Models;
	readonly model: ModelRef;
	readonly url: string;
	readonly markdown: string;
	readonly instruction: string;
	readonly schema?: Record<string, unknown> | undefined;
	readonly signal?: AbortSignal | undefined;
}): Promise<Extracted> {
	const deadline = AbortSignal.timeout(EXTRACTION_TIMEOUT_MS);
	const signal = options.signal === undefined ? deadline : AbortSignal.any([options.signal, deadline]);
	try {
		return await untilAborted(extract({ ...options, signal }), signal);
	} catch (error) {
		if (deadline.aborted && !options.signal?.aborted) throw new Error(`Extraction timed out after ${EXTRACTION_TIMEOUT_MS / 1000}s for ${options.url}.`);
		throw error;
	}
}

async function extract(options: {
	readonly models: Models;
	readonly model: ModelRef;
	readonly url: string;
	readonly markdown: string;
	readonly instruction: string;
	readonly schema?: Record<string, unknown> | undefined;
	readonly signal: AbortSignal;
}): Promise<Extracted> {
	const name = `${options.model.provider}/${options.model.modelId}`;
	const model = options.models.getModel(options.model.provider, options.model.modelId);
	if (model === undefined) throw new Error(`Extraction model ${name} is not known to mochi.`);
	const schemaBlock = options.schema === undefined ? "" : `\n<schema>${JSON.stringify(options.schema)}</schema>`;
	const answerTokens = Math.min(model.maxTokens, Math.floor(model.contextWindow / 4));
	const { page, cut } = fitToContext(options.markdown, model.contextWindow, answerTokens);
	const response = await options.models.completeSimple(
		model,
		{
			systemPrompt: prompt(options.schema === undefined ? "web/extract-text" : "web/extract-schema"),
			messages: [
				{
					role: "user",
					content: `<instruction>${options.instruction}</instruction>${schemaBlock}\n<url>${options.url}</url>\n<page>${page}</page>`,
					timestamp: Date.now(),
				},
			],
		},
		{
			signal: options.signal,
			maxTokens: answerTokens,
		},
	);
	options.signal.throwIfAborted();
	if (response.stopReason === "aborted") throw new DOMException("Extraction aborted", "AbortError");
	if (response.stopReason === "error") throw new Error(`Extraction model ${name} failed: ${response.errorMessage ?? "unknown error"}`);
	const text = contentText(response.content).trim();
	if (text === "") throw new Error(`Extraction model ${name} returned no text.`);
	return { text, usage: response.usage, cut };
}
