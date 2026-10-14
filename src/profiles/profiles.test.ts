import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { parse } from "smol-toml";
import { homeAt } from "../home.ts";
import { tempDir } from "../test-support.ts";
import { profileFns, unitName } from "./profiles.ts";

test("profiles nest by path: create links each to its parent, update restarts the subtree, remove stops it bottom-up and archives", async (t) => {
	const root = homeAt(await tempDir());
	await mkdir(root.dir, { recursive: true });
	await writeFile(root.envFile, "ANTHROPIC_API_KEY=sk-test\nPHOTON_PROJECT_SECRET=never-copied\nMOCHI_A2A_PORT=8789\n");
	await writeFile(root.configFile, 'timeZone = "UTC"\n[models]\nbrain = "anthropic/claude-opus-5-5"\n');
	const calls: string[] = [];
	const unitDir = join(root.dir, "units");
	const fns = profileFns({ home: root, repo: "/repo", unitDir, systemctl: async (args) => (calls.push(args.join(" ")), args[0] === "is-active" ? "active" : "") });
	const tool = (name: string) => fns.find((each) => each.name === name)!;
	const call = async (name: string, args: object) => (await tool(name).execute(args as never, {} as ToolExecutionApi, context)).structuredOutput as Record<string, unknown>;
	if (process.platform !== "linux") return t.skip("systemd user units need Linux");

	await call("profile_create", { path: "poteto", instructions: "You are poteto, chief of staff." });
	await call("profile_create", { path: "poteto/relay", instructions: "You are relay, the mail officer.", models: { brain: "anthropic/claude-haiku-5-5" } });
	await assert.rejects(call("profile_create", { path: "poteto", instructions: "again" }), /exists/);
	await assert.rejects(call("profile_create", { path: "ghost/child", instructions: "x" }), /parent ghost does not exist/);

	const relay = homeAt(join(root.dir, "profiles", "poteto", "profiles", "relay"));
	const relayEnv = await readFile(relay.envFile, "utf8");
	assert.match(relayEnv, /ANTHROPIC_API_KEY=sk-test/);
	assert.doesNotMatch(relayEnv, /PHOTON/, "channel keys are never copied");
	const relayConfig = parse(await readFile(relay.configFile, "utf8")) as { models: { brain: string }; a2a: { peers: Record<string, { tokenEnv: string }> } };
	assert.equal(relayConfig.models.brain, "anthropic/claude-haiku-5-5");
	assert.deepEqual(Object.keys(relayConfig.a2a.peers), ["poteto"], "relay talks to its parent");
	const potetoConfig = parse(await readFile(join(root.dir, "profiles", "poteto", "config.toml"), "utf8")) as { a2a: { peers: Record<string, unknown> } };
	assert.deepEqual(Object.keys(potetoConfig.a2a.peers).sort(), ["parent", "relay"]);
	const rootConfig = parse(await readFile(root.configFile, "utf8")) as { a2a: { peers: Record<string, unknown> } };
	assert.deepEqual(Object.keys(rootConfig.a2a.peers), ["poteto"], "root links only to its child, never a grandchild");
	assert.equal(unitName(root, relay), "mochi-poteto--relay.service");
	assert.match(await readFile(join(unitDir, "mochi-poteto--relay.service"), "utf8"), new RegExp(`MOCHI_HOME=${relay.dir}`));

	// A profile made before 2026-10-14 keeps its instructions in persona.md; listing renames it once.
	await rename(relay.instructionsFile, join(relay.dir, "persona.md"));
	const listed = (await call("profile_list", {})) as unknown as { path: string; state: string; brain: string; instructions: string }[];
	assert.deepEqual(listed.map((row) => [row.path, row.state, row.brain, row.instructions]), [["poteto", "active", "anthropic/claude-opus-5-5", "You are poteto, chief of staff."], ["poteto/relay", "active", "anthropic/claude-haiku-5-5", "You are relay, the mail officer."]]);
	assert.equal(existsSync(join(relay.dir, "persona.md")), false);

	calls.length = 0;
	const updated = await call("profile_update", { path: "poteto", config: '[models]\nfast = "anthropic/claude-haiku-5-5"' });
	assert.deepEqual(updated.restarted, ["poteto", "poteto/relay"]);

	calls.length = 0;
	const removed = await call("profile_remove", { path: "poteto" });
	assert.deepEqual(removed.stopped, ["poteto/relay", "poteto"], "children stop before their parent");
	assert.equal(existsSync(join(root.dir, "profiles", "poteto")), false);
	assert.deepEqual(await readdir(unitDir), [], "both units are removed");
	assert.equal((await readdir(join(root.dir, "profiles", ".archive"))).length, 1, "archived, not deleted");
	assert.doesNotMatch(await readFile(root.envFile, "utf8"), /poteto:/);
	await assert.rejects(call("profile_update", { path: "../etc", instructions: "x" }), /must match|pattern|must be lowercase/i);
});
