import { type Static, Type } from "typebox";

export const Id = Type.String({ pattern: "^[a-z0-9]+(-[a-z0-9]+)*$", maxLength: 64 });

export const ProcName = Type.String({ pattern: "^[a-z0-9]+(-[a-z0-9]+)*$", maxLength: 40 });

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

/** When a schedule fires: each cron slot, once at a time, on each webhook delivery, or when a background process exits. */
export const WhenSchema = Type.Union([
	Type.Object({ cron: Type.String({ minLength: 1 }), tz: Type.String({ minLength: 1 }) }),
	Type.Object({ at: Type.String({ minLength: 1 }) }),
	Type.Object({ webhook: Type.Object({ auth: WebhookAuthSchema }) }),
	/** `watch`: also fire once when a log line first matches this regex. */
	Type.Object({ process: Type.Object({ name: ProcName, pid: Type.Integer(), watch: Type.Optional(Type.String({ minLength: 1 })) }) }),
]);
export type When = Static<typeof WhenSchema>;

/**
 * A run is the ordered `steps`; the `model` step is the run of `prompt` under `profile` (its instructions, model and
 * memory) or `model`. Without `steps` a schedule is the one model step. `check` runs first on a cron or at slot. A
 * process schedule fires into the conversation that started the process, with the prompt and the log tail.
 */
export const ScheduleSchema = Type.Object({
	id: Id,
	when: WhenSchema,
	prompt: Type.String({ minLength: 1 }),
	steps: Type.Optional(Type.Array(StepSchema, { minItems: 1 })),
	notify: Type.Optional(Type.Array(Type.String({ pattern: "^user[0-9]+$" }), { minItems: 1 })),
	model: Type.Optional(Type.String({ minLength: 1 })),
	profile: Type.Optional(Id),
	thinking: Type.Optional(Thinking),
	check: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
});
export type Schedule = Static<typeof ScheduleSchema>;

export const stepsOf = (schedule: Schedule): readonly Step[] => schedule.steps ?? [{ model: {} }];

export function describeWhen(when: When): string {
	if ("cron" in when) return `${when.cron} ${when.tz}`;
	if ("at" in when) return `at ${when.at}`;
	if ("webhook" in when) return `webhook (${when.webhook.auth.kind})`;
	return `process ${when.process.name}${when.process.watch === undefined ? "" : ` /${when.process.watch}/`}`;
}

const ENTRY_FIELDS = {
	id: Id,
	prompt: Type.String({ minLength: 1 }),
	steps: Type.Optional(Type.Array(StepSchema, { minItems: 1 })),
	notify: Type.Optional(Type.Array(Type.String({ pattern: "^user[0-9]+$" }), { minItems: 1 })),
	model: Type.Optional(Type.String({ minLength: 1 })),
	profile: Type.Optional(Id),
	thinking: Type.Optional(Thinking),
	check: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
};

/**
 * The flat shape of a `[[triggers]]` entry in config.toml and of a stored `mochi.trigger` task: `kind` names the when.
 */
export const TriggerEntrySchema = Type.Union([
	Type.Object({ kind: Type.Literal("cron"), ...ENTRY_FIELDS, cron: Type.String(), tz: Type.String() }),
	Type.Object({ kind: Type.Literal("at"), ...ENTRY_FIELDS, at: Type.String() }),
	Type.Object({ kind: Type.Literal("webhook"), ...ENTRY_FIELDS, auth: WebhookAuthSchema }),
]);
type TriggerEntry = Static<typeof TriggerEntrySchema>;

export function scheduleOfEntry(entry: TriggerEntry): Schedule {
	const when: When = entry.kind === "cron" ? { cron: entry.cron, tz: entry.tz } : entry.kind === "at" ? { at: entry.at } : { webhook: { auth: entry.auth } };
	const schedule: Schedule = { id: entry.id, when, prompt: entry.prompt };
	if (entry.steps !== undefined) schedule.steps = entry.steps;
	if (entry.notify !== undefined) schedule.notify = entry.notify;
	if (entry.model !== undefined) schedule.model = entry.model;
	if (entry.profile !== undefined) schedule.profile = entry.profile;
	if (entry.thinking !== undefined) schedule.thinking = entry.thinking;
	if (entry.check !== undefined) schedule.check = entry.check;
	return schedule;
}
