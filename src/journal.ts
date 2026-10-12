import { defineDoc, type TaskId, type Tx } from "@earendil-works/pi-durable";

/** What a task created under each key, so a replayed call finds its child instead of creating a second one. */
export const Journal = defineDoc<{ created: Record<string, TaskId> }>({
	kind: "mochi.journal",
	version: 1,
	scope: "task",
	initial: () => ({ created: {} }),
});

/** Inside one commit: the task recorded under `key` on `owner`, or a new one from `create`, recorded in that commit. */
export async function journaled<R>(tx: Tx, owner: TaskId, key: string, create: () => Promise<TaskId<R>>): Promise<{ readonly id: TaskId<R>; readonly created: boolean }> {
	const journal = await tx.doc(Journal, owner);
	const found = journal.created[key];
	if (found !== undefined) return { id: found as TaskId<R>, created: false };
	const id = await create();
	journal.created[key] = id;
	return { id, created: true };
}
