import { createInterface } from "node:readline";
import type { AttachClient } from "./client.ts";
import type { Target } from "./protocol.ts";

export type LinesOptions = { readonly json: boolean; readonly id?: string; readonly to?: Target };

/** Each stdin line, or the one prompt, goes to `to` (default main); its answer prints. `json` prints that conversation's view frames instead. */
export async function runLines(client: AttachClient, prompt: string | undefined, options: LinesOptions): Promise<void> {
	const print = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
	const to = options.to ?? "main";
	if (options.json) {
		client.onViewFrame = (frame) => print(frame.t === "view" ? { view: frame.value } : { ops: frame.ops });
		await client.request({ op: "show", to });
	}
	let line = 0;
	for await (const raw of prompt === undefined ? createInterface({ input: process.stdin, terminal: false }) : [prompt]) {
		const text = raw.trim();
		if (text === "") continue;
		line++;
		const { submissionId } = await client.request({
			op: "submit",
			to,
			text,
			whenBusy: "steer",
			...(options.id === undefined ? {} : { messageId: `${options.id}:${line}` }),
		});
		const answer = await client.request({ op: "wait", submissionId });
		if (options.json) continue;
		if (answer.status === "done") process.stdout.write(`mochi> ${answer.text}\n`);
		else process.stdout.write(`mochi! unanswered: ${answer.reason}\n`);
	}
}
