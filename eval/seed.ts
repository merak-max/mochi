// Lays out a clean data directory for one scenario. Run under eval/clock.ts so seeded tags and entries sit in the past
// of the scenario's own clock: node --import ./eval/clock.ts eval/seed.ts <dataDir> <scenario>
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { indexOnce } from "../src/memory/feed.ts";
import { addTrigger } from "../src/triggers/trigger.ts";
import { newFaux, openTestMochi, recordingChannel, turnsSettled } from "../src/test-support.ts";
import { ingest } from "../src/turn/turn.ts";
import { type Ago, type Scenario, scenario as byId, TIME_ZONE } from "./scenarios.ts";

/** Milliseconds to add to the real clock so it reads `at` (owner-local, Asia/Kolkata). */
export function skewFor(at: string, now = Date.now()): number {
	return Date.parse(`${at.replace(" ", "T")}:00+05:30`) - now;
}

export function agoMs(ago: Ago): number {
	const amount = Number(ago.slice(0, -1));
	const unit = ago.slice(-1);
	return amount * (unit === "d" ? 86_400_000 : unit === "h" ? 3_600_000 : 60_000);
}

/**
 * Config with the owner's zone, work files, a model-made trigger if the scenario fires one, and past turns replayed on
 * a scripted model: notes go through the real notes tool, then an optional reset with the handoff.
 */
export async function seed(dataDir: string, scenario: Scenario): Promise<void> {
	const now = Date.now();
	await mkdir(join(dataDir, "work"), { recursive: true });
	for (const [path, text] of Object.entries(scenario.files ?? {})) {
		const file = join(dataDir, "work", path);
		await mkdir(dirname(file), { recursive: true });
		await writeFile(file, text);
		if (path.endsWith(".sh")) await chmod(file, 0o755);
	}
	await writeFile(join(dataDir, "config.json"), `${JSON.stringify({ timeZone: TIME_ZONE }, null, 1)}\n`);

	const history = scenario.history ?? [];
	const faux = newFaux();
	faux.setResponses(
		history.flatMap((turn) => [
			...((turn.notes ?? []).length === 0
				? []
				: [fauxAssistantMessage((turn.notes ?? []).map((note) => fauxToolCall("note", { ...note })), { stopReason: "toolUse" })]),
			fauxAssistantMessage(turn.mochi),
		]),
	);
	const recorder = recordingChannel(scenario.channel);
	const channels = new Map([[scenario.channel, recorder.channel]]);
	const mochi = await openTestMochi(dataDir, faux, channels);
	for (const [n, turn] of history.entries()) {
		const id = await ingest(mochi.line, { kind: "message", channel: scenario.channel, messageId: `seed-${n}`, text: turn.owner, at: new Date(now - agoMs(turn.ago)), attachments: [] }, BACKGROUND_CONTEXT);
		await (await mochi.harness.submission(id, BACKGROUND_CONTEXT))?.wait(BACKGROUND_CONTEXT);
	}
	await turnsSettled(mochi.harness);
	if (scenario.handoff !== undefined) await mochi.root.reset(`[handoff from your previous context]\n${scenario.handoff}`, BACKGROUND_CONTEXT);
	await indexOnce(mochi.harness, mochi.index, BACKGROUND_CONTEXT);
	await mochi.close();
	const trigger = scenario.trigger;
	if (trigger !== undefined) {
		// Without a daemon the trigger waits, and drive.ts fires it.
		const local = await openTestMochi(dataDir, faux, channels, undefined, [], { scheduling: "local" });
		const at = new Date(now - 60_000).toISOString();
		await local.harness.commit((tx) => addTrigger(tx, local.trigger, { trigger: { kind: "once", id: trigger.id, at, prompt: trigger.prompt }, origin: "model" }, []), BACKGROUND_CONTEXT);
		await local.close();
	}
}

if (import.meta.main) {
	const [dataDir, id] = process.argv.slice(2);
	if (dataDir === undefined || id === undefined) throw new Error("Usage: node --import ./eval/clock.ts eval/seed.ts <dataDir> <scenario>");
	await seed(dataDir, byId(id));
}
