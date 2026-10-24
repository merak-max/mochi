// The view, ported from uniichat's Memory.ts (github.com/VictorTaelin/uniichat). Pure functions over plain data.
//
// Over a conversation's messages grows a binary tree: node (0,i) is message i in at most NODE bytes, node (l,i)
// merges (l-1,2i) and (l-1,2i+1). A message that fits is its own node; else a compaction writes it.
//
// A view lists nodes covering the chat to its end, oldest first; each message it reaches appends its node. Past
// `high` bytes, a batch merges the adjacent siblings whose parent is built and most due (oldest since its last
// message, to the view's end, in halves: detail fades with age) down to half, so a view changes only at its end
// between batches. Two views: the chat's (turns'), and the compactions' (`seen`), to the first message not built.

/** Node (l,i), as a line of a view. */
export type Part = { readonly l: number; readonly i: number };

/** A view: its lines, the bytes of those built, a batch under way, the bytes past which it merges to half. */
export type View = { parts: Part[]; size: number; batch: boolean; high: number };

/** Node (l,i)'s text; null: not built. */
export type Node = (part: Part) => string | null;

export const NODE = 512;
export const HIGH = 128000;
export const SEEN = 32000;
const BLOCK = 4;
export const TRIES = 5;

/** A ruler, not a sample line: the compactor copied a sample's content. */
const SCALE = "-".repeat(NODE);

export const WAIT = "(not summarized yet: zoom it)";

/** A compaction's task, before its <input>: one message to compress (level 0). */
const LEAF = `Compaction: compress message {id} into one line of at most ${NODE} bytes
(about 70 words), the length of this ruler:
${SCALE}
<input>
`;

/** A compaction's task, before its <input>: two lines to merge. */
const MERGE = `Compaction: merge lines {a} and {b}, adjacent, into one line of at most
${NODE} bytes (about 70 words), the length of this ruler:
${SCALE}
<chat> may hold their messages, {id} to {end}, in more detail: take details
of them from there too.
<input>
`;

