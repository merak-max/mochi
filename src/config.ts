import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { parse as parseToml } from "smol-toml";
import { type Static, Type } from "typebox";
import { createModelSetup, type ModelSetup, ModelsSchema, ProviderSchema } from "./brain/providers.ts";
import { type Home, resolveHome } from "./home.ts";
import { MediaConfigSchema } from "./media/providers.ts";
import { parseWith } from "./parse.ts";
import { normalizeHandle } from "./channels/imessage.ts";

/** The owner's id. Configured users take user2, user3 and so on. */
export const OWNER_ID = "user1";

const ChatUserSchema = Type.Object(
	{ id: Type.String({ pattern: "^user[0-9]+$" }), handle: Type.String({ minLength: 1 }), name: Type.Optional(Type.String({ minLength: 1 })), persona: Type.Optional(Type.String({ minLength: 1 })) },
	{ additionalProperties: false },
);
/** Someone other than the owner who may message mochi on iMessage, in a conversation of their own. */
export type ChatUser = Static<typeof ChatUserSchema>;

/** `<home>/config.toml`. `[[triggers]]` is read as schedule seeds; the key keeps its old name so configs load unchanged. */
const FileSchema = Type.Object(
	{
		timeZone: Type.Optional(Type.String({ minLength: 1 })),
		/** How to reach models; see src/brain/providers.ts. Absent: ANTHROPIC_API_KEY or OPENAI_API_KEY decides. */
		providers: Type.Optional(Type.Record(Type.String({ pattern: "^[a-z0-9-]+$" }), ProviderSchema)),
		models: Type.Optional(ModelsSchema),
		/** An MCP server with `execute` and `skills` tools for the owner's apps. Absent: the apps functions say they are not connected. */
		appsUrl: Type.Optional(Type.String({ pattern: "^https?://" })),
		/** The web and browser service: its API url, the env variable with its key, and the browser profile name. */
		web: Type.Optional(Type.Object({ url: Type.Optional(Type.String({ pattern: "^https?://" })), keyEnv: Type.Optional(Type.String({ pattern: "^[A-Z_][A-Z0-9_]*$" })), browserProfile: Type.Optional(Type.String({ minLength: 1 })) }, { additionalProperties: false })),
		/** Image, video and speech providers; see config.example.toml. */
		media: Type.Optional(MediaConfigSchema),
		users: Type.Optional(Type.Array(ChatUserSchema)),
	},
	{ additionalProperties: true },
);
type FileConfig = Static<typeof FileSchema>;

/** Top-level keys mochi does not read, such as ones a newer or older version used. Boot names them; they do not stop it. */
export function unknownKeys(file: Readonly<Record<string, unknown>>): string[] {
	const known = new Set([...Object.keys(FileSchema.properties), "triggers"]);
	return Object.keys(file).filter((key) => !known.has(key));
}

export type WebConfig = { readonly keyEnv: string; readonly key: string | undefined; readonly url?: string; readonly browserProfile?: string };

export interface Config {
	readonly home: Home;
	readonly appsUrl: string | undefined;
	readonly modelSetup: ModelSetup;
	readonly web: WebConfig;
	readonly timeZone: string;
	/** `file.users` with each handle normalized as the iMessage adapter compares senders. */
	readonly users: readonly ChatUser[];
	readonly file: FileConfig;
	readonly env: Readonly<Record<string, string | undefined>>;
}

/** Resolves the home, loads its `.env` into `process.env`, and reads its config. */
export async function loadConfig(env: NodeJS.ProcessEnv): Promise<Config> {
	const home = resolveHome(env);
	if (existsSync(home.envFile)) process.loadEnvFile(home.envFile);
	const file = parseWith(FileSchema, await readConfigFile(home), "config.toml");
	const timeZone = file.timeZone ?? (Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
	assertTimeZone(timeZone);
	return {
		home,
		appsUrl: env.MOCHI_APPS_URL ?? file.appsUrl,
		modelSetup: createModelSetup({ ...(file.providers === undefined ? {} : { providers: file.providers }), ...(file.models === undefined ? {} : { models: file.models }), env }),
		web: {
			keyEnv: file.web?.keyEnv ?? "FIRECRAWL_API_KEY",
			key: env[file.web?.keyEnv ?? "FIRECRAWL_API_KEY"]?.trim() || undefined,
			...(file.web?.url === undefined ? {} : { url: file.web.url }),
			...(file.web?.browserProfile === undefined ? {} : { browserProfile: file.web.browserProfile }),
		},
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
		if (user.id === OWNER_ID) throw new Error(`Invalid config: users id ${OWNER_ID} is the owner's.`);
		if (seen.has(user.id)) throw new Error(`Invalid config: users id ${user.id} appears twice.`);
		seen.add(user.id);
		normalized.push({ ...user, handle: normalizeHandle(user.handle) });
	}
	return normalized;
}

/** `config.toml`, else nothing: every field has a default. */
async function readConfigFile(home: Home): Promise<unknown> {
	try {
		return parseToml(await readFile(home.configFile, "utf8"));
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
		throw error;
	}
}

function assertTimeZone(timeZone: string): void {
	try {
		new Intl.DateTimeFormat("en", { timeZone });
	} catch {
		throw new Error(`Invalid timeZone in config: ${timeZone}`);
	}
}
