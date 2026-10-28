import json
import math
import re
from collections import Counter

import numpy as np
from openai import AsyncOpenAI

from memory_bench.common import ANSWER_EFFORT, ANSWER_SYSTEM, BENCH_KEY, EMBEDDING_MODEL, LUNA, MEMORY_EFFORT, memory_prompt, write_json_atomic
from memory_bench.datasets import parse_locomo_date, parse_longmemeval_date

CANDIDATES_PER_FACT = 8
PAIRS_PER_CALL = 40
ANSWER_TOP_K = 30
RRF_K = 60
BM25_K1 = 1.5
BM25_B = 0.75

EXTRACT_INSTRUCTIONS = """You read one session of a long conversation and write down the facts in it that someone could ask about later: what people did, said, own, like, plan, decided, felt, and when.

Return a JSON object {"facts": [...]}. Each fact is an object with:
- "subject": the person or thing the fact is about, as a short name, the same way each time
- "fact": one self-contained sentence, with names instead of pronouns and absolute dates instead of "yesterday" or "last week"
- "date": YYYY-MM-DD, the date the fact refers to if the conversation states or implies it, else the session date
- "source": the turn id it came from, such as "t3"

Keep names, numbers and places exactly. Write one fact per thing; do not merge unrelated things. Skip greetings and small talk."""

SUPERSEDE_INSTRUCTIONS = """You keep an append-only log of facts. For each numbered pair below, decide whether the NEW fact supersedes the OLD fact: the new fact makes the old one no longer true now (a change, an update, a correction, a replacement). A new fact that only adds detail, or is about a different thing, does not supersede.

Return a JSON object that maps every pair number to "yes" or "no", such as {"1": "no", "2": "yes"}."""

ANSWER_INSTRUCTIONS = ANSWER_SYSTEM + """

Your memory is a log of facts, oldest first, one per line: date | subject | fact [current] or [superseded on <date>].
When facts disagree, the newest current fact wins. Superseded facts are history: use them for questions about when something changed, or what was true before."""


def tokens(text):
    return re.findall(r"[a-z0-9]+", text.lower())


def bm25_scores(query, documents):
    query_terms = tokens(query)
    document_terms = [tokens(document) for document in documents]
    count = len(documents)
    average_length = sum(len(terms) for terms in document_terms) / max(count, 1)
    containing = Counter()
    for terms in document_terms:
        for term in set(terms):
            containing[term] += 1
    scores = []
    for terms in document_terms:
        frequencies = Counter(terms)
        score = 0.0
        for term in query_terms:
            if frequencies[term] == 0:
                continue
            inverse = math.log(1 + (count - containing[term] + 0.5) / (containing[term] + 0.5))
            weight = frequencies[term] * (BM25_K1 + 1) / (frequencies[term] + BM25_K1 * (1 - BM25_B + BM25_B * len(terms) / max(average_length, 1)))
            score += inverse * weight
        scores.append(score)
    return scores


def hybrid_top(query, query_vector, texts, vectors, limit):
    if not texts:
        return []
    lexical = bm25_scores(query, texts)
    semantic = vectors @ query_vector
    lexical_order = sorted(range(len(texts)), key=lambda index: -lexical[index])
    semantic_order = sorted(range(len(texts)), key=lambda index: -semantic[index])
    fused = Counter()
    for rank, index in enumerate(lexical_order):
        if lexical[index] > 0:
            fused[index] += 1 / (RRF_K + rank + 1)
    for rank, index in enumerate(semantic_order):
        fused[index] += 1 / (RRF_K + rank + 1)
    return [index for index, _ in fused.most_common(limit)]


async def embed(client, texts):
    response = await client.embeddings.create(model=EMBEDDING_MODEL, input=texts)
    matrix = np.array([row.embedding for row in response.data], dtype=np.float32)
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    return matrix / np.maximum(norms, 1e-12)


async def ask_json(client, instructions, text):
    response = await client.responses.create(model=LUNA, instructions=instructions, input="Reply with a JSON object.\n\n" + text, reasoning={"effort": MEMORY_EFFORT}, text={"format": {"type": "json_object"}}, store=False)
    if response.status != "completed":
        raise RuntimeError("fact-log call ended with status " + str(response.status))
    return json.loads(response.output_text)


def session_day(job, date):
    if job.bench == "locomo":
        return parse_locomo_date(date).strftime("%Y-%m-%d")
    return parse_longmemeval_date(date).strftime("%Y-%m-%d")


def sessions(turns):
    grouped = []
    for turn in turns:
        if not grouped or grouped[-1][0]["session"] != turn["session"]:
            grouped.append([])
        grouped[-1].append(turn)
    return grouped


def fact_text(fact):
    return fact["subject"] + ": " + fact["fact"]


def load_log(store):
    facts = []
    supersessions = []
    vectors = []
    for path in sorted(store.glob("session-*.json"), key=lambda path: int(path.stem.split("-")[1])):
        saved = json.loads(path.read_text())
        facts.extend(saved["facts"])
        supersessions.extend(saved["supersessions"])
        if saved["facts"]:
            vectors.append(np.load(path.with_suffix(".npy")))
    matrix = np.concatenate(vectors) if vectors else np.zeros((0, 1), dtype=np.float32)
    return facts, supersessions, matrix


