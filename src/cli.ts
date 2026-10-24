type Flag = { readonly name: string; readonly value?: string; readonly help: string };
type Command = { readonly name: string; readonly args: string; readonly summary: string; readonly flags: readonly Flag[] };

const JSON_FLAG: Flag = { name: "--json", help: "Print JSON instead of text." };

/** Every command. parseCli reads flags and arguments from it and helpText prints it. Order is the help order. */
export const COMMANDS = [
	{ name: "tui", args: "", summary: "Full-screen chat with main (also: mochi with no arguments on a terminal). Without a daemon, this process becomes one until it exits.", flags: [] },
	{ name: "chat", args: "", summary: "Each stdin line is a message to main; each answer prints. /new and /stop work here.", flags: [] },
	{ name: "-p", args: "<prompt>", summary: "One message to main, then its answer. Also --print.", flags: [] },
	{ name: "status", args: "", summary: "The daemon: pid, uptime, wire, build, channels, setup report.", flags: [JSON_FLAG] },
	{ name: "doctor", args: "", summary: "Checks home, config, lock, socket, wire, systemd unit and log. Changes nothing. Exits 1 when a check fails.", flags: [JSON_FLAG] },
	{ name: "stop", args: "", summary: "Stops the daemon: systemctl --user stop mochi when systemd runs it, else SIGTERM and wait.", flags: [] },
	{ name: "--headless", args: "", summary: "The daemon alone. This is the systemd mode.", flags: [] },
	{ name: "auth", args: "apps", summary: "OAuth login to the apps server.", flags: [] },
	{ name: "service", args: "install", summary: "Writes the systemd user unit.", flags: [] },
	{ name: "help", args: "[command]", summary: "This text, or one command's. Also -h and --help.", flags: [] },
	{ name: "version", args: "", summary: "The build of this checkout. Also -v and --version.", flags: [] },
] as const satisfies readonly Command[];

export type CommandName = (typeof COMMANDS)[number]["name"];

export type Cli =
	| { readonly kind: "tui" }
	| { readonly kind: "daemon" }
	| { readonly kind: "lines"; readonly prompt?: string }
	| { readonly kind: "status"; readonly json: boolean }
	| { readonly kind: "doctor"; readonly json: boolean }
	| { readonly kind: "stop" }
	| { readonly kind: "auth-apps" }
	| { readonly kind: "service-install" }
	| { readonly kind: "help"; readonly command?: CommandName }
	| { readonly kind: "version" };

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

/**
 * argv to Cli. No arguments: the TUI on a terminal, else the daemon.
 * "<command> --help" and "-h" give that command's help.
 */
export function parseCli(argv: readonly string[], interactive: boolean): Cli {
	if (argv.length === 0) return interactive ? { kind: "tui" } : { kind: "daemon" };
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
	const first = positional[0];
	switch (name) {
		case "tui":
			return { kind: "tui" };
		case "chat":
			return { kind: "lines" };
		case "-p":
			return { kind: "lines", prompt: first! };
		case "status":
			return { kind: "status", json };
		case "doctor":
			return { kind: "doctor", json };
		case "stop":
			return { kind: "stop" };
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
