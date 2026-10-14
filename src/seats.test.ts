import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { AgentDoc, createRegistry, defineTool, Harness } from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { measureSurface } from "../eval/surface.ts";
import { BUDGET, createSeatConversation, FORBIDDEN_TOOL_NAME, SEATS, seatExtensions, selection } from "./seats.ts";
import { FAUX, newFaux, openTestMochi, tempDir } from "./test-support.ts";

test("each seat's request carries its tools within BUDGET; every agent conversation offers root's exact tools and prompt, and a user has no owner notes", async () => {
	const surfaces = await Promise.all(SEATS.map(async (seat) => [seat, await measureSurface(seat)] as const));
	const fresh = await measureSurface("agent", "new");
	const root = surfaces.find(([seat]) => seat === "agent")![1];
	assert.deepEqual(fresh, root);
	const over = surfaces.flatMap(([seat, { tools, sections }]) =>
		[["tools", tools.reduce((sum, tool) => sum + tool.bytes, 0), BUDGET.tools[seat]] as const, ...sections.map(({ name, bytes }) => [name, bytes, BUDGET.sections[name] ?? 0] as const)]
			.filter(([, size, cap]) => size > cap)
			.map(([name, size, cap]) => `${seat} ${name} ${size} > ${cap}`),
	);
	assert.deepEqual(over, []);
	const seen = Object.fromEntries(surfaces.map(([seat, { tools }]) => [seat, tools.map((tool) => tool.name)]));
	assert.deepEqual(seen, {
		agent: ["notify", "handoff", "codemode"],
		user: ["handoff", "codemode"],
	});
	const userSections = surfaces.find(([seat]) => seat === "user")![1].sections.map((section) => section.name);
	assert.deepEqual(userSections.filter((name) => name === "owner" || name === "notes-index"), []);
	assert.deepEqual(Object.values(seen).flat().filter((name) => FORBIDDEN_TOOL_NAME.test(name)), []);
});

test("a tool or function missing from SURFACE or LIBRARY stops mochi from opening", () => {
	const stray = defineTool({ name: "stray", description: "x", parameters: Type.Object({}), execute: async () => ({}) });
	assert.throws(() => seatExtensions([stray], []), /disagree on stray, notify, handoff, read/);
});

test("only seats.ts creates conversations", async () => {
	const files = (await readdir(import.meta.dirname, { recursive: true })).filter((file) => file.endsWith(".ts") && file !== "seats.ts");
	const creators = [];
	for (const file of files) if (/\.createConversation\(/.test(await readFile(join(import.meta.dirname, file), "utf8"))) creators.push(file);
	assert.deepEqual(creators, []);
});

test("a root created before seats gets the agent seat at boot and keeps its thinking level", async () => {
	const dir = await tempDir();
	const old = await Harness.open(await openNodeSqliteStorage(join(dir, "mochi.sqlite")), { models: createModels(), registry: createRegistry() }, context);
	await old.root(context, { agent: { model: FAUX, thinkingLevel: "high" } });
	await old.close(context);
	const logs: unknown[] = [];
	const mochi = await openTestMochi(dir, newFaux(), new Map(), undefined, [], { log: (event, fields) => logs.push({ event, ...fields }) });
	const root = await mochi.root.agent(context);
	assert.equal(root.thinkingLevel, "high");
	assert.ok(root.callable.some((tool) => tool.name === "react"));
	assert.deepEqual(logs, [{ event: "upgrade", unit: "U6", name: "root-seat", changed: 1 }]);
	await mochi.close();
	const again: unknown[] = [];
	await (await openTestMochi(dir, newFaux(), new Map(), undefined, [], { log: (event) => again.push(event) })).close();
	assert.deepEqual(again, []);
});

test("conversations on the retired owner, run and worker seats move to the agent seat once", async () => {
	const dir = await tempDir();
	const first = await openTestMochi(dir, newFaux());
	const run = await first.harness.commit(async (tx) => {
		const id = await createSeatConversation(tx, "agent", { kind: "ownerless" });
		(await tx.doc(AgentDoc, id)).extensions = ["identity", "notes", "skills", "fast-compaction", "seat-run"];
		return id;
	}, context);
	await first.close();
	const logs: unknown[] = [];
	const mochi = await openTestMochi(dir, newFaux(), new Map(), undefined, [], { log: (event, fields) => logs.push({ event, ...fields }) });
	assert.deepEqual(logs, [{ event: "upgrade", unit: "U11", name: "one-agent-seat", changed: 1 }]);
	assert.deepEqual((await mochi.harness.snapshot(AgentDoc, run, context))?.extensions, selection("agent"));
	await mochi.close();
});
