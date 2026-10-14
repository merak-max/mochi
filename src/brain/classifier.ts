import type { Context } from "@earendil-works/chord";
import type { ClassifierAnswer, ClassifierQuestion, JsonObject, Models } from "@earendil-works/pi-ai";
import type { Gate } from "../triggers/types.ts";

/** TypeSafe Jev through OpenRouter: ~300 ms and ~$0.00002 per call in a live probe on 2026-10-05. */
export const JEV = { provider: "openrouter", modelId: "typesafe/jev-1.13" } as const;
const DEFAULT_THRESHOLD = 0.5;

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

type GateVerdict =
	| { readonly kind: "pass"; readonly probability: number }
	| { readonly kind: "block"; readonly probability: number }
	| { readonly kind: "failed-open"; readonly error: string };

/** Whether the gated work goes ahead. A failed classifier admits: a gate never loses a delivery. */
export function admits(verdict: GateVerdict): verdict is Exclude<GateVerdict, { kind: "block" }> {
	return verdict.kind !== "block";
}

/** One bool question over `state`. Fails open: a classifier error passes, with the error kept for the log. */
export async function checkGate(classify: Classify, gate: Gate, state: JsonObject, context: Context): Promise<GateVerdict> {
	const result = await classify(state, { gate: { type: "bool", instructions: gate.question, criteria: { true: gate.yes, false: gate.no } } }, context);
	if (!result.ok) return { kind: "failed-open", error: result.error };
	const answer = result.answers.gate;
	if (answer?.type !== "bool") return { kind: "failed-open", error: "classifier returned no bool answer" };
	const probability = answer.probability;
	return probability >= (gate.threshold ?? DEFAULT_THRESHOLD) ? { kind: "pass", probability } : { kind: "block", probability };
}
