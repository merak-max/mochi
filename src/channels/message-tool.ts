import { type Static, Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { LastInboundDoc } from "../turn/turn.ts";
import type { Channels, ChatChannelId, MessageRequest } from "./types.ts";

const Params = Type.Object({
	action: Type.Union([Type.Literal("sent"), Type.Literal("edit"), Type.Literal("unsend"), Type.Literal("poll"), Type.Literal("contact"), Type.Literal("read")]),
	messageId: Type.Optional(Type.String({ minLength: 1 })),
	text: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
	title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
	options: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { minItems: 2, maxItems: 12 })),
	name: Type.Optional(Type.String({ minLength: 1 })),
	phone: Type.Optional(Type.String({ minLength: 1 })),
	email: Type.Optional(Type.String({ minLength: 1 })),
});

type Args = Static<typeof Params>;

function requestOf(args: Args): MessageRequest {
	const messageId = args.messageId === undefined ? {} : { messageId: args.messageId };
	switch (args.action) {
		case "sent":
			return { action: "sent" };
		case "edit":
			if (args.text === undefined) throw new Error("edit needs text.");
			return { action: "edit", text: args.text, ...messageId };
		case "unsend":
			return { action: "unsend", ...messageId };
		case "poll":
			if (args.title === undefined || args.options === undefined) throw new Error("poll needs a title and 2 to 12 options.");
			return { action: "poll", title: args.title, options: args.options };
		case "contact": {
			const name = args.name === undefined ? {} : { name: args.name };
			const phone = args.phone === undefined ? {} : { phone: args.phone };
			const email = args.email === undefined ? {} : { email: args.email };
			return { action: "contact", ...name, ...phone, ...email };
		}
		case "read":
			return { action: "read" };
	}
}

/** The message tool: what a chat channel can do besides send bubbles and react, on the channel where the owner last wrote. */
export function messageTool(channels: Channels): ToolRegistration {
	return defineTool({
		name: "message",
		description:
			"iMessage actions in the owner's chat, beyond your reply. sent: list your recent message ids. edit (text, messageId default your newest): rewrite your text message. " +
			"unsend (messageId): retract yours, within about 2 minutes. poll (title, options). contact (name, phone, email; none shares your own card). read: mark the chat read.",
		parameters: Params,
		replay: "unsafe",
		execute: async (args, api, context) => {
			const last = (await api.snapshot(LastInboundDoc, context))?.last?.channel;
			const id: ChatChannelId | undefined = last ?? (channels.has("imessage") ? "imessage" : [...channels.keys()][0]);
			const channel = id === undefined ? undefined : channels.get(id);
			if (id === undefined || channel === undefined) throw new Error("No chat channel is running.");
			if (channel.message === undefined) throw new Error(`message is not supported on ${id}.`);
			const result = await channel.message(requestOf(args));
			return { output: [{ type: "text", text: result }] };
		},
	});
}
