import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createRegistry, defineTool, Harness } from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { measureSurface } from "../eval/surface.ts";
import { BUDGET, FORBIDDEN_TOOL_NAME, SEATS, seatExtensions } from "./seats.ts";
import { FAUX, newFaux, openTestMochi, tempDir } from "./test-support.ts";

const CODING = ["read", "write", "edit", "bash"];

test("each seat's request carries its tools within BUDGET: only root starts agents or adds triggers, root has no notify, and a user has no owner notes", async () => {
	const surfaces = await Promise.all(SEATS.map(async (seat) => [seat, await measureSurface(seat)] as const));
	const over = surfaces.flatMap(([seat, { tools, sections }]) =>
		[["tools", tools.reduce((sum, tool) => sum + tool.bytes, 0), BUDGET.tools[seat]] as const, ...sections.map(({ name, bytes }) => [name, bytes, BUDGET.sections[name] ?? 0] as const)]
			.filter(([, size, cap]) => size > cap)
			.map(([name, size, cap]) => `${seat} ${name} ${size} > ${cap}`),
	);
	assert.deepEqual(over, []);
	const seen = Object.fromEntries(surfaces.map(([seat, { tools }]) => [seat, tools.map((tool) => tool.name)]));
	assert.deepEqual(seen, {
		owner: [...CODING, "note", "recall", "react", "handoff", "code"],
		run: [...CODING, "recall", "notify", "code"],
		worker: [...CODING, "recall", "code"],
		user: [...CODING, "recall", "handoff", "code"],
	});
	const userSections = surfaces.find(([seat]) => seat === "user")![1].sections.map((section) => section.name);
	assert.deepEqual(userSections.filter((name) => name === "owner" || name === "notes-index"), []);
	assert.deepEqual(Object.values(seen).flat().filter((name) => FORBIDDEN_TOOL_NAME.test(name)), []);
});

test("a tool or function missing from SURFACE or LIBRARY stops mochi from opening", () => {
	const stray = defineTool({ name: "stray", description: "x", parameters: Type.Object({}), execute: async () => ({ content: [] }) });
	assert.throws(() => seatExtensions([stray], [], {} as never), /disagree on stray, read/);
});

test("only seats.ts creates conversations", async () => {
	const files = (await readdir(import.meta.dirname, { recursive: true })).filter((file) => file.endsWith(".ts") && file !== "seats.ts");
	const creators = [];
	for (const file of files) if (/\.createConversation\(/.test(await readFile(join(import.meta.dirname, file), "utf8"))) creators.push(file);
	assert.deepEqual(creators, []);
});

test("a root created before seats gets the owner seat at boot and keeps its thinking level", async () => {
	const dir = await tempDir();
	const old = await Harness.open(await openNodeSqliteStorage(join(dir, "mochi.sqlite")), { models: createModels(), registry: createRegistry() }, context);
	await old.root(context, { agent: { model: FAUX, thinkingLevel: "high" } });
	await old.close(context);
	const logs: unknown[] = [];
	const mochi = await openTestMochi(dir, newFaux(), new Map(), undefined, [], { log: (event, fields) => logs.push({ event, ...fields }) });
	const root = await mochi.root.agent(context);
	assert.equal(root.thinkingLevel, "high");
	assert.ok(root.tools.some((tool) => tool.name === "react") && !root.tools.some((tool) => tool.name === "notify"));
	assert.deepEqual(logs, [{ event: "upgrade", unit: "U6", name: "root-seat", changed: 1 }]);
	await mochi.close();
	const again: unknown[] = [];
	await (await openTestMochi(dir, newFaux(), new Map(), undefined, [], { log: (event) => again.push(event) })).close();
	assert.deepEqual(again, []);
});
