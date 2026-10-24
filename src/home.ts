import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Where one mochi keeps everything that is the owner's: config, keys, instructions, roles, skills, the store and
 * the work directory. `MOCHI_HOME`, else `~/.mochi`. Each profile's instructions live in `<home>/profiles/<name>`.
 * The repository holds only code, bundled skills and the bundled worker profile.
 */
export interface Home {
	readonly dir: string;
	/** `KEY=value` lines, loaded before anything reads the environment; a variable already set wins. */
	readonly envFile: string;
	readonly configFile: string;
	/** Root's own instructions, after every prompt section. */
	readonly instructionsFile: string;
	readonly skillsDir: string;
	readonly profilesDir: string;
	/** The owner's own tools, one `<name>.ts` each, loaded by `tools_reload`. */
	readonly toolsDir: string;
	/** Lasting facts as markdown, `<home>/memory`. */
	readonly memoryDir: string;
	readonly logFile: string;
}

/** `MOCHI_HOME`, else `~/.mochi`. */
export function resolveHome(env: Readonly<Record<string, string | undefined>>): Home {
	const dir = resolve(env.MOCHI_HOME ?? join(homedir(), ".mochi"));
	return {
		dir,
		envFile: join(dir, ".env"),
		configFile: join(dir, "config.toml"),
		instructionsFile: join(dir, "instructions.md"),
		skillsDir: join(dir, "skills"),
		profilesDir: join(dir, "profiles"),
		toolsDir: join(dir, "tools"),
		memoryDir: join(dir, "memory"),
		logFile: join(dir, "mochi.log"),
	};
}
