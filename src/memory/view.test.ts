import assert from "node:assert/strict";
import { test } from "node:test";
import { blocks, fit, type Node, ref, slot, task, todo, type View, WAIT, zoom } from "./view.ts";

const tree = (texts: Map<number, string>): Node => (part) => texts.get(slot(part.l, part.i)) ?? null;

function grow(count: number, high: number): { view: View; texts: Map<number, string> } {
	const texts = new Map<number, string>();
	const view: View = { parts: [], size: 0, batch: false, high };
	for (let i = 0; i < count; i++) {
		texts.set(slot(0, i), "x".repeat(100));
		for (const part of todo(tree(texts), i + 1)) texts.set(slot(part.l, part.i), "y".repeat(100));
		fit(view, tree(texts), i + 1, true);
	}
	return { view, texts };
}

test("the view covers every message once, oldest first, and stays near high", () => {
	const { view } = grow(200, 2000);
	let next = 0;
	for (const part of view.parts) {
		assert.equal(part.i * 2 ** part.l, next);
		next += 2 ** part.l;
	}
	assert.equal(next, 200);
	assert.ok(view.size <= 2000, `size ${view.size}`);
	assert.equal(view.parts.at(-1)!.l, 0, "the newest message stays whole");
	assert.ok(view.parts[0]!.l > 2, "old messages merge");
});

test("a new message changes the view only at its end, between batches", () => {
	const { view, texts } = grow(150, 4000);
	const before = view.parts.map(ref);
	texts.set(slot(0, 150), "x".repeat(100));
	fit(view, tree(texts), 151, true);
	const after = view.parts.map(ref);
	if (!view.batch) assert.deepEqual(after.slice(0, before.length), before);
});

test("zoom opens a line into its halves and a message whole", () => {
	const texts = new Map([[slot(0, 0), "a"], [slot(0, 1), "b"], [slot(1, 0), "ab"]]);
	assert.equal(zoom(tree(texts), (i) => `msg ${i}`, 4, 0, 2), "0+1|a\n1+1|b");
	assert.equal(zoom(tree(texts), (i) => `msg ${i}`, 4, 1, 1), "1+0|msg 1");
	assert.equal(zoom(tree(texts), (i) => `msg ${i}`, 4, 2, 2), `2+1|${WAIT}\n3+1|${WAIT}`);
	assert.match(zoom(tree(texts), (i) => `msg ${i}`, 4, 1, 2), /^No line 1\+2.*roots: 0\+4\.$/);
});

test("blocks wrap view lines in chat tags, BLOCK lines a block", () => {
	const texts = new Map([[slot(0, 0), "a\nb"]]);
	const parts = [0, 1, 2, 3, 4].map((i) => ({ l: 0, i }));
	const out = blocks(parts, tree(texts), 5);
	assert.equal(out.length, 3);
	assert.equal(out[0], "<chat>\n");
	assert.ok(out[1]!.startsWith("0+1|a b\n1+1|" + WAIT));
	assert.equal(out[2], "4+1|" + WAIT + "\n</chat>\n");
});

test("task names its lines like uniichat", () => {
	assert.match(task(0, 5), /^Compaction: compress message 5 into one line/);
	assert.match(task(2, 1), /^Compaction: merge lines 4\+2 and 6\+2, adjacent/);
	assert.match(task(2, 1), /their messages, 4 to 7, in more detail/);
});
