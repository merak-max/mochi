import { Type } from "typebox";
import { parseWith } from "../parse.ts";

const Reply = Type.Object({
	id: Type.Optional(Type.Integer()),
	result: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
	error: Type.Optional(Type.Object({ message: Type.String() }, { additionalProperties: true })),
}, { additionalProperties: true });

export class Cdp {
	readonly #socket: WebSocket;
	readonly #pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (reason: Error) => void; timer: NodeJS.Timeout }>();
	#next = 0;

	private constructor(socket: WebSocket) {
		this.#socket = socket;
		socket.addEventListener("message", (event) => {
			try {
				const reply = parseWith(Reply, JSON.parse(String(event.data)), "CDP reply");
				if (reply.id === undefined) return;
				const pending = this.#pending.get(reply.id);
				if (pending === undefined) return;
				clearTimeout(pending.timer);
				this.#pending.delete(reply.id);
				if (reply.error) pending.reject(new Error(reply.error.message));
				else pending.resolve(reply.result ?? {});
			} catch {
				this.#fail(new Error("Invalid CDP reply."));
			}
		});
		socket.addEventListener("close", () => this.#fail(new Error("CDP connection closed.")));
		socket.addEventListener("error", () => this.#fail(new Error("CDP connection failed.")));
	}

	static async connect(url: string): Promise<Cdp> {
		const socket = new WebSocket(url);
		const cdp = new Cdp(socket);
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => { socket.close(); reject(new Error("CDP connection timed out.")); }, 20_000);
			socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
			socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("CDP connection failed.")); }, { once: true });
		});
		return cdp;
	}

	call(method: string, params: object = {}, sessionId?: string): Promise<Record<string, unknown>> {
		const id = ++this.#next;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => { this.#pending.delete(id); reject(new Error(`CDP ${method} timed out.`)); }, 20_000);
			this.#pending.set(id, { resolve, reject, timer });
			this.#socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }));
		});
	}

	async evaluate(expression: string, sessionId: string): Promise<unknown> {
		const reply = await this.call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
		if (reply.exceptionDetails !== undefined) throw new Error("Browser document changed during evaluation.");
		return parseWith(Type.Object({ result: Type.Object({ value: Type.Optional(Type.Unknown()) }, { additionalProperties: true }) }, { additionalProperties: true }), reply, "CDP evaluation").result.value;
	}

	close(): void {
		this.#fail(new Error("CDP connection closed."));
		this.#socket.close();
	}

	#fail(error: Error): void {
		for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
		this.#pending.clear();
	}
}