def clean_facts(raw, session_number, day):
    facts = []
    for entry in raw.get("facts", []):
        subject = str(entry.get("subject", "")).strip()
        fact = str(entry.get("fact", "")).strip()
        if not subject or not fact:
            continue
        date = str(entry.get("date", "")).strip()
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
            date = day
        source = "session-" + str(session_number) + " " + str(entry.get("source", "")).strip()
        facts.append({"subject": subject, "fact": fact, "date": date, "source": source.strip()})
    return facts


async def ingest(job):
    client = AsyncOpenAI(api_key=BENCH_KEY, base_url=job.url("ingest"), timeout=600, max_retries=6)
    grouped = sessions(job.item["turns"])
    for session in grouped:
        number = session[0]["session"]
        record_path = job.store / ("session-" + str(number) + ".json")
        if record_path.exists():
            continue
        facts, _, matrix = load_log(job.store)
        day = session_day(job, session[0]["date"])
        lines = ["Session " + str(number) + ", date " + day + " (" + session[0]["date"] + "):"]
        for turn_number, turn in enumerate(session, start=1):
            lines.append("[t" + str(turn_number) + "] " + turn["speaker"] + ": " + turn["text"])
        new_facts = clean_facts(await ask_json(client, EXTRACT_INSTRUCTIONS, "\n".join(lines)), number, day)
        first_id = len(facts)
        for offset, fact in enumerate(new_facts):
            fact["id"] = first_id + offset
        new_vectors = await embed(client, [fact_text(fact) for fact in new_facts]) if new_facts else np.zeros((0, 1), dtype=np.float32)
        pairs = []
        if facts and new_facts:
            old_texts = [fact_text(fact) for fact in facts]
            for index, fact in enumerate(new_facts):
                for old_index in hybrid_top(fact_text(fact), new_vectors[index], old_texts, matrix, CANDIDATES_PER_FACT):
                    pairs.append((fact, facts[old_index]))
        supersessions = []
        for start in range(0, len(pairs), PAIRS_PER_CALL):
            batch = pairs[start:start + PAIRS_PER_CALL]
            numbered = []
            for position, (new, old) in enumerate(batch, start=1):
                numbered.append(str(position) + ". OLD (" + old["date"] + "): " + fact_text(old) + "\n   NEW (" + new["date"] + "): " + fact_text(new))
            answers = await ask_json(client, SUPERSEDE_INSTRUCTIONS, "\n".join(numbered))
            for position, (new, old) in enumerate(batch, start=1):
                if str(position) not in answers:
                    raise RuntimeError("supersede check gave no answer for pair " + str(position) + " of " + str(len(batch)))
                if str(answers[str(position)]).strip().lower() == "yes":
                    supersessions.append({"old": old["id"], "new": new["id"], "date": new["date"]})
        if new_facts:
            np.save(record_path.with_suffix(".npy"), new_vectors)
        write_json_atomic(record_path, {"facts": new_facts, "supersessions": supersessions, "pairs_checked": len(pairs)})
    facts, supersessions, _ = load_log(job.store)
    return {"sessions": len(grouped), "facts": len(facts), "supersessions": len(supersessions)}


def render(facts, supersessions, chosen):
    superseded_on = {}
    for link in supersessions:
        earlier = superseded_on.get(link["old"])
        if earlier is None or link["date"] < earlier:
            superseded_on[link["old"]] = link["date"]
    rows = sorted((facts[index] for index in chosen), key=lambda fact: (fact["date"], fact["id"]))
    lines = []
    for fact in rows:
        status = "[current]" if fact["id"] not in superseded_on else "[superseded on " + superseded_on[fact["id"]] + "]"
        lines.append(fact["date"] + " | " + fact["subject"] + " | " + fact["fact"] + " " + status)
    return "\n".join(lines)


async def answer(job, question):
    if not hasattr(job, "fact_log"):
        job.fact_log = load_log(job.store)
        job.fact_client = AsyncOpenAI(api_key=BENCH_KEY, base_url=job.url("answer"), timeout=600, max_retries=6)
    facts, supersessions, matrix = job.fact_log
    query_vector = (await embed(job.fact_client, [question["question"]]))[0]
    chosen = hybrid_top(question["question"], query_vector, [fact_text(fact) for fact in facts], matrix, ANSWER_TOP_K)
    context = render(facts, supersessions, chosen)
    response = await job.fact_client.responses.create(model=LUNA, instructions=ANSWER_INSTRUCTIONS, input=[{"role": "user", "content": memory_prompt(context, question)}], reasoning={"effort": ANSWER_EFFORT}, store=False)
    if response.status != "completed":
        raise RuntimeError("answer for " + question["qid"] + " ended with status " + str(response.status))
    return response.output_text.strip(), len(context.encode("utf-8")), {"retrieved": len(chosen), "facts": len(facts)}
