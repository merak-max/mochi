// OptMem's merge tree (github.com/VictorTaelin/OptMem): a log of lines, and one summary line for each aligned
// power-of-two block [lo, hi) of it, built from its two halves. Position is identity.

export type Block = readonly [lo: number, hi: number];

export const blockKey = ([lo, hi]: Block): string => `${lo}-${hi}`;

/** Blocks up to this many lines are summarized from the raw lines, larger ones from their two halves. */
export const RAW_MAX = 16;

/** Tile [0, total) with aligned blocks, keeping a block whole when its size is at most `alpha` times its age. */
function tile(total: number, alpha: number): Block[] {
	let root = 1;
	while (root < total) root *= 2;
	const out: Block[] = [];
	const stack: Block[] = [[0, root]];
	while (stack.length > 0) {
		const [lo, hi] = stack.pop()!;
		if (lo >= total) continue;
		const size = hi - lo;
		if (size > 1 && (hi > total || size > alpha * (total - lo))) {
			const mid = (lo + hi) / 2;
			stack.push([mid, hi], [lo, mid]);
		} else {
			out.push([lo, hi]);
		}
	}
	return out.sort((a, b) => a[0] - b[0]);
}

/** At most `budget` blocks covering the log, finest near the end: recent lines stay whole, old ones merge. */
export function cover(total: number, budget: number): Block[] {
	if (total <= 0) return [];
	if (total <= budget) return Array.from({ length: total }, (_, i): Block => [i, i + 1]);
	let lo = 0;
	let hi = 1;
	for (let step = 0; step < 60; step++) {
		const mid = (lo + hi) / 2;
		if (tile(total, mid).length > budget) lo = mid;
		else hi = mid;
	}
	const out = tile(total, hi);
	while (out.length < budget) {
		let widest = -1;
		for (let i = 0; i < out.length; i++) {
			const [a, b] = out[i]!;
			if (b - a > 1) widest = i;
		}
		if (widest === -1) break;
		const [a, b] = out[widest]!;
		const mid = (a + b) / 2;
		out.splice(widest, 1, [a, mid], [mid, b]);
	}
	return out;
}

/** Every complete block of `total` lines that has no summary yet, smallest first, so each one's halves exist. */
export function pending(total: number, has: (block: Block) => boolean): Block[] {
	const todo: Block[] = [];
	for (let size = 2; size <= total; size *= 2) {
		for (let lo = 0; lo + size <= total; lo += size) {
			const block: Block = [lo, lo + size];
			if (!has(block)) todo.push(block);
		}
	}
	return todo;
}

/** The two halves of a block, or undefined for a single line. */
export function halves([lo, hi]: Block): readonly [Block, Block] | undefined {
	if (hi - lo < 2) return undefined;
	const mid = (lo + hi) / 2;
	return [[lo, mid], [mid, hi]];
}
