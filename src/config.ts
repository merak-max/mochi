import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { type Static, Type } from "typebox";
import { MediaConfigSchema } from "./media/media.ts";
import { parseWith } from "./parse.ts";
import { DreamConfigSchema, dreamConfig } from "./memory/dream.ts";
import { normalizeHandle } from "./channels/imessage.ts";

/** The owner's id. Configured users take user2, user3 and so on. */
export const OWNER_ID = "user1";

const ChatUserSchema = Type.Object(
	{ id: Type.String({ pattern: "^user[0-9]+$" }), handle: Type.String({ minLength: 1 }), name: Type.Optional(Type.String({ minLength: 1 })), persona: Type.Optional(Type.String({ minLength: 1 })) },
	{ additionalProperties: false },
);
/** Someone other than the owner who may message mochi on iMessage, in a conversation of their own. */
export type ChatUser = Static<typeof ChatUserSchema>;

/** data/config.json. Later units add their own keys, such as trigger seeds. */
const FileSchema = Type.Object(
	{
		timeZone: Type.Optional(Type.String({ minLength: 1 })),
		memory: Type.Optional(Type.Object({ repo: Type.Optional(Type.String({ minLength: 1 })), dreaming: Type.Optional(DreamConfigSchema) }, { additionalProperties: false })),
		/** Image, video and speech providers; see src/media/config.example.json. */
		media: Type.Optional(MediaConfigSchema),
		/** Minutes of silence after which an owner message starts a fresh thread; 0 never resets. Default 60. */
		idleResetMinutes: Type.Optional(Type.Integer({ minimum: 0 })),
		users: Type.Optional(Type.Array(ChatUserSchema)),
	},
	{ additionalProperties: true },
);
export type FileConfig = Static<typeof FileSchema>;

export interface Config {
	readonly dataDir: string;
	readonly executorUrl: string;
	/** Absent: model calls fail with an auth error; the daemon still starts. */
	readonly bifrostKey: string | undefined;
	/** Absent: the classifier is unavailable, so the `classify` tool errors and trigger gates pass. */
	readonly openRouterKey: string | undefined;
	/** Absent: the web functions in `code` fail with a clear error. */
	readonly firecrawlKey: string | undefined;
	readonly timeZone: string;
	/** `file.users` with each handle normalized as the iMessage adapter compares senders. */
	readonly users: readonly ChatUser[];
	readonly file: FileConfig;
	readonly env: Readonly<Record<string, string | undefined>>;
}

export async function loadConfig(env: Readonly<Record<string, string | undefined>>): Promise<Config> {
	const dataDir = resolve(env.MOCHI_DATA_DIR ?? "data");
	const file = parseWith(FileSchema, await readJson(join(dataDir, "config.json")), "data/config.json");
	const timeZone = file.timeZone ?? "Asia/Kolkata";
	assertTimeZone(timeZone);
	dreamConfig(file.memory?.dreaming, timeZone);
	return {
		dataDir,
		executorUrl: env.EXECUTOR_URL ?? "https://executor.shau.me/mcp",
		bifrostKey: env.BIFROST_VIRTUAL_KEY || undefined,
		openRouterKey: env.OPENROUTER_API_KEY || undefined,
		firecrawlKey: env.FIRECRAWL_API_KEY?.trim() || undefined,
		timeZone,
		users: chatUsers(file.users ?? []),
		file,
		env,
	};
}

function chatUsers(users: readonly ChatUser[]): ChatUser[] {
	const seen = new Set<string>([OWNER_ID]);
	const normalized: ChatUser[] = [];
	for (const user of users) {
		if (user.id === OWNER_ID) throw new Error(`Invalid data/config.json: users id ${OWNER_ID} is the owner's.`);
		if (seen.has(user.id)) throw new Error(`Invalid data/config.json: users id ${user.id} appears twice.`);
		seen.add(user.id);
		normalized.push({ ...user, handle: normalizeHandle(user.handle) });
	}
	return normalized;
}

async function readJson(path: string): Promise<unknown> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
		throw error;
	}
	return JSON.parse(text);
}

function assertTimeZone(timeZone: string): void {
	try {
		new Intl.DateTimeFormat("en", { timeZone });
	} catch {
		throw new Error(`Invalid timeZone in data/config.json: ${timeZone}`);
	}
}
