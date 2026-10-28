import json
from collections import defaultdict

from memory_bench.common import (
    EMBEDDING_PER_M,
    LUNA_CACHED_INPUT_PER_M,
    LUNA_OUTPUT_PER_M,
    LUNA_UNCACHED_INPUT_PER_M,
    MOCHI_VARIANTS,
    item_dir,
    item_file,
    read_jsonl,
    write_json_atomic,
)
from memory_bench.datasets import LOCOMO_ADVERSARIAL

TOKEN_FIELDS = ["calls", "input_tokens", "cached_tokens", "cache_write_tokens", "output_tokens", "reasoning_tokens", "embed_tokens", "errors", "latency_ms"]


def empty_usage():
    usage = {field: 0 for field in TOKEN_FIELDS}
    usage["cost"] = None
    return usage


def add_call(usage, call):
    usage["calls"] += 1
    usage["latency_ms"] += call.get("latency_ms", 0)
    if "embeddings" in call["endpoint"]:
        usage["embed_tokens"] += call.get("input_tokens", 0)
    else:
        usage["input_tokens"] += call.get("input_tokens", 0)
        usage["cached_tokens"] += call.get("cached_tokens", 0)
        usage["cache_write_tokens"] += call.get("cache_write_tokens", 0)
        usage["output_tokens"] += call.get("output_tokens", 0)
        usage["reasoning_tokens"] += call.get("reasoning_tokens", 0)
    if call.get("status", 0) >= 400 or call.get("error"):
        usage["errors"] += 1
    if call.get("cost") is not None:
        usage["cost"] = (usage["cost"] or 0) + float(call["cost"])


def merge_usage(target, source):
    for field in TOKEN_FIELDS:
        target[field] += source[field]
    if source["cost"] is not None:
        target["cost"] = (target["cost"] or 0) + source["cost"]


def usage_by_key(run_dir):
    usage = defaultdict(empty_usage)
    for call in read_jsonl(run_dir / "calls.jsonl"):
        add_call(usage[(call["bench"], call["system"], call["item"], call["phase"])], call)
    return usage


def dollars(usage):
    uncached = usage["input_tokens"] - usage["cached_tokens"]
    total = uncached * LUNA_UNCACHED_INPUT_PER_M + usage["cached_tokens"] * LUNA_CACHED_INPUT_PER_M + usage["output_tokens"] * LUNA_OUTPUT_PER_M + usage["embed_tokens"] * EMBEDDING_PER_M
    return total / 1_000_000


def ingest_owner(system):
    return "mochi-tree" if system in MOCHI_VARIANTS else system


def mean(values):
    return sum(values) / len(values) if values else None


def percent(value):
    return "n/a" if value is None else f"{100 * value:.1f}"


def number(value):
    return f"{value:,}"


