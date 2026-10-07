import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { CommitChange } from "@earendil-works/pi-durable";
import type { Apps } from "../apps/apps.ts";
import { SEATS } from "../seats.ts";
import { messageText } from "../text.ts";
import { newFaux, openTestMochi, tempDir, type TestMochi } from "../test-support.ts";
import { fingerprint } from "./code.ts";

async function runScript(code: string, apps: Apps, scriptDeadlineMs?: number): Promise<{ mochi: TestMochi; result: string; live: number[] }> {
	const faux = newFaux();
	faux.setResponses([fauxAssistantMessage(fauxToolCall("code", { code }), { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
	const mochi = await openTestMochi(await tempDir(), faux, new Map(), undefined, [], { apps, ...(scriptDeadlineMs === undefined ? {} : { scriptDeadlineMs }) });
	const live = new Set<number>();
	const counts: number[] = [];
	mochi.harness.subscribeCommits(({ changes }) => {
		for (const change of changes as readonly CommitChange[]) {
			if (change.type !== "task" || change.value.kind !== "mochi.call") continue;
			if (change.value.state.status === "terminal") live.delete(change.value.id);
			else live.add(change.value.id);
			counts.push(live.size);
		}
	});
	await (await mochi.root.submit({ type: "input", content: "go" }, context)).wait(context);
	const entry = (await mochi.root.entries({}, 100, undefined, context)).items.find((item) => item.kind === "pi.tool-result");
	return { mochi, result: entry?.model?.[0] === undefined ? "" : messageText(entry.model[0]), live: counts };
}

const unused = async (): Promise<never> => assert.fail("not called");

test("fifty nested calls in one Promise.all never have more than eight mochi.call tasks live", async (t) => {
	let inFlight = 0;
	let most = 0;
	const apps: Apps = {
		search: async (query) => {
			most = Math.max(most, ++inFlight);
			await sleep(10);
			inFlight--;
			return { items: [{ path: query, signature: "" }] };
		},
		call: unused,
		skills: unused,
	};
	const { mochi, result, live } = await runScript(`return (await Promise.all(Array.from({ length: 50 }, (_, i) => tools.apps_search({ query: "q" + i })))).length;`, apps);
	t.diagnostic(`most live mochi.call tasks ${Math.max(...live)}, most in Executor ${most}`);
	assert.equal(result, "Script completed.\n50");
	assert.equal(Math.max(...live), 8);
	assert.equal(most, 8);
	await mochi.close();
});

test("a script past its deadline aborts its live children and lists the once calls that completed", async () => {
	const aborted: string[] = [];
	const apps: Apps = {
		search: unused,
		call: async (path, _args, callContext) => {
			if (path === "gmail.send") return "sent";
			await new Promise((resolve) => callContext.abortSignal?.addEventListener("abort", resolve));
			aborted.push(path);
			throw new Error("aborted");
		},
		skills: unused,
	};
	const { mochi, result } = await runScript(`await tools.apps_call({ path: "gmail.send", args: {} }); return await tools.apps_call({ path: "slow.export", args: {} });`, apps, 300);
	assert.match(result, /^Script failed \(timeout\)\.[\s\S]*Completed before the error: apps_call ×1\.$/);
	const calls = (await mochi.harness.commit((tx) => tx.scanTasks({ kind: "mochi.call" }, 10), context)).items;
	assert.deepEqual(calls.map((task) => (task.state.status === "terminal" ? task.state.outcome.status : task.state.status)).sort(), ["aborted", "completed"]);
	assert.deepEqual(aborted, ["slow.export"]);
	await mochi.close();
});

test("every seat's code declares a return type per function and finds the rest with search()", async () => {
	const { mochi, result } = await runScript(`return await search("site map");`, { search: unused, call: unused, skills: unused });
	for (const seat of SEATS) {
		const description = mochi.registry.snapshot().extension(`seat-${seat}`)?.tools?.find((tool) => tool.name === "code")?.description ?? "";
		assert.match(description, /web_search\(args: \{ excludeDomains\?: Array<string>; includeDomains\?: Array<string>; limit\?: number; query: string; recency\?: [^}]*\}\): Promise<Array<\{ snippet: string; title: string; url: string; \}>>/);
		assert.match(description, /apps_search\(args: \{ query: string; \}\): Promise<\{ items: Array<\{ path: string; signature: string; \}>; \}>/);
		const tail = { owner: ", agent_send, agent_stop, agent_status, trigger_remove", run: ", trigger_remove", worker: "" }[seat];
		assert.ok(description.includes(`more functions: web_map, browse, browse_fast, image_gen, video_gen, speak, transcribe, classify, apps_skills${tail}.`));
		assert.equal(/trigger_add\(/.test(description), seat === "owner");
		assert.equal(/trigger_list\(/.test(description), seat !== "worker");
		assert.equal(/agent\(/.test(description) && /agent_start\(/.test(description), seat === "owner");
	}
	assert.match(result, /web_map\(args: \{ limit\?: number; search\?: string; url: string; \}\): Promise<Array<string>>/);
	assert.doesNotMatch(result, /classify/);
	await mochi.close();
});

test("a call's fingerprint ignores key order and separates arguments", () => {
	assert.equal(fingerprint("llm", { prompt: "a", system: "b" }), fingerprint("llm", { system: "b", prompt: "a" }));
	assert.notEqual(fingerprint("llm", { prompt: "a" }), fingerprint("llm", { prompt: "b" }));
	assert.notEqual(fingerprint("llm", { prompt: "a" }), fingerprint("web_fetch", { prompt: "a" }));
});
