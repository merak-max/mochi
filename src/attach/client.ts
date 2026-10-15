import { connect, type Socket } from "node:net";
import { applyImmutable } from "@earendil-works/chord/delta";
import type { ConversationView, TaskGraph } from "@earendil-works/pi-durable";
import { type DaemonInfo, PROTOCOL, parseServerMessage, readLines, type Request, type Results, type ServerMessage, writeLine } from "./protocol.ts";

/** The daemon did not answer as mochi: an old daemon, another protocol, or a bad frame. Not the same as no daemon. */
export class ProtocolError extends Error {}

export class AttachClient {
	readonly #socket: Socket;
	readonly #waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
	readonly #listeners = new Set<() => void>();
	#sequence = 0;
	#failure: string | undefined;
	view: ConversationView | undefined;
	tasks: TaskGraph | undefined;
	daemon: DaemonInfo | undefined;
	onViewFrame: (frame: Extract<ServerMessage, { t: "view" | "view-ops" }>) => void = () => {};
	readonly closed: Promise<void>;

	private constructor(socket: Socket) {
		this.#socket = socket;
		this.closed = new Promise((resolve) => socket.once("close", () => resolve()));
		void this.closed.then(() => {
			const reason = this.#failure ?? "The daemon closed the connection.";
			for (const waiter of this.#waiting.values()) waiter.reject(new ProtocolError(reason));
			this.#waiting.clear();
		});
		readLines(
			socket,
			(raw) => {
				const parsed = parseServerMessage(raw);
				if (parsed.ok) this.#receive(parsed.value);
				else this.#fail(`The daemon sent ${parsed.problem}.`);
			},
			(problem) => this.#fail(`The daemon sent a line that is ${problem}.`),
		);
	}

	/**
	 * Connects and says hello. `watch`: stream main's view and the task graph (the TUI and --json need them).
	 * Rejects with the socket error when no daemon listens, and with a ProtocolError when one answers in another protocol.
	 */
	static async connect(path: string, options: { readonly watch: boolean }): Promise<AttachClient> {
		const client = await new Promise<AttachClient>((resolve, reject) => {
			const socket = connect(path);
			socket.once("connect", () => resolve(new AttachClient(socket)));
			socket.once("error", reject);
		});
		try {
			client.daemon = await client.request({ op: "hello", protocol: PROTOCOL, watch: options.watch });
		} catch (error) {
			client.#socket.destroy();
			const message = error instanceof Error ? error.message : String(error);
			// A protocol 1 daemon has no hello op.
			if (message.startsWith("Unknown request")) throw new ProtocolError("The running daemon predates mochi protocol 2. Restart it: mochi stop, then start mochi again.");
			throw new ProtocolError(message);
		}
		return client;
	}

	request<K extends Request["op"]>(request: Extract<Request, { op: K }>): Promise<Results[K]> {
		const id = ++this.#sequence;
		return new Promise((resolve, reject) => {
			this.#waiting.set(id, { resolve: resolve as (value: unknown) => void, reject });
			writeLine(this.#socket, { id, request });
		});
	}

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	close(): void {
		this.#socket.end();
	}

	#fail(reason: string): void {
		this.#failure ??= reason;
		this.#socket.destroy();
	}

	#receive(message: ServerMessage): void {
		switch (message.t) {
			case "reply": {
				const waiter = this.#waiting.get(message.id);
				this.#waiting.delete(message.id);
				if (message.ok) waiter?.resolve(message.value);
				else waiter?.reject(new Error(message.error));
				return;
			}
			case "error":
				this.#fail(message.error);
				return;
			case "view":
				this.view = message.value;
				this.onViewFrame(message);
				break;
			case "view-ops":
				this.view = applyImmutable(this.view, message.ops);
				this.onViewFrame(message);
				break;
			case "tasks":
				this.tasks = message.value;
				break;
			case "tasks-ops":
				this.tasks = applyImmutable(this.tasks, message.ops);
				break;
		}
		for (const listener of this.#listeners) listener();
	}
}
