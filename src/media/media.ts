import { Type } from "@earendil-works/pi-ai";
import { defineFn, type ScriptFn } from "../code/code.ts";
import { MediaClient, type MediaDeps } from "./client.ts";

export { MediaClient, type MediaDeps } from "./client.ts";
export { splitAttachments, loadAttachment } from "./files.ts";
export { prepareInbound } from "./inbound.ts";
export { MediaConfigSchema, parseMediaConfig, type MediaConfig } from "./providers.ts";

const PathResult = Type.Object({ path: Type.String() });

export function mediaFns(deps: MediaDeps): ScriptFn[] {
	const client = new MediaClient(deps);
	return [
		defineFn({
			name: "image_gen",
			description: `Generate an image. Models: ${deps.config.images.providers.map((provider) => `${provider.name}${provider.name === deps.config.images.default ? " (default)" : ""}`).join(", ")}. model selects a provider name. edit is an input image path. Send the returned path with a standalone attach: <path> line.`,
			parameters: Type.Object({
				prompt: Type.String({ minLength: 1 }),
				size: Type.Optional(Type.String({ pattern: "^[1-9][0-9]{0,4}x[1-9][0-9]{0,4}$" })),
				model: Type.Optional(Type.String({ minLength: 1 })),
				edit: Type.Optional(Type.String({ minLength: 1 })),
			}),
			output: PathResult,
			replay: "once",
			run: async (args, _call, context) => ({ value: await client.image(args, context.abortSignal) }),
		}),
		defineFn({
			name: "video_gen",
			description: "Generate an MP4 with the configured video model, poll and download. Costly, interrupted calls never rerun. Return a work-relative path; send it with a standalone attach: <path> line.",
			parameters: Type.Object({
				prompt: Type.String({ minLength: 1 }),
				seconds: Type.Optional(Type.Union(["4", "8", "12"].map((seconds) => Type.Literal(seconds)))),
				orientation: Type.Optional(Type.Union([Type.Literal("portrait"), Type.Literal("landscape")])),
			}),
			output: PathResult,
			replay: "once",
			run: async (args, _call, context) => ({ value: await client.video(args, context.abortSignal) }),
		}),
		defineFn({
			name: "speak",
			description: "Speak English text with Deepgram Aura-2, default cordelia, a polite young female voice. Save AAC in M4A. Return a work-relative path; send it with a standalone attach: <path> line.",
			parameters: Type.Object({ text: Type.String({ minLength: 1, maxLength: 2000 }), voice: Type.Optional(Type.String({ pattern: "^[a-z]+$" })) }),
			output: PathResult,
			replay: "once",
			run: async (args, _call, context) => ({ value: await client.speak(args, context.abortSignal) }),
		}),
		defineFn({
			name: "transcribe",
			description: "Transcribe an audio or video file inside the work directory with Deepgram Nova-3. Return text.",
			parameters: Type.Object({ path: Type.String({ minLength: 1 }) }),
			output: Type.Object({ text: Type.String() }),
			replay: "read",
			run: async ({ path }, _call, context) => ({ value: { text: (await client.transcript(path, context.abortSignal)).text } }),
		}),
	];
}
