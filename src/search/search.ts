import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { FileFinder } from "@ff-labs/fff-node";

/** How long a first call on a new root waits for fff's initial scan. A search after that sees what is indexed so far. */
const SCAN_WAIT_MS = 30_000;
const LINE_CHARS = 300;

/**
 * One fff index per root, for the life of the daemon. Each index watches its tree, so a later search sees new files
 * without a rescan. fff skips gitignored files and refuses `/`.
 */
export class FileIndexes {
	readonly #finders = new Map<string, Promise<FileFinder>>();

	/** `root` absolute, or relative to the home dir; absent, the home dir. */
	finder(root: string | undefined): { readonly root: string; readonly finder: Promise<FileFinder> } {
		const home = homedir();
		const absolute = root === undefined ? home : isAbsolute(root) ? resolve(root) : resolve(home, root);
		let finder = this.#finders.get(absolute);
		if (finder === undefined) {
			finder = open(absolute, home);
			this.#finders.set(absolute, finder);
			finder.catch(() => this.#finders.delete(absolute));
		}
		return { root: absolute, finder };
	}

	close(): void {
		for (const finder of this.#finders.values()) void finder.then((each) => each.destroy(), () => {});
		this.#finders.clear();
	}
}

async function open(root: string, home: string): Promise<FileFinder> {
	const created = FileFinder.create({ basePath: root, aiMode: true, enableHomeDirScanning: root === home });
	if (!created.ok) throw new Error(`fff cannot index ${root}: ${created.error}`);
	const scanned = await created.value.waitForScan(SCAN_WAIT_MS);
	if (!scanned.ok) throw new Error(`fff scan of ${root} failed: ${scanned.error}`);
	return created.value;
}

const RootParam = Type.Optional(Type.String({ minLength: 1, description: "Directory to search: absolute, or relative to the home dir. Default: the home dir." }));

export function searchFns(indexes: FileIndexes): ToolRegistration[] {
	return [
		defineTool({
			name: "find",
			description:
				"Find files by name under a directory. Fuzzy and typo tolerant, recent and often-changed files first; with glob: true the query is a glob such as **/*.toml. Skips gitignored files. Returns absolute paths.",
			parameters: Type.Object({
				query: Type.String({ minLength: 1 }),
				root: RootParam,
				glob: Type.Optional(Type.Boolean()),
				limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
			}),
			structuredOutputSchema: Type.Object({
				root: Type.String(),
				total: Type.Number(),
				files: Type.Array(Type.Object({ path: Type.String(), modified: Type.String() })),
				scanning: Type.Boolean(),
			}),
			replay: "safe",
			execute: async ({ query, root, glob, limit }) => {
				const index = indexes.finder(root);
				const finder = await index.finder;
				const options = { pageSize: limit ?? 20 };
				const found = glob === true ? finder.glob(query, options) : finder.fileSearch(query, options);
				if (!found.ok) throw new Error(`find failed: ${found.error}`);
				const files = found.value.items.map((item) => ({ path: join(index.root, item.relativePath), modified: new Date(item.modified * 1000).toISOString() }));
				return { structuredOutput: { root: index.root, total: found.value.totalMatched, files, scanning: finder.isScanning() } };
			},
		}),
		defineTool({
			name: "grep",
			description:
				"Search file contents under a directory. mode plain (default) matches the text, regex a regular expression, fuzzy a near match per line. Lowercase queries ignore case. Prefix the query with a glob or a folder to narrow it: '*.ts TODO' or 'src/ TODO'. Skips gitignored files. Returns absolute paths and 1-based lines.",
			parameters: Type.Object({
				query: Type.String({ minLength: 1 }),
				root: RootParam,
				mode: Type.Optional(Type.Union([Type.Literal("plain"), Type.Literal("regex"), Type.Literal("fuzzy")])),
				limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
				context: Type.Optional(Type.Integer({ minimum: 0, maximum: 10, description: "Lines before and after each match." })),
			}),
			structuredOutputSchema: Type.Object({
				root: Type.String(),
				matches: Type.Array(Type.Object({ path: Type.String(), line: Type.Number(), text: Type.String(), before: Type.Optional(Type.Array(Type.String())), after: Type.Optional(Type.Array(Type.String())) })),
				more: Type.Boolean(),
			}),
			replay: "safe",
			execute: async ({ query, root, mode, limit, context }) => {
				const index = indexes.finder(root);
				const finder = await index.finder;
				const found = finder.grep(query, { mode: mode ?? "plain", pageSize: limit ?? 50, beforeContext: context ?? 0, afterContext: context ?? 0 });
				if (!found.ok) throw new Error(`grep failed: ${found.error}`);
				if (found.value.regexFallbackError !== undefined) throw new Error(`grep: invalid regex: ${found.value.regexFallbackError}`);
				const matches = [];
				for (const item of found.value.items) {
					const match: { path: string; line: number; text: string; before?: string[]; after?: string[] } = { path: join(index.root, item.relativePath), line: item.lineNumber, text: item.lineContent.slice(0, LINE_CHARS) };
					if (item.contextBefore !== undefined && item.contextBefore.length > 0) match.before = item.contextBefore;
					if (item.contextAfter !== undefined && item.contextAfter.length > 0) match.after = item.contextAfter;
					matches.push(match);
				}
				return { structuredOutput: { root: index.root, matches, more: found.value.nextCursor !== null } };
			},
		}),
	];
}
