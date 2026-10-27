import asyncio
import json
import os

from memory_bench.common import BENCH_KEY, DATA_CACHE_DIR, EMBEDDING_DIMS, EMBEDDING_MODEL, LUNA, MEMORY_EFFORT

BATCH_TURNS = 2
TOP_K = 30
OBSERVATION_DATE = "These messages were exchanged on {date}. Use that as the Observation Date to resolve relative times."


def memory_config(job, url):
    return {
        "llm": {
            "provider": "openai",
            "config": {
                "model": LUNA,
                "api_key": BENCH_KEY,
                "openai_base_url": url,
                "is_reasoning_model": True,
                "reasoning_effort": MEMORY_EFFORT,
            },
        },
        "embedder": {
            "provider": "openai",
            "config": {
                "model": EMBEDDING_MODEL,
                "api_key": BENCH_KEY,
                "openai_base_url": url,
                "embedding_dims": EMBEDDING_DIMS,
            },
        },
        "vector_store": {
            "provider": "qdrant",
            "config": {
                "collection_name": "bench",
                "path": str(job.store / "qdrant"),
                "embedding_model_dims": EMBEDDING_DIMS,
                "on_disk": True,
            },
        },
        "history_db_path": str(job.store / "history.db"),
    }


def open_memory(job, url):
    os.environ["MEM0_DIR"] = str(job.store / "mem0-home")
    os.environ["MEM0_TELEMETRY"] = "false"
    os.environ["FASTEMBED_CACHE_PATH"] = str(DATA_CACHE_DIR / "fastembed")
    from mem0 import Memory
    from mem0.utils.spacy_models import get_nlp_full

    memory = Memory.from_config(memory_config(job, url))
    if get_nlp_full() is None:
        raise RuntimeError("mem0: spaCy model en_core_web_sm did not load, so entity extraction is off")
    if memory.vector_store._get_bm25_encoder() is None:
        raise RuntimeError("mem0: fastembed BM25 encoder did not load, so keyword search is off")
    return memory


def session_batches(turns):
    batches = []
    batch = []
    for turn in turns:
        if batch and (len(batch) == BATCH_TURNS or batch[-1]["session"] != turn["session"]):
            batches.append(batch)
            batch = []
        batch.append(turn)
    if batch:
        batches.append(batch)
    return batches


def ingest_sync(job):
    memory = open_memory(job, job.url("ingest"))
    progress_file = job.store / "batches_done.json"
    done = json.loads(progress_file.read_text()) if progress_file.exists() else 0
    batches = session_batches(job.item["turns"])
    for number in range(done, len(batches)):
        batch = batches[number]
        messages = []
        for turn in batch:
            content = "[" + turn["date"] + "] " + turn["speaker"] + ": " + turn["text"]
            messages.append({"role": turn["role"], "content": content})
        dated = OBSERVATION_DATE.format(date=batch[0]["date"])
        memory.add(messages, user_id=job.item_id, metadata={"date": batch[0]["date"], "session": batch[0]["session"]}, prompt=dated)
        progress_file.write_text(json.dumps(number + 1))
    stored = len(memory.get_all(filters={"user_id": job.item_id}, top_k=100000).get("results", []))
    memory.vector_store.client.close()
    return {"batches": len(batches), "memories_stored": stored}


async def ingest(job):
    return await asyncio.to_thread(ingest_sync, job)


def search_sync(job, question):
    if not hasattr(job, "mem0_memory"):
        job.mem0_memory = open_memory(job, job.url("answer"))
    return job.mem0_memory.search(question["question"], top_k=TOP_K, filters={"user_id": job.item_id})


async def context_for(job, question):
    async with job.lock:
        found = await asyncio.to_thread(search_sync, job, question)
    lines = []
    for row in found.get("results", []):
        date = (row.get("metadata") or {}).get("date", "unknown date")
        lines.append("- [" + str(date) + "] " + row["memory"])
    return "\n".join(lines), {"retrieved": len(lines)}
