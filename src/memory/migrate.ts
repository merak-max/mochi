import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { defineDoc, defineDocFamily, type Harness } from "@earendil-works/pi-durable";
import type { Log } from "../log.ts";

type KeptLines = { lines: { at: string; text: string }[]; blocks: Record<string, string> };

const empty = (): KeptLines => ({ lines: [], blocks: {} });

/** The lines root kept with the retired `note` tool. */
const MemoryLog = defineDoc<KeptLines>({ kind: "mochi.memory-log", version: 1, scope: "session", initial: empty, checkpointWhen: () => false });

/** The lines each profile kept with the retired `note` tool, by profile name. */
const ProfileMemoryLog = defineDocFamily<KeptLines, null>({ kind: "mochi.profile-memory", version: 1, scope: "session", family: true, initial: empty, checkpointWhen: () => false });

/**
 * Writes the lines kept with the retired `note` tool to `<memoryDir>/<owner>.md`, one line each, oldest first, then
 * retires the documents it wrote. Root's file is `root.md`. A file that exists is left as it is, so a second run writes nothing.
 * Delete this file once the live store has run it.
 */
export async function migrateKeptLines(harness: Harness, memoryDir: string, profiles: readonly string[], log: Log, context: Context): Promise<void> {
	const owners: { name: string; kept: KeptLines | undefined }[] = [{ name: "root", kept: await harness.snapshot(MemoryLog, context) }];
	for (const profile of profiles) owners.push({ name: profile, kept: await harness.snapshot(ProfileMemoryLog, profile, context) });
	const written: string[] = [];
	for (const { name, kept } of owners) {
		if (kept === undefined || kept.lines.length === 0) continue;
		const file = join(memoryDir, `${name}.md`);
		if (existsSync(file)) continue;
		await mkdir(memoryDir, { recursive: true });
		const lines = kept.lines.map((line) => `- ${line.at}: ${line.text.replace(/\s+/g, " ").trim()}`);
		await writeFile(file, `# What ${name} kept\n\n${lines.join("\n")}\n`);
		written.push(name);
	}
	await harness.commit(async (tx) => {
		for (const name of written) {
			if (name === "root") await tx.retireDoc(MemoryLog);
			else await tx.retireDoc(ProfileMemoryLog, name);
		}
	}, context);
	if (written.length > 0) log("memory.migrated", { files: written });
}
