import type { JsonValue } from "@earendil-works/chord";
import { type ClassifierQuestion, type JsonObject, type Models, Type } from "@earendil-works/pi-ai";
import { defineTool, type ModelRef, type ToolRegistration } from "@earendil-works/pi-durable";
import { messageText } from "../text.ts";
import type { Classify } from "./classifier.ts";

/** `llm` calls in flight at once across every script; a Promise.all over hundreds of slices waits its turn. */
const LLM_CONCURRENCY = 8;

function limiter(slots: number): <T>(work: () => Promise<T>) => Promise<T> {
	let free = slots;
	const waiting: (() => void)[] = [];
	return async (work) => {
		if (free > 0) free--;
		else await new Promise<void>((resolve) => waiting.push(resolve));
		try {
			return await work();
		} finally {
			const next = waiting.shift();
			if (next === undefined) free++;
			else next();
		}
	};
}
const Instructions = Type.String({ minLength: 1, maxLength: 500 });
const Question = Type.Union([
	Type.Object({ type: Type.Literal("bool"), instructions: Instructions, yes: Type.String({ minLength: 1 }), no: Type.String({ minLength: 1 }) }),
	Type.Object({ type: Type.Literal("choice"), instructions: Instructions, options: Type.Record(Type.String({ pattern: "^[a-z0-9_-]+$" }), Type.String({ minLength: 1 }), { minProperties: 2 }) }),
	Type.Object({ type: Type.Literal("score"), instructions: Instructions, levels: Type.Array(Type.String({ minLength: 1 }), { minItems: 2, maxItems: 10 }) }),
]);
const Answer = Type.Union([
	Type.Object({ type: Type.Literal("bool"), probability: Type.Number() }),
	Type.Object({ type: Type.Literal("choice"), choice: Type.String(), probabilities: Type.Record(Type.String(), Type.Number()), confidence: Type.Number() }),
	Type.Object({ type: Type.Literal("score"), score: Type.Number(), confidence: Type.Number() }),
]);

const MODELS = ["brain", "fast", "strongest"] as const;

/**
 * Model calls from scripts: `llm` with no tools, on the fast model unless it names brain or strongest, and `classify`
 * on the classifier model. `ref` is the same name-to-model lookup the agent tool uses; it throws on an unknown name.
 */
export function thinkFns(deps: { readonly models: Models; readonly ref: (name: string) => ModelRef; readonly classify: Classify }): readonly ToolRegistration[] {
	const slot = limiter(LLM_CONCURRENCY);
	return [
		defineTool({
			name: "llm",
			description: "One model completion, no tools: the fast model, or model brain or strongest. Hand it a slice of data; only its answer reaches you.",
			parameters: Type.Object({ prompt: Type.String(), system: Type.Optional(Type.String()), model: Type.Optional(Type.Union(MODELS.map((name) => Type.Literal(name)))) }),
			structuredOutputSchema: Type.String(),
			replay: "safe",
			execute: async ({ prompt, system, model: name }, _api, context) => {
				const ref = deps.ref(name ?? "fast");
				const model = deps.models.getModel(ref.provider, ref.modelId);
				if (model === undefined) throw new Error(`Model ${name ?? "fast"} (${ref.provider}/${ref.modelId}) is not configured.`);
				const signal = context.abortSignal;
				const response = await slot(() =>
					deps.models.completeSimple(
						model,
						{ ...(system === undefined ? {} : { systemPrompt: system }), messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
						{ ...(signal === undefined ? {} : { signal }), reasoning: "low", maxTokens: model.maxTokens },
					),
				);
				if (response.stopReason === "error" || response.stopReason === "aborted") throw new Error(`llm failed: ${response.errorMessage ?? response.stopReason}`);
				return { structuredOutput: messageText(response), usage: response.usage };
			},
		}),
		defineTool({
			name: "classify",
			description: "Typed bool, choice or score questions about a JSON object, answered by the classifier model with probabilities. Gate pattern: classify({state:{payload}, questions:{need:{type:'bool', instructions:'Does this need the owner?', criteria:{true:'...', false:'...'}}}}), then act only when answers.need.probability is above your threshold. A trigger can do the same before its model with a classify step.",
			parameters: Type.Object({
				state: Type.Record(Type.String(), Type.Unknown()),
				questions: Type.Record(Type.String({ pattern: "^[a-z0-9_]+$" }), Question, { minProperties: 1, maxProperties: 8 }),
			}),
			structuredOutputSchema: Type.Record(Type.String(), Answer),
			replay: "safe",
			execute: async ({ state, questions }, _api, context) => {
				const asked = Object.fromEntries(
					Object.entries(questions).map(([id, question]): [string, ClassifierQuestion] => {
						switch (question.type) {
							case "bool":
								return [id, { type: "bool", instructions: question.instructions, criteria: { true: question.yes, false: question.no } }];
							case "choice":
								return [id, { type: "choice", instructions: question.instructions, criteria: question.options }];
							case "score":
								return [id, { type: "score", instructions: question.instructions, criteria: question.levels }];
						}
					}),
				);
				const result = await deps.classify(state as JsonObject, asked, context);
				if (!result.ok) throw new Error(`Classifier failed: ${result.error}`);
				return { structuredOutput: result.answers as unknown as JsonValue };
			},
		}),
	];
}
