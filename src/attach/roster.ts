import type { Context } from "@earendil-works/chord";
import { AgentDoc, type ConversationId, type ConversationRecord, type Harness, LiveDoc } from "@earendil-works/pi-durable";
import type { ChatUser } from "../config.ts";
import { allPages } from "../pages.ts";
import { ownerOf, type Profiles } from "../profiles/profiles.ts";
import { scanTriggers } from "../triggers/trigger.ts";
import { userConversation } from "../turn/turn.ts";
import type { AgentKind, AgentSummary, Target } from "./protocol.ts";

export type RosterDeps = {
	readonly harness: Harness;
	readonly root: ConversationId;
	readonly line: ConversationId;
	readonly profiles: Profiles;
	readonly users: readonly ChatUser[];
};

type Named = { readonly id: number; readonly kind: AgentKind; readonly label: string; readonly parent?: number; readonly title?: string };

const firstLine = (text: string): string => (text.split("\n").find((line) => line.trim() !== "") ?? "").trim().slice(0, 120);

// A script fork's stored brief starts with fork.ts's preamble paragraph; the caller's own brief follows it.
const FORK_PREAMBLE = /^You are [^\n]*, a fork of this conversation[^\n]*\n\n/;
const briefTitle = (brief: string): string => firstLine(brief.replace(FORK_PREAMBLE, ""));

/** Kind, label, parent and title of every conversation, from records and documents only: no entry scans. */
async function names(deps: RosterDeps, context: Context): Promise<Named[]> {
	const { harness } = deps;
	const { records, triggers } = await harness.commit(
		async (tx) => ({ records: await allPages((cursor) => tx.scanConversations({}, 256, cursor)), triggers: await scanTriggers(tx) }),
		context,
	);
	const triggerOf = new Map<number, { readonly id: string; readonly prompt: string }>();
	for (const task of triggers) triggerOf.set(task.conversationId, { id: task.input.trigger.id, prompt: task.input.trigger.prompt });
	const userOf = new Map<number, string>();
	for (const user of deps.users) {
		const id = await userConversation(harness, user.handle, context);
		if (id !== null) userOf.set(id, user.id);
	}
	const descriptions = new Map<string, string>();
	for (const profile of await deps.profiles.all()) descriptions.set(profile.name, profile.description);

	const result: Named[] = [];
	for (const record of records) result.push(await nameOf(deps, record, triggerOf, userOf, descriptions, context));
	return result;
}

async function nameOf(
	deps: RosterDeps,
	record: ConversationRecord,
	triggerOf: ReadonlyMap<number, { readonly id: string; readonly prompt: string }>,
	userOf: ReadonlyMap<number, string>,
	descriptions: ReadonlyMap<string, string>,
	context: Context,
): Promise<Named> {
	const id = record.id;
	const parentId = record.owner?.conversationId ?? record.parent?.conversationId;
	const parent = parentId === undefined ? {} : { parent: parentId };
	if (id === deps.root) return { id, kind: "root", label: "main" };
	if (id === deps.line) return { id, kind: "line", label: "line" };
	if (record.owner !== undefined) {
		const task = await deps.harness.getTask(record.owner.taskId, context);
		if (task?.kind === "mochi.agent") {
			const input = task.input as { readonly name: string; readonly brief: string };
			const kind = record.parent === undefined ? "agent" : "fork";
			return { id, kind, label: `${kind}:${input.name}@${id}`, ...parent, title: briefTitle(input.brief) };
		}
		return { id, kind: "conversation", label: `conversation:${id}`, ...parent };
	}
	const trigger = triggerOf.get(id);
	if (trigger !== undefined) return { id, kind: "trigger", label: `trigger:${trigger.id}`, ...parent, title: firstLine(trigger.prompt) };
	const owner = await ownerOf(deps.harness, id, context);
	if (owner !== "root") {
		const description = descriptions.get(owner.profile) ?? "";
		return { id, kind: "profile", label: `profile:${owner.profile}`, ...parent, ...(description === "" ? {} : { title: description }) };
	}
	const user = userOf.get(id);
	if (user !== undefined) return { id, kind: "user", label: `user:${user}`, ...parent };
	return { id, kind: "conversation", label: `conversation:${id}`, ...parent };
}

/** Every conversation the CLI may name, in id order. */
export async function roster(deps: RosterDeps, context: Context): Promise<AgentSummary[]> {
	const graph = await deps.harness.taskGraph(context);
	// Background tasks wait for a slot or a sweep; only foreground work makes a conversation busy.
	const working = new Set<number>();
	for (const node of Object.values(graph.value.tasks)) {
		if (!node.background) working.add(node.conversationId);
	}
	graph.dispose();
	const result: AgentSummary[] = [];
	for (const named of await names(deps, context)) {
		const id = named.id as ConversationId;
		const live = await deps.harness.snapshot(LiveDoc, id, context);
		const agent = await deps.harness.snapshot(AgentDoc, id, context);
		const busy = live?.run !== undefined || working.has(id);
		const model = agent?.model === undefined ? {} : { model: `${agent.model.provider}/${agent.model.modelId}` };
		result.push({ ...named, state: busy ? "busy" : "idle", ...model });
	}
	return result;
}

/** A number, or a string of digits, is a conversation id. Any other string must equal one label exactly. */
export async function resolveTarget(deps: RosterDeps, target: Target, context: Context): Promise<ConversationId> {
	if (typeof target === "number") return target as ConversationId;
	if (/^[0-9]+$/.test(target)) return Number(target) as ConversationId;
	if (target === "main") return deps.root;
	const matches: number[] = [];
	for (const named of await names(deps, context)) {
		if (named.label === target) matches.push(named.id);
	}
	if (matches.length === 1) return matches[0] as ConversationId;
	if (matches.length === 0) throw new Error(`No conversation is labelled "${target}". Run mochi agents to see the labels.`);
	throw new Error(`The label "${target}" names conversations ${matches.join(", ")}. Use the id.`);
}
