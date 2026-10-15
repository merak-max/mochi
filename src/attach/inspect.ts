import { writeFile } from "node:fs/promises";
import type { Cursor, UsageState } from "@earendil-works/pi-durable";
import type { AttachClient } from "./client.ts";
import type { AgentSummary, ModelSummary, Target } from "./protocol.ts";

const print = (text: string) => process.stdout.write(`${text}\n`);

/** Rows as columns padded to the widest cell; the last column is not padded. */
export function table(rows: readonly (readonly string[])[]): string {
	const widths: number[] = [];
	for (const row of rows) {
		for (let at = 0; at < row.length; at++) widths[at] = Math.max(widths[at] ?? 0, row[at]!.length);
	}
	const lines: string[] = [];
	for (const row of rows) {
		const cells = row.map((cell, at) => (at === row.length - 1 ? cell : cell.padEnd(widths[at]!)));
		lines.push(cells.join("  ").trimEnd());
	}
	return lines.join("\n");
}

export async function runAgents(client: AttachClient, json: boolean): Promise<void> {
	const agents = await client.request({ op: "agents" });
	if (json) {
		print(JSON.stringify(agents));
		return;
	}
	const labelOf = new Map<number, string>();
	for (const agent of agents) labelOf.set(agent.id, agent.label);
	const rows = [["ID", "KIND", "LABEL", "PARENT", "STATE", "MODEL", "TITLE"]];
	for (const agent of agents) rows.push(agentRow(agent, labelOf));
	print(table(rows));
}

function agentRow(agent: AgentSummary, labelOf: ReadonlyMap<number, string>): string[] {
	const parent = agent.parent === undefined ? "-" : (labelOf.get(agent.parent) ?? String(agent.parent));
	return [String(agent.id), agent.kind, agent.label, parent, agent.state, agent.model ?? "-", agent.title ?? ""];
}

function totalCost(usage: UsageState): number {
	let total = 0;
	for (const each of Object.values(usage.models)) total += each.cost.total;
	for (const each of Object.values(usage.tools)) total += each.cost.total;
	return total;
}

function uptime(startedAt: string): string {
	let seconds = Math.floor((Date.now() - Date.parse(startedAt)) / 1000);
	const days = Math.floor(seconds / 86_400);
	seconds -= days * 86_400;
	const hours = Math.floor(seconds / 3_600);
	seconds -= hours * 3_600;
	const minutes = Math.floor(seconds / 60);
	if (days > 0) return `${days}d ${hours}h`;
	if (hours > 0) return `${hours}h ${minutes}m`;
	return `${minutes}m ${seconds - minutes * 60}s`;
}

export async function runStatus(client: AttachClient, json: boolean): Promise<void> {
	const status = await client.request({ op: "status" });
	if (json) {
		print(JSON.stringify(status));
		return;
	}
	print(`mochi is running: pid ${status.pid}, up ${uptime(status.startedAt)} (since ${status.startedAt})`);
	print(`protocol ${status.protocol}, build ${status.build}, scheduling ${status.scheduling}`);
	print(`home ${status.home}`);
	print(`channels: ${status.channels.length === 0 ? "none" : status.channels.join(", ")}`);
	print(`live tasks: ${status.liveTasks}`);
	print(`usage: $${totalCost(status.usage).toFixed(2)} in total`);
	print("setup:");
	for (const line of status.setup) print(`  ${line}`);
}

export function printModels(models: readonly ModelSummary[], search: string | undefined, json: boolean): void {
	const wanted = search?.toLowerCase();
	const shown: ModelSummary[] = [];
	for (const model of models) {
		const words = [model.provider, model.modelId, model.name, ...model.roles].join(" ").toLowerCase();
		if (wanted === undefined || words.includes(wanted)) shown.push(model);
	}
	if (json) {
		print(JSON.stringify(shown));
		return;
	}
	const rows = [["MODEL", "CONTEXT", "ROLES"]];
	for (const model of shown) rows.push([`${model.provider}/${model.modelId}`, String(model.contextWindow), model.roles.join(", ")]);
	print(table(rows));
}

/** One JSON line per entry, oldest first. `out` must not exist yet, so an export never overwrites a file. */
export async function runExport(client: AttachClient, to: Target, out: string | undefined): Promise<void> {
	const lines: string[] = [];
	let cursor: Cursor | undefined;
	do {
		const page = await client.request({ op: "export", to, ...(cursor === undefined ? {} : { cursor }) });
		for (const entry of page.items) lines.push(JSON.stringify(entry));
		cursor = page.next;
	} while (cursor !== undefined);
	const text = lines.length === 0 ? "" : `${lines.join("\n")}\n`;
	if (out === undefined) {
		process.stdout.write(text);
		return;
	}
	await writeFile(out, text, { flag: "wx" });
	process.stderr.write(`Wrote ${lines.length} entries to ${out}.\n`);
}