def collect(run_dir):
    run = json.loads((run_dir / "run.json").read_text())
    usage = usage_by_key(run_dir)
    failures = read_jsonl(run_dir / "failures.jsonl")
    variants = []
    for system in run["systems"]:
        variants.extend(MOCHI_VARIANTS if system == "mochi-tree" else [system])
    rows = defaultdict(lambda: {"correct": [], "f1": [], "adversarial_correct": [], "adversarial_f1": [], "by_category": defaultdict(list), "questions": 0, "answered": 0, "judged": 0, "ingest": empty_usage(), "answer": empty_usage(), "judge": empty_usage(), "ingest_wall": 0.0, "answer_wall": 0.0, "zooms": [], "items": 0, "job_failures": 0, "truncated": 0, "filtered": 0})
    per_item = []
    for bench, item_id in run["items"]:
        item = json.loads(item_file(run_dir, bench, item_id).read_text())
        questions = {question["qid"]: question for question in item["questions"]}
        for system in variants:
            owner_dir = item_dir(run_dir, bench, ingest_owner(system), item_id)
            if not owner_dir.exists():
                continue
            row = rows[(bench, system)]
            row["items"] += 1
            if (owner_dir / "filtered.json").exists():
                row["filtered"] += 1
            row["questions"] += len(questions)
            answers = {answer["qid"]: answer for answer in read_jsonl(item_dir(run_dir, bench, system, item_id) / "answers.jsonl")}
            judgments = {verdict["qid"]: verdict for verdict in read_jsonl(item_dir(run_dir, bench, system, item_id) / "judgments.jsonl")}
            row["answered"] += len(answers)
            row["judged"] += len(judgments)
            for answer in answers.values():
                row["answer_wall"] += answer["wall_s"]
                info = answer.get("info") or {}
                if "zoom_calls" in info:
                    row["zooms"].append(info["zoom_calls"])
                if "tool_calls" in info:
                    row["zooms"].append(info["tool_calls"])
                if info.get("truncated_turns"):
                    row["truncated"] += 1
            for qid, verdict in judgments.items():
                question = questions[qid]
                correct = 1.0 if verdict["correct"] else 0.0
                row["by_category"][question["category"]].append(correct)
                if bench == "locomo" and question["category"] == LOCOMO_ADVERSARIAL:
                    row["adversarial_correct"].append(correct)
                    row["adversarial_f1"].append(verdict["f1"])
                    continue
                row["correct"].append(correct)
                if "f1" in verdict:
                    row["f1"].append(verdict["f1"])
            for phase in ("answer", "judge"):
                merge_usage(row[phase], usage[(bench, system, item_id, phase)])
            owner = ingest_owner(system)
            ingest_usage = usage[(bench, owner, item_id, "ingest")]
            merge_usage(row["ingest"], ingest_usage)
            ingest_path = item_dir(run_dir, bench, owner, item_id) / "ingest.json"
            ingest_wall = json.loads(ingest_path.read_text())["wall_s"] if ingest_path.exists() else None
            if ingest_wall is not None:
                row["ingest_wall"] += ingest_wall
            for failure in failures:
                if failure.get("bench") == bench and failure.get("item") == item_id and failure.get("system") == owner:
                    row["job_failures"] += 1
            if system == owner:
                per_item.append({"bench": bench, "item": item_id, "system": owner, "turns": len(item["turns"]), "transcript_bytes": sum(len(turn["text"].encode("utf-8")) for turn in item["turns"]), "ingest": ingest_usage, "ingest_wall": ingest_wall})
    return run, rows, per_item, failures


