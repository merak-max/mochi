import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, unlink } from "node:fs/promises";
import { basename } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Type } from "@earendil-works/pi-ai";
import { providerEndpoint, type ProviderConfig } from "../brain/providers.ts";
import { parseWith } from "../parse.ts";
import { loadAttachment, mimeOf, outputPath, saveOutput, workPath } from "./files.ts";
import { parseMediaConfig, type MediaConfig, type ImageProvider } from "./providers.ts";

export interface MediaDeps {
	readonly workDir: string;
	readonly config: MediaConfig;
	readonly env: Readonly<Record<string, string | undefined>>;
	/** The `[providers]` table, where `media.speech.provider` finds its url and key. */
	readonly providers?: Readonly<Record<string, ProviderConfig>>;
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
const TranscriptReply = Type.Object({ text: Type.String(), duration: Type.Optional(Type.Number()) });

const execute = promisify(execFile);

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
		const response = await fetch(url, {
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
			const image = await loadAttachment(args.edit, this.deps.workDir);
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
		const image = reply.data[0]!;
		let bytes: Buffer;
		if ("b64_json" in image) {
			bytes = Buffer.from(image.b64_json, "base64");
		} else {
			const url = new URL(image.url);
			if (url.protocol !== "https:" || url.username || url.password) throw new Error("Image download URL must use HTTPS without credentials.");
			bytes = Buffer.from(await (await this.request(url.href, {}, signal)).arrayBuffer());
		}
		return saveOutput(this.deps.workDir, imageExtension(bytes), bytes);
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

	private async downloadVideo(id: string, signal?: AbortSignal): Promise<{ path: string }> {
		const provider = this.deps.config.video;
		if (!provider) throw new Error("No video provider configured.");
		const route = this.route(provider);
		const deadline = AbortSignal.timeout(8 * 60_000);
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
				await delay(5_000, undefined, { signal: bounded });
			}
		} catch (error) {
			throw new Error(`Video ${id} was not downloaded. ${error instanceof Error ? error.message : String(error)} Resume with this id, do not generate it again.`, { cause: error });
		}
	}

	private speech(): { base: string; headers: Record<string, string>; tts: string; stt: string; voice: string } {
		const speech = this.deps.config.speech;
		if (speech === undefined) throw new Error("Speech is not configured: set [media.speech] provider, tts, stt and voice.");
		const route = this.route(providerEndpoint(speech.provider, this.deps.providers));
		return { ...route, tts: speech.tts, stt: speech.stt, voice: speech.voice };
	}

	async speak(args: { text: string; voice?: string }, signal?: AbortSignal): Promise<{ path: string }> {
		const speech = this.speech();
		const response = await this.request(`${speech.base}/audio/speech`, {
			method: "POST", headers: { ...speech.headers, "content-type": "application/json" },
			body: JSON.stringify({ model: speech.tts, input: args.text, voice: args.voice ?? speech.voice, response_format: "aac" }),
		}, signal);
		const aac = await saveOutput(this.deps.workDir, "aac", new Uint8Array(await response.arrayBuffer()));
		const aacAbsolute = await workPath(aac.path, this.deps.workDir);
		const m4a = await outputPath(this.deps.workDir, "m4a");
		try {
			await execute("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", "-i", aacAbsolute, "-c:a", "copy", "-movflags", "+faststart", "-n", m4a.absolute], { ...(signal === undefined ? {} : { signal }), timeout: 60_000 });
			return { path: m4a.path };
		} catch (error) {
			await unlink(m4a.absolute).catch(() => {});
			throw error;
		} finally {
			await unlink(aacAbsolute).catch(() => {});
		}
	}

	async transcript(path: string, signal?: AbortSignal): Promise<{ text: string; duration?: number }> {
		const absolute = await workPath(path, this.deps.workDir);
		const speech = this.speech();
		const form = new FormData();
		form.set("model", speech.stt);
		form.set("file", new Blob([new Uint8Array(await readFile(absolute))], { type: mimeOf(path) }), basename(path));
		const response = await this.request(`${speech.base}/audio/transcriptions`, { method: "POST", headers: speech.headers, body: form }, signal);
		const reply = parseWith(TranscriptReply, await response.json(), "transcription response");
		return { text: reply.text, ...(reply.duration === undefined ? {} : { duration: reply.duration }) };
	}
}

function imageExtension(data: Buffer): string {
	if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "png";
	if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "jpg";
	if (data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP") return "webp";
	if (["GIF87a", "GIF89a"].includes(data.toString("ascii", 0, 6))) return "gif";
	if (data.toString("ascii", 4, 8) === "ftyp" && ["avif", "avis"].includes(data.toString("ascii", 8, 12))) return "avif";
	throw new Error("Image provider did not return a supported image format.");
}
