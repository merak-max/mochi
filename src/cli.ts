import type { Target } from "./attach/protocol.ts";

type Flag = { readonly name: string; readonly value?: string; readonly help: string };
type Command = { readonly name: string; readonly args: string; readonly summary: string; readonly flags: readonly Flag[] };

const JSON_FLAG: Flag = { name: "--json", help: "Print JSON instead of text." };
const ID_FLAG: Flag = { name: "--id", value: "key", help: "Make it safe to run again: line n becomes request cli:<key>:<n>, and a repeat gets the first answer." };
const TO_FLAG: Flag = { name: "--to", value: "id|label", help: "Send to this conversation instead of main." };

/** Every command. parseCli reads flags and arguments from it and helpText prints it. Order is the help order. */
export const COMMANDS = [
	{ name: "tui", args: "", summary: "Full-screen chat with main (also: mochi with no arguments on a terminal). Without a daemon, this process becomes one until it exits.", flags: [] },
	{ name: "attach", args: "<id|label>", summary: "The full-screen chat on another conversation. Needs a running daemon.", flags: [] },
	{ name: "chat", args: "", summary: "Each stdin line is a message; each answer prints.", flags: [TO_FLAG, ID_FLAG, JSON_FLAG] },
	{ name: "-p", args: "<prompt>", summary: "One message, then its answer. Also --print.", flags: [TO_FLAG, ID_FLAG, JSON_FLAG] },
	{ name: "agents", args: "", summary: "Every conversation: id, kind, label, parent, state, model, title.", flags: [JSON_FLAG] },
	{ name: "status", args: "", summary: "The daemon: pid, uptime, protocol, build, channels, setup report, usage, live tasks.", flags: [JSON_FLAG] },
	{ name: "doctor", args: "", summary: "Checks home, config, lock, socket, protocol, systemd unit and log. Changes nothing. Exits 1 when a check fails.", flags: [JSON_FLAG] },
	{ name: "models", args: "[search]", summary: "The configured models and their roles (brain, fast, strongest, classifier, aliases).", flags: [JSON_FLAG] },
	{ name: "stop", args: "", summary: "Stops the daemon: systemctl --user stop mochi when systemd runs it, else SIGTERM and wait.", flags: [] },
	{ name: "export", args: "<id|label> [out]", summary: "A conversation's history as JSON lines, to a new file out or to stdout.", flags: [] },
	{ name: "--headless", args: "", summary: "The daemon alone. This is the systemd mode.", flags: [] },
	{ name: "auth", args: "apps", summary: "OAuth login to the apps server.", flags: [] },
	{ name: "service", args: "install", summary: "Writes the systemd user unit.", flags: [] },
	{ name: "help", args: "[command]", summary: "This text, or one command's. Also -h and --help.", flags: [] },
	{ name: "version", args: "", summary: "The build of this checkout. Also -v and --version.", flags: [] },
] as const satisfies readonly Command[];

export type CommandName = (typeof COMMANDS)[number]["name"];

export type Cli =
	| { readonly kind: "tui"; readonly to?: Target }
	| { readonly kind: "daemon" }
	| { readonly kind: "lines"; readonly prompt?: string; readonly to?: Target; readonly id?: string; readonly json: boolean }
	| { readonly kind: "agents"; readonly json: boolean }
	| { readonly kind: "status"; readonly json: boolean }
	| { readonly kind: "doctor"; readonly json: boolean }
	| { readonly kind: "models"; readonly search?: string; readonly json: boolean }
	| { readonly kind: "stop" }
	| { readonly kind: "export"; readonly to: Target; readonly out?: string }
	| { readonly kind: "auth-apps" }
	| { readonly kind: "service-install" }
	| { readonly kind: "help"; readonly command?: CommandName }
	| { readonly kind: "version" };

const ID_KEY = /^[A-Za-z0-9._-]+$/;

function find(name: string): Command | undefined {
	const ALIASES: Readonly<Record<string, string>> = { "--print": "-p", "-h": "help", "--help": "help", "-v": "version", "--version": "version" };
	const wanted = ALIASES[name] ?? name;
	for (const command of COMMANDS) {
		if (command.name === wanted) return command;
	}
	return undefined;
}

const fail = (problem: string, command?: string): never => {
	throw new Error(`${problem} Run mochi help${command === undefined ? "" : ` ${command}`}.`);
};

/** A number in a target is a conversation id; anything else is a label. */
const targetOf = (text: string): Target => (/^[0-9]+$/.test(text) ? Number(text) : text);

/**
 * argv to Cli. No arguments: the TUI on a terminal, else the daemon. "--json" alone streams main's view.
 * "<command> --help" and "-h" give that command's help.
 */
