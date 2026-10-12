import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { promisify } from "node:util";
import type { Context } from "@earendil-works/chord";
import type { ImageContent } from "@earendil-works/pi-ai";
import { defineExtension, type ToolRegistration } from "@earendil-works/pi-durable";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";

const execute = promisify(execFile);

/** Longest side sent to the model. Anthropic downsamples past ~1568 px anyway, and a phone scan is 3000+. */
const MAX_SIDE = 1568;
/** Raw files at or under this size and side are sent as they are. */
const PASS_BYTES = 3_500_000;
const MODEL_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const CONVERT_EXT = new Set([".heic", ".heif", ".avif", ".bmp", ".tif", ".tiff"]);

/**
 * pi-durable's `read` refuses images. This `read` sends them to the model instead: PNG, JPEG, GIF and WebP pass through
 * when small, anything else or anything large goes through ffmpeg to a JPEG at most MAX_SIDE px on its longest side.
 * Text files are untouched.
 */
export function createImageReadTool(): ToolRegistration {
	const base = createReadTool() as unknown as ToolRegistration;
	return {
		...base,
		description: base.description.replace("Read the contents of a text file.", "Read a text file, or see an image."),
		replay: "safe",
		async execute(args, api, context) {
			const result = await base.execute(args, api, context);
			const unsupported = result.isError === true && result.diagnostics?.some((d) => d.code === "unsupported_image");
			const path = (args as { path: string }).path;
			if (!unsupported && !CONVERT_EXT.has(extname(path).toLowerCase())) return result;
			const absolute = api.env === undefined ? path : await absoluteOf(api.env, path, context);
			const image = await loadImage(absolute);
			return { content: [{ type: "text", text: `${path} (${image.mimeType}${image.scaled ? `, scaled to ${MAX_SIDE}px` : ""})` }, image.content] };
		},
	} as ToolRegistration;
}

async function absoluteOf(env: NonNullable<Parameters<ToolRegistration["execute"]>[1]["env"]>, path: string, context: Context): Promise<string> {
	const resolved = await env.absolutePath(path.startsWith("@") ? path.slice(1) : path, context);
	if (!resolved.ok) throw new Error(`Cannot resolve ${path}`);
	return resolved.value;
}

export async function loadImage(absolute: string, signal?: AbortSignal): Promise<{ content: ImageContent; mimeType: string; scaled: boolean }> {
	const bytes = await readFile(absolute);
	const sniffed = sniff(bytes);
	if (sniffed !== undefined && MODEL_TYPES.has(sniffed) && bytes.length <= PASS_BYTES && (await longestSide(absolute, signal)) <= MAX_SIDE) {
		return { content: { type: "image", mimeType: sniffed, data: bytes.toString("base64") }, mimeType: sniffed, scaled: false };
	}
	const dir = await mkdtemp(join(tmpdir(), "mochi-img-"));
	try {
		const out = join(dir, "view.jpg");
		const scale = `scale='if(gt(iw,ih),min(${MAX_SIDE},iw),-2)':'if(gt(iw,ih),-2,min(${MAX_SIDE},ih))'`;
		await execute("/usr/bin/ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", "-i", absolute, "-frames:v", "1", "-vf", scale, "-q:v", "3", "-y", out], { ...(signal === undefined ? {} : { signal }), timeout: 60_000 });
		const jpeg = await readFile(out);
		return { content: { type: "image", mimeType: "image/jpeg", data: jpeg.toString("base64") }, mimeType: sniffed ?? "image", scaled: true };
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function longestSide(absolute: string, signal?: AbortSignal): Promise<number> {
	try {
		const { stdout } = await execute("/usr/bin/ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", absolute], { ...(signal === undefined ? {} : { signal }), timeout: 30_000 });
		const [w, h] = stdout.trim().split(",").map(Number);
		return Math.max(w ?? Infinity, h ?? Infinity);
	} catch {
		return Infinity;
	}
}

function sniff(bytes: Buffer): string | undefined {
	if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
	if (bytes.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
	if (bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
	return undefined;
}

/** CodingTools with an image-aware `read`. */
export const MochiCodingTools = defineExtension({
	name: "coding-tools",
	tools: [createImageReadTool(), createWriteTool(), createEditTool(), createBashTool()],
});
