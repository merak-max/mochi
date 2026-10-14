import type { Socket } from "node:net";
import type { Op } from "@earendil-works/chord/delta";
import type { ConversationView, ModelRef, TaskGraph, UsageState } from "@earendil-works/pi-durable";

export type ConversationSummary = { readonly id: number; readonly label: string; readonly title?: string };
export type ModelSummary = ModelRef & { readonly name: string; readonly contextWindow: number };

export type Request =
	| { readonly op: "show"; readonly conversationId: number }
	| {
			readonly op: "submit";
			readonly conversationId: number;
			readonly text: string;
			readonly whenBusy: "steer" | "followUp";
			readonly messageId?: string;
	  }
	| { readonly op: "abort"; readonly conversationId: number; readonly everything: boolean }
	| { readonly op: "compact"; readonly conversationId: number; readonly instructions?: string }
	| { readonly op: "reset"; readonly conversationId: number }
	| { readonly op: "configure"; readonly conversationId: number; readonly model?: ModelRef; readonly thinkingLevel?: string }
	| { readonly op: "conversations" }
	| { readonly op: "models" }
	| { readonly op: "usage" }
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
