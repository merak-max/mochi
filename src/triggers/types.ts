import { type Static, Type } from "typebox";

export const Id = Type.String({ pattern: "^[a-z0-9]+(-[a-z0-9]+)*$", maxLength: 64 });

const WebhookAuthSchema = Type.Union([
	Type.Object({ kind: Type.Literal("hmac-sha256"), header: Type.String({ minLength: 1 }), secret: Type.String({ minLength: 16 }) }),
	Type.Object({ kind: Type.Literal("bearer"), token: Type.String({ minLength: 16 }) }),
]);
export type WebhookAuth = Static<typeof WebhookAuthSchema>;

const Thinking = Type.Union(["off", "low", "medium", "high", "xhigh", "max"].map((level) => Type.Literal(level)));

const RUN_FIELDS = {
	id: Id,
	prompt: Type.String({ minLength: 1 }),
	notify: Type.Optional(Type.Array(Type.String({ pattern: "^user[0-9]+$" }), { minItems: 1 })),
	model: Type.Optional(Type.String({ minLength: 1 })),
	role: Type.Optional(Type.String({ pattern: "^[a-z0-9]+(-[a-z0-9]+)*$" })),
	thinking: Type.Optional(Thinking),
};

export const TriggerSchema = Type.Union([
	Type.Object({ kind: Type.Literal("cron"), ...RUN_FIELDS, cron: Type.String(), tz: Type.String(), check: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })) }),
	Type.Object({ kind: Type.Literal("webhook"), ...RUN_FIELDS, auth: WebhookAuthSchema }),
]);
export type Trigger = Static<typeof TriggerSchema>;
