// Runs scenarios against live Opus, each in a clean data directory under a clock shifted to the scenario's time, then
// dumps and grades them. Each scenario is seeded (eval/seed.ts) and driven (eval/drive.ts) in its own processes.
// Usage: node eval/run.ts <label> [scenario ids...] [--repo <dir>] [--jobs 4] [--regrade]
// --regrade grades the label's saved transcripts again without running anything.
// <label> names the output directory eval/runs/<label>. --repo runs another checkout's src (the baseline copy).
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { dump, render, type Transcript } from "./dump.ts";
import { type Grade, grade, type Sent } from "./grade.ts";
import { type Scenario, SCENARIOS, scenario as byId } from "./scenarios.ts";
import { skewFor } from "./seed.ts";

const EVAL = import.meta.dirname;
const CLOCK = join(EVAL, "clock.ts");
const RUN_TIMEOUT_MS = 10 * 60_000;

function option(args: string[], name: string): string | undefined {
	const at = args.indexOf(name);
	if (at < 0) return undefined;
	const value = args[at + 1];
	args.splice(at, 2);
	return value;
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const repo = resolve(option(args, "--repo") ?? join(EVAL, ".."));
	const jobs = Number(option(args, "--jobs") ?? 4);
	const [label, ...ids] = args;
	if (label === undefined) throw new Error("Usage: node eval/run.ts <label> [scenario ids...] [--repo <dir>] [--jobs n]");
	const regrade = ids.includes("--regrade");
	const named = ids.filter((id) => id !== "--regrade");
	const chosen = named.length === 0 ? SCENARIOS : named.map(byId);
	const out = join(EVAL, "runs", label);
	await mkdir(out, { recursive: true });
	const queue = [...chosen];
	const grades: Grade[] = [];
	await Promise.all(
		Array.from({ length: Math.min(jobs, queue.length) }, async () => {
			for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
				const graded = await (regrade ? gradeDir(next, join(out, next.id)) : runScenario(next, join(out, next.id), repo)).catch((error: unknown) => {
					process.stderr.write(`${next.id} failed to run: ${String(error)}\n`);
					return undefined;
				});
				if (graded !== undefined) grades.push(graded);
				process.stderr.write(`${next.id}: ${graded?.pass ? "PASS" : "FAIL"}\n`);
			}
		}),
	);
	await writeFile(join(out, "summary.md"), summary(label, grades.sort((a, b) => SCENARIOS.findIndex((s) => s.id === a.id) - SCENARIOS.findIndex((s) => s.id === b.id))));
	process.stdout.write(await readFile(join(out, "summary.md"), "utf8"));
}

async function runScenario(scenario: Scenario, dir: string, repo: string): Promise<Grade> {
	await rm(dir, { recursive: true, force: true });
	const dataDir = join(dir, "data");
	await mkdir(dataDir, { recursive: true });
	const env = { ...nodeEnv(), MOCHI_EVAL_SKEW_MS: String(skewFor(scenario.at)) };
	const log: string[] = [];
	const seeded = await spawnNode(["--import", CLOCK, join(EVAL, "seed.ts"), dataDir, scenario.id], env, undefined);
	if (seeded.code !== 0) throw new Error(`seed failed: ${seeded.stderr}`);
	const drive = ["--import", CLOCK, join(EVAL, "drive.ts"), dataDir, scenario.id, "--repo", repo];
	const first = await spawnNode(drive, env, scenario.crashOn === undefined ? undefined : join(dataDir, "work", scenario.crashOn));
	log.push("--- run 1", first.stdout, first.stderr);
	if (first.killed) {
		const second = await spawnNode(drive, env, undefined);
		log.push("--- run 2, after SIGKILL", second.stdout, second.stderr);
	}
	await writeFile(join(dir, "run.log"), log.join("\n"));
	const transcript = await dump(dataDir);
	await writeFile(join(dir, "transcript.json"), JSON.stringify(transcript, null, 1));
	return gradeDir(scenario, dir);
}

