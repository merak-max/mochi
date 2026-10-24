import { readdir, stat } from "node:fs/promises";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type Extension, type Registry, type ToolRegistration } from "@earendil-works/pi-durable";

/** One file of `<home>/tools`: the version that is live, and the error of the newest load if it failed. */
type Loaded = { readonly file: string; readonly name?: string; readonly mtime?: string; readonly error?: string };

const ENTRY = pathToFileURL(join(import.meta.dirname, "..", "main.ts")).href;

/**
 * Home tools import packages as the repo does: a bare import in `<dir>` resolves from mochi's own node_modules, so
 * `import { defineTool } from "@earendil-works/pi-durable"` works in a file outside the repo.
 */
function resolveFromRepo(dir: string): void {
	const prefix = pathToFileURL(dir).href + "/";
	registerHooks({
		resolve(specifier, context, next) {
			const bare = !specifier.startsWith(".") && !specifier.startsWith("/") && !specifier.includes(":");
			if (bare && context.parentURL?.startsWith(prefix)) return next(specifier, { ...context, parentURL: ENTRY });
			return next(specifier, context);
		},
	});
}

function isTool(value: unknown): value is ToolRegistration {
	if (typeof value !== "object" || value === null) return false;
	const tool = value as Partial<ToolRegistration>;
	return typeof tool.name === "string" && typeof tool.execute === "function" && typeof tool.parameters === "object";
}

/**
 * The owner's own tools: each `<dir>/<name>.ts` default-exports one `defineTool` tool, callable from agent-seat
 * scripts. `seat` rebuilds the `seat-agent` extension with the given home tools; installing it replaces the old one in
 * place, so the next script sees the change without a restart.
 */
export function homeTools(dir: string, registry: Registry, seat: (tools: readonly ToolRegistration[]) => Extension) {
	resolveFromRepo(dir);
	const live = new Map<string, { tool: ToolRegistration; name: string; mtime: string }>();
	let builtIn: readonly string[] = [];

	/**
	 * Imports every changed file. A file that fails keeps no tool: its error is in the result, and the others stay.
	 * `names`: the built-in tool names, given once at start; a home tool may not take one.
	 */
	async function reload(names?: readonly string[]): Promise<Loaded[]> {
		if (names !== undefined) builtIn = names;
		const files: string[] = [];
		for (const entry of await readdir(dir).catch((error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? [] : Promise.reject(error)))) {
			if (entry.endsWith(".ts")) files.push(entry);
		}
		files.sort();
		const result: Loaded[] = [];
		for (const file of [...live.keys()]) {
			if (!files.includes(file)) live.delete(file);
		}
		for (const file of files) {
			const path = join(dir, file);
			const mtime = (await stat(path)).mtime.toISOString();
			const before = live.get(file);
			if (before !== undefined && before.mtime === mtime) {
				result.push({ file, name: before.name, mtime });
				continue;
			}
			live.delete(file);
			try {
				const module = (await import(`${pathToFileURL(path).href}?v=${Date.parse(mtime)}`)) as { default?: unknown };
				if (!isTool(module.default)) throw new Error("the default export is not a defineTool tool");
				const name = module.default.name;
				if (builtIn.includes(name)) throw new Error(`${name} is a built-in tool; pick another name`);
				for (const [other, loaded] of live) {
					if (loaded.name === name) throw new Error(`${other} already defines ${name}`);
				}
				live.set(file, { tool: { ...module.default, callers: ["tools"], deferred: true }, name, mtime });
				result.push({ file, name, mtime });
			} catch (error) {
				result.push({ file, mtime, error: error instanceof Error ? error.message : String(error) });
			}
		}
		registry.install(seat([...live.values()].map((each) => each.tool)));
		return result;
	}

	const tool = defineTool({
		name: "tools_reload",
		description:
			`Load the tools in ${dir}: each <name>.ts default-exports one defineTool({ name, description, parameters, execute }) from "@earendil-works/pi-durable" (Type from "@earendil-works/pi-ai"). ` +
			"Returns each file with the tool name now live, or its error; a file that fails has no live tool. The change shows from the next script on; find a loaded tool there with searchTools().",
		parameters: Type.Object({}),
		structuredOutputSchema: Type.Array(
			Type.Object({ file: Type.String(), name: Type.Optional(Type.String()), mtime: Type.Optional(Type.String()), error: Type.Optional(Type.String()) }),
		),
		replay: "safe",
		execute: async () => ({ structuredOutput: await reload() }),
	});
	return { tool, reload };
}
