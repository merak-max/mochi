import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { newFaux, openTestMochi, tempDir } from "../test-support.ts";
import { forgetNote, memoryAsOf, readMemory, writeNote } from "./memory.ts";
import { publishNext, RepoDoc, type CrashWindow } from "./publication.ts";
import { MemoryGit, renderRepo } from "./repo.ts";

const draft = (body: string) => ({ slug: "dog", kind: "fact" as const, subject: "Dog", body });
async function setup() {
	const dir = await tempDir();
	const repo = join(dir, "memory");
	const mochi = await openTestMochi(dir, newFaux(), undefined, undefined, undefined, { memory: { repo } });
	await publishNext(mochi.harness, context);
	return { dir, repo, mochi };
}
test("conformant deterministic files retain complete escaped multiline content and metadata", () => {
	const memory = { notes: { dog: { ...draft("Biscuit\n[body metadata]\n\n- exact"), writtenBy: "mochi" as const, updated: "2026-10-05", source: { conversation: 1, entry: 42 } } } };
	const files = renderRepo(memory);
	assert.match(files["MEMORY.md"]!, /## Index\n\n- \[\[fact\/dog\]\] Dog \(fact\)/);
	assert.equal(files["fact/dog.md"], '# Dog\n\n- Biscuit\\n[body metadata]\\n\\n- exact [source: mochi://conversation/1/entry/42; added: 2026-10-05]\n');
	assert.deepEqual(renderRepo(memory), files);
});

for (const window of ["intent", "objects", "ref", "worktree", "accepted"] satisfies CrashWindow[]) {
	test(`SQLite reopen after ${window} preserves exact revision and one local commit`, async () => {
		const { dir, repo, mochi } = await setup();
		await mochi.harness.commit((tx) => writeNote(tx, draft("Biscuit"), undefined, "2026-10-05", "first"), context);
		await assert.rejects(publishNext(mochi.harness, context, async (at) => { if (at === window) throw new Error("simulated crash"); }), /simulated crash/);
		await mochi.harness.commit((tx) => writeNote(tx, draft("Pancake"), undefined, "2026-10-06", "second"), context);
		await mochi.close();
		const reopened = await openTestMochi(dir, newFaux(), undefined, undefined, undefined, { memory: { repo } });
		while (await publishNext(reopened.harness, context) !== "empty") {}
		assert.equal(await new MemoryGit(repo).git(["rev-list", "--count", "HEAD"]), "3");
		const commits = (await new MemoryGit(repo).git(["rev-list", "--reverse", "HEAD"])).split("\n");
		assert.match(await new MemoryGit(repo).git(["show", `${commits[1]}:fact/dog.md`]), /Biscuit/);
		assert.match(await readFile(join(repo, "fact/dog.md"), "utf8"), /Pancake/);
		assert.equal((await reopened.harness.snapshot(RepoDoc, context))?.queue.length, 0);
		assert.equal(await new MemoryGit(repo).git(["remote"]), "");
		await reopened.close();
	});
}
for (const window of ["intent", "objects", "ref", "worktree", "accepted"]) {
	test(`SIGKILL at ${window} recovers deterministic publication and released advisory lock`, async () => {
		const dir = await tempDir();
		const fixture = join(import.meta.dirname, "fixtures/crash.ts");
		const first = spawnSync(process.execPath, [fixture, dir, window], { encoding: "utf8", timeout: 50_000 });
		assert.equal(first.signal, "SIGKILL", first.stderr);
		const second = spawnSync(process.execPath, [fixture, dir, "recover"], { encoding: "utf8", timeout: 50_000 });
		assert.equal(second.status, 0, second.stderr);
		assert.deepEqual(JSON.parse(second.stdout.trim().split("\n").at(-1)!), { count: "2", published: 2, pending: null });
	});
}
test("direct and concurrent edits queue individually; replay after later edit never overwrites it", async () => {
	const { repo, mochi } = await setup();
	await Promise.all([
		mochi.harness.commit((tx) => writeNote(tx, draft("first"), undefined, "2026-10-05", "edit-1"), context),
		mochi.harness.commit((tx) => writeNote(tx, draft("second"), undefined, "2026-10-05", "edit-2"), context),
	]);
	const receipt = await mochi.harness.commit((tx) => writeNote(tx, draft("first"), undefined, "2026-10-05", "edit-1"), context);
	assert.equal(receipt.body, "first");
	assert.equal((await readMemory(mochi.harness, context)).notes.dog?.body, "second");
	assert.equal((await mochi.harness.snapshot(RepoDoc, context))?.queue.length, 2);
	while (await publishNext(mochi.harness, context) !== "empty") {}
	await mochi.harness.commit((tx) => forgetNote(tx, "dog", "forget-1"), context);
	await publishNext(mochi.harness, context);
	assert.equal(await new MemoryGit(repo).git(["rev-list", "--count", "HEAD"]), "4");
	assert.deepEqual(await new MemoryGit(repo).tree(await new MemoryGit(repo).head()), { "MEMORY.md": (await new MemoryGit(repo).tree(await new MemoryGit(repo).head()))["MEMORY.md"] });
	await mochi.close();
});
test("dirty owned, unrelated, staged files and foreign branches block without overwrite", async () => {
	const { repo, mochi } = await setup();
	await mochi.harness.commit((tx) => writeNote(tx, draft("first"), undefined, "2026-10-05"), context);
	await publishNext(mochi.harness, context);
	await mochi.harness.commit((tx) => writeNote(tx, draft("second"), undefined, "2026-10-05"), context);
	const dog = join(repo, "fact/dog.md");
	const original = await readFile(dog, "utf8");
	await writeFile(dog, "human");
	await assert.rejects(publishNext(mochi.harness, context), /Dirty/);
	assert.equal(await readFile(dog, "utf8"), "human");
	await writeFile(dog, original);
	await writeFile(join(repo, "foreign.txt"), "keep me");
	await assert.rejects(publishNext(mochi.harness, context), /Dirty/);
	assert.equal(await readFile(join(repo, "foreign.txt"), "utf8"), "keep me");
	await mochi.close();
});
test("foreign branch and staged content refuse publication without accepting the foreign index", async () => {
	const { repo, mochi } = await setup();
	await mochi.harness.commit((tx) => writeNote(tx, draft("one"), undefined, "2026-10-05"), context);
	await publishNext(mochi.harness, context);
	await mochi.harness.commit((tx) => writeNote(tx, draft("two"), undefined, "2026-10-05"), context);
	const git = new MemoryGit(repo);
	await git.git(["symbolic-ref", "HEAD", "refs/heads/foreign"]);
	await assert.rejects(publishNext(mochi.harness, context), /Foreign|HEAD|Detached/);
	await git.git(["symbolic-ref", "HEAD", "refs/heads/main"]);
	await writeFile(join(repo, "fact/dog.md"), "human staged");
	await git.git(["add", "--", "fact/dog.md"]);
	await assert.rejects(publishNext(mochi.harness, context), /Dirty/);
	assert.equal(await readFile(join(repo, "fact/dog.md"), "utf8"), "human staged");
	await mochi.close();
});
test("pending publication recovers an abandoned app-owned private-index lock", async () => {
	const { repo, mochi } = await setup();
	await mochi.harness.commit((tx) => writeNote(tx, draft("second"), undefined, "2026-10-05"), context);
	await assert.rejects(publishNext(mochi.harness, context, async (at) => { if (at === "ref") throw new Error("crash"); }), /crash/);
	await writeFile(join(repo, ".git", "mochi-index.lock"), "abandoned");
	try {
		await publishNext(mochi.harness, context);
		assert.equal(await new MemoryGit(repo).git(["status", "--porcelain"]), "");
		assert.equal((await mochi.harness.snapshot(RepoDoc, context))?.pending, null);
	} finally { await mochi.close(); }
});
test("pending publication refuses third-value edits after ref movement", async () => {
	const { repo, mochi } = await setup();
	await mochi.harness.commit((tx) => writeNote(tx, draft("first"), undefined, "2026-10-05"), context);
	await publishNext(mochi.harness, context);
	await mochi.harness.commit((tx) => writeNote(tx, draft("second"), undefined, "2026-10-05"), context);
	await assert.rejects(publishNext(mochi.harness, context, async (at) => { if (at === "ref") throw new Error("crash"); }), /crash/);
	await writeFile(join(repo, "fact/dog.md"), "human after crash");
	await assert.rejects(publishNext(mochi.harness, context), /Dirty memory file/);
	assert.equal(await readFile(join(repo, "fact/dog.md"), "utf8"), "human after crash");
	assert.notEqual((await mochi.harness.snapshot(RepoDoc, context))?.pending, null);
	await mochi.close();
});
test("native publisher consumes committed edits and note output distinguishes durable saving from Git", async () => {
	const dir = await tempDir();
	const repo = join(dir, "memory");
	const faux = newFaux();
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("codemode", { code: `return await tools.note(${JSON.stringify(draft("Biscuit"))});` }), { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	const mochi = await openTestMochi(dir, faux, undefined, undefined, undefined, { memory: { repo } });
	await (await mochi.root.submit({ type: "input", content: "Remember Biscuit." }, context)).wait(context);
	const task = (await mochi.harness.snapshot(RepoDoc, context))?.task;
	if (task !== null && task !== undefined) await mochi.harness.waitForTask(task, context);
	assert.equal((await mochi.harness.snapshot(RepoDoc, context))?.published, 2);
	assert.equal(await new MemoryGit(repo).git(["rev-list", "--count", "HEAD"]), "2");
	const result = (await mochi.root.entries({}, 50, undefined, context)).items.find((entry) => entry.kind === "pi.tool-result");
	assert.match(JSON.stringify(result?.model), /Durably saved; local Git (pending|published)/);
	await mochi.close();
});
test("advisory publisher lock excludes contenders and releases without deleting its file", async () => {
	const { repo, mochi } = await setup();
	const git = new MemoryGit(repo);
	let release = (): void => {};
	let acquired = (): void => {};
	const ready = new Promise<void>((accept) => { acquired = accept; });
	const gate = new Promise<void>((accept) => { release = accept; });
	const holder = git.lock(async () => { acquired(); await gate; });
	await ready;
	try {
		await assert.rejects(new MemoryGit(repo).lock(async () => {}), /lock is held/);
	} finally { release(); await holder; }
	await git.lock(async () => {});
	assert.equal(await readFile(join(repo, ".git", "mochi-publisher.lock"), "utf8"), "");
	await mochi.close();
});
test("unsafe root symlink and nonempty human directory refused", async () => {
	const dir = await tempDir();
	await mkdir(join(dir, "human"));
	await writeFile(join(dir, "human", "notes.md"), "owner");
	await assert.rejects(new MemoryGit(join(dir, "human")).init(), /Nonempty/);
	await (await import("node:fs/promises")).symlink(join(dir, "human"), join(dir, "link"));
	await assert.rejects(new MemoryGit(join(dir, "link")).init(), /symlink/);
});
test("passive memory anchor supports date rewind without a root model call", async () => {
	const mochi = await openTestMochi(await tempDir(), newFaux());
	await mochi.harness.commit((tx) => writeNote(tx, draft("before"), undefined, "2026-10-05"), context);
	const at = new Date().toISOString();
	await new Promise((resolve) => setTimeout(resolve, 5));
	await mochi.harness.commit((tx) => writeNote(tx, draft("after"), undefined, "2026-10-05"), context);
	assert.equal((await memoryAsOf(mochi.harness, at, context)).notes.dog?.body, "before");
	assert.equal((await mochi.root.entries({}, 100, undefined, context)).items.filter((entry) => entry.model !== undefined).length, 0);
	await mochi.close();
});