/** Grade a finished scenario directory from its transcript.json, sent.jsonl and work files; rewrites transcript.md and grade.json. */
async function gradeDir(scenario: Scenario, dir: string): Promise<Grade> {
	const dataDir = join(dir, "data");
	const transcript = JSON.parse(await readFile(join(dir, "transcript.json"), "utf8")) as Transcript;
	const sent = existsSync(join(dir, "sent.jsonl"))
		? (await readFile(join(dir, "sent.jsonl"), "utf8")).split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as Sent)
		: [];
	await writeFile(join(dir, "transcript.md"), `${render(transcript)}\n\n## sent to the owner's ${scenario.channel}\n${sent.map((item) => (item.kind === "send" ? `> ${item.text.replaceAll("\n", "\n> ")}` : `[react ${item.emoji}]`)).join("\n\n")}\n`);
	const bookings = existsSync(join(dataDir, "work", "bookings.log"))
		? (await readFile(join(dataDir, "work", "bookings.log"), "utf8")).split("\n").filter((line) => line.trim() !== "").length
		: 0;
	const graded = grade(scenario, transcript, { sent, bookings, today: scenario.at.slice(0, 10) });
	await writeFile(join(dir, "grade.json"), JSON.stringify(graded, null, 1));
	return graded;
}

/** Only what mochi needs: its three keys and a PATH without the owner's tool installs. */
function nodeEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		PATH: `${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
		HOME: process.env.HOME,
		LANG: "C.UTF-8",
	};
	for (const key of ["BIFROST_VIRTUAL_KEY", "OPENROUTER_API_KEY", "FIRECRAWL_API_KEY"]) if (process.env[key]) env[key] = process.env[key];
	return env;
}

/** `node <args>` with `env`. With `killOn`, SIGKILL it two seconds after that file appears. */
async function spawnNode(args: readonly string[], env: NodeJS.ProcessEnv, killOn: string | undefined): Promise<{ stdout: string; stderr: string; killed: boolean; code: number | null }> {
	const child = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "";
	let stderr = "";
	child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
	child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
	let killed = false;
	const poll =
		killOn === undefined
			? undefined
			: setInterval(() => {
					if (!killed && existsSync(killOn)) {
						killed = true;
						setTimeout(() => child.kill("SIGKILL"), 2000);
					}
				}, 200);
	const timer = setTimeout(() => child.kill("SIGKILL"), RUN_TIMEOUT_MS);
	await exited(child);
	clearTimeout(timer);
	if (poll !== undefined) clearInterval(poll);
	return { stdout, stderr, killed, code: child.exitCode };
}

function exited(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
	return new Promise((resolveExit) => child.once("exit", () => resolveExit()));
}

function summary(label: string, grades: readonly Grade[]): string {
	const rows = grades.map((g) => {
		const failed = g.checks.filter((check) => !check.pass).map((check) => `${check.name}${check.detail === "" ? "" : ` (${check.detail})`}`);
		return `| ${g.id} | ${g.pass ? "pass" : "FAIL"} | ${g.checks.filter((c) => c.pass).length}/${g.checks.length} | ${g.promptTokensPerTurn} | ${g.outputTokensPerTurn} | $${g.cost.toFixed(3)} | ${g.toolCalls.join(" ")} | ${failed.join("; ")} |`;
	});
	const passed = grades.filter((g) => g.pass).length;
	const checks = grades.flatMap((g) => g.checks);
	return [
		`# Eval ${label}`,
		"",
		`Scenarios passed: ${passed}/${grades.length}. Checks passed: ${checks.filter((c) => c.pass).length}/${checks.length}. Cost: $${grades.reduce((s, g) => s + g.cost, 0).toFixed(3)}.`,
		"",
		"| scenario | result | checks | prompt tok/turn | output tok/turn | cost | tools called | failed checks |",
		"|---|---|---|---|---|---|---|---|",
		...rows,
		"",
	].join("\n");
}

if (import.meta.main) await main();
