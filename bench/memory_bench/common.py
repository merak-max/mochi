import json
from pathlib import Path

LUNA = "azure/gpt-6-luna"
JUDGE_MODEL = "azure/gpt-6.1-sol"
EMBEDDING_MODEL = "openai/text-embedding-3-small"
EMBEDDING_DIMS = 1536
MEMORY_EFFORT = "none"
ANSWER_EFFORT = "medium"
PROXY_PORT = 18790
FALKOR_PORT = 16379
FALKOR_IMAGE = "falkordb/falkordb:v4.22.2"
FALKOR_CONTAINER = "memory-bench-falkordb"
BENCH_KEY = "bench-proxy-injects-the-key"
LUNA_CONTEXT_TOKENS = 272000
LUNA_UNCACHED_INPUT_PER_M = 0.125
LUNA_CACHED_INPUT_PER_M = 0.01
LUNA_OUTPUT_PER_M = 0.50
EMBEDDING_PER_M = 0.02
BENCH_DIR = Path(__file__).resolve().parent.parent
RUNS_DIR = BENCH_DIR / "runs"
DATA_CACHE_DIR = BENCH_DIR / "data" / "cache"

SYSTEMS = ["mochi-tree", "amr-dream", "amr", "graphiti", "mem0", "fact-log", "rag", "full-context"]
CONTENT_FILTER_EXIT = 3
MOCHI_VARIANTS = ["mochi-tree", "mochi-tree-small-tail"]

ANSWER_SYSTEM = """You answer one question about a long conversation history, using only the memory you are given.
Answer concisely: a short phrase when the question asks for a fact, a few sentences when it asks for advice or a recommendation, using what you know about the person.
For a question about time, work it out from the dates in the memory and give an absolute date or duration.
If the memory does not contain the answer, reply exactly: Not mentioned in the conversation."""


def proxy_url(system, bench, item, phase):
    return "http://127.0.0.1:" + str(PROXY_PORT) + "/t/" + system + "/" + bench + "/" + item + "/" + phase + "/v1"


def question_message(question):
    text = "Question: " + question["question"]
    if question.get("question_date"):
        text = "Current date: " + question["question_date"] + "\n" + text
    return text


def memory_prompt(context, question):
    return "<memory>\n" + context + "\n</memory>\n\n" + question_message(question)


def item_dir(run_dir, bench, system, item_id):
    return Path(run_dir) / bench / system / item_id


def item_file(run_dir, bench, item_id):
    return Path(run_dir) / "items" / bench / (item_id + ".json")


def read_jsonl(path):
    rows = []
    path = Path(path)
    if not path.exists():
        return rows
    for line in path.read_text().splitlines():
        if line.strip():
            rows.append(json.loads(line))
    return rows


def append_jsonl(path, row):
    with open(path, "a") as handle:
        handle.write(json.dumps(row) + "\n")


def write_json_atomic(path, value):
    path = Path(path)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=1))
    temporary.replace(path)
