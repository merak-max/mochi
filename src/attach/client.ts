import { connect, type Socket } from "node:net";
import { applyImmutable } from "@earendil-works/chord/delta";
import type { ConversationView, TaskGraph } from "@earendil-works/pi-durable";
import { readLines, type Request, type Results, type ServerMessage, writeLine } from "./protocol.ts";

/** The terminal side of attach: the shown conversation and task graph as plain values, and typed requests. */
export class AttachClient {
	readonly #socket: Socket;
	readonly #waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
	readonly #listeners = new Set<() => void>();
	#sequence = 0;
	view: ConversationView | undefined;
	tasks: TaskGraph | undefined;
	/** Called with each view frame as received: the value, then one batch of ops per commit. */
	onViewFrame: (frame: Extract<ServerMessage, { t: "view" | "view-ops" }>) => void = () => {};
	readonly closed: Promise<void>;

	private constructor(socket: Socket) {
		this.#socket = socket;
		this.closed = new Promise((resolve) => socket.once("close", () => resolve()));
		void this.closed.then(() => {
			for (const waiter of this.#waiting.values()) waiter.reject(new Error("The daemon closed the connection."));
			this.#waiting.clear();
		});
		readLines(socket, (raw) => this.#receive(raw as ServerMessage));
	}

	/** Connects to the daemon's socket; rejects when no daemon listens there. */
	static connect(path: string): Promise<AttachClient> {
		return new Promise((resolve, reject) => {
			const socket = connect(path);
			socket.once("connect", () => resolve(new AttachClient(socket)));
			socket.once("error", reject);
		});
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

	#receive(message: ServerMessage): void {
		switch (message.t) {
			case "reply": {
				const waiter = this.#waiting.get(message.id);
				this.#waiting.delete(message.id);
				if (message.ok) waiter?.resolve(message.value);
				else waiter?.reject(new Error(message.error));
				return;
			}
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
