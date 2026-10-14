import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, platform } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { parse, stringify } from "smol-toml";
import { adoptInstructions, type Home, homeAt } from "../home.ts";

// A profile is another mochi with a home of its own under `<home>/profiles/<name>`, so the tree of profiles is the
// directory tree and a path such as `poteto/relay` addresses one. Each runs as its own service and talks to its parent
// over A2A. Any mochi manages only the profiles below its own home; nothing is ever deleted, a removed home is archived.

const run = promisify(execFile);
const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const PathSchema = Type.String({ pattern: "^[a-z0-9]+(-[a-z0-9]+)*(/[a-z0-9]+(-[a-z0-9]+)*)*$", maxLength: 120 });

/** The home of the profile at `path` below `root`: `poteto/relay` is `<root>/profiles/poteto/profiles/relay`. */
export function profileHome(root: Home, path: string): Home {
	const parts = path.split("/");
	if (parts.some((part) => !NAME.test(part))) throw new Error(`Profile path "${path}" must be lowercase names joined by "/".`);
	return homeAt(join(root.dir, ...parts.flatMap((part) => ["profiles", part])));
}

/** `poteto/relay` from a home below `root`. */
const pathOf = (root: Home, home: Home): string => relative(root.dir, home.dir).split(sep).filter((part, i) => i % 2 === 1).join("/");

/** The user service that runs a profile. Each home path gives one unit name, at any depth. */
export const unitName = (root: Home, home: Home): string => `mochi-${pathOf(root, home).replaceAll("/", "--")}.service`;

/** Every profile below `home`, depth first, parents before children. */
export async function listHomes(home: Home): Promise<Home[]> {
	const names = (await readdir(home.profilesDir).catch(() => [] as string[])).filter((name) => NAME.test(name)).sort();
	const found: Home[] = [];
	for (const name of names) {
		const child = homeAt(join(home.profilesDir, name));
		found.push(child, ...(await listHomes(child)));
	}
	return found;
}

async function freePort(): Promise<number> {
	return new Promise((resolvePort, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			server.close(() => (typeof address === "object" && address !== null ? resolvePort(address.port) : reject(new Error("No port"))));
		});
	});
}

type Env = Record<string, string>;

const readEnv = async (home: Home): Promise<Env> => {
	const text = await readFile(home.envFile, "utf8").catch(() => "");
	const env: Env = {};
	for (const line of text.split("\n")) {
		const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
		if (match !== null) env[match[1]!] = match[2]!.replace(/^["']|["']$/g, "");
	}
	return env;
};

const writeEnv = async (home: Home, env: Env): Promise<void> => {
	await writeFile(home.envFile, `${Object.entries(env).map(([key, value]) => `${key}=${value}`).join("\n")}\n`, { mode: 0o600 });
	await chmod(home.envFile, 0o600);
};

const readToml = async (home: Home): Promise<Record<string, unknown>> => {
	const text = await readFile(home.configFile, "utf8").catch(() => undefined);
	return text === undefined ? {} : (parse(text) as Record<string, unknown>);
};

const writeToml = (home: Home, config: Record<string, unknown>): Promise<void> => writeFile(home.configFile, `${stringify(config)}\n`, { mode: 0o600 });

/** Adds or removes `name:token` in a home's MOCHI_A2A_PEER_TOKENS. */
function withPeerToken(env: Env, name: string, token: string | undefined): Env {
	const pairs = (env.MOCHI_A2A_PEER_TOKENS ?? "").split(",").map((pair) => pair.trim()).filter((pair) => pair !== "" && !pair.startsWith(`${name}:`));
	if (token !== undefined) pairs.push(`${name}:${token}`);
	return { ...env, MOCHI_A2A_PEER_TOKENS: pairs.join(",") };
}

const tokenEnv = (name: string): string => `${name.toUpperCase().replaceAll("-", "_")}_A2A_TOKEN`;

/** Models, gateways and the classifier: what a profile needs to think. Channel keys are never copied. */
const MODEL_KEYS = /^(ANTHROPIC_API_KEY|OPENAI_API_KEY|OPENROUTER_API_KEY|BIFROST_[A-Z_]+|FIRECRAWL_API_KEY|DEEPGRAM_API_KEY|EXECUTOR_URL)$/;

export interface ProfileDeps {
	readonly home: Home;
	/** The repository the daemon runs from, so a profile runs the same code. */
	readonly repo: string;
	/** Runs systemctl --user; replaced in tests. */
	readonly systemctl?: (args: readonly string[]) => Promise<string>;
	/** Where user units go: `~/.config/systemd/user`. */
	readonly unitDir?: string;
}

const unitDirOf = (deps: ProfileDeps): string => deps.unitDir ?? join(homedir(), ".config", "systemd", "user");

const systemctlOf = (deps: ProfileDeps) =>
	deps.systemctl ?? (async (args: readonly string[]) => (await run("systemctl", ["--user", ...args])).stdout.trim());

async function installUnit(deps: ProfileDeps, home: Home): Promise<string> {
	if (platform() !== "linux") throw new Error("Profiles run as systemd user services, which need Linux. On this machine start one by hand: MOCHI_HOME=<home> node src/main.ts --headless");
	const unit = unitName(deps.home, home);
	const text = [
		"[Unit]",
		`Description=mochi profile ${pathOf(deps.home, home)}`,
		"After=network-online.target",
		"StartLimitIntervalSec=0",
		"",
		"[Service]",
		"Type=simple",
		`WorkingDirectory=${deps.repo}`,
		`Environment=MOCHI_HOME=${home.dir}`,
		`Environment=PATH=${process.env.PATH ?? "/usr/bin:/bin"}`,
		`ExecStart=${process.execPath} src/main.ts --headless`,
		"Restart=always",
		"RestartSec=5",
		`StandardOutput=append:${home.logFile}`,
		`StandardError=append:${home.logFile}`,
		"UMask=0077",
		"",
		"[Install]",
		"WantedBy=default.target",
		"",
	].join("\n");
	const dir = unitDirOf(deps);
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, unit), text);
	const systemctl = systemctlOf(deps);
	await systemctl(["daemon-reload"]);
	await systemctl(["enable", "--now", unit]);
	return unit;
}

