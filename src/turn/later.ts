import type { EntryId } from "@earendil-works/pi-durable";
import type { LaterMessage } from "../channels/types.ts";
import { commandOf } from "./commands.ts";

/** The longest the Photon check may take before a reply goes out unchecked. */
export const LATER_CHECK_MS = 1_500;
/** The longest a reply waits for a newer message to reach mochi before it goes out after all. */
export const LATER_WAIT_MS = 15_000;
export const LATER_POLL_MS = 250;

/** What mochi knows about a newer message: no submission yet, or the answer its submission got. */
export type Known = { readonly kind: "missing" } | { readonly kind: "submitted"; readonly answer: EntryId | undefined };

/**
 * The request keys of newer messages that this answer does not cover. A message is covered when its submission was
 * answered by the same answer entry, because it reached the run before the run ended. Commands never get a model answer.
 */
export function uncovered(later: readonly LaterMessage[], ownId: string, keyOf: (id: string) => string, known: (key: string) => Known, answer: EntryId): string[] {
	const out: string[] = [];
	for (const message of later) {
		if (message.id === ownId) continue;
		if (commandOf(message.text) !== undefined) continue;
		const key = keyOf(message.id);
		const state = known(key);
		if (state.kind === "submitted" && state.answer === answer) continue;
		out.push(key);
	}
	return out;
}
