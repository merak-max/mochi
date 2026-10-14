import { type Static, Type } from "typebox";

export const Id = Type.String({ pattern: "^[a-z0-9]+(-[a-z0-9]+)*$", maxLength: 64 });

const WebhookAuthSchema = Type.Union([
	Type.Object({ kind: Type.Literal("hmac-sha256"), header: Type.String({ minLength: 1 }), secret: Type.String({ minLength: 16 }) }),
	Type.Object({ kind: Type.Literal("bearer"), token: Type.String({ minLength: 16 }) }),
]);
export type WebhookAuth = Static<typeof WebhookAuthSchema>;

export const GateSchema = Type.Object({
	question: Type.String({ minLength: 1, maxLength: 500 }),
	yes: Type.String({ minLength: 1, maxLength: 300 }),
	no: Type.String({ minLength: 1, maxLength: 300 }),
	threshold: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 1 })),
});
export type Gate = Static<typeof GateSchema>;

const Prompt = Type.String({ minLength: 1 });
const NotifyWhen = Type.Optional(GateSchema);
const Notify = Type.Optional(Type.Array(Type.String({ pattern: "^user[0-9]+$" }), { minItems: 1 }));
const Model = Type.Optional(Type.String({ minLength: 1 }));
const Role = Type.Optional(Type.String({ pattern: "^[a-z0-9]+(-[a-z0-9]+)*$" }));
const Check = Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }));
const Thinking = Type.Optional(Type.Union(["off", "low", "medium", "high", "xhigh", "max"].map((level) => Type.Literal(level))));

export const TriggerSchema = Type.Union([
	Type.Object({ kind: Type.Literal("cron"), id: Id, cron: Type.String(), tz: Type.String(), prompt: Prompt, notifyWhen: NotifyWhen, notify: Notify, model: Model, role: Role, thinking: Thinking, check: Check }),
	Type.Object({ kind: Type.Literal("once"), id: Id, at: Type.String({ format: "date-time" }), prompt: Prompt, notifyWhen: NotifyWhen, notify: Notify, model: Model, role: Role, thinking: Thinking }),
	Type.Object({
		kind: Type.Literal("webhook"),
		id: Id,
		auth: WebhookAuthSchema,
		prompt: Prompt,
		admitWhen: Type.Optional(GateSchema),
		notifyWhen: NotifyWhen,
		notify: Notify,
		model: Model,
		role: Role,
		thinking: Thinking,
	}),
]);
export type Trigger = Static<typeof TriggerSchema>;
