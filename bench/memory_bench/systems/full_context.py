from memory_bench.common import LUNA_CONTEXT_TOKENS
from memory_bench.datasets import render_turn

BYTES_PER_TOKEN_ESTIMATE = 3
PROMPT_RESERVE_TOKENS = 12000


async def ingest(job):
    return {"turns": len(job.item["turns"])}


async def context_for(job, question):
    lines = [render_turn(turn) for turn in job.item["turns"]]
    budget = (LUNA_CONTEXT_TOKENS - PROMPT_RESERVE_TOKENS) * BYTES_PER_TOKEN_ESTIMATE
    total = 0
    for line in lines:
        total += len(line.encode("utf-8")) + 1
    dropped = 0
    while total > budget and dropped < len(lines):
        total -= len(lines[dropped].encode("utf-8")) + 1
        dropped += 1
    kept = lines[dropped:]
    return "\n".join(kept), {"truncated_turns": dropped}
