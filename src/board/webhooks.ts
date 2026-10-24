import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Context } from "@earendil-works/chord";
import { readBody, safeEqual, validSha256Signature } from "../http.ts";
import type { WebhooksConfig } from "../config.ts";
import { log } from "../log.ts";
import type { Mochi } from "../mochi.ts";
import { BoardDoc, deliverWebhook, type WebhookAuth } from "./board.ts";

const BODY_LIMIT = 1024 * 1024;
const DELIVERY_HEADERS = ["x-github-delivery", "x-request-id", "webhook-id"];

type Headers = IncomingMessage["headers"];

const single = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);

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

function reply(response: ServerResponse, status: number, text: string): void {
	response.writeHead(status, { "content-type": "text/plain" });
	response.end(`${text}\n`);
}

/** A POST to /hooks/<id> starts one fire of board item <id> and answers 202 at once; the fire runs on its own. */
async function handle(mochi: Mochi, request: IncomingMessage, response: ServerResponse, context: Context): Promise<void> {
	const match = /^\/hooks\/([a-z0-9-]+)\/?$/.exec(new URL(request.url ?? "/", "http://hooks").pathname);
	if (request.method !== "POST" || match === null) return reply(response, 404, "not found");
	const id = match[1]!;
	const item = (await mochi.harness.snapshot(BoardDoc, context))?.items[id];
	if (item?.when === undefined || !("webhook" in item.when)) return reply(response, 404, "not found");
	const body = await readBody(request, response, BODY_LIMIT);
	if (body === undefined) return;
	if (!authorized(item.when.webhook.auth, request.headers, body)) {
		log("webhook.unauthorized", { id, remote: request.socket.remoteAddress });
		return reply(response, 401, "unauthorized");
	}
	const delivery = deliveryId(request.headers, body);
	const started = await mochi.harness.commit((tx) => deliverWebhook(tx, mochi.board, mochi.line.id, id, delivery, body.toString("utf8")), context);
	log("webhook.admitted", { id, delivery, duplicate: !started });
	reply(response, 202, "accepted");
}

export async function webhooksComponent(mochi: Mochi, config: WebhooksConfig, context: Context): Promise<void> {
	const server = createServer((request, response) => {
		handle(mochi, request, response, context).catch((error: unknown) => {
			log("webhook.failed", { url: request.url, error: String(error) });
			if (!response.headersSent) reply(response, 500, "internal error");
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(config.port, config.host, () => resolve());
	});
	context.abortSignal?.addEventListener("abort", () => server.close(), { once: true });
	const address = server.address() as AddressInfo;
	log("webhooks.started", { listen: `${address.address}:${address.port}`, url: config.url });
}