def write(run_dir):
    run, rows, per_item, failures = collect(run_dir)
    lines = ["# Memory benchmark: " + run_dir.name, "", "Commands, run in order; each one resumes the same run:", "", "```", "set -a; source /run/user/1000/mochi.env; set +a"] + run["commands"] + ["```", ""]
    lines.append("Dollars use fitted Bifrost rates for Luna (uncached input $" + str(LUNA_UNCACHED_INPUT_PER_M) + "/M, cached input $" + str(LUNA_CACHED_INPUT_PER_M) + "/M, output $" + str(LUNA_OUTPUT_PER_M) + "/M) and the text-embedding-3-small list price ($" + str(EMBEDDING_PER_M) + "/M, ESTIMATE); Bifrost returns no cost field. Judge (Astra) cost is excluded. acc %/$ is the headline judge accuracy divided by total dollars; $/1k questions divides total dollars by answered questions. Token counts come from each response's usage. Input includes cached input; cache write is part of uncached input. mochi-tree-small-tail reuses mochi-tree's tree, so its ingest columns repeat mochi-tree's and do not add. Ingest wall counts only the last attempt of a resumed job; call time is the sum of model-call latencies, which equals wall time for sequential ingest (mochi-tree, mem0) and exceeds it for graphiti, which calls in parallel.")
    lines.append("")
    for bench in ("locomo", "longmemeval"):
        keys = [key for key in rows if key[0] == bench]
        if not keys:
            continue
        categories = sorted({category for key in keys for category in rows[key]["by_category"]})
        lines.append("## " + bench)
        lines.append("")
        header = ["system", "items", "answered/questions", "judge acc %"]
        if bench == "locomo":
            header += ["F1 %", "adversarial acc %", "adversarial F1 %"]
        header += [category + " %" for category in categories if not (bench == "locomo" and category == LOCOMO_ADVERSARIAL)]
        header += ["ingest $", "answer $", "total $", "acc %/$", "$/1k questions", "ingest calls", "ingest in", "ingest cached", "ingest cache write", "ingest out", "ingest embed", "answer calls", "answer in", "answer cached", "answer cache write", "answer out", "answer embed", "ingest wall s", "answer wall s (sum)", "failed job attempts", "failed calls", "filtered items", "tool calls/question"]
        lines.append("| " + " | ".join(header) + " |")
        lines.append("|" + "---|" * len(header))
        for key in sorted(keys, key=lambda key: key[1]):
            row = rows[key]
            cells = [key[1], str(row["items"]), str(row["answered"]) + "/" + str(row["questions"]), percent(mean(row["correct"]))]
            if bench == "locomo":
                cells += [percent(mean(row["f1"])), percent(mean(row["adversarial_correct"])), percent(mean(row["adversarial_f1"]))]
            for category in categories:
                if bench == "locomo" and category == LOCOMO_ADVERSARIAL:
                    continue
                values = row["by_category"].get(category, [])
                cells.append(percent(mean(values)) + " (" + str(len(values)) + ")")
            ingest = row["ingest"]
            answer = row["answer"]
            ingest_dollars = dollars(ingest)
            answer_dollars = dollars(answer)
            total_dollars = ingest_dollars + answer_dollars
            accuracy = mean(row["correct"])
            per_dollar = "n/a" if accuracy is None or total_dollars == 0 else f"{100 * accuracy / total_dollars:.1f}"
            per_thousand = "n/a" if row["answered"] == 0 else f"{1000 * total_dollars / row['answered']:.2f}"
            zoom_mean = mean(row["zooms"])
            cells += [f"{ingest_dollars:.4f}", f"{answer_dollars:.4f}", f"{total_dollars:.4f}", per_dollar, per_thousand, number(ingest["calls"]), number(ingest["input_tokens"]), number(ingest["cached_tokens"]), number(ingest["cache_write_tokens"]), number(ingest["output_tokens"]), number(ingest["embed_tokens"]), number(answer["calls"]), number(answer["input_tokens"]), number(answer["cached_tokens"]), number(answer["cache_write_tokens"]), number(answer["output_tokens"]), number(answer["embed_tokens"]), f"{row['ingest_wall']:.0f}", f"{row['answer_wall']:.0f}", str(row["job_failures"]), str(ingest["errors"] + answer["errors"]), str(row["filtered"]), "n/a" if zoom_mean is None else f"{zoom_mean:.2f}"]
            lines.append("| " + " | ".join(cells) + " |")
        lines.append("")
        truncated = [key[1] + " (" + str(rows[key]["truncated"]) + " answers)" for key in keys if rows[key]["truncated"]]
        if truncated:
            lines.append("Full-context truncated the oldest turns for: " + ", ".join(truncated) + ".")
            lines.append("")
    lines.append("## Ingest tokens per conversation")
    lines.append("")
    lines.append("| bench | item | system | turns | transcript bytes | ingest $ | calls | LLM in | LLM cached | LLM cache write | LLM out | reasoning | embed | call time s | last-attempt wall s | failed calls |")
    lines.append("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    for entry in per_item:
        usage = entry["ingest"]
        wall = "n/a" if entry["ingest_wall"] is None else f"{entry['ingest_wall']:.0f}"
        lines.append("| " + " | ".join([entry["bench"], entry["item"], entry["system"], str(entry["turns"]), number(entry["transcript_bytes"]), f"{dollars(usage):.4f}", number(usage["calls"]), number(usage["input_tokens"]), number(usage["cached_tokens"]), number(usage["cache_write_tokens"]), number(usage["output_tokens"]), number(usage["reasoning_tokens"]), number(usage["embed_tokens"]), f"{usage['latency_ms'] / 1000:.0f}", wall, str(usage["errors"])]) + " |")
    lines.append("")
    judge_total = {field: 0 for field in TOKEN_FIELDS}
    for row in rows.values():
        for field in TOKEN_FIELDS:
            judge_total[field] += row["judge"][field]
    lines.append("Judge (Astra) usage, not counted in any system: " + number(judge_total["calls"]) + " calls, " + number(judge_total["input_tokens"]) + " in, " + number(judge_total["output_tokens"]) + " out.")
    lines.append("")
    if failures:
        lines.append("## Failure history")
        lines.append("")
        lines.append("Each failed job attempt or judge call, grouped. A resumed run retries them; the answered/questions column shows what is still missing.")
        lines.append("")
        grouped = defaultdict(int)
        for failure in failures:
            if failure.get("phase") == "judge":
                key = "judge call: " + failure["error"][:120]
            else:
                key = "job " + failure["bench"] + "/" + failure["system"] + "/" + failure["item"] + " exited " + str(failure["exit"])
            grouped[key] += 1
        for key, count in grouped.items():
            lines.append("- " + str(count) + "x " + key)
        lines.append("")
    (run_dir / "summary.md").write_text("\n".join(lines))
    serializable = {key[0] + "/" + key[1]: {name: value for name, value in row.items() if name != "by_category"} | {"by_category": dict(row["by_category"])} for key, row in rows.items()}
    write_json_atomic(run_dir / "summary.json", {"rows": serializable, "per_item": per_item})
    print("\n".join(lines))
