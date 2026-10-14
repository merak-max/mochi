// Dream over a stopped or copied data directory without writing anything: pin from `since` (default 0, all history),
// narrow on the fast model, ask the reviewer, then check the proposals in a commit that is always rolled back.
// Usage: node eval/dream-dry.ts <dataDir> [since]
import "../src/config.ts";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createRegistry, Harness, type TaskId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createBifrostModels, FAST, OPUS } from "../src/brain/models.ts";
import { applyDreamBatch, BatchSchema, INSTRUCTIONS, narrow, parseJsonAnswer, pinMemory } from "../src/memory/dream.ts";
import { parseWith } from "../src/parse.ts";
import { messageText } from "../src/text.ts";
import { fastCompletion } from "../src/turn/lifecycle.ts";

const [dataDir, sinceArg] = process.argv.slice(2);
if (dataDir === undefined) throw new Error("Usage: node eval/dream-dry.ts <dataDir> [since]");
const models = createBifrostModels(process.env.BIFROST_VIRTUAL_KEY ?? "", process.env.OPENROUTER_API_KEY);
const harness = await Harness.open(await openNodeSqliteStorage(join(dataDir, "mochi.sqlite")), { models, registry: createRegistry() }, context);

class Rollback extends Error {}
async function readOnly<T>(read: Parameters<typeof harness.commit>[0]): Promise<T> {
	let value: T | undefined;
	await harness.commit(async (tx) => {
		value = (await read(tx)) as T;
		throw new Rollback();
	}, context).catch((error: unknown) => {
		if (!(error instanceof Rollback)) throw error;
	});
	return value as T;
}

const pin = await readOnly<Awaited<ReturnType<typeof pinMemory>>>((tx) => pinMemory(tx, OPUS, Date.now(), "dry" as unknown as TaskId, Number(sinceArg ?? 0)));
const pinnedChars = pin.evidence.reduce((total, item) => total + item.text.length, 0);
console.log(`pinned ${pin.evidence.length} entries, ${pinnedChars} chars, cutoff ${pin.cutoff}`);
const fast = fastCompletion(models, FAST);
const memos = new Map<string, unknown>();
let maps = 0;
const evidence = await narrow(pin.evidence, async (request, ctx) => (maps++, fast(request, ctx)), async (name, compute) => {
	if (!memos.has(name)) memos.set(name, await compute());
	return memos.get(name) as never;
}, context);
console.log(`map calls ${maps}; reviewing ${evidence.length} entries, ${evidence.reduce((t, i) => t + i.text.length, 0)} chars; owner chat ${evidence.filter((i) => i.conversation === 1).length}`);
const brain = models.getModel(OPUS.provider, OPUS.modelId)!;
const response = await models.completeSimple(brain, { systemPrompt: INSTRUCTIONS, messages: [{ role: "user", content: JSON.stringify({ memory: pin.memory, cutoff: pin.cutoff, evidence }), timestamp: Date.now() }] }, { reasoning: "medium", maxTokens: 16_000 });
const batch = parseWith(BatchSchema, parseJsonAnswer(messageText(response)), "Dreaming proposals");
console.log(`reviewer usage ${JSON.stringify(response.usage.cost)}`);
for (const proposal of batch) console.log(proposal.kind === "put" ? `PUT ${proposal.note.slug} (${proposal.note.kind}): ${proposal.note.body}` : `FORGET ${proposal.slug}`);
const verdict = await readOnly<string>(async (tx) => {
	try {
		await applyDreamBatch(tx, pin, batch, new Date().toISOString().slice(0, 10));
		return "the batch passes every check";
	} catch (error) {
		return `the batch is rejected: ${String(error)}`;
	}
});
console.log(verdict);
await harness.close(context);
