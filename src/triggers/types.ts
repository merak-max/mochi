import { type Static, Type } from "typebox";

const Id = Type.String({ pattern: "^[a-z0-9]+(-[a-z0-9]+)*$", maxLength: 64 });

export const WebhookAuthSchema = Type.Union([
	// GitHub: X-Hub-Signature-256
	Type.Object({ kind: Type.Literal("hmac-sha256"), header: Type.String({ minLength: 1 }), secret: Type.String({ minLength: 16 }) }),
	Type.Object({ kind: Type.Literal("bearer"), token: Type.String({ minLength: 16 }) }),
]);
export type WebhookAuth = Static<typeof WebhookAuthSchema>;

/**
 * A yes/no question a classifier model answers before an Opus step. It passes when P(yes) reaches `threshold`.
 * A classifier error passes too: a gate may save a run, never lose one.
 */
export const GateSchema = Type.Object({
	question: Type.String({ minLength: 1, maxLength: 500 }),
	yes: Type.String({ minLength: 1, maxLength: 300 }),
	no: Type.String({ minLength: 1, maxLength: 300 }),
	threshold: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 1 })),
});
export type Gate = Static<typeof GateSchema>;

const Prompt = Type.String({ minLength: 1 });
/** Checked by the classifier against each `notify` text of the trigger's runs. */
const NotifyWhen = Type.Optional(GateSchema);
/** Who the trigger's `notify` reaches, by id: user1 is the owner, user2 and up are configured users. Absent: ["user1"]. */
const Notify = Type.Optional(Type.Array(Type.String({ pattern: "^user[0-9]+$" }), { minItems: 1 }));
/** The run's model: a tier (fast, default, strongest), an alias from agents/models.json, or provider/id. Absent: the role's, else fast. */
const Model = Type.Optional(Type.String({ minLength: 1 }));
/** An agents/<role>.md type: its instructions join the run's, and its model and thinking are the run's defaults. */
const Role = Type.Optional(Type.String({ pattern: "^[a-z0-9]+(-[a-z0-9]+)*$" }));
/**
 * A host command (argv, no shell) run before a cron slot, outside the jail, like a systemd unit the owner wrote. Empty
 * stdout or a non-zero exit skips the slot with no model call; otherwise stdout is the run's payload. Config only: the
 * model cannot add one with trigger_add.
 */
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
		/** Checked against each delivery's payload; a delivery that fails it is acknowledged and never runs. */
		admitWhen: Type.Optional(GateSchema),
		notifyWhen: NotifyWhen,
		notify: Notify,
		model: Model,
		role: Role,
		thinking: Thinking,
	}),
]);
export type Trigger = Static<typeof TriggerSchema>;

/** Trigger seeds under `triggers` in data/config.json. */
export const SeedsSchema = Type.Array(TriggerSchema);

