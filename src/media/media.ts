import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { MediaClient, type MediaDeps } from "./client.ts";

const PathResult = Type.Object({ path: Type.String() });

export function mediaFns(deps: MediaDeps): ToolRegistration[] {
	const client = new MediaClient(deps);
	return [
		defineTool({
			name: "image_gen",
			description: `Generate an image. Models: ${deps.config.images.providers.map((provider) => `${provider.name}${provider.name === deps.config.images.default ? " (default)" : ""}`).join(", ")}. model selects a provider name. edit is an input image path. Send the returned path with a standalone attach: <path> line.`,
			parameters: Type.Object({
				prompt: Type.String({ minLength: 1 }),
				size: Type.Optional(Type.String({ pattern: "^[1-9][0-9]{0,4}x[1-9][0-9]{0,4}$" })),
				model: Type.Optional(Type.String({ minLength: 1 })),
				edit: Type.Optional(Type.String({ minLength: 1 })),
			}),
			structuredOutputSchema: PathResult,
			replay: "unsafe",
			execute: async (args, _api, context) => ({ structuredOutput: await client.image(args, context.abortSignal) }),
		}),
		defineTool({
			name: "video_gen",
			description: "Generate an MP4 with the configured video model, poll and download. Costly, interrupted calls never rerun. Return a work-relative path; send it with a standalone attach: <path> line.",
			parameters: Type.Object({
				prompt: Type.String({ minLength: 1 }),
				seconds: Type.Optional(Type.Union(["4", "8", "12"].map((seconds) => Type.Literal(seconds)))),
				orientation: Type.Optional(Type.Union([Type.Literal("portrait"), Type.Literal("landscape")])),
			}),
			structuredOutputSchema: PathResult,
			replay: "unsafe",
			execute: async (args, _api, context) => ({ structuredOutput: await client.video(args, context.abortSignal) }),
		}),
		defineTool({
			name: "speak",
			description: "Speak text with the configured voice model. voice overrides the configured voice name. Save Opus in CAF, the format of an iMessage voice note. Return a work-relative path; send it with a standalone voice: <path> line as a voice note, or attach: <path> as a file.",
			parameters: Type.Object({ text: Type.String({ minLength: 1, maxLength: 2000 }), voice: Type.Optional(Type.String({ pattern: "^[a-z]+$" })) }),
			structuredOutputSchema: PathResult,
			replay: "unsafe",
			execute: async (args, _api, context) => ({ structuredOutput: await client.speak(args, context.abortSignal) }),
		}),
		defineTool({
			name: "transcribe",
			description: "Transcribe an audio or video file inside the work directory with the configured speech model. Return text.",
			parameters: Type.Object({ path: Type.String({ minLength: 1 }) }),
			structuredOutputSchema: Type.Object({ text: Type.String() }),
			replay: "safe",
			execute: async ({ path }, _api, context) => ({ structuredOutput: { text: (await client.transcript(path, context.abortSignal)).text } }),
		}),
	];
}