export function bytes(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

export function slot(l: number, i: number): number {
	return (2 * i + 1) * 2 ** l - 1;
}

export function span(part: Part): [number, number] {
	const a = part.i * 2 ** part.l;
	return [a, a + 2 ** part.l - 1];
}

export function ctx(l: number, i: number): number {
	return l === 0 ? i : (i + 1) * 2 ** l;
}

function halves(part: Part): Part[] {
	if (part.l === 0) return [];
	return [{ l: part.l - 1, i: 2 * part.i }, { l: part.l - 1, i: 2 * part.i + 1 }];
}

/** The tree's roots: a node per power of two in the count, largest first. */
function roots(count: number): Part[] {
	const out: Part[] = [];
	let id = 0;
	for (let l = 30; l >= 0; l--) {
		if (id + 2 ** l <= count) {
			out.push({ l, i: id / 2 ** l });
			id += 2 ** l;
		}
	}
	return out;
}

/** Its zoom target, "id+n". */
export function ref(part: Part): string {
	return part.i * 2 ** part.l + "+" + 2 ** part.l;
}

function flat(text: string): string {
	if (!text.includes("\n")) return text;
	return text.replace(/\s*\n\s*/g, " ");
}

function line(part: Part, text: string): string {
	return ref(part) + "|" + flat(text);
}

/** A text's first NODE bytes. */
function cut(text: string): string {
	return Buffer.from(text, "utf8").subarray(0, NODE).toString("utf8").replace(/�+$/, "");
}

export function over(line: string): string {
	return `Too long: your last line for this <input> was ${bytes(line)} bytes,
over the ${NODE}-byte limit. Write the whole line again, cutting just
enough of the least valuable items to fit before this cut:
${cut(line)}| ← LIMIT`;
}

/** Node (l,i)'s task, but its input. */
export function task(l: number, i: number): string {
	const [a, z] = span({ l, i });
	const n = 2 ** l / 2;
	const fill: Array<[string, string]> = [["{a}", a + "+" + n], ["{b}", a + n + "+" + n], ["{id}", String(a)], ["{end}", String(z)]];
	let text = l === 0 ? LEAF : MERGE;
	for (const [key, value] of fill) text = text.replace(key, value);
	return text;
}

/** What node (l,i) is made from: its message, or its halves' lines; null while a half is not built. */
export function source(node: Node, show: (i: number) => string, l: number, i: number): string | null {
	if (l === 0) return show(i);
	const [a, b] = halves({ l, i }).map((half) => node(half));
	if (a === null || a === undefined || b === null || b === undefined) return null;
	return flat(a) + "\n" + flat(b);
}

/** A line's bytes as calls get it: none until built. */
export function size(node: Node, part: Part): number {
	const text = node(part);
	return text === null ? 0 : bytes(text);
}

/** The message after a view's last line. */
function end(parts: readonly Part[]): number {
	if (parts.length === 0) return 0;
	return span(parts[parts.length - 1]!)[1] + 1;
}

/** The index of a view's line holding message id (past its end: none). */
export function cover(parts: readonly Part[], id: number): number {
	let a = 0;
	let z = parts.length;
	while (a < z) {
		const m = (a + z) >> 1;
		if (span(parts[m]!)[1] < id) a = m + 1;
		else z = m;
	}
	return a;
}

/** A view to message `end`: its lines from it dropped, the messages to it appended. */
export function reach(view: View, node: Node, to: number): void {
	for (const part of view.parts.splice(cover(view.parts, to))) view.size -= size(node, part);
	for (let i = end(view.parts); i < to; i++) {
		view.parts.push({ l: 0, i });
		view.size += size(node, { l: 0, i });
	}
}

type Pair = { d: number; k: number; a: Part; b: Part };

/**
 * A view's most due pairs merged down to half, as their parents allow: a pair whose parent is built, most due first
 * ((T + 1) / 2^l - i, T the view's end: its age from its last message, in halves), the oldest of equals; a heap of
 * pairs over the view as a linked list, so a view of thousands merges in milliseconds.
 */
function merge(from: View, node: Node): { parts: Part[]; size: number } {
	const t = end(from.parts);
	const low = from.high / 2;
	const view: Array<Part | null> = [...from.parts];
	const next = view.map((_, k) => k + 1);
	const prev = view.map((_, k) => k - 1);
	const heap: Pair[] = [];
	const higher = (x: Pair, y: Pair): boolean => x.d > y.d || (x.d === y.d && x.k < y.k);
	const swap = (x: number, y: number): void => {
		const held = heap[x]!;
		heap[x] = heap[y]!;
		heap[y] = held;
	};
	const offer = (k: number): void => {
		if (k < 0) return;
		const a = view[k];
		const b = view[next[k]!];
		if (!a || !b || a.i % 2 !== 0 || b.l !== a.l || b.i !== a.i + 1) return;
		if (node({ l: a.l + 1, i: a.i / 2 }) === null) return;
		heap.push({ d: (t + 1) / 2 ** a.l - a.i, k, a, b });
		for (let x = heap.length - 1; x > 0 && higher(heap[x]!, heap[(x - 1) >> 1]!); x = (x - 1) >> 1) swap(x, (x - 1) >> 1);
	};
	const take = (): Pair => {
		const top = heap[0]!;
		const last = heap.pop()!;
		if (heap.length > 0) {
			heap[0] = last;
			let x = 0;
			for (;;) {
				let m = x;
				for (const c of [2 * x + 1, 2 * x + 2]) {
					if (c < heap.length && higher(heap[c]!, heap[m]!)) m = c;
				}
				if (m === x) break;
				swap(x, m);
				x = m;
			}
		}
		return top;
	};
	let total = from.size;
	view.forEach((_, k) => offer(k));
	while (heap.length > 0 && total > low) {
		const { k, a, b } = take();
		const j = next[k]!;
		if (view[k] !== a || view[j] !== b) continue;
		const up = { l: a.l + 1, i: a.i / 2 };
		total += size(node, up) - size(node, a) - size(node, b);
		view[k] = up;
		view[j] = null;
		next[k] = next[j]!;
		prev[next[j]!] = k;
		offer(prev[k]!);
		offer(k);
	}
	return { parts: view.filter((part): part is Part => part !== null), size: total };
}

/**
 * A view to its end; a batch starts as the view passes `high`, or goes on at a message (`next`) if a missing parent
 * stopped it; between messages, only a whole batch, to half or, as parents not built keep it over, by `high`. True
 * when the view changed other than at its end.
 */
export function fit(view: View, node: Node, to: number, next: boolean): boolean {
	reach(view, node, to);
	const parts = view.parts.length;
	const batch = view.batch;
	if (view.size > view.high || (next && view.batch)) {
		const merged = merge(view, node);
		if (next || merged.size <= Math.max(view.high / 2, view.size - view.high)) {
			view.parts = merged.parts;
			view.size = merged.size;
		}
		view.batch = view.size > view.high / 2;
	}
	return view.parts.length !== parts || view.batch !== batch;
}

/** The view's lines before message `to`, in BLOCK-line blocks inside <chat> tags; a line not built shows WAIT. */
export function blocks(parts: readonly Part[], node: Node, to: number): string[] {
	const lines: string[] = [];
	for (const part of parts) {
		if (span(part)[1] >= to) break;
		lines.push(line(part, node(part) ?? WAIT) + "\n");
	}
	const whole = Math.floor(lines.length / BLOCK);
	const out = ["<chat>\n"];
	for (let k = 0; k < whole; k++) out.push(lines.slice(k * BLOCK, (k + 1) * BLOCK).join(""));
	out.push(lines.slice(whole * BLOCK).join("") + "</chat>\n");
	return out;
}

/** The nodes not built whose sources are, oldest message first (`ctx`; at a tie, a merge first). */
export function todo(node: Node, count: number): Part[] {
	const out: Part[] = [];
	for (let l = 0; 2 ** l <= count; l++) {
		for (let i = 0; (i + 1) * 2 ** l <= count; i++) {
			const part = { l, i };
			if (node(part) !== null) continue;
			if (halves(part).every((half) => node(half) !== null)) out.push(part);
		}
	}
	out.sort((a, b) => ctx(a.l, a.i) - ctx(b.l, b.i) || b.l - a.l);
	return out;
}

/** The first message from `from` on from which those to the end go whole: HIGH bytes, the last always. */
export function whole(sizes: readonly number[], from: number, high: number): number {
	let k = sizes.length;
	let total = 0;
	for (; k > from; k--) {
		total += sizes[k - 1]!;
		if (k < sizes.length && total > high) return k;
	}
	return k;
}

/** Line id+n as a node; null: n is not a power of 2, or id not a multiple of n, or past the count. */
function part(id: number, n: number, count: number): Part | null {
	const l = Math.log2(n);
	const ok = Number.isInteger(id) && Number.isInteger(l) && id >= 0 && id % n === 0 && id + n <= count;
	return ok ? { l, i: id / n } : null;
}

/** A message (n = 1) whole; else the two lines under id+n. */
export function zoom(node: Node, show: (i: number) => string, count: number, id: number, n: number): string {
	const at = part(id, n, count);
	if (at === null) {
		const all = roots(count).map((root) => ref(root)).join(", ");
		return "No line " + id + "+" + n + ": n is a power of 2, id a multiple of n. The tree's roots: " + all + ".";
	}
	if (n === 1) return id + "+0|" + show(id);
	return halves(at).map((half) => line(half, node(half) ?? WAIT)).join("\n");
}
