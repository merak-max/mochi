import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, unlink } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { basename } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { parseWith } from "../parse.ts";
import { mimeOf, outputPath, saveOutput, workPath } from "./files.ts";
import { parseMediaConfig, type MediaConfig, type ImageProvider } from "./providers.ts";

export interface MediaDeps {
	readonly workDir: string;
	readonly config: MediaConfig;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly fetch?: typeof fetch;
	readonly deepgramEndpoint?: string;
	readonly pollMs?: number;
	readonly videoTimeoutMs?: number;
}

const ImageReply = Type.Object({ data: Type.Array(Type.Union([
	Type.Object({ b64_json: Type.String({ minLength: 1 }) }),
	Type.Object({ url: Type.String({ minLength: 1 }) }),
]), { minItems: 1 }) });
const VideoReply = Type.Object({
	id: Type.String({ minLength: 1 }),
	status: Type.Union(["queued", "in_progress", "completed", "failed"].map((status) => Type.Literal(status))),
	error: Type.Optional(Type.Union([Type.Null(), Type.Object({ message: Type.String() })])),
});
const TranscriptReply = Type.Object({
	metadata: Type.Optional(Type.Object({ duration: Type.Optional(Type.Number()) })),
	results: Type.Object({ channels: Type.Array(Type.Object({ alternatives: Type.Array(Type.Object({ transcript: Type.String() }), { minItems: 1 }) }), { minItems: 1 }) }),
});

const execute = promisify(execFile);
export const DEFAULT_VOICE = "cordelia";

export class MediaClient {
	private readonly deps: MediaDeps;

	constructor(deps: MediaDeps) {
		this.deps = { ...deps, config: parseMediaConfig(deps.config) };
	}

