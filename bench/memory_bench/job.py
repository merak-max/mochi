import argparse
import asyncio
import importlib
import json
import shutil
import sys
import time

from openai import AsyncOpenAI

from memory_bench.common import (
    ANSWER_EFFORT,
    ANSWER_SYSTEM,
    BENCH_KEY,
    LUNA,
    append_jsonl,
    item_dir,
    item_file,
    memory_prompt,
    proxy_url,
    read_jsonl,
    write_json_atomic,
)

SYSTEM_MODULES = {
    "full-context": "memory_bench.systems.full_context",
    "rag": "memory_bench.systems.rag",
    "mem0": "memory_bench.systems.mem0_system",
    "graphiti": "memory_bench.systems.graphiti_system",
    "amr": "memory_bench.systems.amr_system",
    "amr-dream": "memory_bench.systems.amr_system",
    "fact-log": "memory_bench.systems.fact_log",
}
RESUMABLE_INGEST = {"graphiti", "mem0", "amr", "amr-dream", "fact-log"}
CONTENT_FILTER_EXIT = 3
CONTENT_FILTER_MARKS = ("content_filter", "content management policy")
ANSWER_CONCURRENCY = 8


class Job:
    def __init__(self, run_dir, bench, item_id, system):
        self.run_dir = run_dir
        self.bench = bench
        self.item_id = item_id
        self.system = system
        self.item = json.loads(item_file(run_dir, bench, item_id).read_text())
        self.dir = item_dir(run_dir, bench, system, item_id)
        self.store = self.dir / "store"
        self.lock = asyncio.Lock()

    def url(self, phase):
        return proxy_url(self.system, self.bench, self.item_id, phase)


async def run_ingest(job, module):
    ingest_file = job.dir / "ingest.json"
    if ingest_file.exists():
        return
    if job.store.exists() and job.system not in RESUMABLE_INGEST:
        shutil.rmtree(job.store)
    job.store.mkdir(parents=True, exist_ok=True)
    started = time.time()
    details = await module.ingest(job)
    write_json_atomic(ingest_file, {"wall_s": round(time.time() - started, 1), "details": details})


async def answer_with_context(job, module, client, question):
    context, info = await module.context_for(job, question)
    response = await client.responses.create(
        model=LUNA,
        instructions=ANSWER_SYSTEM,
        input=[{"role": "user", "content": memory_prompt(context, question)}],
        reasoning={"effort": ANSWER_EFFORT},
        store=False,
    )
    if response.status != "completed":
        raise RuntimeError("answer for " + question["qid"] + " ended with status " + str(response.status))
    return response.output_text.strip(), len(context.encode("utf-8")), info


async def answer_one(job, module, client, question, answers_file):
    started = time.time()
    if hasattr(module, "answer"):
        answer, context_bytes, info = await module.answer(job, question)
    else:
        answer, context_bytes, info = await answer_with_context(job, module, client, question)
    row = {
        "qid": question["qid"],
        "answer": answer,
        "wall_s": round(time.time() - started, 2),
        "context_bytes": context_bytes,
        "info": info,
    }
    append_jsonl(answers_file, row)


async def run_answers(job, module):
    answers_file = job.dir / "answers.jsonl"
    done = {row["qid"] for row in read_jsonl(answers_file)}
    pending = [question for question in job.item["questions"] if question["qid"] not in done]
    client = AsyncOpenAI(api_key=BENCH_KEY, base_url=job.url("answer"), timeout=600, max_retries=6)
    gate = asyncio.Semaphore(ANSWER_CONCURRENCY)

    async def guarded(question):
        async with gate:
            await answer_one(job, module, client, question, answers_file)

    await asyncio.gather(*(guarded(question) for question in pending))


async def main_async(args):
    job = Job(args.run_dir, args.bench, args.item, args.system)
    job.dir.mkdir(parents=True, exist_ok=True)
    module = importlib.import_module(SYSTEM_MODULES[args.system])
    await run_ingest(job, module)
    await run_answers(job, module)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-dir", required=True)
    parser.add_argument("--bench", required=True)
    parser.add_argument("--item", required=True)
    parser.add_argument("--system", required=True)
    try:
        asyncio.run(main_async(parser.parse_args()))
    except Exception as error:
        text = repr(error)
        cause = error.__cause__
        while cause is not None:
            text += " " + repr(cause)
            cause = cause.__cause__
        if any(mark in text for mark in CONTENT_FILTER_MARKS):
            print("content filter blocked this item:", text[:500], file=sys.stderr)
            sys.exit(CONTENT_FILTER_EXIT)
        raise


if __name__ == "__main__":
    main()
