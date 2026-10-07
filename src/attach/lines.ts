import { createInterface } from "node:readline";
import type { AttachClient } from "./client.ts";

/**
 * Chat and print modes for scripts: each stdin line (or the one prompt) goes to root through `ingest` as channel
 * `cli`, one at a time, and its answer prints as `mochi> ...`. With `id`, line n is message `<id>:<n>`, so rerunning
 * the same script after a crash finds the same submissions and prints their answers instead of asking again. With
 * `json`, the root view's value and ops print as JSON lines instead, like pi-durable's example 19.
 */
export async function runLines(client: AttachClient, prompt: string | undefined, options: { readonly json: boolean; readonly id?: string }): Promise<void> {
	const print = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
	const root = (await client.request({ op: "conversations" })).find((summary) => summary.label === "main");
	if (root === undefined) throw new Error("The daemon has no root conversation.");
	if (options.json) {
		client.onViewFrame = (frame) => print(frame.t === "view" ? { view: frame.value } : { ops: frame.ops });
		await client.request({ op: "show", conversationId: root.id });
	}
	let line = 0;
	for await (const raw of prompt === undefined ? createInterface({ input: process.stdin, terminal: false }) : [prompt]) {
		const text = raw.trim();
		if (text === "") continue;
		line++;
		const { submissionId } = await client.request({
			op: "submit",
			conversationId: root.id,
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