	private route(provider: { baseUrl: string; keyEnv: string }): { base: string; headers: Record<string, string> } {
		const key = this.deps.env[provider.keyEnv];
		if (!key) throw new Error(`Media provider is not configured: ${provider.keyEnv} is unset.`);
		const url = new URL(provider.baseUrl);
		if (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "localhost")) throw new Error("Media endpoint must use HTTPS.");
		return { base: provider.baseUrl.replace(/\/$/, ""), headers: { Authorization: `Bearer ${key}` } };
	}

	private imageProvider(name?: string): ImageProvider {
		const selected = name ?? this.deps.config.images.default;
		const provider = this.deps.config.images.providers.find((candidate) => candidate.name === selected);
		if (!provider) throw new Error(`No image provider configured with name ${selected}.`);
		return provider;
	}

	private async request(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
		const timeout = AbortSignal.timeout(120_000);
		const response = await (this.deps.fetch ?? fetch)(url, {
			...init, signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
		});
		if (!response.ok) {
			await response.body?.cancel();
			throw new Error(`Media request failed (HTTP ${response.status}) at ${new URL(url).pathname}.`);
		}
		return response;
	}

	async image(args: { prompt: string; size?: string; model?: string; edit?: string }, signal?: AbortSignal): Promise<{ path: string }> {
		const provider = this.imageProvider(args.model);
		const route = this.route(provider);
		const size = args.size ?? "1024x1024";
		if (!/^[1-9][0-9]{0,4}x[1-9][0-9]{0,4}$/.test(size)) throw new Error("Image size must be WIDTHxHEIGHT.");
		const [width, height] = size.split("x").map(Number);
		const dimensions = provider.sizeStyle === "width-height" ? { width, height } : { size };
		let body: BodyInit;
		let headers = route.headers;
		if (args.edit !== undefined) {
			if (!provider.edits) throw new Error(`Image provider ${provider.name} does not support edits.`);
			const image = await loadImage(args.edit, this.deps.workDir);
			const form = new FormData();
			form.set("model", provider.model);
			form.set("prompt", args.prompt);
			form.set("n", "1");
			for (const [key, value] of Object.entries(dimensions)) form.set(key, String(value));
			form.set("image", new Blob([new Uint8Array(image.bytes)], { type: image.mimeType }), image.name);
			body = form;
		} else {
			headers = { ...headers, "content-type": "application/json" };
			body = JSON.stringify({ model: provider.model, prompt: args.prompt, ...dimensions, n: 1 });
		}
		const response = await this.request(`${route.base}/images/${args.edit === undefined ? "generations" : "edits"}`, { method: "POST", headers, body }, signal);
		const reply = parseWith(ImageReply, await response.json(), "image response");
		const image = reply.data[0];
		if (image === undefined) throw new Error("Image response is empty.");
		let bytes: Buffer;
		if ("b64_json" in image) {
			bytes = Buffer.from(image.b64_json, "base64");
		} else {
			const url = new URL(image.url);
			if (url.protocol !== "https:" || url.username || url.password) throw new Error("Image download URL must use HTTPS without credentials.");
			bytes = Buffer.from(await (await this.request(url.href, {}, signal)).arrayBuffer());
		}
		const extension = imageExtension(bytes);
		return saveOutput(this.deps.workDir, extension, bytes);
	}

	async video(args: { prompt: string; seconds?: "4" | "8" | "12"; orientation?: "portrait" | "landscape" }, signal?: AbortSignal): Promise<{ path: string }> {
		const provider = this.deps.config.video;
		if (!provider) throw new Error("No video provider configured.");
		const route = this.route(provider);
		const response = await this.request(`${route.base}/videos`, {
			method: "POST", headers: { ...route.headers, "content-type": "application/json" },
			body: JSON.stringify({ model: provider.model, prompt: args.prompt, seconds: args.seconds ?? "4", size: args.orientation === "portrait" ? "720x1280" : "1280x720" }),
		}, signal);
		const video = parseWith(VideoReply, await response.json(), "video creation response");
		return this.downloadVideo(video.id, signal);
	}

	async downloadVideo(id: string, signal?: AbortSignal): Promise<{ path: string }> {
		const provider = this.deps.config.video;
		if (!provider) throw new Error("No video provider configured.");
		const route = this.route(provider);
		const deadline = AbortSignal.timeout(this.deps.videoTimeoutMs ?? 8 * 60_000);
		const bounded = signal === undefined ? deadline : AbortSignal.any([signal, deadline]);
		const url = `${route.base}/videos/${encodeURIComponent(id)}`;
		try {
			for (;;) {
				const response = await this.request(url, { headers: route.headers }, bounded);
				const video = parseWith(VideoReply, await response.json(), "video status response");
				if (video.status === "failed") throw new Error(`Video ${id} failed: ${video.error?.message ?? "provider failure"}`);
				if (video.status === "completed") {
					const content = await this.request(`${url}/content?variant=video`, { headers: route.headers }, bounded);
					return saveOutput(this.deps.workDir, "mp4", new Uint8Array(await content.arrayBuffer()));
				}
				await delay(this.deps.pollMs ?? 5_000, undefined, { signal: bounded });
			}
		} catch (error) {
			throw new Error(`Video ${id} was not downloaded. ${error instanceof Error ? error.message : String(error)} Resume with this id, do not generate it again.`, { cause: error });
		}
	}

	private deepgram(): { base: string; headers: Record<string, string> } {
		const keyEnv = this.deps.config.speech?.deepgramKeyEnv;
		const key = keyEnv === undefined ? undefined : this.deps.env[keyEnv];
		if (!key) throw new Error(`Deepgram is not configured: ${keyEnv ?? "speech.deepgramKeyEnv"} is unset.`);
		return { base: (this.deps.deepgramEndpoint ?? "https://api.deepgram.com").replace(/\/$/, ""), headers: { Authorization: `Token ${key}` } };
	}

	async speak(args: { text: string; voice?: string }, signal?: AbortSignal): Promise<{ path: string }> {
		const voice = args.voice ?? DEFAULT_VOICE;
		if (!/^[a-z]+$/.test(voice)) throw new Error("Voice must be an Aura-2 English voice name, such as cordelia.");
		const route = this.deepgram();
		const response = await this.request(`${route.base}/v1/speak?model=aura-2-${voice}-en&encoding=mp3`, {
			method: "POST", headers: { ...route.headers, "content-type": "application/json" }, body: JSON.stringify({ text: args.text }),
		}, signal);
		const mp3 = await saveOutput(this.deps.workDir, "mp3", new Uint8Array(await response.arrayBuffer()));
		const m4a = await outputPath(this.deps.workDir, "m4a");
		try {
			await execute("/usr/bin/ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", "-i", await workPath(mp3.path, this.deps.workDir), "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", "-n", m4a.absolute], { ...(signal === undefined ? {} : { signal }), timeout: 60_000 });
			return { path: m4a.path };
		} catch (error) {
			await unlink(m4a.absolute).catch(() => {});
			throw error;
		} finally {
			await unlink(await workPath(mp3.path, this.deps.workDir)).catch(() => {});
		}
	}

	async transcript(path: string, signal?: AbortSignal): Promise<{ text: string; duration?: number }> {
		const absolute = await workPath(path, this.deps.workDir);
		const route = this.deepgram();
		const response = await this.request(`${route.base}/v1/listen?model=nova-3&smart_format=true&detect_language=true`, {
			method: "POST", headers: { ...route.headers, "content-type": mimeOf(path) }, body: await readFile(absolute),
		}, signal);
		const reply = parseWith(TranscriptReply, await response.json(), "transcription response");
		const first = reply.results.channels[0]?.alternatives[0];
		if (first === undefined) throw new Error("Transcription response is empty.");
		const duration = reply.metadata?.duration;
		return { text: first.transcript, ...(duration === undefined ? {} : { duration }) };
	}
}

async function loadImage(path: string, workDir: string): Promise<{ bytes: Buffer; name: string; mimeType: string }> {
	return { bytes: await readFile(await workPath(path, workDir)), name: basename(path), mimeType: mimeOf(path) };
}

function imageExtension(bytes: Uint8Array): string {
	const data = Buffer.from(bytes);
	if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "png";
	if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "jpg";
	if (data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP") return "webp";
	if (["GIF87a", "GIF89a"].includes(data.toString("ascii", 0, 6))) return "gif";
	if (data.toString("ascii", 4, 8) === "ftyp" && ["avif", "avis"].includes(data.toString("ascii", 8, 12))) return "avif";
	throw new Error("Image provider did not return a supported image format.");
}
