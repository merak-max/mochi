import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

/** Bytes read after a 413 before the connection is destroyed, as a multiple of the limit. */
const DRAIN_FACTOR = 2;

/**
 * The request body, or undefined when it is over `limit` bytes. Over the limit this function has already answered 413
 * with `connection: close`: at once for a declared Content-Length, otherwise once the streamed body passes the limit.
 * It then reads at most `DRAIN_FACTOR * limit` more bytes, and destroys the socket only once the reply is flushed, so the client always sees it.
 */
export function readBody(request: IncomingMessage, response: ServerResponse, limit: number): Promise<Buffer | undefined> {
	return new Promise((resolve, reject) => {
		const tooLarge = (): void => {
			resolve(undefined);
			request.removeAllListeners("data");
			request.removeAllListeners("end");
			if (!response.headersSent) response.writeHead(413, { "content-type": "text/plain", connection: "close" }).end("body too large\n");
			let drained = 0;
			const cut = (): void => {
				if (drained > DRAIN_FACTOR * limit && response.writableFinished) request.destroy();
			};
			response.on("finish", cut);
			request.on("data", (chunk: Buffer) => {
				drained += chunk.length;
				cut();
			});
			request.on("end", () => request.socket.destroySoon());
		};
		if (Number(request.headers["content-length"] ?? 0) > limit) return tooLarge();
		const chunks: Buffer[] = [];
		let size = 0;
		request.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > limit) return tooLarge();
			chunks.push(chunk);
		});
		request.on("end", () => resolve(Buffer.concat(chunks)));
		request.on("error", reject);
	});
}

/** Constant-time string comparison that does not leak length. */
export function safeEqual(given: string, expected: string): boolean {
	const a = createHash("sha256").update(given).digest();
	const b = createHash("sha256").update(expected).digest();
	return timingSafeEqual(a, b);
}

/** Whether `header` is the hex HMAC-SHA256 of `body` under `secret`, with or without a `sha256=` prefix. */
export function validSha256Signature(body: Uint8Array, header: string | undefined, secret: string): boolean {
	if (header === undefined) return false;
	const expected = createHmac("sha256", secret).update(body).digest("hex");
	return safeEqual(header.trim().replace(/^sha256=/i, "").toLowerCase(), expected);
}
