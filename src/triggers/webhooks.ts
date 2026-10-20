import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { ConversationBusy, type Harness } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { withCancel } from "@earendil-works/chord/context";
import { holdText } from "../context.ts";
import { readBody, safeEqual, validSha256Signature } from "../http.ts";
import type { Config } from "../config.ts";
import { type Log, log } from "../log.ts";
import type { Mochi } from "../mochi.ts";
import { pause } from "../pause.ts";
import type { Classify } from "../brain/classifier.ts";
import { applyAgent, type Profiles } from "../profiles/profiles.ts";
import { inputPasses, liveTrigger, parseSeeds, RUN_DEADLINE_MS, reconcileSeeds, runAgent } from "./trigger.ts";
import type { WebhookAuth } from "./types.ts";

const BODY_LIMIT = 1024 * 1024;
const DELIVERY_HEADERS = ["x-github-delivery", "x-request-id", "webhook-id"];

interface WebhookDeps {
	readonly harness: Pick<Harness, "commit" | "conversation">;
	readonly catalog: Profiles;
	readonly log: Log;
	readonly classify: Classify;
	readonly workDir: string;
}

type Headers = IncomingMessage["headers"];

function authorized(auth: WebhookAuth, headers: Headers, body: Buffer): boolean {
	if (auth.kind === "bearer") {
		const header = single(headers.authorization);
		return header !== undefined && header.startsWith("Bearer ") && safeEqual(header.slice(7), auth.token);
	}
	return validSha256Signature(body, single(headers[auth.header.toLowerCase()]), auth.secret);
}

function deliveryId(headers: Headers, body: Buffer): string {
	for (const name of DELIVERY_HEADERS) {
		const value = single(headers[name])?.trim();
		if (value) return value;
	}
	return createHash("sha256").update(body).digest("hex");
}

function webhookContent(id: string, prompt: string, body: string): string {
	return `${prompt}\n<webhook_payload source="${id}">\n${body}\n</webhook_payload>`;
}

const single = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);

async function startWebhookServer(
	deps: WebhookDeps,
	listen: { readonly host: string; readonly port: number },
	context: Context,
): Promise<{ readonly server: Server; readonly address: AddressInfo }> {
	const server = createServer((request, response) => {
		handle(deps, request, response, context).catch((error: unknown) => {
			deps.log("webhook.failed", { url: request.url, error: String(error) });
			if (!response.headersSent) reply(response, 500, "internal error");
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(listen.port, listen.host, () => resolve());
	});
	context.abortSignal?.addEventListener("abort", () => server.close(), { once: true });
	return { server, address: server.address() as AddressInfo };
}

async function handle(deps: WebhookDeps, request: IncomingMessage, response: ServerResponse, context: Context): Promise<void> {
	const match = /^\/hooks\/([a-z0-9-]+)\/?$/.exec(new URL(request.url ?? "/", "http://hooks").pathname);
	if (request.method !== "POST" || match === null) return reply(response, 404, "not found");
	const id = match[1] ?? "";
	const found = await deps.harness.commit((tx) => liveTrigger(tx, id), context);
	const trigger = found?.input.trigger;
	if (found === undefined || trigger?.kind !== "webhook") return reply(response, 404, "not found");

	const body = await readBody(request, response, BODY_LIMIT);
	if (body === undefined) return;

	if (!authorized(trigger.auth, request.headers, body)) {
		deps.log("webhook.unauthorized", { id, remote: request.socket.remoteAddress });
		return reply(response, 401, "unauthorized");
	}
	const delivery = deliveryId(request.headers, body);
	const requestId = `webhook:${id}:${delivery}`;
	const memo = new Map<string, number>();
	const remember = async (key: string, value?: number) => (value === undefined ? memo.get(key) : (memo.set(key, value), value));
	if (!(await inputPasses(trigger, body.toString("utf8"), deps.classify, remember, deps.log, context))) return reply(response, 202, "accepted");
	const run = await runAgent(trigger, deps.catalog);
	await deps.harness.commit((tx) => applyAgent(tx, found.conversationId, run), context);
	const conversation = await deps.harness.conversation(found.conversationId, context);
	try {
		const content = await holdText(deps.harness, deps.workDir, found.conversationId, `in:${requestId}`, webhookContent(id, trigger.prompt, body.toString("utf8")), context);
		const submission = await conversation!.submit({ type: "input", content, requestId, whenBusy: "reject" }, context);
		deps.log("webhook.admitted", { id, delivery, submissionId: submission.id });
		reply(response, 202, "accepted");
		const race = withCancel(context);
		const settled = await Promise.race([submission.wait(race.context), pause(RUN_DEADLINE_MS, race.context.abortSignal).then(() => undefined)]).finally(() => race.cancel());
		if (settled === undefined && !context.abortSignal?.aborted) {
			await conversation!.abort(context);
			deps.log("webhook.timed_out", { id, delivery });
		}
	} catch (error) {
		if (!(error instanceof ConversationBusy)) throw error;
		return reply(response, 503, "busy");
	}
}

function reply(response: ServerResponse, status: number, text: string): void {
	response.writeHead(status, { "content-type": "text/plain" });
	response.end(`${text}\n`);
}

export async function triggersComponent({ harness, trigger, catalog, classify, line }: Mochi, config: Config, context: Context): Promise<void> {
	const seeds = parseSeeds(config.file, config.users);
	await reconcileSeeds(harness, trigger, seeds, catalog, context);
	const listen = { host: config.env.MOCHI_BIND_HOST || "127.0.0.1", port: Number(config.env.MOCHI_HOOKS_PORT || 8788) };
	const { address } = await startWebhookServer({ harness, catalog, log, classify, workDir: line.workDir }, listen, context);
	log("triggers.started", { seeds: seeds.map((seed) => seed.id), hooks: `${address.address}:${address.port}` });
}
