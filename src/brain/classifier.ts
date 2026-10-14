import type { Context } from "@earendil-works/chord";
import type { ClassifierAnswer, ClassifierQuestion, JsonObject, Models } from "@earendil-works/pi-ai";
import type { ModelRef } from "@earendil-works/pi-durable";


export type Classified = { readonly ok: true; readonly answers: Readonly<Record<string, ClassifierAnswer>> } | { readonly ok: false; readonly error: string };

/** Answers typed questions about JSON state with the `[models] classifier` model. Never throws. */
export type Classify = (state: JsonObject, questions: Readonly<Record<string, ClassifierQuestion>>, context: Context) => Promise<Classified>;

export function createClassify(models: Models, classifier: ModelRef | undefined): Classify {
	return async (state, questions, context) => {
		if (classifier === undefined) return { ok: false, error: "No classifier: set [models] classifier to a model on a provider with api \"classifier\"." };
		const model = models.getModelOfType("classifier", classifier.provider, classifier.modelId);
		if (model === undefined) return { ok: false, error: `Classifier ${classifier.provider}/${classifier.modelId} is not configured.` };
		const signal = context.abortSignal;
		const result = await models.classify(model, { state, questions: { ...questions } }, signal === undefined ? {} : { signal });
		if (result.stopReason !== "stop") return { ok: false, error: result.errorMessage ?? result.stopReason };
		return { ok: true, answers: result.answers };
	};
}

export type ClassifyStep = { readonly question: string; readonly yes: string; readonly no: string; readonly threshold?: number };

/** P(yes) for one yes/no question over `state`. A classifier failure throws, so a broken gate shows instead of passing. */
export async function classifyYes(classify: Classify, step: ClassifyStep, state: JsonObject, context: Context): Promise<number> {
	const result = await classify(state, { gate: { type: "bool", instructions: step.question, criteria: { true: step.yes, false: step.no } } }, context);
	if (!result.ok) throw new Error(`classify step failed: ${result.error}`);
	const answer = result.answers.gate;
	if (answer?.type !== "bool") throw new Error("classify step got no yes/no answer.");
	return answer.probability;
}
