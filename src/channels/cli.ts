import { chmodSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { type ConversationId, type Harness, LiveDoc, type LiveState } from "@earendil-works/pi-durable";
import { log } from "../log.ts";
import type { Bubble, Channel, ChannelProfile, InboundSink } from "./types.ts";

/** Bump on every change to the frames. A terminal says its number in hello; the daemon refuses another. */
export const WIRE = 4;

/** What a terminal learns in hello: enough for status, stop and doctor. */
export type DaemonFacts = {
	readonly wire: number;
	readonly pid: number;
	readonly startedAt: string;
	readonly build: string;
	readonly home: string;
	readonly channels: readonly string[];
	readonly setup: readonly string[];
};

/** Terminal to daemon. `watch`: also send main's live status. */
type ClientFrame = { readonly t: "hello"; readonly wire: number; readonly watch: boolean } | { readonly t: "line"; readonly text: string };

/** Daemon to terminal. Each line gets one `done` after its Turn ends. An `error` closes the connection. */
export type DaemonFrame =
	| ({ readonly t: "hello" } & DaemonFacts)
	| { readonly t: "bubble"; readonly text: string }
	| { readonly t: "done" }
	| { readonly t: "live"; readonly status: string }
	| { readonly t: "error"; readonly error: string };

const CLI_PROFILE: ChannelProfile = {
	id: "cli",
	maxBubbles: 1,
	paragraphsAreBubbles: false,
	typingMaxMs: 0,
};

interface CliChannel extends Channel {
	/** Shows `status` to every watching terminal. */
	status(status: string): void;
}

/**
 * The terminal channel on the unix socket at `path`. Each line is an inbound message from the owner, and each bubble
 * goes to every attached terminal, as one thread shows on every device. `run` resolves once the socket listens and
 * serves until `signal` aborts.
 */
export function createCliChannel(path: string, facts: DaemonFacts): CliChannel {
	const terminals = new Map<Socket, { watch: boolean }>();
	let current = "";
	let sequence = 0;
	const write = (socket: Socket, frame: DaemonFrame): void => {
		if (!socket.destroyed) socket.write(`${JSON.stringify(frame)}\n`);
	};
	const refuse = (socket: Socket, error: string): void => {
		log("cli.refused", { error });
		write(socket, { t: "error", error });
		socket.end();
	};

	const accept = (socket: Socket, sink: InboundSink): void => {
		let ingesting: Promise<unknown> = Promise.resolve();
		readLines(socket, (line) => {
			const frame = parseClientFrame(line);
			if (typeof frame === "string") return refuse(socket, frame);
			const greeted = terminals.get(socket);
			if (frame.t === "hello") {
				if (frame.wire !== WIRE) return refuse(socket, wireMismatch(frame.wire));
				terminals.set(socket, { watch: frame.watch });
				write(socket, { t: "hello", ...facts });
				if (frame.watch) write(socket, { t: "live", status: current });
				return;
			}
			if (greeted === undefined) return refuse(socket, wireMismatch(undefined));
			const inbound = { kind: "message", channel: "cli", messageId: `${Date.now()}-${++sequence}`, text: frame.text, at: new Date(), attachments: [] } as const;
			const ingested = ingesting.then(() => sink(inbound));
			ingesting = ingested.catch(() => {});
			ingested
				.then((turn) => turn.answered)
				.then(
					() => write(socket, { t: "done" }),
					(error: unknown) => refuse(socket, error instanceof Error ? error.message : String(error)),
				);
		});
		socket.on("close", () => terminals.delete(socket));
		socket.on("error", () => socket.destroy());
	};

	return {
		profile: CLI_PROFILE,
		async run(sink, signal) {
			rmSync(path, { force: true });
			const server = createServer((socket) => accept(socket, sink));
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(path, () => resolve());
			});
			chmodSync(path, 0o600);
			signal.addEventListener("abort", () => {
				server.close();
				for (const socket of terminals.keys()) socket.destroy();
				rmSync(path, { force: true });
			}, { once: true });
		},
		async send(bubble) {
			const text = bubbleText(bubble);
			if (terminals.size === 0) log("cli.unseen", { chars: text.length });
			for (const socket of terminals.keys()) write(socket, { t: "bubble", text });
			return [];
		},
		async typing() {},
		status(status) {
			if (status === current) return;
			current = status;
			for (const [socket, terminal] of terminals) {
				if (terminal.watch) write(socket, { t: "live", status });
			}
		},
	};
}

/** Calls `show` with main's status after each commit that changes its `pi.live`. Returns the unsubscribe. */
export function watchLive(harness: Harness, root: ConversationId, show: (status: string) => void): () => void {
	return harness.subscribeCommits(({ changes }) => {
		for (const change of changes) {
			if (change.type !== "document" || change.record.kind !== LiveDoc.definition.kind || change.conversationId !== root) continue;
			show(liveStatus(change.value as LiveState | null));
		}
	});
}

/** One line: what main is doing now, or "" when idle. */
function liveStatus(live: LiveState | null): string {
	if (live === null || live.run === undefined) return "";
	const retry = live.generation?.retry;
	if (retry !== undefined) return `retrying: ${retry.error}`;
	const running: string[] = [];
	for (const slot of live.tools ?? []) {
		if (slot.status === "running") running.push(slot.name);
	}
	for (const slot of live.nestedTools ?? []) {
		if (slot.status === "running") running.push(slot.name);
	}
	return running.length === 0 ? "working" : `running ${running.join(" > ")}`;
}

function bubbleText(bubble: Bubble): string {
	switch (bubble.kind) {
		case "text":
			return bubble.text;
		case "link":
			return bubble.url;
		case "file":
			return `[file ${bubble.name}, ${bubble.bytes.length} bytes]`;
	}
}

const wireMismatch = (theirs: number | undefined): string =>
	`This daemon speaks mochi wire ${WIRE} and the terminal speaks ${theirs === undefined ? "another" : `wire ${theirs}`}. Restart the older side: mochi stop, then start mochi again.`;

function parseClientFrame(line: string): ClientFrame | string {
	let raw: unknown;
	try {
		raw = JSON.parse(line);
	} catch {
		return `not JSON: ${line.slice(0, 80)}`;
	}
	if (typeof raw !== "object" || raw === null) return wireMismatch(undefined);
	const frame = raw as Record<string, unknown>;
	if (frame.t === "hello" && typeof frame.wire === "number" && typeof frame.watch === "boolean") return { t: "hello", wire: frame.wire, watch: frame.watch };
	if (frame.t === "line" && typeof frame.text === "string" && frame.text.trim() !== "") return { t: "line", text: frame.text };
	return wireMismatch(typeof frame.wire === "number" ? frame.wire : undefined);
}

/** Calls `onLine` with each non-blank line of the stream. */
export function readLines(socket: Socket, onLine: (line: string) => void): void {
	let buffer = "";
	socket.setEncoding("utf8");
	socket.on("data", (chunk: string) => {
		buffer += chunk;
		for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			if (line.trim() !== "") onLine(line);
		}
	});
}
