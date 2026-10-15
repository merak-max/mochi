import { copyFile, readFile, realpath, mkdir, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import type { Bubble } from "../channels/types.ts";

const MIME: Readonly<Record<string, string>> = {
	".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
	".gif": "image/gif", ".heic": "image/heic", ".heif": "image/heif", ".avif": "image/avif",
	".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
	".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".aac": "audio/aac", ".wav": "audio/wav",
	".ogg": "audio/ogg", ".oga": "audio/ogg", ".opus": "audio/ogg", ".flac": "audio/flac",
	".pdf": "application/pdf", ".txt": "text/plain", ".json": "application/json",
};

export const mimeOf = (path: string): string => MIME[extname(path).toLowerCase()] ?? "application/octet-stream";

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

export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;

/**
 * Copies a regular file under `home`, at most MAX_ATTACHMENT_BYTES, to work/out/<uuid>/<its name>, so the sent bytes
 * stay in the work directory and keep their name. Returns the copy's work-relative path.
 */
export async function copyIntoWork(path: string, workDir: string, home = homedir()): Promise<string> {
	const actual = await realpath(path);
	if (!within(await realpath(home), actual)) throw new Error("The file must be inside the owner's home directory.");
	const info = await stat(actual);
	if (!info.isFile()) throw new Error("The path is not a regular file.");
	if (info.size > MAX_ATTACHMENT_BYTES) throw new Error("The file is larger than 100 MB.");
	const dir = `out/${randomUUID()}`;
	await mkdir(resolve(workDir, dir), { recursive: true });
	await copyFile(actual, resolve(await workPath(dir, workDir), basename(path)), constants.COPYFILE_EXCL);
	return `${dir}/${basename(path)}`;
}

/** A file to send, as a checked work-relative path. An absolute path outside the work directory is copied in first. */
export async function outgoingPath(path: string, workDir: string, home = homedir()): Promise<string> {
	const root = resolve(workDir);
	const local = isAbsolute(path) && within(root, resolve(path)) ? relative(root, resolve(path)) : path;
	if (isAbsolute(local)) return copyIntoWork(local, workDir, home);
	await workPath(local, workDir);
	return local;
}

export async function loadAttachment(path: string, workDir: string): Promise<Extract<Bubble, { kind: "file" }>> {
	const absolute = await workPath(path, workDir);
	return { kind: "file", name: basename(path), mimeType: mimeOf(path), bytes: await readFile(absolute) };
}

export async function loadOutgoing(path: string, workDir: string, home = homedir()): Promise<Extract<Bubble, { kind: "file" }>> {
	return loadAttachment(await outgoingPath(path, workDir, home), workDir);
}

/** Checks each file now, copies one from outside the work directory in, and appends an attach: line per file to `text`. */
export async function withAttachments(text: string, paths: readonly string[], workDir: string, home = homedir()): Promise<string> {
	const lines = [text];
	for (const path of paths) {
		try {
			lines.push(`attach: ${await outgoingPath(path, workDir, home)}`);
		} catch (error) {
			throw new Error(`Attachment ${path} cannot be sent: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return lines.join("\n");
}