export function parseCli(argv: readonly string[], interactive: boolean): Cli {
	if (argv.length === 0) return interactive ? { kind: "tui" } : { kind: "daemon" };
	if (argv.length === 1 && argv[0] === "--json") return { kind: "lines", json: true };
	const command = find(argv[0]!);
	if (command === undefined) return fail(`Unknown command ${argv[0]}.`);
	const name = command.name as CommandName;
	if (argv.includes("--help") || argv.includes("-h")) return name === "help" ? { kind: "help" } : { kind: "help", command: name };

	const values = new Map<string, string>();
	const switches = new Set<string>();
	const positional: string[] = [];
	for (let at = 1; at < argv.length; at++) {
		const arg = argv[at]!;
		if (!arg.startsWith("--") || arg === "--") {
			positional.push(arg);
			continue;
		}
		const flag = command.flags.find((each) => each.name === arg);
		if (flag === undefined) return fail(`mochi ${name} has no flag ${arg}.`, name);
		if (flag.value === undefined) {
			switches.add(arg);
			continue;
		}
		const value = argv[at + 1];
		if (value === undefined) return fail(`${arg} needs a ${flag.value}.`, name);
		values.set(arg, value);
		at++;
	}
	const required = command.args.split(" ").filter((word) => word.startsWith("<")).length;
	const optional = command.args.split(" ").filter((word) => word.startsWith("[")).length;
	if (positional.length < required || positional.length > required + optional) {
		return fail(`Usage: mochi ${name}${command.args === "" ? "" : ` ${command.args}`}.`, name);
	}

	const json = switches.has("--json");
	const id = values.get("--id");
	if (id !== undefined && !ID_KEY.test(id)) return fail("--id needs a key of letters, digits, dot, dash or underscore.", name);
	const toText = values.get("--to");
	const to = toText === undefined ? {} : { to: targetOf(toText) };
	const first = positional[0];
	const second = positional[1];
	switch (name) {
		case "tui":
			return { kind: "tui" };
		case "attach":
			return { kind: "tui", to: targetOf(first!) };
		case "chat":
			return { kind: "lines", json, ...to, ...(id === undefined ? {} : { id }) };
		case "-p":
			return { kind: "lines", prompt: first!, json, ...to, ...(id === undefined ? {} : { id }) };
		case "agents":
			return { kind: "agents", json };
		case "status":
			return { kind: "status", json };
		case "doctor":
			return { kind: "doctor", json };
		case "models":
			return { kind: "models", json, ...(first === undefined ? {} : { search: first }) };
		case "stop":
			return { kind: "stop" };
		case "export":
			return { kind: "export", to: targetOf(first!), ...(second === undefined ? {} : { out: second }) };
		case "--headless":
			return { kind: "daemon" };
		case "auth":
			if (first !== "apps") return fail(`Unknown auth target ${first}.`, name);
			return { kind: "auth-apps" };
		case "service":
			if (first !== "install") return fail(`Unknown service action ${first}.`, name);
			return { kind: "service-install" };
		case "help": {
			if (first === undefined) return { kind: "help" };
			const wanted = find(first);
			if (wanted === undefined) return fail(`Unknown command ${first}.`);
			return { kind: "help", command: wanted.name as CommandName };
		}
		case "version":
			return { kind: "version" };
		default: {
			const _exhaustive: never = name;
			throw new Error(`Unhandled command ${String(_exhaustive)}`);
		}
	}
}

const usageOf = (command: Command): string => `mochi ${command.name}${command.args === "" ? "" : ` ${command.args}`}`;

export function helpText(name?: CommandName): string {
	if (name === undefined) {
		const lines = ["Usage: mochi <command>", ""];
		const width = Math.max(...COMMANDS.map((command) => usageOf(command).length));
		for (const command of COMMANDS) lines.push(`  ${usageOf(command).padEnd(width)}  ${command.summary}`);
		lines.push("", "Run mochi help <command> for its flags.");
		return lines.join("\n");
	}
	const command = find(name)!;
	const flagNames = command.flags.map((flag) => (flag.value === undefined ? flag.name : `${flag.name} <${flag.value}>`));
	const lines = [`Usage: ${usageOf(command)}${flagNames.map((flag) => ` [${flag}]`).join("")}`, "", command.summary];
	if (command.flags.length > 0) lines.push("");
	const width = Math.max(0, ...flagNames.map((flag) => flag.length));
	for (let at = 0; at < command.flags.length; at++) lines.push(`  ${flagNames[at]!.padEnd(width)}  ${command.flags[at]!.help}`);
	return lines.join("\n");
}
