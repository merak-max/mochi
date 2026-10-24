import { createInterface } from "node:readline";
import type { Terminal } from "./client.ts";

/** Each stdin line, or the one prompt, goes to main. Its bubbles print, and the next line waits for its Turn to end. */
export async function runLines(terminal: Terminal, prompt: string | undefined): Promise<void> {
	let lineDone = (): void => {};
	let failure: string | undefined;
	terminal.onFrame = (frame) => {
		if (frame.t === "bubble") process.stdout.write(`mochi> ${frame.text}\n`);
		if (frame.t === "error") failure = frame.error;
		if (frame.t === "done" || frame.t === "error") lineDone();
	};
	void terminal.closed.then(() => {
		failure ??= "The daemon closed the connection.";
		lineDone();
	});
	for await (const raw of prompt === undefined ? createInterface({ input: process.stdin, terminal: false }) : [prompt]) {
		const text = raw.trim();
		if (text === "") continue;
		const done = new Promise<void>((resolve) => {
			lineDone = resolve;
		});
		terminal.send(text);
		await done;
		if (failure !== undefined) throw new Error(failure);
	}
}
