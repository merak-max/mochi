import { appendFileSync } from "node:fs";

export type Log = (event: string, fields?: Record<string, unknown>) => void;

let file: string | undefined;

/** Send log lines to `path` instead of stderr, so they do not draw over the terminal UI. */
export function setLogFile(path: string): void {
	file = path;
}

/** One JSON line per event on stderr; stdout stays free for the terminal. */
export const log: Log = (event, fields = {}) => {
	const line = `${JSON.stringify({ at: new Date().toISOString(), event, ...fields })}\n`;
	if (file === undefined) process.stderr.write(line);
	else appendFileSync(file, line);
};
