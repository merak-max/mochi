import type { Content } from "spectrum-ts";
import type { IMessageApp, IMessageMessage, IMessageSpace, ReactionHandle } from "../imessage.ts";

export const OWNER = "+15550100001";
export const OWNER_DM = "any;-;+15550100001";

const bytes = (value: string) => async () => Buffer.from(value);
const noStream = async () => new ReadableStream();

export const contents = {
	text: { type: "text", text: "hey mochi" },
	photo: { type: "attachment", id: "att-1", name: "IMG_0001.HEIC", mimeType: "image/heic", read: bytes("heic"), stream: noStream },
	pdf: { type: "attachment", id: "att-2", name: "lease.pdf", mimeType: "application/pdf", read: bytes("pdf"), stream: noStream },
	voice: { type: "voice", mimeType: "audio/x-caf", duration: 4, read: bytes("caf"), stream: noStream },
	typing: { type: "typing", state: "start" },
} satisfies Record<string, Content>;

export interface FakeEvents {
	readonly reacted: Array<{ readonly id: string; readonly emoji: string }>;
	readonly unsent: string[];
	readonly sent: Array<{ readonly space: string; readonly text?: string; readonly link?: string; readonly file?: string; readonly replyTo?: string }>;
	readonly typing: string[];
	readonly read: string[];
}

export function events(): FakeEvents {
	return { reacted: [], unsent: [], sent: [], typing: [], read: [] };
}

export function message(
	log: FakeEvents,
	fields: { readonly id: string; readonly sender?: string; readonly direction?: "inbound" | "outbound"; readonly content: Content },
): IMessageMessage {
	return {
		id: fields.id,
		direction: fields.direction ?? "inbound",
		sender: fields.sender === undefined ? undefined : { id: fields.sender },
		timestamp: new Date("2026-10-05T08:32:00Z"),
		content: fields.content,
		async react(emoji): Promise<ReactionHandle> {
			log.reacted.push({ id: fields.id, emoji });
			return { unsend: async () => void log.unsent.push(`${fields.id}:${emoji}`) };
		},
		async read() {
			log.read.push(fields.id);
		},
	};
}

/** `fail` makes every send reject with it, as the SDK would. */
export function space(log: FakeEvents, id: string, known: readonly IMessageMessage[] = [], fail?: unknown): IMessageSpace {
	const record = async (entry: FakeEvents["sent"][number]) => {
		if (fail !== undefined) throw fail;
		log.sent.push(entry);
	};
	return {
		send: (text) => record({ space: id, text }),
		sendReply: (text, replyTo) => record({ space: id, text, replyTo }),
		sendLink: (link) => record({ space: id, link }),
		sendFile: (file) => record({ space: id, file: file.name }),
		async startTyping() {
			log.typing.push(`${id}:on`);
		},
		async stopTyping() {
			log.typing.push(`${id}:off`);
		},
		async getMessage(messageId) {
			return known.find((m) => m.id === messageId);
		},
	};
}

/** A Photon line for the owner's DM: `live` streams until stop, and `catchUp(since)` replays `logged` events after `since`. */
export function app(space: IMessageSpace, live: readonly IMessageMessage[], logged: readonly IMessageMessage[] = []) {
	const catchUps: number[] = [];
	let stop = () => {};
	const stopped = new Promise<boolean>((resolve) => (stop = () => resolve(true)));
	const pairs = (messages: readonly IMessageMessage[]) => messages.map((message) => [space, message] as const);
	const line: IMessageApp = {
		messages: (async function* () {
			yield* pairs(live);
			await stopped;
		})(),
		catchUp: async function* (since) {
			catchUps.push(since);
			yield* pairs(logged.filter((message) => message.sequence! > since));
		},
		dm: async () => space,
		stop: async () => stop(),
	};
	return { ...line, catchUps, stopped: () => Promise.race([stopped, false]) };
}
