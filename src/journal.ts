import { defineDoc, type TaskId, type Tx } from "@earendil-works/pi-durable";

/** What a task created under each key, so a replayed call finds its child instead of creating a second one. */
const Journal = defineDoc<{ created: Record<string, TaskId> }>({
	kind: "mochi.journal",
	version: 1,
	scope: "task",
	initial: () => ({ created: {} }),
	checkpointWhen: () => false,
});

/**
 * Inside one commit: the task recorded under `key` on `owner`, or a new one from `create`, recorded in that commit.
 * `keep`: for a task that lives as long as the daemon, the most keys with this key's prefix (up to its first colon) to
 * hold; older ones are dropped. A rerun only ever repeats the newest.
 */
export async function journaled<R>(tx: Tx, owner: TaskId, key: string, create: () => Promise<TaskId<R>>, keep?: number): Promise<{ readonly id: TaskId<R>; readonly created: boolean }> {
	const journal = await tx.doc(Journal, owner);
	const found = journal.created[key];
	if (found !== undefined) return { id: found as TaskId<R>, created: false };
	const id = await create();
	journal.created[key] = id;
	if (keep !== undefined) {
		const prefix = `${key.split(":")[0]}:`;
		const same = Object.keys(journal.created).filter((each) => each.startsWith(prefix));
		for (const old of same.slice(0, Math.max(0, same.length - keep))) delete journal.created[old];
	}
	return { id, created: true };
}
