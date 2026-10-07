// Prints the model-facing surface of root: every tool with its schema size, and every prompt section with its size;
// then each seat's tool names and bytes.
// Run: node eval/surface.ts [--json]
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message, SystemMessage, Tool } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { createSeatConversation, type Seat, SEATS } from "../src/seats.ts";
import { AgentCatalog } from "../src/agents/catalog.ts";
import { fixedClassify, newFaux, openTestMochi, recordingChannel, tempDir } from "../src/test-support.ts";

const REPO = join(import.meta.dirname, "..");

export interface Surface {
	readonly tools: readonly { name: string; bytes: number }[];
	readonly sections: readonly { name: string; bytes: number }[];
	readonly base: number;
	readonly totalBytes: number;
}

export async function measureSurface(seat: Seat = "owner"): Promise<Surface> {
	const faux = newFaux();
	let seen: Message[] = [];
	faux.setResponses([
		(context) => {
			seen = context.messages;
			return fauxAssistantMessage("ok");
		},
	]);
	const dir = await tempDir();
	const channels = new Map([["whatsapp", recordingChannel("whatsapp").channel]] as const);
	const mochi = await openTestMochi(dir, faux, channels, fixedClassify(1), [], {
		skillsDir: join(REPO, "skills"),
		agents: await AgentCatalog.load(join(REPO, "agents")),
	});
	const id = seat === "owner" ? mochi.root.id : await mochi.harness.commit((tx) => createSeatConversation(tx, seat, { kind: "ownerless" }), BACKGROUND_CONTEXT);
	const conversation = (await mochi.harness.conversation(id, BACKGROUND_CONTEXT))!;
	await (await conversation.submit({ type: "input", content: "hi" }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
	await mochi.close();
	const system = seen.find((message): message is SystemMessage => message.role === "system");
	if (system === undefined) throw new Error("The first request carried no system message.");
	const tools = (system.toolsAdded ?? []).map((tool: Tool) => ({ name: tool.name, bytes: JSON.stringify(tool).length }));
	const sections = Object.entries(system.sections ?? {}).map(([name, text]) => ({ name, bytes: (text ?? "").length }));
	const base = typeof system.content === "string" ? system.content.length : JSON.stringify(system.content).length;
	const totalBytes = base + tools.reduce((sum, tool) => sum + tool.bytes, 0) + sections.reduce((sum, section) => sum + section.bytes, 0);
	return { tools, sections, base, totalBytes };
}

if (import.meta.main) {
	const surface = await measureSurface();
	if (process.argv.includes("--json")) {
		process.stdout.write(`${JSON.stringify(surface)}\n`);
	} else {
		for (const tool of surface.tools) process.stdout.write(`tool ${tool.name} ${tool.bytes}\n`);
		for (const section of surface.sections) process.stdout.write(`section ${section.name} ${section.bytes}\n`);
		for (const seat of SEATS) {
			const { tools } = await measureSurface(seat);
			process.stdout.write(`seat ${seat} tools=${tools.length} toolBytes=${tools.reduce((s, t) => s + t.bytes, 0)} ${tools.map((t) => t.name).join(" ")}\n`);
		}
		process.stdout.write(`tools=${surface.tools.length} toolBytes=${surface.tools.reduce((s, t) => s + t.bytes, 0)} sectionBytes=${surface.sections.reduce((s, x) => s + x.bytes, 0)} base=${surface.base} total=${surface.totalBytes} (~${Math.round(surface.totalBytes / 4)} tokens)\n`);
	}
}
