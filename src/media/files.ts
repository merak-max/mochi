import { copyFile, readFile, realpath, mkdir, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { lookup } from "mime-types";
import type { Bubble } from "../channels/types.ts";

export const mimeOf = (path: string): string => lookup(path) || "application/octet-stream";

function within(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export async function workPath(path: string, workDir: string): Promise<string> {
	const root = resolve(workDir);
	const candidate = resolve(root, path);
	if (isAbsolute(path) || !within(root, candidate)) throw new Error("Media path must be relative and inside the work directory.");
	const actual = await realpath(candidate);
	if (!within(await realpath(root), actual)) throw new Error("Media path escapes the work directory through a symlink.");
	return actual;
}

export async function outputPath(workDir: string, extension: string): Promise<{ path: string; absolute: string }> {
	await mkdir(resolve(workDir, "out"), { recursive: true });
	const out = await workPath("out", workDir);
	const path = `out/${randomUUID()}.${extension}`;
	return { path, absolute: resolve(out, basename(path)) };
}

export async function saveOutput(workDir: string, extension: string, bytes: Uint8Array): Promise<{ path: string }> {
	const out = await outputPath(workDir, extension);
	await writeFile(out.absolute, bytes, { flag: "wx" });
	return { path: out.path };
}

const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;

/**
 * Copies a regular file under `home`, at most MAX_ATTACHMENT_BYTES, to work/out/<uuid>/<its name>, so the sent bytes
 * stay in the work directory and keep their name. Returns the copy's work-relative path.
 */
async function copyIntoWork(path: string, workDir: string): Promise<string> {
	const actual = await realpath(path);
	if (!within(await realpath(homedir()), actual)) throw new Error("The file must be inside the owner's home directory.");
	const info = await stat(actual);
	if (!info.isFile()) throw new Error("The path is not a regular file.");
	if (info.size > MAX_ATTACHMENT_BYTES) throw new Error("The file is larger than 100 MB.");
	const dir = `out/${randomUUID()}`;
	await mkdir(resolve(workDir, dir), { recursive: true });
	await copyFile(actual, resolve(await workPath(dir, workDir), basename(path)), constants.COPYFILE_EXCL);
	return `${dir}/${basename(path)}`;
}

export async function loadAttachment(path: string, workDir: string): Promise<Extract<Bubble, { kind: "file" }>> {
	const absolute = await workPath(path, workDir);
	return { kind: "file", name: basename(path), mimeType: mimeOf(path), bytes: await readFile(absolute) };
}

/** A file to send, from a work-relative path. An absolute path outside the work directory is copied in first. */
export async function loadOutgoing(path: string, workDir: string): Promise<Extract<Bubble, { kind: "file" }>> {
	const root = resolve(workDir);
	const local = isAbsolute(path) && within(root, resolve(path)) ? relative(root, resolve(path)) : path;
	if (isAbsolute(local)) return loadAttachment(await copyIntoWork(local, workDir), workDir);
	return loadAttachment(local, workDir);
}
