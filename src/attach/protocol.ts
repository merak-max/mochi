import type { Socket } from "node:net";
import type { Op } from "@earendil-works/chord/delta";
import type { ConversationView, ModelRef, TaskGraph, UsageState } from "@earendil-works/pi-durable";

// A terminal attaches to the daemon over a Unix socket, one JSON object per line. The daemon streams the shown
// conversation's view and the task graph as pi-durable watch frames (a value, then Chord ops per commit), and answers
// requests by id. The client never touches storage.

export type ConversationSummary = { readonly id: number; readonly label: string; readonly title?: string };
export type ModelSummary = ModelRef & { readonly name: string; readonly contextWindow: number };

export type Request =
	/** Show this conversation: the view stream switches to it. */
	| { readonly op: "show"; readonly conversationId: number }
	/** Root input goes through `ingest` as channel `cli`; another conversation is submitted to directly. */
	| {
			readonly op: "submit";
			readonly conversationId: number;
			readonly text: string;
			readonly whenBusy: "steer" | "followUp";
			/** Root only: the `cli` message id, so a retry after a crash finds the same submission. Default: a fresh one. */
			readonly messageId?: string;
	  }
	/** Esc: abort the conversation's current work. `everything` also stops its background agents and tasks. */
	| { readonly op: "abort"; readonly conversationId: number; readonly everything: boolean }
	| { readonly op: "compact"; readonly conversationId: number; readonly instructions?: string }
	/** /new: start a fresh context; the transcript keeps a `pi.reset` marker. */
	| { readonly op: "reset"; readonly conversationId: number }
	| { readonly op: "configure"; readonly conversationId: number; readonly model?: ModelRef; readonly thinkingLevel?: string }
	| { readonly op: "conversations" }
	| { readonly op: "models" }
	| { readonly op: "usage" }
	/** Resolve once the submission settles, with its answer text. */
	| { readonly op: "wait"; readonly submissionId: number };

export type Answer =
	| { readonly status: "done"; readonly text: string }
	| { readonly status: "unanswered"; readonly reason: string };

export type Results = {
	show: null;
	submit: { readonly submissionId: number };
	abort: null;
	compact: null;
	reset: null;
	configure: null;
	conversations: readonly ConversationSummary[];
	models: readonly ModelSummary[];
	usage: UsageState;
	wait: Answer;
};

export type ClientMessage = { readonly id: number; readonly request: Request };

export type ServerMessage =
	| { readonly t: "reply"; readonly id: number; readonly ok: true; readonly value: unknown }
	| { readonly t: "reply"; readonly id: number; readonly ok: false; readonly error: string }
	| { readonly t: "view"; readonly value: ConversationView }
	| { readonly t: "view-ops"; readonly ops: readonly Op[] }
	| { readonly t: "tasks"; readonly value: TaskGraph }
	| { readonly t: "tasks-ops"; readonly ops: readonly Op[] };

/** Calls `onMessage` with each parsed line of `socket`. */
export function readLines(socket: Socket, onMessage: (message: unknown) => void): void {
	let buffer = "";
	socket.setEncoding("utf8");
	socket.on("data", (chunk: string) => {
		buffer += chunk;
		for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			if (line.trim() !== "") onMessage(JSON.parse(line));
		}
	});
}

export function writeLine(socket: Socket, message: ClientMessage | ServerMessage): void {
	if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
}
