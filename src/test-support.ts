import { mkdir, mkdtemp } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { type FauxProviderHandle, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type { Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { Apps } from "./apps/apps.ts";
import type { Classified, Classify } from "./brain/classifier.ts";
import { type Mochi, openMochi } from "./mochi.ts";
import { IMESSAGE_PROFILE } from "./channels/imessage.ts";
import { TELEGRAM_PROFILE } from "./channels/telegram.ts";
import type { Channel, ChannelProfile, Channels, ChatChannelId, Reaction } from "./channels/types.ts";
import { WHATSAPP_PROFILE } from "./channels/whatsapp.ts";
import { SearchIndex } from "./index/fts.ts";
import type { Log } from "./log.ts";
import { allPages } from "./pages.ts";
import { AgentCatalog, type AgentType } from "./agents/catalog.ts";
import type { Retry } from "./turn/turn.ts";
import type { ChatUser } from "./config.ts";


export const FAUX = { provider: "faux", modelId: "faux-1" } as const;

export async function tempDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "mochi-test-"));
}

export interface TestMochi extends Mochi {
	readonly index: SearchIndex;
	close(): Promise<void>;
}

/** A classifier that answers every bool question with `probability`, or fails when given an error string. */
export function fixedClassify(outcome: number | string): Classify & { readonly calls: unknown[] } {
	const calls: unknown[] = [];
	const classify = async (state: unknown, questions: Readonly<Record<string, unknown>>): Promise<Classified> => {
		calls.push(state);
		if (typeof outcome === "string") return { ok: false, error: outcome };
		return { ok: true, answers: Object.fromEntries(Object.keys(questions).map((id) => [id, { type: "bool", probability: outcome }])) };
	};
	return Object.assign(classify, { calls });
}

/** Opens mochi on SQLite files in `dir`; reopening the same dir is a daemon restart. */
export async function openTestMochi(
	dir: string,
	faux: FauxProviderHandle,
	channels: Channels = new Map(),
	classify: Classify = fixedClassify("no classifier in tests"),
	agentTypes: readonly AgentType[] = [],
	overrides: {
		readonly skillsDir?: string;
		readonly memory?: NonNullable<import("./mochi.ts").MochiOptions["memory"]>;
		readonly agents?: AgentCatalog;
		readonly scheduling?: "daemon" | "local";
		readonly retry?: Retry;
		readonly log?: Log;
		readonly now?: () => Date;
		readonly apps?: Apps;
		readonly scriptDeadlineMs?: number;
		readonly triggerDeadlineMs?: number;
		readonly procPollMs?: number;
		readonly users?: readonly ChatUser[];
	} = {},
): Promise<TestMochi> {
	const { skillsDir, agents, scheduling, log, ...options } = overrides;
	await mkdir(join(dir, "work"), { recursive: true });
	const models = createModels();
	models.setProvider(faux.provider);
	const index = new SearchIndex(join(dir, "index.sqlite"));
	const mochi = await openMochi(
		{
			storage: await openNodeSqliteStorage(join(dir, "mochi.sqlite")),
			models,
			brain: FAUX,
			fast: FAUX,
			classify,
			firecrawlKey: undefined,
			index,
			skillsDir: skillsDir ?? join(dir, "skills"),
			agents: agents ?? testCatalog(agentTypes),
			workDir: join(dir, "work"),
			channels,
			timeZone: "Asia/Kolkata",
			publicUrl: "https://mochi.example",
			scheduling: scheduling ?? "daemon",
			...options,
			today: () => "2026-10-05",
			log: log ?? (() => {}),
		},
		BACKGROUND_CONTEXT,
	);
	return {
		...mochi,
		index,
		close: async () => {
			await mochi.harness.close(BACKGROUND_CONTEXT);
			index.close();
		},
	};
}

/** Resolves once no Turn is live: every owed message has been sent, merged, or given up. */
export async function turnsSettled(harness: Harness, context: Context = BACKGROUND_CONTEXT): Promise<void> {
	for (;;) {
		const turns = await allPages((cursor) => harness.commit((tx) => tx.scanTasks({ kind: "mochi.turn" }, 256, cursor), context));
		const live = turns.filter((task) => task.state.status !== "terminal");
		if (live.length === 0) return;
		await Promise.all(live.map((task) => harness.waitForTask(task.id, context)));
	}
}

export function newFaux(): FauxProviderHandle {
	return fauxProvider();
}

export const PROFILES: Readonly<Record<ChatChannelId, ChannelProfile>> = { imessage: IMESSAGE_PROFILE, telegram: TELEGRAM_PROFILE, whatsapp: WHATSAPP_PROFILE };

/** A channel that records each bubble it sends (a link as its URL, a file as its name), each reaction, and each user's bubbles by handle. */
export function recordingChannel(id: ChatChannelId, options: { react: boolean } = { react: true }) {
	const sent: string[] = [];
	const sentTo: { person: string | undefined; text: string }[] = [];
	const reactions: { messageId: string; reaction: Reaction | "none" }[] = [];
	const channel: Channel = {
		profile: options.react ? PROFILES[id] : { ...PROFILES[id], reactions: [] },
		run: async (_sink, signal) => {
			await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
		},
		send: async (bubble, person) => {
			const text = bubble.kind === "text" ? bubble.text : bubble.kind === "link" ? bubble.url : bubble.name;
			sent.push(text);
			sentTo.push({ person, text });
		},
		typing: async () => {},
		...(options.react
			? {
					react: async (messageId: string, reaction: Reaction | "none") => {
						reactions.push({ messageId, reaction });
					},
				}
			: {}),
	};
	return { channel, sent, sentTo, reactions };
}

/** Every tier and alias resolves to the faux model; `worker` is always there. */
export function testCatalog(types: readonly AgentType[] = []): AgentCatalog {
	const faux = `${FAUX.provider}/${FAUX.modelId}`;
	return new AgentCatalog([{ name: "worker", instructions: "", thinking: "low" }, ...types], {
		models: { opus: faux, sonnet: faux, fable: faux, haiku: faux },
		tiers: { fast: "haiku", default: "opus", strongest: "fable", panel: ["opus", "fable", "sonnet"] },
	});
}

/**
 * POSTs an endless chunked body with no Content-Length on a raw socket for `ms`. Returns the status line the server
 * sent, whether it closed the connection, and how many bytes it took before that.
 */
export async function endlessChunkedPost(port: number, path: string, ms = 1500): Promise<{ status: string; closed: boolean; sentBytes: number }> {
	const socket = connect(port, "127.0.0.1");
	let sentBytes = 0;
	let closed = false;
	let received = "";
	socket.on("data", (data) => {
		received += data.toString();
	});
	socket.on("close", () => {
		closed = true;
	});
	socket.on("error", () => {
		closed = true;
	});
	socket.write(`POST ${path} HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n`);
	const chunk = Buffer.concat([Buffer.from("10000\r\n"), Buffer.alloc(0x10000, 120), Buffer.from("\r\n")]);
	const pump = (): void => {
		while (!closed) {
			sentBytes += 0x10000;
			if (!socket.write(chunk)) {
				socket.once("drain", pump);
				return;
			}
		}
	};
	pump();
	await new Promise((resolve) => setTimeout(resolve, ms));
	socket.destroy();
	return { status: received.split("\r\n")[0] ?? "", closed, sentBytes };
}
