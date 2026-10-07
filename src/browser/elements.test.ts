import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parseWith } from "../parse.ts";
import { PageSnapshot, elementTable } from "./elements.ts";

test("recorded example.com snapshot produces numbered observed targets and one operation question", async () => {
	const page = parseWith(PageSnapshot, JSON.parse(await readFile(new URL("./example.snapshot.json", import.meta.url), "utf8")), "recorded snapshot");
	assert.equal(page.url, "https://example.com/");
	assert.match(page.text, /Learn more/);
	const table = elementTable(page, "Click Learn more.");
	assert.deepEqual(table.elements, [{ index: "1", role: "link", label: "Learn more", value: "", operations: ["CLICK"] }]);
	assert.equal(table.targets.get("CLICK")?.get("1")?.label, "Learn more");
	assert.deepEqual(Object.keys(table.questions).sort(), ["click_target", "operation"]);
	assert.equal(table.questions.operation?.type, "choice");
	assert.equal(table.controls.get("WAIT")?.kind, "wait");
});

test("shared editable node has one index and dropdown options have distinct targets", () => {
	const page = parseWith(PageSnapshot, {
		url: "https://example.com", title: "Search", text: "Search", marker: [], page_key: [], guards: {},
		actions: [
			{ id: "e1", node: 9, kind: "fill", role: "searchbox", label: "Query", value: "hello" },
			{ id: "e2", node: 9, kind: "click", role: "searchbox", label: "Open Query", value: "hello" },
			{ id: "e3", node: 10, kind: "select", role: "combobox", label: "Trip → One way", value: "one", current_value: "Round trip" },
			{ id: "e4", node: 10, kind: "select", role: "combobox", label: "Trip → Multi city", value: "multi", current_value: "Round trip" },
			{ id: "wait", kind: "wait", label: "Wait" },
		],
	}, "page");
	const table = elementTable(page, "Search.");
	assert.equal(table.elements.length, 2);
	assert.deepEqual(table.elements[0]?.operations, ["TYPE_TEXT", "CLICK"]);
	assert.equal(table.targets.get("TYPE_TEXT")?.get("1")?.id, "e1");
	assert.equal(table.targets.get("CLICK")?.get("1")?.id, "e2");
	assert.deepEqual(table.elements[1]?.options, [
		{ index: "2:1", label: "Trip → One way", value: "one" },
		{ index: "2:2", label: "Trip → Multi city", value: "multi" },
	]);
	assert.equal(table.targets.get("SELECT")?.get("2:2")?.id, "e4");
	assert.deepEqual(Object.keys(table.questions).sort(), ["click_target", "operation", "select_target", "type_text_target"]);
});
