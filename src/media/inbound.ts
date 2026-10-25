import { readFile } from "node:fs/promises";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { SavedFile } from "../turn/turn.ts";
import { MediaClient, type MediaDeps } from "./client.ts";
import { mimeOf, saveOutput, workPath } from "./files.ts";
import { heicToJpeg } from "./heic.ts";

/**
 * The type an image's bytes say it is. A channel's label can be wrong (iMessage sends PNGs as image/jpeg), and the model
 * provider rejects an image whose label does not match its bytes.
 */
function imageType(bytes: Uint8Array): string | undefined {
	const starts = (...prefix: number[]) => prefix.every((byte, i) => bytes[i] === byte);
	if (starts(0x89, 0x50, 0x4e, 0x47)) return "image/png";
	if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
	if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";
	if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
	return undefined;
}

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
				const bytes = await heicToJpeg(new Uint8Array(await readFile(absolute)), signal);
				const jpeg = await saveOutput(workDir, "jpg", bytes);
				images.push({ type: "image", mimeType: "image/jpeg", data: Buffer.from(bytes).toString("base64") });
				notes.push(`[image converted from ${file.path}, JPEG saved at ${jpeg.path}]`);
			} else if (file.kind === "image" && /^(image\/png|image\/jpeg|image\/gif|image\/webp)$/.test(file.mimeType)) {
				const bytes = await readFile(absolute);
				images.push({ type: "image", mimeType: imageType(bytes) ?? file.mimeType, data: bytes.toString("base64") });
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
