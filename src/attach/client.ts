import { connect, type Socket } from "node:net";
import { type DaemonFacts, type DaemonFrame, readLines, WIRE } from "../channels/cli.ts";

/** The daemon answered, but not as this mochi: another wire, or a bad frame. Not the same as no daemon. */
export class WireError extends Error {}

/** One terminal on the daemon's socket. */
export class Terminal {
	readonly #socket: Socket;
	readonly facts: DaemonFacts;
	/** Every frame after hello. An `error` frame ends the connection. */
	onFrame: (frame: DaemonFrame) => void = () => {};
	readonly closed: Promise<void>;

	private constructor(socket: Socket, facts: DaemonFacts, closed: Promise<void>) {
		this.#socket = socket;
		this.facts = facts;
		this.closed = closed;
	}

	/** Rejects with the socket error when no daemon listens, and with a WireError when one answers another way. */
	static async connect(path: string, watch: boolean): Promise<Terminal> {
		const socket = await new Promise<Socket>((resolve, reject) => {
			const opened = connect(path);
			opened.once("connect", () => resolve(opened));
			opened.once("error", reject);
		});
		const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
		let terminal: Terminal | undefined;
		const greeted = new Promise<Terminal>((resolve, reject) => {
			void closed.then(() => reject(new WireError("The daemon closed the connection before hello.")));
			readLines(socket, (line) => {
				let frame: DaemonFrame;
				try {
					frame = JSON.parse(line) as DaemonFrame;
				} catch {
					socket.destroy();
					return reject(new WireError(`The daemon sent a line that is not JSON: ${line.slice(0, 80)}`));
				}
				if (terminal !== undefined) return terminal.onFrame(frame);
				if (frame.t === "error") return reject(new WireError(frame.error));
				if (frame.t !== "hello") return reject(new WireError(`The daemon sent ${frame.t} before hello.`));
				const { t: _hello, ...facts } = frame;
				terminal = new Terminal(socket, facts, closed);
				resolve(terminal);
			});
		});
		socket.write(`${JSON.stringify({ t: "hello", wire: WIRE, watch })}\n`);
		return greeted;
	}

	send(text: string): void {
		if (!this.#socket.destroyed) this.#socket.write(`${JSON.stringify({ t: "line", text })}\n`);
	}

	close(): void {
		this.#socket.end();
	}
}
