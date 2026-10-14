import type { Context } from "@earendil-works/chord";
import type { ClassifierAnswer, ClassifierQuestion, JsonObject, Models } from "@earendil-works/pi-ai";

/** TypeSafe Jev through OpenRouter: ~300 ms and ~$0.00002 per call in a live probe on 2026-10-05. */
export const JEV = { provider: "openrouter", modelId: "typesafe/jev-1.13" } as const;

export type Classified = { readonly ok: true; readonly answers: Readonly<Record<string, ClassifierAnswer>> } | { readonly ok: false; readonly error: string };

/** Answers typed questions about JSON state with a small classifier model. Never throws. */
export type Classify = (state: JsonObject, questions: Readonly<Record<string, ClassifierQuestion>>, context: Context) => Promise<Classified>;

export function createClassify(models: Models): Classify {
	return async (state, questions, context) => {
		const model = models.getModelOfType("classifier", JEV.provider, JEV.modelId);
		if (model === undefined) return { ok: false, error: `Classifier ${JEV.provider}/${JEV.modelId} is not configured.` };
		const signal = context.abortSignal;
		const result = await models.classify(model, { state, questions: { ...questions } }, signal === undefined ? {} : { signal });
		if (result.stopReason !== "stop") return { ok: false, error: result.errorMessage ?? result.stopReason };
		return { ok: true, answers: result.answers };
	};
}

export type JevStep = { readonly question: string; readonly yes: string; readonly no: string; readonly threshold?: number };

/** P(yes) for one yes/no question over `state`. A classifier failure throws, so a broken gate shows instead of passing. */
export async function jevYes(classify: Classify, step: JevStep, state: JsonObject, context: Context): Promise<number> {
	const result = await classify(state, { gate: { type: "bool", instructions: step.question, criteria: { true: step.yes, false: step.no } } }, context);
	if (!result.ok) throw new Error(`jev step failed: ${result.error}`);
	const answer = result.answers.gate;
	if (answer?.type !== "bool") throw new Error("jev step got no yes/no answer.");
	return answer.probability;
}
