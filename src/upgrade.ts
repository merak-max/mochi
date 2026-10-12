import type { Context } from "@earendil-works/chord";
import type { JsonValue } from "@earendil-works/chord";
import { type ConversationId, defineDoc, defineDocFamily, LiveDoc, ROOT_CONVERSATION_ID, type Storage, type SubmissionId } from "@earendil-works/pi-durable";
import { CodemodeStoreDoc } from "@earendil-works/pi-durable/codemode";
import type { ChannelId } from "./channels/types.ts";
import { allPages } from "./pages.ts";
import { seatRoot } from "./seats.ts";
import { addTrigger, type TriggerTask } from "./triggers/trigger.ts";
import type { Trigger } from "./triggers/types.ts";
import { type Line, openTurn } from "./turn/turn.ts";

// Boot steps that convert live data written by older code. Each runs before `harness.resume()` and is idempotent: the
// old form retires in the commit that writes the new one, so a second boot finds nothing to do.

export interface UpgradeStep {
	readonly unit: string;
	readonly name: string;
	run(host: { readonly storage: Storage; readonly line: Line; readonly trigger: TriggerTask }, context: Context): Promise<{ readonly changed: number }>;
}

type Route = { submissionId: SubmissionId; channel: ChannelId; messageId: string; recorded: boolean };
const RouteDoc = defineDocFamily<Route, Route>({ kind: "mochi.route", version: 1, scope: "session", family: true, initial: (seed) => seed });
const OutboxDoc = defineDoc<{ pending: SubmissionId[] }>({ kind: "mochi.outbox", version: 1, scope: "session", initial: () => ({ pending: [] }) });

/**
 * Each answer still pending in the Router's `mochi.outbox` becomes an owner Turn. Its `run` phase submits under the
 * stored request key, so admission returns the original submission and the Turn delivers its answer. Then the outbox
 * and every `mochi.route` member retire.
 */
export const outboxToTurns: UpgradeStep = {
	unit: "U5",
	name: "outbox-to-turns",
	async run({ storage, line }, context) {
		const { harness } = line;
		const query = { scope: { kind: "session" }, at: "current", kind: RouteDoc.definition.kind } as const;
		const keys = (await allPages((cursor) => storage.scanDocuments(query, 256, cursor, context))).flatMap((record) => record.key ?? []);
		const outbox = await harness.snapshot(OutboxDoc, context);
		if (outbox === undefined && keys.length === 0) return { changed: 0 };
		const routes = new Map<string, Readonly<Route>>();
		for (const key of keys) {
			const route = await harness.snapshot(RouteDoc, key, context);
			if (route !== undefined) routes.set(key, route);
		}
		return harness.commit(async (tx) => {
			let changed = 0;
			for (const id of outbox?.pending ?? []) {
				const route = routes.get(String(id));
				if (route === undefined || route.channel === "cli") continue;
				const key = `${route.channel}:${route.messageId}`;
				await openTurn(tx, line, { source: "owner", channel: route.channel, key, tag: "", text: "", files: [] });
				changed++;
			}
			if (outbox !== undefined) await tx.retireDoc(OutboxDoc);
			for (const key of keys) await tx.retireDoc(RouteDoc, key);
			return { changed: changed + keys.length + (outbox === undefined ? 0 : 1) };
		}, context);
	},
};

/** Root predates seats; this runs every boot and changes nothing once root holds the owner seat. */
export const rootSeat: UpgradeStep = {
	unit: "U6",
	name: "root-seat",
	run: ({ line }, context) => line.harness.commit(async (tx) => ({ changed: (await seatRoot(tx)) ? 1 : 0 }), context),
};

type LegacyTrigger = { trigger: Trigger; origin: "config" | "model"; conversationId: ConversationId | null; last: { result: string } | null };
export const TriggersDoc = defineDoc<{ items: Record<string, LegacyTrigger> }>({
	kind: "mochi.triggers",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ items: {} }),
});

/**
 * Each trigger in `mochi.triggers` becomes a trigger task with its origin, in its conversation when it had one; a once
 * trigger that already fired is spent. The document retires in the same commit.
 */
