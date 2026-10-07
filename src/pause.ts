import { setTimeout as sleep } from "node:timers/promises";

/** Wait `ms`, or less if `signal` aborts first. Only the abort is swallowed. */
export async function pause(ms: number, signal?: AbortSignal): Promise<void> {
	try {
		await sleep(ms, undefined, signal === undefined ? {} : { signal });
	} catch (error) {
		if (!(error instanceof Error && error.name === "AbortError")) throw error;
	}
}
