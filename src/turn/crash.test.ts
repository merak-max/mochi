import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { tempDir } from "../test-support.ts";

const FIXTURE = join(import.meta.dirname, "fixtures", "crash.ts");
const A = ["A first bubble.", "A second bubble.", "A third bubble."];
const N = ["N first bubble.", "N second bubble."];

type Summary = { sent: string[]; turns: string[]; records: number; inputs: unknown[]; modelCalls: number; cursor: number | null };

/** One life killed at `kill`, then one life that runs to the end. */
async function crashAt(scenario: string, kill: string): Promise<Summary> {
	const dir = await tempDir();
	const life = (point: string) => spawnSync(process.execPath, [FIXTURE, dir, scenario, point], { encoding: "utf8", timeout: 50_000 });
	const killed = life(kill);
	assert.equal(killed.signal, "SIGKILL", `the first life dies at ${kill}: ${killed.stderr}`);
	const last = life("none");
	assert.equal(last.status, 0, last.stderr);
	return JSON.parse(last.stdout.trim().split("\n").at(-1)!) as Summary;
}

const cases: readonly { scenario: string; kill: string; sent: readonly string[]; records?: number }[] = [
	{ scenario: "owner", kill: "ingest-commit", sent: A },
	{ scenario: "owner", kill: "submit", sent: A },
	{ scenario: "owner", kill: "settled", sent: A },
	{ scenario: "owner", kill: "bubble-sent", sent: [A[0]!, ...A] },
	{ scenario: "owner", kill: "bubble-checkpoint", sent: A },
	{ scenario: "down", kill: "down-sleep", sent: A },
	{ scenario: "notify", kill: "notify-open", sent: N, records: 1 },
	{ scenario: "notify", kill: "record", sent: N, records: 1 },
	{ scenario: "ordered", kill: "between-turns", sent: [...A, "B first bubble.", "B second bubble."] },
];

for (const { scenario, kill, sent, records = 0 } of cases) {
	test(`a SIGKILL at ${kill} (${scenario}) still delivers every bubble once, in order`, async (t) => {
		const summary = await crashAt(scenario, kill);
		t.diagnostic(`kill ${kill}: sent=${JSON.stringify(summary.sent)} turns=${JSON.stringify(summary.turns)} records=${summary.records}`);
		assert.deepEqual(summary.sent, sent);
		assert.ok(summary.turns.every((result) => result === "sent"), JSON.stringify(summary.turns));
		assert.equal(summary.records, records);
		assert.equal(summary.cursor, scenario === "notify" ? null : scenario === "ordered" ? 2 : 1, "the cursor survives every kill with its Turn");
	});
}

test("ingest and the Turn's run phase submit byte-identical input for a message with an image", async (t) => {
	const healed = await crashAt("image", "ingest-commit");
	const dir = await tempDir();
	const control = spawnSync(process.execPath, [FIXTURE, dir, "image", "none"], { encoding: "utf8", timeout: 50_000 });
	const direct = JSON.parse(control.stdout.trim()) as Summary;
	t.diagnostic(`image input: ${JSON.stringify(healed.inputs).length} bytes from the run phase, ${JSON.stringify(direct.inputs).length} from ingest`);
	assert.equal(healed.inputs.length, 1);
	assert.deepEqual(healed.inputs, direct.inputs);
	assert.match(JSON.stringify(healed.inputs), /"type":"image"/);
});