export const triggersToTasks: UpgradeStep = {
	unit: "U8",
	name: "triggers-to-tasks",
	async run({ line, trigger }, context) {
		const old = await line.harness.snapshot(TriggersDoc, ROOT_CONVERSATION_ID, context);
		if (old === undefined) return { changed: 0 };
		return line.harness.commit(async (tx) => {
			let changed = 1;
			for (const record of Object.values(old.items)) {
				if (record.trigger.kind === "once" && record.last !== null) continue;
				await addTrigger(tx, trigger, { trigger: record.trigger, origin: record.origin }, [], record.conversationId ?? undefined);
				changed++;
			}
			await tx.retireDoc(TriggersDoc, ROOT_CONVERSATION_ID);
			return { changed };
		}, context);
	},
};

const legacy = (kind: string) => defineDoc({ kind, version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({}) });
const AGENT_DOCS = [legacy("mochi.agents"), legacy("mochi.agent-depth")];

/**
 * Anchor and Reporter tasks have no definition now, so a live one would stay blocked forever; `abortTask` settles each
 * `orphaned`. Then every conversation's `mochi.agents` and `mochi.agent-depth` retire.
 */
export const drainAgentKinds: UpgradeStep = {
	unit: "U9",
	name: "drain-agent-kinds",
	async run({ storage, line: { harness } }, context) {
		let changed = 0;
		for (const kind of ["mochi.agent-anchor", "mochi.agent-reporter"]) {
			const tasks = await allPages((cursor) => harness.commit((tx) => tx.scanTasks({ kind }, 256, cursor), context));
			for (const task of tasks.filter((task) => task.state.status !== "terminal")) {
				await harness.abortTask(task.id, context);
				changed++;
			}
		}
		for (const { id } of await allPages((cursor) => storage.scanConversations({}, 256, cursor, context))) {
			for (const doc of AGENT_DOCS) {
				if ((await harness.snapshot(doc, id, context)) === undefined) continue;
				await harness.commit((tx) => tx.retireDoc(doc, id), context);
				changed++;
			}
		}
		return { changed };
	},
};

/** A nightly checkpoint turn of the deleted rollover would resume and answer into root; its run is aborted instead. */
export const retireRollover: UpgradeStep = {
	unit: "U10",
	name: "retire-rollover",
	async run({ line: { harness, root } }, context) {
		const run = (await harness.snapshot(LiveDoc, root.id, context))?.run;
		for (const id of run?.inputs ?? []) {
			const record = await (await harness.submission(id, context))?.status(context);
			if (record?.requestId?.startsWith("rollover:") !== true) continue;
			await harness.abortTask(run!.taskId, context);
			return { changed: 1 };
		}
		return { changed: 0 };
	},
};

const OldStoreDoc = defineDoc<{ values: { [key: string]: JsonValue } }>({ kind: "mochi.codemode-store", version: 1, scope: "conversation", history: "latest", fork: "current", initial: () => ({ values: {} }) });

/**
 * mochi's own `code` tool gave way to pi-durable's `codemode`. A live `mochi.call` task has no definition now, so
 * `abortTask` settles it `orphaned`. Each conversation's `mochi.codemode-store` values move to `pi.codemode.store`,
 * and the old document retires in the same commit.
 */
export const codeToCodemode: UpgradeStep = {
	unit: "U13",
	name: "code-to-codemode",
	async run({ storage, line: { harness } }, context) {
		let changed = 0;
		const calls = await allPages((cursor) => harness.commit((tx) => tx.scanTasks({ kind: "mochi.call" }, 256, cursor), context));
		for (const task of calls) {
			if (task.state.status === "terminal") continue;
			await harness.abortTask(task.id, context);
			changed++;
		}
		for (const { id } of await allPages((cursor) => storage.scanConversations({}, 256, cursor, context))) {
			const old = await harness.snapshot(OldStoreDoc, id, context);
			if (old === undefined) continue;
			await harness.commit(async (tx) => {
				const store = await tx.doc(CodemodeStoreDoc, id);
				for (const [key, value] of Object.entries(old.values)) {
					if (!Object.hasOwn(store.values, key)) store.values[key] = value;
				}
				await tx.retireDoc(OldStoreDoc, id);
			}, context);
			changed++;
		}
		return { changed };
	},
};

/** In unit order. */
export const UPGRADES: readonly UpgradeStep[] = [outboxToTurns, rootSeat, triggersToTasks, drainAgentKinds, retireRollover, codeToCodemode];
