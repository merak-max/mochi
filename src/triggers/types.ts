import { type Static, Type } from "typebox";

export const Id = Type.String({ pattern: "^[a-z0-9]+(-[a-z0-9]+)*$", maxLength: 64 });

const WebhookAuthSchema = Type.Union([
	Type.Object({ kind: Type.Literal("hmac-sha256"), header: Type.String({ minLength: 1 }), secret: Type.String({ minLength: 16 }) }),
	Type.Object({ kind: Type.Literal("bearer"), token: Type.String({ minLength: 16 }) }),
]);
export type WebhookAuth = Static<typeof WebhookAuthSchema>;

const Thinking = Type.Union(["off", "low", "medium", "high", "xhigh", "max"].map((level) => Type.Literal(level)));

/** Stops the chain unless the classifier's P(yes) reaches `threshold` (default 0.5). `on: "output"` judges the notify text. */
const ClassifyStepSchema = Type.Object({
	classify: Type.Object({
		question: Type.String({ minLength: 1 }),
		yes: Type.String({ minLength: 1 }),
		no: Type.String({ minLength: 1 }),
		threshold: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
		on: Type.Optional(Type.Union([Type.Literal("input"), Type.Literal("output")])),
	}),
});
export const StepSchema = Type.Union([ClassifyStepSchema, Type.Object({ model: Type.Object({}) })]);
export type Step = Static<typeof StepSchema>;

/**
 * A run is the ordered `steps`; the `model` step is the run of `prompt` under `profile` (its instructions, model and
 * memory) or `model`. Without `steps` a trigger is the one model step, as every trigger was before steps.
 */
const RUN_FIELDS = {
	id: Id,
	prompt: Type.String({ minLength: 1 }),
	steps: Type.Optional(Type.Array(StepSchema, { minItems: 1 })),
	notify: Type.Optional(Type.Array(Type.String({ pattern: "^user[0-9]+$" }), { minItems: 1 })),
	model: Type.Optional(Type.String({ minLength: 1 })),
	profile: Type.Optional(Type.String({ pattern: "^[a-z0-9]+(-[a-z0-9]+)*$" })),
	/** The older name of `profile`, kept so stored triggers load unchanged. */
	role: Type.Optional(Type.String({ pattern: "^[a-z0-9]+(-[a-z0-9]+)*$" })),
	thinking: Type.Optional(Thinking),
};

export const TriggerSchema = Type.Union([
	Type.Object({ kind: Type.Literal("cron"), ...RUN_FIELDS, cron: Type.String(), tz: Type.String(), check: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })) }),
	Type.Object({ kind: Type.Literal("webhook"), ...RUN_FIELDS, auth: WebhookAuthSchema }),
]);
export type Trigger = Static<typeof TriggerSchema>;

export const stepsOf = (trigger: Trigger): readonly Step[] => trigger.steps ?? [{ model: {} }];
