import { existsSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Where one mochi keeps everything that is the owner's: config, keys, instructions, roles, skills, the store and
 * the work directory. `MOCHI_HOME`, else `~/.mochi`. A profile is a home of its own under `<home>/profiles/<name>`.
 * The repository holds only code, bundled skills and bundled roles.
 */
export interface Home {
	readonly dir: string;
	/** `KEY=value` lines, loaded before anything reads the environment; a variable already set wins. */
	readonly envFile: string;
	readonly configFile: string;
	/** Root's own instructions, after every prompt section. Was `persona.md`; `adoptInstructions` renames it once. */
	readonly instructionsFile: string;
	readonly agentsDir: string;
	readonly skillsDir: string;
	readonly profilesDir: string;
	readonly logFile: string;
}

export function homeAt(dir: string): Home {
	return {
		dir,
		envFile: join(dir, ".env"),
		configFile: join(dir, "config.toml"),
		instructionsFile: join(dir, "instructions.md"),
		agentsDir: join(dir, "agents"),
		skillsDir: join(dir, "skills"),
		profilesDir: join(dir, "profiles"),
		logFile: join(dir, "mochi.log"),
	};
}

/** `MOCHI_HOME`, then the older `MOCHI_DATA_DIR`, then `~/.mochi`. `--profile <name>` picks `<home>/profiles/<name>`. */
export function resolveHome(env: Readonly<Record<string, string | undefined>>, profile?: string): Home {
	const base = resolve(env.MOCHI_HOME ?? env.MOCHI_DATA_DIR ?? join(homedir(), ".mochi"));
	return homeAt(profile === undefined ? base : join(base, "profiles", profile));
}

/** Loads the home's `.env` into `process.env`. Variables the process already has are kept. */
export function loadHomeEnv(home: Home): void {
	if (existsSync(home.envFile)) process.loadEnvFile(home.envFile);
}

/** A home from before 2026-10-14 keeps root's instructions in `persona.md`. Renames it once; a no-op after. */
export function adoptInstructions(home: Home): void {
	const old = join(home.dir, "persona.md");
	if (existsSync(old) && !existsSync(home.instructionsFile)) renameSync(old, home.instructionsFile);
}
