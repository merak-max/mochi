import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, unlink } from "node:fs/promises";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { SavedFile } from "../turn/turn.ts";
import { MediaClient, type MediaDeps } from "./client.ts";
import { mimeOf, outputPath, workPath } from "./files.ts";

const execute = promisify(execFile);

export async function prepareInbound(
	files: readonly SavedFile[],
	workDir: string,
	deps: Omit<MediaDeps, "workDir">,
	signal?: AbortSignal,
): Promise<{ notes: string[]; images: ImageContent[] }> {
	const client = new MediaClient({ ...deps, workDir });
	const notes: string[] = [];
	const images: ImageContent[] = [];
	for (const file of files) {
		const note = `[${file.kind} attachment ${file.mimeType}, ${file.bytes} bytes, saved at ${file.path}]`;
		try {
			const absolute = await workPath(file.path, workDir);
			if (/^image\/hei[cf](?:-sequence)?(?:;|$)/i.test(file.mimeType) || /^image\/hei[cf]$/.test(mimeOf(file.path))) {
				const jpeg = await outputPath(workDir, "jpg");
				try {
					await execute("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", "-i", absolute, "-frames:v", "1", "-q:v", "2", "-n", jpeg.absolute], { ...(signal === undefined ? {} : { signal }), timeout: 60_000 });
					images.push({ type: "image", mimeType: "image/jpeg", data: (await readFile(jpeg.absolute)).toString("base64") });
					notes.push(`[image converted from ${file.path}, JPEG saved at ${jpeg.path}]`);
				} catch (error) {
					await unlink(jpeg.absolute).catch(() => {});
					throw error;
				}
			} else if (file.kind === "image" && /^(image\/png|image\/jpeg|image\/gif|image\/webp)$/.test(file.mimeType)) {
				images.push({ type: "image", mimeType: file.mimeType, data: (await readFile(absolute)).toString("base64") });
			} else if (file.kind === "audio" || file.mimeType.startsWith("audio/") || file.mimeType.startsWith("video/")) {
				const transcript = await client.transcript(file.path, signal);
				const duration = transcript.duration === undefined ? "" : `, ${Math.round(transcript.duration)} s`;
				notes.push(transcript.text.trim() === "" ? note : `[${file.mimeType.startsWith("video/") ? "video transcript" : "voice note"}${duration}: ${JSON.stringify(transcript.text)}, saved at ${file.path}]`);
			} else {
				notes.push(note);
			}
		} catch {
			notes.push(note);
		}
	}
	return { notes, images };
}
