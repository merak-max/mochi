import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { tempDir } from "../test-support.ts";

const FIXTURE = join(import.meta.dirname, "fixtures", "script.ts");

type Summary = { effects: { op: string; args?: unknown }[]; result: string[]; calls: number; journal: string[]; agents: string[]; conversations: number; replay: string };

async function crashAt(scenario: string, kill: string): Promise<Summary> {
	const dir = await tempDir();
	const life = (point: string) => spawnSync(process.execPath, [FIXTURE, dir, scenario, point], { encoding: "utf8", timeout: 50_000 });
	const killed = life(kill);
	assert.equal(killed.signal, "SIGKILL", `the first life dies at ${kill}: ${killed.stderr}`);
	const last = life("none");
	assert.equal(last.status, 0, last.stderr);
	return JSON.parse(last.stdout.trim().split("\n").at(-1)!) as Summary;
}

const ops = (summary: Summary) => summary.effects.map((effect) => effect.op);

test("a SIGKILL inside a read call reruns that call only; earlier children are found by key, ids stay numbers", async (t) => {
	const summary = await crashAt("chain", "search-2");
	t.diagnostic(JSON.stringify(summary));
	assert.deepEqual(ops(summary), ["search", "search", "search", "call"]);
	assert.equal(summary.calls, 3);
	assert.match(summary.result[0]!, /^Script completed\.[\s\S]*"hit 1"[\s\S]*"hit 3"[\s\S]*"sent 1"/);
	assert.deepEqual(summary.journal, ["number"]);
	assert.equal(summary.replay, "safe");
});

test("a SIGKILL inside a once call reports it interrupted and never runs it again", async (t) => {
	const summary = await crashAt("chain", "call");
	t.diagnostic(JSON.stringify(summary));
	assert.deepEqual(ops(summary), ["search", "search", "call"]);
	assert.equal(summary.calls, 3);
	assert.match(summary.result[0]!, /^Script failed \(script\)\.[\s\S]*apps_call was interrupted and may have partially run/);
});

test("a SIGKILL after every child completed returns the recorded results without rerunning any", async (t) => {
	const summary = await crashAt("chain", "done");
	t.diagnostic(JSON.stringify(summary));
	assert.deepEqual(ops(summary), ["search", "search", "call"]);
	assert.equal(summary.calls, 3);
	assert.match(summary.result[0]!, /^Script completed\.[\s\S]*"hit 1"[\s\S]*"hit 2"[\s\S]*"sent 1"/);
});

test("a Promise.all fan-out with repeated calls replays onto the same six children and acts once per child", async (t) => {
	const summary = await crashAt("fanout", "fanout-3");
	t.diagnostic(JSON.stringify(summary));
	assert.deepEqual(
		summary.effects.map((effect) => JSON.stringify(effect.args)).sort(),
		['{"to":0}', '{"to":0}', '{"to":1}', '{"to":1}', '{"to":2}', '{"to":2}'],
	);
	assert.equal(summary.calls, 6);
	assert.match(summary.result[0]!, /^Script failed \(script\)\.[\s\S]*interrupted[\s\S]*Completed before the error: apps_call ×3\./);
});

test("a SIGKILL during a foreground agent call resumes onto the same agent task and child, and the answer returns once", async (t) => {
	const summary = await crashAt("agent", "agent-brief");
	t.diagnostic(JSON.stringify(summary));
	assert.deepEqual(summary.agents, ["terminal"]);
	assert.equal(summary.conversations, 3, "root, the line and one child");
	assert.deepEqual(summary.result, ["Script completed.\n2, 3, 5."]);
});
