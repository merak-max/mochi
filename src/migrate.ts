import { chmodSync, copyFileSync, existsSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "smol-toml";
import type { Home } from "./home.ts";

/**
 * Moves an older mochi into a home: the data directory (store, work, memory, roles, instructions) becomes the home, its
 * config.json becomes config.toml, and the env file becomes the home's .env. The old data directory is left as a
 * symlink to the home, so paths written into past transcripts still resolve. Run it with the daemon stopped.
 */
export function migrate(input: { readonly from: string; readonly envFile?: string; readonly home: Home }): string[] {
	const { from, envFile, home } = input;
	const done: string[] = [];
	if (existsSync(home.dir)) throw new Error(`${home.dir} already exists; move it aside first.`);
	if (!existsSync(join(from, "mochi.sqlite"))) throw new Error(`${from} has no mochi.sqlite; nothing to migrate.`);
	renameSync(from, home.dir);
	symlinkSync(home.dir, from);
	done.push(`moved ${from} to ${home.dir} and left a symlink`);
	const oldConfig = join(home.dir, "config.json");
	if (existsSync(oldConfig)) {
		const config = JSON.parse(readFileSync(oldConfig, "utf8")) as Record<string, unknown>;
		writeFileSync(home.configFile, `${HEADER}${stringify(upgradeConfig(config))}\n`, { mode: 0o600 });
		renameSync(oldConfig, `${oldConfig}.migrated`);
		done.push(`wrote ${home.configFile}; the old file is config.json.migrated`);
	}
	if (envFile !== undefined && existsSync(envFile) && !existsSync(home.envFile)) {
		copyFileSync(envFile, home.envFile);
		chmodSync(home.envFile, 0o600);
		done.push(`copied ${envFile} to ${home.envFile}`);
	}
	return done;
}

const HEADER = "# mochi config. Keys live in .env next to this file. See config.example.toml in the repository.\n\n";

/**
 * The pre-home config used a fixed Bifrost gateway: Claude ids as `anthropic/<id>` and the OpenAI route as
 * `azure/<id>`. Those become two providers on the same gateway, and model names gain their provider prefix.
 */
export function upgradeConfig(config: Readonly<Record<string, unknown>>): Record<string, unknown> {
	const url = process.env.BIFROST_URL;
	if (url === undefined) throw new Error("Set BIFROST_URL to the gateway the old config used, then migrate.");
	const model = (id: string): string => (id.startsWith("anthropic/") ? `bifrost/${id.slice("anthropic/".length)}` : id.startsWith("azure/") ? `bifrost-gpt/${id}` : id);
	const triggers = Array.isArray(config.triggers)
		? config.triggers.map((trigger: Record<string, unknown>) => (typeof trigger.model === "string" ? { ...trigger, model: model(trigger.model) } : trigger))
		: undefined;
	return {
		...config,
		...(process.env.EXECUTOR_URL === undefined ? {} : { executorUrl: process.env.EXECUTOR_URL }),
		providers: {
			bifrost: { api: "anthropic", url: `${url}/anthropic`, keyEnv: "BIFROST_VIRTUAL_KEY" },
			"bifrost-gpt": { api: "responses", url: `${url}/openai/v1`, keyEnv: "BIFROST_VIRTUAL_KEY" },
		},
		models: {
			brain: "bifrost/claude-opus-5-5",
			fast: "bifrost-gpt/azure/gpt-6-luna",
			strongest: "bifrost/claude-fable-5-1",
			aliases: { opus: "bifrost/claude-opus-5-5", sonnet: "bifrost/claude-sonnet-5-5", fable: "bifrost/claude-fable-5-1", haiku: "bifrost/claude-haiku-5-5", luna: "bifrost-gpt/azure/gpt-6-luna", sol: "bifrost-gpt/azure/gpt-6.1-sol" },
			overrides: {
				"bifrost-gpt/azure/gpt-6-luna": { cost: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 }, contextWindow: 272_000, promptCache: { short: 1800, long: 1800 } },
			},
		},
		...(triggers === undefined ? {} : { triggers }),
	};
}
