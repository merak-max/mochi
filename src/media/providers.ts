import { Type, type Static } from "@earendil-works/pi-ai";
import { parseWith } from "../parse.ts";

const Connection = {
	baseUrl: Type.String({ minLength: 1 }),
	keyEnv: Type.String({ minLength: 1 }),
	model: Type.String({ minLength: 1 }),
};

const ImageProviderSchema = Type.Object({
	...Connection,
	name: Type.String({ minLength: 1 }),
	sizeStyle: Type.Optional(Type.Union([Type.Literal("size"), Type.Literal("width-height")])),
	edits: Type.Optional(Type.Boolean()),
});

export const MediaConfigSchema = Type.Object({
	images: Type.Object({
		default: Type.String(),
		providers: Type.Array(ImageProviderSchema),
	}),
	video: Type.Optional(Type.Object(Connection)),
	/** provider names a `[providers]` entry that serves the OpenAI audio API. */
	speech: Type.Optional(Type.Object({
		provider: Type.String({ minLength: 1 }),
		tts: Type.String({ minLength: 1 }),
		stt: Type.String({ minLength: 1 }),
		voice: Type.Optional(Type.String({ pattern: "^[a-z]+$" })),
	})),
});

export type ImageProvider = Static<typeof ImageProviderSchema>;
export type MediaConfig = Static<typeof MediaConfigSchema>;

export function parseMediaConfig(value: unknown): MediaConfig {
	const config = parseWith(MediaConfigSchema, value, "media configuration");
	const names = config.images.providers.map((provider) => provider.name);
	if (new Set(names).size !== names.length) throw new Error("Image provider names must be unique.");
	if (names.length > 0 && !names.includes(config.images.default)) throw new Error("Default image provider is not configured.");
	return config;
}
