import json
import os
import re
from datetime import timezone

from memory_bench.common import BENCH_KEY, EMBEDDING_DIMS, EMBEDDING_MODEL, FALKOR_PORT, LUNA
from memory_bench.datasets import parse_locomo_date, parse_longmemeval_date

os.environ["GRAPHITI_TELEMETRY_ENABLED"] = "false"

from graphiti_core import Graphiti
from graphiti_core.cross_encoder.openai_reranker_client import OpenAIRerankerClient
from graphiti_core.driver.falkordb_driver import FalkorDriver
from graphiti_core.embedder.openai import OpenAIEmbedder, OpenAIEmbedderConfig
from graphiti_core.llm_client.config import LLMConfig
from graphiti_core.llm_client.openai_client import OpenAIClient
from graphiti_core.nodes import EpisodeType
from graphiti_core.search.search_config import SearchConfig
from graphiti_core.search.search_config_recipes import COMBINED_HYBRID_SEARCH_RRF

SEARCH_LIMIT = 20


def bare_model(model):
    return model.rsplit("/", 1)[-1]


class GatewayModelClient(OpenAIClient):
    @staticmethod
    def _is_reasoning_model(model):
        return OpenAIClient._is_reasoning_model(bare_model(model))

    @staticmethod
    def _resolve_reasoning_effort(model, reasoning):
        return OpenAIClient._resolve_reasoning_effort(bare_model(model), reasoning)

    @staticmethod
    def _prompt_cache_options(model):
        return OpenAIClient._prompt_cache_options(bare_model(model))


def graph_name(job):
    return re.sub(r"[^A-Za-z0-9_]", "_", job.bench + "_" + job.item_id)


def open_graphiti(job, url):
    llm_config = LLMConfig(api_key=BENCH_KEY, base_url=url, model=LUNA, small_model=LUNA)
    llm = GatewayModelClient(config=llm_config)
    embedder = OpenAIEmbedder(OpenAIEmbedderConfig(api_key=BENCH_KEY, base_url=url, embedding_model=EMBEDDING_MODEL, embedding_dim=EMBEDDING_DIMS))
    reranker = OpenAIRerankerClient(config=llm_config)
    driver = FalkorDriver(host="127.0.0.1", port=FALKOR_PORT, database=graph_name(job))
    return Graphiti(graph_driver=driver, llm_client=llm, embedder=embedder, cross_encoder=reranker)


def parse_date(job, text):
    if job.bench == "locomo":
        return parse_locomo_date(text).replace(tzinfo=timezone.utc)
    return parse_longmemeval_date(text).replace(tzinfo=timezone.utc)


def sessions(turns):
    grouped = []
    for turn in turns:
        if not grouped or grouped[-1][0]["session"] != turn["session"]:
            grouped.append([])
        grouped[-1].append(turn)
    return grouped


async def ingest(job):
    graphiti = open_graphiti(job, job.url("ingest"))
    progress_file = job.store / "episodes_done.json"
    done = json.loads(progress_file.read_text()) if progress_file.exists() else []
    if not done:
        await graphiti.build_indices_and_constraints()
    group = graph_name(job)
    for session in sessions(job.item["turns"]):
        number = session[0]["session"]
        if number in done:
            continue
        body = "\n".join(turn["speaker"] + ": " + turn["text"] for turn in session)
        await graphiti.add_episode(
            name="session-" + str(number),
            episode_body=body,
            source=EpisodeType.message,
            source_description="conversation session on " + session[0]["date"],
            reference_time=parse_date(job, session[0]["date"]),
            group_id=group,
        )
        done.append(number)
        progress_file.write_text(json.dumps(done))
    await graphiti.close()
    return {"episodes": len(done)}


def format_date(value):
    if value is None:
        return "present"
    return value.strftime("%Y-%m-%d %H:%M")


async def context_for(job, question):
    if not hasattr(job, "graphiti"):
        job.graphiti = open_graphiti(job, job.url("answer"))
    config = SearchConfig(edge_config=COMBINED_HYBRID_SEARCH_RRF.edge_config, node_config=COMBINED_HYBRID_SEARCH_RRF.node_config, limit=SEARCH_LIMIT)
    results = await job.graphiti.search_(question["question"], config=config, group_ids=[graph_name(job)])
    lines = ["FACTS (with the period each was true):"]
    for edge in results.edges:
        valid = "unknown" if edge.valid_at is None else format_date(edge.valid_at)
        lines.append("- " + edge.fact + " (" + valid + " to " + format_date(edge.invalid_at) + ")")
    lines.append("ENTITIES:")
    for node in results.nodes:
        lines.append("- " + node.name + ": " + (node.summary or ""))
    return "\n".join(lines), {"edges": len(results.edges), "nodes": len(results.nodes)}
