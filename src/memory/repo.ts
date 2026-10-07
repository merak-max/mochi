import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { Memory } from "./memory.ts";
import { OWNER_KINDS, type Note } from "../notes/schema.ts";

const run = promisify(execFile);
const GIT_ARGS = ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "-c", "core.fsmonitor=false"];
export type Files = Record<string, string>;
export type PublicationPlan = {
	branch: string; base: string | null; target: string; tree: string; at: number;
	files: Files; previous: Files; objects: { type: "blob" | "tree" | "commit"; bytes: string; hash: string }[];
};

const line = (value: string): string => JSON.stringify(value).slice(1, -1);
const metadata = (note: Note): string =>
	`[source: ${note.source === undefined ? "durable note" : `mochi://conversation/${note.source.conversation}/entry/${note.source.entry}`}; added: ${note.updated}]`;
export function renderRepo(memory: Memory): Files {
	const files: Files = {};
	const owner: string[] = [];
	const index: string[] = [];
	for (const note of Object.values(memory.notes).sort((a, b) => a.slug.localeCompare(b.slug))) {
		const body = `- ${line(note.body)} ${metadata(note)}\n`;
		if (OWNER_KINDS.has(note.kind)) owner.push(`### ${note.slug}: ${line(note.subject)} (${note.kind})\n${body}`);
		else {
			const path = `${note.kind}/${note.slug}.md`;
			files[path] = `# ${line(note.subject)}\n\n${body}`;
			index.push(`- [[${note.kind}/${note.slug}]] ${line(note.subject)} (${note.kind})`);
		}
	}
	files["MEMORY.md"] = `# Memory\n\n${owner.join("\n")}\n## Index\n\n${index.join("\n")}\n`;
	return files;
}

