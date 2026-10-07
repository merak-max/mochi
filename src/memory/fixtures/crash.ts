import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { newFaux, openTestMochi } from "../../test-support.ts";
import { writeNote } from "../memory.ts";
import { type CrashWindow, publishNext, RepoDoc } from "../publication.ts";
import { MemoryGit } from "../repo.ts";

const dir = process.argv[2]!;
const window = process.argv[3]!;
const repo = join(dir, "memory");
const mochi = await openTestMochi(dir, newFaux(), undefined, undefined, undefined, { memory: { repo } });
if (window !== "recover") {
	await publishNext(mochi.harness, context);
	await mochi.harness.commit((tx) => writeNote(tx, { slug: "dog", kind: "fact", subject: "Dog", body: "Biscuit" }, undefined, "2026-10-05", "first"), context);
	await publishNext(mochi.harness, context, async (at: CrashWindow) => { if (at === window) process.kill(process.pid, "SIGKILL"); });
	throw new Error("Crash window was not reached");
}
while (await publishNext(mochi.harness, context) !== "empty") {}
const state = await mochi.harness.snapshot(RepoDoc, context);
const count = await new MemoryGit(repo).git(["rev-list", "--count", "HEAD"]);
await mochi.close();
process.stdout.write(JSON.stringify({ count, published: state?.published, pending: state?.pending }) + "\n");