async function status(deps: ProfileDeps, home: Home): Promise<string> {
	try {
		return await systemctlOf(deps)(["is-active", unitName(deps.home, home)]);
	} catch (error) {
		const out = (error as { stdout?: string }).stdout?.trim();
		return out === undefined || out === "" ? "unknown" : out;
	}
}

const resolveInside = (root: Home, path: string): Home => {
	const home = profileHome(root, path);
	if (!resolve(home.dir).startsWith(resolve(root.profilesDir) + sep)) throw new Error(`Profile ${path} is outside this mochi's profiles.`);
	return home;
};

/** The parent of `path`: this mochi for a top-level profile, else the profile one level up. */
const parentOf = (root: Home, path: string): { home: Home; name: string } => {
	const parts = path.split("/");
	return parts.length === 1 ? { home: root, name: "parent" } : { home: profileHome(root, parts.slice(0, -1).join("/")), name: parts.at(-2)! };
};

export function profileFns(deps: ProfileDeps): ToolRegistration[] {
	const root = deps.home;
	return [
		defineTool({
			name: "profile_list",
			description: "List the mochi profiles below this one (a path such as poteto/relay), each with its service state, brain model and first instructions line.",
			parameters: Type.Object({}),
			structuredOutputSchema: Type.Array(Type.Object({ path: Type.String(), state: Type.String(), brain: Type.String(), instructions: Type.String() })),
			replay: "safe",
			execute: async () => {
				const rows = [];
				for (const home of await listHomes(root)) {
					const config = await readToml(home);
					const models = (config.models ?? {}) as { brain?: string };
					adoptInstructions(home);
					const first = (await readFile(home.instructionsFile, "utf8").catch(() => "")).split("\n").find((line) => line.trim() !== "") ?? "";
					rows.push({ path: pathOf(root, home), state: await status(deps, home), brain: models.brain ?? "(default)", instructions: first.slice(0, 120) });
				}
				return { structuredOutput: rows };
			},
		}),
		defineTool({
			name: "profile_create",
			description:
				"Create a mochi profile: another mochi with its own home, instructions, memory and service, below this one (path poteto/relay nests " +
				"under poteto). It gets this mochi's model keys, never channel keys, and an A2A link to its parent. models overrides [models] " +
				"(brain, fast). env adds variables, such as a channel's keys. Restart the parent to call it with a2a_ask.",
			parameters: Type.Object({
				path: PathSchema,
				instructions: Type.String({ minLength: 1 }),
				models: Type.Optional(Type.Object({ brain: Type.Optional(Type.String()), fast: Type.Optional(Type.String()) })),
				env: Type.Optional(Type.Record(Type.String({ pattern: "^[A-Z_][A-Z0-9_]*$" }), Type.String())),
			}),
			structuredOutputSchema: Type.Object({ path: Type.String(), home: Type.String(), unit: Type.String(), a2a: Type.String() }),
			replay: "unsafe",
			execute: async ({ path, instructions, models, env }) => {
				const home = resolveInside(root, path);
				if (existsSync(home.dir)) throw new Error(`Profile ${path} exists. Use profile_update.`);
				const parent = parentOf(root, path);
				if (!existsSync(parent.home.dir)) throw new Error(`Its parent ${path.split("/").slice(0, -1).join("/")} does not exist.`);
				const name = path.split("/").at(-1)!;
				const parentEnv = await readEnv(parent.home);
				const parentConfig = await readToml(parent.home);
				const [a2aPort, hooksPort] = [await freePort(), await freePort()];
				const toChild = randomBytes(24).toString("hex");
				const toParent = randomBytes(24).toString("hex");
				const parentPort = Number(parentEnv.MOCHI_A2A_PORT || 8789);

				await mkdir(home.dir, { recursive: true, mode: 0o700 });
				const keys = Object.fromEntries(Object.entries({ ...process.env, ...parentEnv }).filter(([key, value]) => MODEL_KEYS.test(key) && value !== undefined)) as Env;
				await writeEnv(home, {
					...keys,
					MOCHI_A2A_AGENT_NAME: name,
					MOCHI_A2A_PORT: String(a2aPort),
					MOCHI_HOOKS_PORT: String(hooksPort),
					MOCHI_BIND_HOST: "127.0.0.1",
					MOCHI_A2A_PEER_TOKENS: `${parent.name}:${toChild}`,
					[tokenEnv(parent.name)]: toParent,
					...env,
				});
				const childConfig: Record<string, unknown> = {
					...(parentConfig.timeZone === undefined ? {} : { timeZone: parentConfig.timeZone }),
					...(parentConfig.providers === undefined ? {} : { providers: parentConfig.providers }),
					models: { ...(parentConfig.models as object | undefined), ...models },
					a2a: { peers: { [parent.name]: { url: `http://127.0.0.1:${parentPort}`, tokenEnv: tokenEnv(parent.name) } } },
				};
				await writeToml(home, childConfig);
				await writeFile(home.instructionsFile, `${instructions.trim()}\n`);

				// The parent learns the child: it accepts the child's token and may call it.
				await writeEnv(parent.home, { ...withPeerToken(parentEnv, name, toParent), [tokenEnv(name)]: toChild });
				const peers = ((parentConfig.a2a as { peers?: Record<string, unknown> } | undefined)?.peers ?? {}) as Record<string, unknown>;
				await writeToml(parent.home, { ...parentConfig, a2a: { peers: { ...peers, [name]: { url: `http://127.0.0.1:${a2aPort}`, tokenEnv: tokenEnv(name) } } } });

				const unit = await installUnit(deps, home);
				return { structuredOutput: { path, home: home.dir, unit, a2a: `peer "${name}" on 127.0.0.1:${a2aPort}; the parent sees it after a restart` } };
			},
		}),
		defineTool({
			name: "profile_update",
			description: "Change a profile's instructions, or merge config (TOML table keys, such as models or triggers) into its config.toml, then restart it and the profiles below it.",
			parameters: Type.Object({ path: PathSchema, instructions: Type.Optional(Type.String({ minLength: 1 })), config: Type.Optional(Type.String({ minLength: 1, description: "TOML to merge, top-level keys replace" })) }),
			structuredOutputSchema: Type.Object({ path: Type.String(), restarted: Type.Array(Type.String()) }),
			replay: "safe",
			execute: async ({ path, instructions, config }) => {
				const home = resolveInside(root, path);
				if (!existsSync(home.dir)) throw new Error(`No profile ${path}. Use profile_list.`);
				if (instructions !== undefined) {
					adoptInstructions(home);
					await writeFile(home.instructionsFile, `${instructions.trim()}\n`);
				}
				if (config !== undefined) await writeToml(home, { ...(await readToml(home)), ...(parse(config) as Record<string, unknown>) });
				const restarted: string[] = [];
				for (const each of [home, ...(await listHomes(home))]) {
					await systemctlOf(deps)(["restart", unitName(root, each)]);
					restarted.push(pathOf(root, each));
				}
				return { structuredOutput: { path, restarted } };
			},
		}),
		defineTool({
			name: "profile_remove",
			description: "Stop a profile and every profile below it, and archive its home under profiles/.archive. Nothing is deleted.",
			parameters: Type.Object({ path: PathSchema }),
			structuredOutputSchema: Type.Object({ archived: Type.String(), stopped: Type.Array(Type.String()) }),
			replay: "safe",
			execute: async ({ path }) => {
				const home = resolveInside(root, path);
				if (!existsSync(home.dir)) throw new Error(`No profile ${path}. Use profile_list.`);
				const systemctl = systemctlOf(deps);
				const stopped: string[] = [];
				// Children first, so no profile outlives the one it reports to.
				for (const each of [...(await listHomes(home))].reverse().concat(home)) {
					const unit = unitName(root, each);
					await systemctl(["disable", "--now", unit]).catch(() => "");
					await rm(join(unitDirOf(deps), unit), { force: true });
					stopped.push(pathOf(root, each));
				}
				await systemctl(["daemon-reload"]);
				const parent = parentOf(root, path);
				const name = path.split("/").at(-1)!;
				const parentEnv = await readEnv(parent.home);
				const { [tokenEnv(name)]: _dropped, ...rest } = withPeerToken(parentEnv, name, undefined);
				await writeEnv(parent.home, rest);
				const parentConfig = await readToml(parent.home);
				const peers = { ...((parentConfig.a2a as { peers?: Record<string, unknown> } | undefined)?.peers ?? {}) };
				delete peers[name];
				await writeToml(parent.home, { ...parentConfig, a2a: { peers } });
				const archive = join(parent.home.profilesDir, ".archive", `${name}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
				await mkdir(join(parent.home.profilesDir, ".archive"), { recursive: true });
				await rename(home.dir, archive);
				return { structuredOutput: { archived: archive, stopped } };
			},
		}),
	];
}
