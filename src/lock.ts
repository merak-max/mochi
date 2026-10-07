import { readFileSync, rmSync, writeFileSync } from "node:fs";

/** Take `path` for this process, or throw if another live process holds it. */
export function acquireLock(path: string): () => void {
	try {
		writeFileSync(path, String(process.pid), { flag: "wx" });
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
		const holder = Number(readFileSync(path, "utf8").trim());
		if (Number.isInteger(holder) && holder > 0 && holder !== process.pid && isAlive(holder)) {
			throw new Error(`Another mochi (pid ${holder}) owns ${path}.`);
		}
		writeFileSync(path, String(process.pid));
	}
	return () => rmSync(path, { force: true });
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error instanceof Error && "code" in error && error.code === "EPERM";
	}
}
