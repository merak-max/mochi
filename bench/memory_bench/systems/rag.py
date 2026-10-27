import json

import numpy as np
from openai import AsyncOpenAI

from memory_bench.common import BENCH_KEY, EMBEDDING_MODEL
from memory_bench.datasets import render_turn

TOP_K = 10
EMBED_BATCH = 100
EMBED_INPUT_CHARS = 24000
EMBED_BATCH_CHARS = 400000


def chunk_texts(job):
    return [render_turn(turn)[:EMBED_INPUT_CHARS] for turn in job.item["turns"]]


def batches(texts):
    batch = []
    chars = 0
    for text in texts:
        if batch and (len(batch) == EMBED_BATCH or chars + len(text) > EMBED_BATCH_CHARS):
            yield batch
            batch = []
            chars = 0
        batch.append(text)
        chars += len(text)
    if batch:
        yield batch


async def embed(client, texts):
    vectors = []
    for batch in batches(texts):
        response = await client.embeddings.create(model=EMBEDDING_MODEL, input=batch)
        for row in response.data:
            vectors.append(row.embedding)
    matrix = np.array(vectors, dtype=np.float32)
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    return matrix / np.maximum(norms, 1e-12)


async def ingest(job):
    client = AsyncOpenAI(api_key=BENCH_KEY, base_url=job.url("ingest"), max_retries=6)
    texts = chunk_texts(job)
    matrix = await embed(client, texts)
    np.save(job.store / "vectors.npy", matrix)
    (job.store / "chunks.json").write_text(json.dumps(texts))
    return {"chunks": len(texts)}


async def context_for(job, question):
    if not hasattr(job, "rag_matrix"):
        job.rag_matrix = np.load(job.store / "vectors.npy")
        job.rag_chunks = json.loads((job.store / "chunks.json").read_text())
        job.rag_client = AsyncOpenAI(api_key=BENCH_KEY, base_url=job.url("answer"), max_retries=6)
    query = await embed(job.rag_client, [question["question"]])
    scores = job.rag_matrix @ query[0]
    best = np.argsort(-scores)[:TOP_K]
    chosen = sorted(int(index) for index in best)
    lines = [job.rag_chunks[index] for index in chosen]
    return "\n".join(lines), {"retrieved": len(lines)}