export class MemoryGit {
	readonly repo: string;
	constructor(repo: string) { this.repo = resolve(repo); }
	async git(args: string[], input?: Buffer | string, index?: string): Promise<string> {
		const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_ATTR_NOSYSTEM: "1", GIT_NO_REPLACE_OBJECTS: "1", ...(index === undefined ? {} : { GIT_INDEX_FILE: index }) };
		if (input === undefined) return (await run("git", [...GIT_ARGS, ...args], { cwd: this.repo, env, maxBuffer: 16 * 1024 * 1024 })).stdout.trimEnd();
		return new Promise((accept, reject) => {
			const child = execFile("git", [...GIT_ARGS, ...args], { cwd: this.repo, env, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => error === null ? accept(stdout.trimEnd()) : reject(error));
			child.stdin!.end(input);
		});
	}
	async safePath(path: string): Promise<void> {
		const full = resolve(this.repo, path);
		if (full !== this.repo && !full.startsWith(this.repo + sep)) throw new Error("Unsafe memory path");
		let part = full;
		for (;;) {
			try { if ((await lstat(part)).isSymbolicLink()) throw new Error("Memory repo symlink refused"); }
			catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
			if (part === dirname(part)) break;
			part = dirname(part);
		}
	}
	async init(): Promise<void> {
		await this.safePath("");
		await mkdir(this.repo, { recursive: true });
		if (await realpath(this.repo) !== this.repo) throw new Error("Unsafe memory repo root");
		try { await lstat(join(this.repo, ".git")); }
		catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
			if ((await readdir(this.repo)).length !== 0) throw new Error("Nonempty memory directory is not app-owned");
			await this.git(["init", "--object-format=sha1", "-b", "main"]);
		}
		for (const path of [".git", ".git/index", ".git/HEAD", ".git/refs", ".git/refs/heads", ".git/refs/heads/main", ".git/objects", ".git/config"]) await this.safePath(path);
		if (!(await lstat(join(this.repo, ".git"))).isDirectory()) throw new Error("Memory repo must be a standalone Git repository");
		if (await this.git(["rev-parse", "--show-toplevel"]) !== this.repo) throw new Error("Foreign memory repo root");
		if (await this.git(["rev-parse", "--show-object-format"]) !== "sha1") throw new Error("Memory repo must use SHA-1");
		const config = await this.git(["config", "--local", "--list"]);
		if (/^(filter\.|core\.(worktree|bare|symlinks|attributesfile)|extensions\.|include)/m.test(config.replace(/^core.bare=false$/m, ""))) throw new Error("Unsafe memory Git configuration");
		for (const path of [".gitattributes", ".git/info/attributes", ".git/objects/info/alternates", ".git/info/grafts", ".git/refs/replace"]) {
			try { await lstat(join(this.repo, path)); throw new Error(`Memory ${path} refused`); }
			catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
		}
	}
	async lock<T>(work: () => Promise<T>): Promise<T> {
		const path = join(this.repo, ".git", "mochi-publisher.lock");
		await this.safePath(path);
		const holder = spawn("flock", ["--exclusive", "--nonblock", "--conflict-exit-code", "75", path, process.execPath, "-e", "process.stdout.write('locked\\n'); process.stdin.resume();"], { stdio: ["pipe", "pipe", "pipe"] });
		let acquired = false;
		const exited = new Promise<void>((accept, reject) => {
			holder.once("error", reject);
			holder.once("exit", (code) => code === 0 && acquired ? accept() : reject(new Error(code === 75 ? "Memory publisher lock is held" : "Memory publisher lock process failed")));
		});
		const ready = new Promise<void>((accept, reject) => holder.stdout.once("data", (chunk: Buffer) => {
			if (chunk.toString() !== "locked\n") return reject(new Error("Invalid memory publisher lock response"));
			acquired = true;
			accept();
		}));
		await Promise.race([ready, exited]);
		try { return await work(); } finally { holder.stdin.end(); await exited; }
	}
	async head(): Promise<string | null> {
		try { return await this.git(["rev-parse", "--verify", "HEAD"]); } catch { return null; }
	}
	async branch(): Promise<string> {
		const branch = await this.git(["symbolic-ref", "HEAD"]);
		if (branch !== "refs/heads/main") throw new Error("Foreign or detached memory branch refused");
		return branch;
	}
	async tree(rev: string | null): Promise<Record<string, string>> {
		if (rev === null) return {};
		const entries = (await this.git(["ls-tree", "-r", "-z", rev])).split("\0").filter(Boolean);
		const result: Record<string, string> = {};
		for (const entry of entries) {
			const match = /^(100644) blob ([a-f0-9]{40})\t(.+)$/.exec(entry);
			if (match === null || match[2] === undefined || match[3] === undefined) throw new Error("Non-regular memory Git file refused");
			result[match[3]] = match[2];
		}
		return result;
	}
	async prepare(base: string | null, previous: Files, files: Files, revision: number, at: number): Promise<PublicationPlan> {
		if (await this.head() !== base) throw new Error("Foreign memory HEAD; human edits are not imported");
		if (await this.git(["status", "--porcelain", "--untracked-files=all"]) !== "") throw new Error("Dirty memory repo; publication pending");
		const branch = await this.branch();
		const blobs = await this.tree(base);
		if (Object.keys(blobs).some((path) => path.endsWith(".gitattributes"))) throw new Error("Memory attributes refused");
		const objects: PublicationPlan["objects"] = [];
		const object = (type: "blob" | "tree" | "commit", bytes: Buffer): string => {
			const hash = createHash("sha1").update(Buffer.from(`${type} ${bytes.length}\0`)).update(bytes).digest("hex");
			objects.push({ type, bytes: bytes.toString("base64"), hash }); return hash;
		};
		for (const path of Object.keys(previous)) delete blobs[path];
		for (const [path, value] of Object.entries(files)) {
			await this.safePath(path);
			if (Object.hasOwn(blobs, path)) throw new Error(`Foreign memory path ${path}`);
			blobs[path] = object("blob", Buffer.from(value));
		}
		const treeAt = (prefix: string): string => {
			const entries = new Map<string, { mode: string; hash: string }>();
			for (const [path, hash] of Object.entries(blobs)) {
				if (!path.startsWith(prefix)) continue;
				const tail = path.slice(prefix.length);
				const slash = tail.indexOf("/");
				if (slash < 0) entries.set(tail, { mode: "100644", hash });
				else {
					const name = tail.slice(0, slash);
					if (!entries.has(name)) entries.set(name, { mode: "40000", hash: treeAt(prefix + name + "/") });
				}
			}
			return object("tree", Buffer.concat([...entries].sort(([a, av], [b, bv]) => Buffer.compare(Buffer.from(a + (av.mode === "40000" ? "/" : "")), Buffer.from(b + (bv.mode === "40000" ? "/" : "")))).map(([name, entry]) => Buffer.concat([Buffer.from(`${entry.mode} ${name}\0`), Buffer.from(entry.hash, "hex")]))));
		};
		const tree = treeAt("");
		const date = `${Math.floor(at / 1000)} +0000`;
		const commit = `tree ${tree}\n${base === null ? "" : `parent ${base}\n`}author Mochi <mochi@localhost> ${date}\ncommitter Mochi <mochi@localhost> ${date}\n\nMochi memory revision ${revision}\n`;
		const target = object("commit", Buffer.from(commit));
		return { branch, base, target, tree, at, files, previous, objects };
	}
	async publish(plan: PublicationPlan, crash?: (window: "objects" | "ref" | "worktree") => Promise<void>): Promise<void> {
		await this.init();
		if (await this.branch() !== plan.branch) throw new Error("Foreign memory branch");
		const head = await this.head();
		if (head !== plan.base && head !== plan.target) throw new Error("Foreign memory HEAD; publication pending");
		const paths = new Set([...Object.keys(plan.previous), ...Object.keys(plan.files)]);
		const baseTree = await this.tree(plan.base);
		const targetTree = { ...baseTree };
		for (const path of Object.keys(plan.previous)) delete targetTree[path];
		for (const [path, value] of Object.entries(plan.files)) targetTree[path] = createHash("sha1").update(`blob ${Buffer.byteLength(value)}\0`).update(value).digest("hex");
		for (const path of paths) {
			await this.safePath(path);
			let value: Buffer | null;
			try { value = await readFile(join(this.repo, path)); } catch (error) {
				if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
				value = null;
			}
			const matches = (expected: string | undefined): boolean => expected === undefined ? value === null : value !== null && value.equals(Buffer.from(expected));
			if (!matches(plan.previous[path]) && !matches(plan.files[path])) throw new Error(`Dirty memory file ${path}; publication pending`);
		}
		const status = await this.git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
		for (const row of status.split("\0").filter(Boolean)) if (!paths.has(row.slice(3))) throw new Error("Dirty unrelated memory files; publication pending");
		const indexTree = await this.tree(await this.git(["write-tree"]));
		const equal = (a: Record<string, string>, b: Record<string, string>): boolean => Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([key, value]) => b[key] === value);
		if (!equal(indexTree, baseTree) && !equal(indexTree, targetTree)) throw new Error("Foreign memory index; publication pending");
		for (const [path, hash] of Object.entries(baseTree)) {
			if (paths.has(path)) continue;
			await this.safePath(path);
			const value = await readFile(join(this.repo, path));
			if (createHash("sha1").update(`blob ${value.length}\0`).update(value).digest("hex") !== hash) throw new Error("Dirty unrelated tracked memory file");
		}
		for (const obj of plan.objects) if (await this.git(["hash-object", "-w", "-t", obj.type, "--stdin"], Buffer.from(obj.bytes, "base64")) !== obj.hash) throw new Error("Memory object hash mismatch");
		await crash?.("objects");
		if (head === plan.base) await this.git(["update-ref", plan.branch, plan.target, plan.base ?? "0000000000000000000000000000000000000000"]);
		await crash?.("ref");
		if (await this.head() !== plan.target || await this.branch() !== plan.branch) throw new Error("Memory HEAD changed during publication");
		for (const path of paths) {
			const full = join(this.repo, path);
			if (plan.files[path] === undefined) await rm(full, { force: true });
			else {
				await mkdir(dirname(full), { recursive: true });
				const temp = join(this.repo, ".git", "mochi-file-tmp");
				await this.safePath(temp);
				await rm(temp, { force: true });
				await writeFile(temp, plan.files[path], { flag: "wx" });
				await rename(temp, full);
			}
		}
		const privateIndex = join(this.repo, ".git", "mochi-index");
		await this.safePath(privateIndex);
		await rm(privateIndex, { force: true });
		await this.safePath(`${privateIndex}.lock`);
		await rm(`${privateIndex}.lock`, { force: true });
		await this.git(["read-tree", plan.target], undefined, privateIndex);
		await rename(privateIndex, join(this.repo, ".git", "index"));
		await crash?.("worktree");
		if (await this.head() !== plan.target || await this.branch() !== plan.branch || await this.git(["status", "--porcelain", "--untracked-files=all"]) !== "") throw new Error("Memory repo changed during publication");
	}
}
