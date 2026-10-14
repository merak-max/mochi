import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { promisify } from "node:util";
import { Type } from "@earendil-works/pi-ai";
import type { ToolExecutionResult, ToolRegistration } from "@earendil-works/pi-durable";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";

const execute = promisify(execFile);

const FFMPEG_EXTENSIONS = new Set([".heic", ".heif", ".avif", ".tif", ".tiff"]);

const ReadOutput = Type.Union([Type.String(), Type.Object({ type: Type.Literal("image"), data: Type.String(), mimeType: Type.String(), note: Type.String() })]);

function withScriptOutput(result: ToolExecutionResult): ToolExecutionResult {
	if (result.isError === true) return result;
	const note = (result.diagnostics ?? []).map((diagnostic) => diagnostic.message).join(" ");
	let text = "";
	for (const item of result.output ?? []) {
		if (item.type === "image") return { ...result, structuredOutput: { type: "image", data: item.data, mimeType: item.mimeType, note } };
		text += item.text;
	}
	return { ...result, structuredOutput: note === "" ? text : `${text}\n\n[${note}]` };
}

async function createImageReadTool(): Promise<ToolRegistration> {
	const base = createReadTool({ images: await createNodePhotonImages() }) as unknown as ToolRegistration;
	return {
		...base,
		structuredOutputSchema: ReadOutput,
		async execute(args, api, context) {
			const { path } = args as { path: string };
			if (!FFMPEG_EXTENSIONS.has(extname(path).toLowerCase()) || api.env === undefined) return withScriptOutput(await base.execute(args, api, context));
			const resolved = await api.env.absolutePath(path.startsWith("@") ? path.slice(1) : path, context);
			if (!resolved.ok) throw new Error(`Cannot resolve ${path}`);
			const dir = await mkdtemp(join(tmpdir(), "mochi-img-"));
			try {
				const jpeg = join(dir, "image.jpg");
				await execute("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", "-i", resolved.value, "-frames:v", "1", "-q:v", "2", "-y", jpeg], { timeout: 60_000 });
				const result = await base.execute({ ...(args as object), path: jpeg }, api, context);
				const converted = { severity: "info" as const, message: `Converted ${path} to JPEG with ffmpeg.` };
				return withScriptOutput({ ...result, diagnostics: [...(result.diagnostics ?? []), converted] });
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		},
	};
}

export async function codingTools(): Promise<ToolRegistration[]> {
	return [await createImageReadTool(), createWriteTool(), createEditTool(), createBashTool()] as unknown as ToolRegistration[];
}
