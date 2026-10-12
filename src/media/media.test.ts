import { strict as assert } from "node:assert";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { copyFile, mkdtemp, readFile, writeFile, symlink, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { createRegistry, defineExtension, Harness } from "@earendil-works/pi-durable";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { FAUX, newFaux } from "../test-support.ts";
import { messageText } from "../text.ts";
import { loadAttachment, splitAttachments, workPath } from "./files.ts";
import { MediaClient, mediaFns, prepareInbound, parseMediaConfig, type MediaDeps } from "./media.ts";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8WQAAAAASUVORK5CYII=", "base64");
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const depsOf = (workDir: string, network: typeof fetch): MediaDeps => ({
	workDir, config: { images: { default: "mai", providers: [
		{ name: "mai", baseUrl: "https://si.example/mai/v1", keyEnv: "IMAGE_KEY", model: "mai-image-2.6", edits: true },
		{ name: "sunburst", baseUrl: "https://media.example/openai/v1", keyEnv: "BEST_KEY", model: "gpt-image-2.5-sunburst", edits: true },
	] }, video: { baseUrl: "https://media.example/openai/v1", keyEnv: "VIDEO_KEY", model: "sora-2" }, speech: { deepgramKeyEnv: "SPEECH_KEY" } },
	env: { IMAGE_KEY: "si-key", BEST_KEY: "media-key", VIDEO_KEY: "media-key", SPEECH_KEY: "dg-key" }, fetch: network, pollMs: 1,
});
async function temporary(t: { after(fn: () => Promise<unknown>): void }): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "mochi-media-test-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

test("standalone attachment lines become ordered file bubbles and prose stays intact", async (t) => {
	const dir = await temporary(t);
	await writeFile(join(dir, "clip.M4A"), Buffer.from([1, 2, 3]));
	assert.deepEqual(splitAttachments("hello\r\n attach: clip.M4A \r\ninline attach: nope\r\nattach: out/a.png"), {
		text: "hello\ninline attach: nope", attachments: ["clip.M4A", "out/a.png"],
	});
	assert.deepEqual(await loadAttachment("clip.M4A", dir), { kind: "file", name: "clip.M4A", mimeType: "audio/mp4", bytes: Buffer.from([1, 2, 3]) });
});

test("paths reject traversal, absolute paths and symlink escapes including output", async (t) => {
	const dir = await temporary(t);
	const outside = await temporary(t);
	await writeFile(join(outside, "secret"), "outside");
	await symlink(join(outside, "secret"), join(dir, "link"));
	await symlink(outside, join(dir, "out"));
	for (const path of ["../secret", join(outside, "secret"), "link"]) await assert.rejects(workPath(path, dir), /work directory/);
	let requests = 0;
	const client = new MediaClient(depsOf(dir, async () => { requests++; return json({ data: [{ b64_json: PNG.toString("base64") }] }); }));
	await assert.rejects(client.image({ prompt: "x", edit: "link" }), /work directory/);
	assert.equal(requests, 0);
	await assert.rejects(client.image({ prompt: "x" }), /work directory/);
	assert.deepEqual(await readdir(outside), ["secret"]);
});

test("images use configured provider names, Bearer auth, OpenAI bodies and multipart edits", async (t) => {
	const dir = await temporary(t);
	await writeFile(join(dir, "input.png"), PNG);
	const requests: { url: string; init: RequestInit }[] = [];
	const client = new MediaClient(depsOf(dir, async (url, init) => {
		assert.ok(init); requests.push({ url: String(url), init });
		return json({ data: [{ b64_json: PNG.toString("base64") }] });
	}));
	const generated = await client.image({ prompt: "mochi", size: "1536x1024" });
	assert.deepEqual(await readFile(join(dir, generated.path)), PNG);
	const first = requests[0]!;
	assert.equal(first.url, "https://si.example/mai/v1/images/generations");
	assert.deepEqual(JSON.parse(String(first.init.body)), { model: "mai-image-2.6", prompt: "mochi", size: "1536x1024", n: 1 });
	assert.equal(new Headers(first.init.headers).get("authorization"), "Bearer si-key");
	await client.image({ prompt: "best", model: "sunburst" });
	assert.deepEqual(JSON.parse(String(requests[1]!.init.body)), { model: "gpt-image-2.5-sunburst", prompt: "best", size: "1024x1024", n: 1 });
	await client.image({ prompt: "edit", model: "sunburst", edit: "input.png" });
	const edit = requests[2]!;
	assert.equal(edit.url, "https://media.example/openai/v1/images/edits");
	assert.ok(edit.init.body instanceof FormData);
	assert.equal(edit.init.body.get("prompt"), "edit");
	assert.equal(edit.init.body.get("size"), "1024x1024");
	assert.equal(new Headers(edit.init.headers).get("content-type"), null);
	const file = edit.init.body.get("image");
	assert.ok(file instanceof File);
	assert.deepEqual(Buffer.from(await file.arrayBuffer()), PNG);
	await client.image({ prompt: "edit MAI", edit: "input.png" });
	const maiEdit = requests[3]!;
	assert.equal(maiEdit.url, "https://si.example/mai/v1/images/edits");
	assert.ok(maiEdit.init.body instanceof FormData);
	assert.equal(maiEdit.init.body.get("model"), "mai-image-2.6");
	assert.equal(maiEdit.init.body.get("width"), null);
	assert.equal(maiEdit.init.body.get("height"), null);
});

test("provider errors and malformed images write no output and missing keys fail clearly", async (t) => {
	const dir = await temporary(t);
	await assert.rejects(new MediaClient(depsOf(dir, async () => json({ data: [{ b64_json: PNG.toString("base64") }] }, 429))).image({ prompt: "x" }), /Media request failed \(HTTP 429\)/);
	for (const reply of [json({ data: [] }), json({ data: [{ b64_json: "not png" }] })]) {
		await assert.rejects(new MediaClient(depsOf(dir, async () => reply)).image({ prompt: "x" }), /Invalid image response|supported image format/);
	}
	await assert.rejects(new MediaClient({ ...depsOf(dir, async () => json({})), env: {} }).image({ prompt: "x" }), /IMAGE_KEY/);
	assert.deepEqual(await readdir(dir), []);
});

test("video polls direct bare ids, downloads variant video, reports failures and cancels", async (t) => {
	const dir = await temporary(t);
	const requests: string[] = [];
	let polls = 0;
	const client = new MediaClient(depsOf(dir, async (url, init) => {
		const path = String(url); requests.push(path);
		assert.equal(new Headers(init?.headers).get("authorization"), "Bearer media-key");
		if (init?.method === "POST") {
			assert.deepEqual(JSON.parse(String(init.body)), { model: "sora-2", prompt: "tea", seconds: "8", size: "720x1280" });
			return json({ id: "video_abc", status: "queued" });
		}
		if (path.endsWith("content?variant=video")) return new Response(Buffer.from("mp4-content"));
		return json({ id: "video_abc", status: ++polls === 1 ? "in_progress" : "completed" });
	}));
	const result = await client.video({ prompt: "tea", seconds: "8", orientation: "portrait" });
	assert.equal((await readFile(join(dir, result.path))).toString(), "mp4-content");
	assert.deepEqual(requests, ["https://media.example/openai/v1/videos", "https://media.example/openai/v1/videos/video_abc", "https://media.example/openai/v1/videos/video_abc", "https://media.example/openai/v1/videos/video_abc/content?variant=video"]);
	await assert.rejects(new MediaClient(depsOf(dir, async () => json({ id: "v", status: "failed", error: { message: "blocked" } }))).downloadVideo("v"), /Video v was not downloaded/);
	const controller = new AbortController();
	const cancelled = new MediaClient(depsOf(dir, async () => { controller.abort(); return json({ id: "v", status: "queued" }); }));
	await assert.rejects(cancelled.downloadVideo("v", controller.signal), /do not generate it again/);
});

test("Aura speech becomes AAC M4A and Nova sends bytes with a transcript", async (t) => {
	const dir = await temporary(t);
	const wav = join(dir, "sample.wav");
	await promisify(execFile)("ffmpeg", ["-nostdin", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.1", wav]);
	const audio = await readFile(wav);
	const client = new MediaClient(depsOf(dir, async (url, init) => {
		assert.equal(new Headers(init?.headers).get("authorization"), "Token dg-key");
		if (String(url).includes("/speak")) {
			assert.equal(String(url), "https://api.deepgram.com/v1/speak?model=aura-2-cordelia-en&encoding=mp3");
			assert.deepEqual(JSON.parse(String(init?.body)), { text: "Tea." });
			return new Response(audio);
		}
		assert.equal(String(url), "https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&detect_language=true");
		assert.equal(new Headers(init?.headers).get("content-type"), "audio/mp4");
		assert.ok(Buffer.isBuffer(init?.body));
		assert.ok(init.body.length > 0);
		return json({ metadata: { duration: 0.1 }, results: { channels: [{ alternatives: [{ transcript: "Tea." }] }] } });
	}));
	const spoken = await client.speak({ text: "Tea." });
	assert.ok(spoken.path.endsWith(".m4a"));
	const probe = await promisify(execFile)("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name", "-of", "csv=p=0", join(dir, spoken.path)]);
	assert.equal(probe.stdout.trim(), "aac");
	assert.deepEqual(await client.transcript(spoken.path), { text: "Tea.", duration: 0.1 });
	assert.equal((await readdir(join(dir, "out"))).filter((name) => name.endsWith(".mp3")).length, 0);
	await assert.rejects(client.speak({ text: "x", voice: "../nope" }), /Voice must/);
});

test("inbound media preserves originals, exposes voice text and degrades failures to file notes", async (t) => {
	const dir = await temporary(t);
	await writeFile(join(dir, "image.png"), PNG);
	await writeFile(join(dir, "note.m4a"), "voice");
	await writeFile(join(dir, "broken.heic"), "not heic");
	const deps = depsOf(dir, async () => json({ metadata: { duration: 12.2 }, results: { channels: [{ alternatives: [{ transcript: "Bring tea." }] }] } }));
	const files = [
		{ path: "image.png", mimeType: "image/png", kind: "image", bytes: PNG.length },
		{ path: "note.m4a", mimeType: "audio/mp4", kind: "audio", bytes: 5 },
		{ path: "broken.heic", mimeType: "image/heic", kind: "image", bytes: 8 },
	] satisfies Parameters<typeof prepareInbound>[0];
	const prepared = await prepareInbound(files, dir, deps);
	assert.deepEqual(prepared.images, [{ type: "image", mimeType: "image/png", data: PNG.toString("base64") }]);
	assert.deepEqual(prepared.notes, ['[voice note, 12 s: "Bring tea.", saved at note.m4a]', "[image attachment image/heic, 8 bytes, saved at broken.heic]"]);
	assert.equal((await readFile(join(dir, "note.m4a"))).toString(), "voice");
	await copyFile(join(import.meta.dirname, "fixtures", "grid.heic"), join(dir, "grid.heic"));
	const photo = await prepareInbound([{ path: "grid.heic", mimeType: "image/heic", kind: "image", bytes: 5512 }], dir, deps);
	const jpeg = Buffer.from(photo.images[0]!.data, "base64");
	const size = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", "-"], { input: jpeg }).toString().trim();
	assert.equal(size, "640,480", "every tile of a HEIC grid, not the first one");
	const failed = await prepareInbound([files[1]!], dir, { ...deps, fetch: async () => json({}, 500) });
	assert.deepEqual(failed.notes, ["[audio attachment audio/mp4, 5 bytes, saved at note.m4a]"]);
});

test("costly media calls are unsafe to replay: a restart mid-call reports them interrupted and never calls a provider again", async (t) => {
	const dir = await temporary(t);
	let calls = 0;
	let started = (): void => {};
	const fns = mediaFns(depsOf(dir, async (_url, init) => {
		calls++;
		if (calls === 3) started();
		await new Promise<void>((resolve) => init?.signal?.addEventListener("abort", () => resolve(), { once: true }));
		throw new Error("cancelled by harness close");
	}));
	assert.deepEqual(fns.map((fn) => [fn.name, fn.replay]), [["image_gen", "unsafe"], ["video_gen", "unsafe"], ["speak", "unsafe"], ["transcribe", "safe"]]);
	const registry = createRegistry();
	const extensions = [
		createCodemodeExtension({ sandbox: new CodemodeSandbox({ memoryLimitBytes: 64 * 1024 * 1024 }), models: false }),
		defineExtension({ name: "test-media", tools: fns.map((fn) => ({ ...fn, callers: ["tools" as const] })) }),
	];
	for (const extension of extensions) registry.install(extension);
	const faux = newFaux();
	const models = createModels();
	models.setProvider(faux.provider);
	const script = `const settled = (p) => p.catch((error) => error.message);
return await Promise.all([
	settled(tools.image_gen({ prompt: "tea" })),
	settled(tools.video_gen({ prompt: "tea" })),
	settled(tools.speak({ text: "tea" })),
]);`;
	faux.setResponses([fauxAssistantMessage(fauxToolCall("codemode", { code: script }), { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
	const database = join(dir, "media.sqlite");
	const open = async () => Harness.open(await openNodeSqliteStorage(database), { registry, models, settings: { extensions } }, BACKGROUND_CONTEXT);
	const first = await open();
	const root = await first.root(BACKGROUND_CONTEXT, { agent: { model: FAUX } });
	const begun = new Promise<void>((resolve) => { started = resolve; });
	const submitted = await root.submit({ type: "input", content: "make media" }, BACKGROUND_CONTEXT);
	await begun;
	await first.close(BACKGROUND_CONTEXT);

	const recovered = await open();
	t.after(() => recovered.close(BACKGROUND_CONTEXT));
	recovered.resume();
	assert.equal((await (await recovered.submission(submitted.id, BACKGROUND_CONTEXT))!.wait(BACKGROUND_CONTEXT)).status, "done");
	const after = await recovered.root(BACKGROUND_CONTEXT);
	const entry = (await after.entries({}, 50, undefined, BACKGROUND_CONTEXT)).items.find((each) => each.kind === "pi.tool-result");
	const text = messageText(entry!.model![0]!);
	assert.match(text, /^Script completed\n/);
	assert.match(text, /\["Tool image_gen was interrupted and may have partially run","Tool video_gen was interrupted and may have partially run","Tool speak was interrupted and may have partially run"\]/);
	assert.equal(calls, 3);
});

test("image URLs preserve JPEG and WebP bytes without leaking provider credentials", async (t) => {
	const dir = await temporary(t);
	for (const [bytes, extension] of [
		[Buffer.from([0xff, 0xd8, 0xff, 0xe0]), "jpg"],
		[Buffer.from("RIFF0000WEBPVP8 "), "webp"],
	] as const) {
		const client = new MediaClient(depsOf(dir, async (url, init) => {
			if (String(url).includes("/images/generations")) return json({ data: [{ url: "https://cdn.example/result" }] });
			assert.equal(String(url), "https://cdn.example/result");
			assert.equal(new Headers(init?.headers).get("authorization"), null);
			return new Response(bytes);
		}));
		const result = await client.image({ prompt: "x" });
		assert.ok(result.path.endsWith(`.${extension}`));
		assert.deepEqual(await readFile(join(dir, result.path)), bytes);
	}
});

test("new providers and width-height behavior require configuration only", async (t) => {
	const dir = await temporary(t);
	const deps = depsOf(dir, async (_url, init) => {
		assert.deepEqual(JSON.parse(String(init?.body)), { model: "future-model", prompt: "x", width: 768, height: 1280, n: 1 });
		return json({ data: [{ b64_json: PNG.toString("base64") }] });
	});
	deps.config.images.providers.push({ name: "future", baseUrl: "https://future.example/v1", keyEnv: "IMAGE_KEY", model: "future-model", sizeStyle: "width-height" });
	const client = new MediaClient(deps);
	await client.image({ prompt: "x", model: "future", size: "768x1280" });
	await assert.rejects(client.image({ prompt: "x", model: "future", edit: "no-file.png" }), /does not support edits/);
	await assert.rejects(client.image({ prompt: "x", model: "unconfigured" }), /No image provider/);
	assert.match(mediaFns(deps)[0]!.description, /mai \(default\), sunburst, future/);
});

test("media configuration is parsed at the boundary and rejects ambiguous names", () => {
	assert.throws(() => parseMediaConfig({}), /Invalid media configuration/);
	assert.throws(() => parseMediaConfig({ images: { default: "missing", providers: [{ name: "x", baseUrl: "https://x.example", keyEnv: "KEY", model: "x" }] } }), /Default image provider/);
	assert.throws(() => parseMediaConfig({ images: { default: "x", providers: [
		{ name: "x", baseUrl: "https://x.example", keyEnv: "KEY", model: "x" },
		{ name: "x", baseUrl: "https://y.example", keyEnv: "KEY", model: "y" },
	] } }), /names must be unique/);
});

