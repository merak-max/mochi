import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { promisify } from "node:util";
import type { Context } from "@earendil-works/chord";
import type { Api, ImageContent, Model, Models, TextContent } from "@earendil-works/pi-ai";
import { convertToPng, detectSupportedImageMimeTypeFromFile, formatDimensionNote, resizeImage } from "@earendil-works/pi-coding-agent";
import { defineExtension, type Extension, type ToolRegistration } from "@earendil-works/pi-durable";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";

const execute = promisify(execFile);

/** Types the model takes as they are. pi converts every other type to PNG. */
const MODEL_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
/** Photon cannot decode these, so ffmpeg turns them into a JPEG first. */
const FFMPEG_TYPES: Readonly<Record<string, string>> = { ".heic": "image/heic", ".heif": "image/heif", ".avif": "image/avif" };
/** Photon decodes these, but pi-durable's `read` does not detect them as images. */
const PHOTON_TYPES: Readonly<Record<string, string>> = { ".tif": "image/tiff", ".tiff": "image/tiff" };
const NON_VISION_NOTE = "[Current model does not support images. The image will be omitted from this request.]";

/**
 * pi-durable's `read` refuses images. This `read` sends them to the model the way pi-coding-agent's `read` does:
 * PNG, JPEG, GIF and WebP keep their type, other types become PNG, and every image goes through pi's `resizeImage`
 * with the calling model's resize limits. Text files are untouched.
 */
export function createImageReadTool(models: Models): ToolRegistration {
	const base = createReadTool() as unknown as ToolRegistration;
	return {
		...base,
		description: base.description.replace("Read the contents of a text file.", "Read a text file, or see an image."),
		replay: "safe",
		async execute(args, api, context) {
			const path = (args as { path: string }).path;
			const extension = extname(path).toLowerCase();
			const undetected = FFMPEG_TYPES[extension] !== undefined || PHOTON_TYPES[extension] !== undefined;
			let result: Awaited<ReturnType<ToolRegistration["execute"]>> | undefined;
			if (!undetected) {
				result = await base.execute(args, api, context);
				const unsupported = result.isError === true && result.diagnostics?.some((d) => d.code === "unsupported_image");
				if (!unsupported) return result;
			}
			const absolute = api.env === undefined ? path : await absoluteOf(api.env, path, context);
			const ref = (await api.agent(context)).model;
			const model = ref === undefined ? undefined : models.getModel(ref.provider, ref.modelId);
			return { content: await readImage(absolute, model) };
		},
	} as ToolRegistration;
}

async function absoluteOf(env: NonNullable<Parameters<ToolRegistration["execute"]>[1]["env"]>, path: string, context: Context): Promise<string> {
	const resolved = await env.absolutePath(path.startsWith("@") ? path.slice(1) : path, context);
	if (!resolved.ok) throw new Error(`Cannot resolve ${path}`);
	return resolved.value;
}

/** The content pi-coding-agent's `read` returns for an image: a note, then the image, or only the note when the model cannot see images. */
export async function readImage(absolute: string, model: Model<Api> | undefined): Promise<(TextContent | ImageContent)[]> {
	if (model !== undefined && !model.input.includes("image")) {
		return [{ type: "text", text: `Read image file\n${NON_VISION_NOTE}` }];
	}
	const extension = extname(absolute).toLowerCase();
	let bytes: Buffer;
	let mimeType: string;
	let originalType: string | undefined;
	const ffmpegType = FFMPEG_TYPES[extension];
	if (ffmpegType !== undefined) {
		bytes = await ffmpegToJpeg(absolute);
		mimeType = "image/jpeg";
		originalType = ffmpegType;
	} else {
		bytes = await readFile(absolute);
		mimeType = (await detectSupportedImageMimeTypeFromFile(absolute)) ?? PHOTON_TYPES[extension] ?? "application/octet-stream";
	}
	if (!MODEL_TYPES.has(mimeType)) {
		const png = await convertToPng(bytes.toString("base64"), mimeType);
		if (png === null) {
			return [{ type: "text", text: `Read image file [${mimeType}]\n[Image omitted: could not be converted to a supported inline image format.]` }];
		}
		bytes = Buffer.from(png.data, "base64");
		originalType = mimeType;
		mimeType = "image/png";
	}
	const resized = await resizeImage(new Uint8Array(bytes), mimeType, model?.inputLimits?.images?.resize);
	if (resized === null) {
		return [{ type: "text", text: `Read image file [${mimeType}]\n[Image omitted: could not be resized below the inline image size limit.]` }];
	}
	const lines = [`Read image file [${resized.mimeType}]`];
	if (originalType !== undefined && originalType !== resized.mimeType) lines.push(`[Image converted from ${originalType} to ${resized.mimeType}.]`);
	const dimensionNote = formatDimensionNote(resized);
	if (dimensionNote !== undefined) lines.push(dimensionNote);
	return [{ type: "text", text: lines.join("\n") }, { type: "image", data: resized.data, mimeType: resized.mimeType }];
}

/** The first frame as a full-size JPEG. pi's `resizeImage` scales it afterwards. */
async function ffmpegToJpeg(absolute: string): Promise<Buffer> {
	const dir = await mkdtemp(join(tmpdir(), "mochi-img-"));
	try {
		const out = join(dir, "view.jpg");
		await execute("/usr/bin/ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", "-i", absolute, "-frames:v", "1", "-q:v", "2", "-y", out], { timeout: 60_000 });
		return await readFile(out);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/** CodingTools with an image-aware `read`. */
export function mochiCodingTools(models: Models): Extension {
	return defineExtension({
		name: "coding-tools",
		tools: [createImageReadTool(models), createWriteTool(), createEditTool(), createBashTool()],
	});
}
