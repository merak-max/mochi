import argparse
import asyncio
import json
import os
import shlex
import subprocess
import sys
import time
import urllib.request

from openai import AsyncOpenAI

from memory_bench import summary
from memory_bench.common import (
    ANSWER_SYSTEM,
    BENCH_DIR,
    BENCH_KEY,
    CONTENT_FILTER_EXIT,
    FALKOR_CONTAINER,
    FALKOR_IMAGE,
    FALKOR_PORT,
    MOCHI_VARIANTS,
    PROXY_PORT,
    RUNS_DIR,
    SYSTEMS,
    append_jsonl,
    item_dir,
    item_file,
    proxy_url,
    question_message,
    read_jsonl,
    write_json_atomic,
)
from memory_bench.datasets import load_locomo, load_longmemeval
from memory_bench.judge import judge

REPO_DIR = BENCH_DIR.parent
JUDGE_CONCURRENCY = 16
JOB_ATTEMPTS = 3
KEPT_ENV = {"PATH", "HOME", "USER", "LANG", "LC_ALL", "TERM", "TMPDIR", "SHELL"}


def clean_env():
    env = {}
    for name, value in os.environ.items():
        if name in KEPT_ENV or name.startswith("MISE_") or name.startswith("XDG_"):
            env[name] = value
    env["NO_PROXY"] = "127.0.0.1,localhost"
    return env


def prepare_items(run_dir, args):
    items = []
    if args.locomo:
        wanted = [] if args.locomo == "all" else args.locomo.split(",")
        items.extend(load_locomo(wanted))
    if args.lme_per_type or args.lme_items:
        wanted = args.lme_items.split(",") if args.lme_items else []
        items.extend(load_longmemeval(args.lme_per_type, wanted))
    for item in items:
        item["answer_system"] = ANSWER_SYSTEM
        for question in item["questions"]:
            question["message"] = question_message(question)
        path = item_file(run_dir, item["bench"], item["item_id"])
        path.parent.mkdir(parents=True, exist_ok=True)
        write_json_atomic(path, item)
    return items


def proxy_alive():
    try:
        with urllib.request.urlopen("http://127.0.0.1:" + str(PROXY_PORT) + "/health", timeout=2) as response:
            return response.status == 200
    except OSError:
        return False


def start_proxy(run_dir):
    if proxy_alive():
        raise SystemExit("port " + str(PROXY_PORT) + " already serves a proxy; stop it first so calls log to this run")
    log = open(run_dir / "proxy.log", "a")
    env = clean_env()
    env["BIFROST_VIRTUAL_KEY"] = os.environ["BIFROST_VIRTUAL_KEY"]
    process = subprocess.Popen([sys.executable, "-m", "memory_bench.proxy", "--log", str(run_dir / "calls.jsonl"), "--port", str(PROXY_PORT)], cwd=BENCH_DIR, env=env, stdout=log, stderr=log)
    for _ in range(50):
        if proxy_alive():
            return process
        time.sleep(0.2)
    process.kill()
    raise SystemExit("proxy did not start; see " + str(run_dir / "proxy.log"))


def ensure_falkordb(run_dir):
    data_dir = (run_dir / "falkordb").resolve()
    data_dir.mkdir(exist_ok=True)
    inspect = subprocess.run(["docker", "inspect", "-f", "{{.State.Running}} {{range .Mounts}}{{.Source}}{{end}}", FALKOR_CONTAINER], capture_output=True, text=True)
    if inspect.returncode == 0 and inspect.stdout.strip() == "true " + str(data_dir):
        return
    subprocess.run(["docker", "rm", "-f", FALKOR_CONTAINER], capture_output=True)
    owner = str(os.getuid()) + ":" + str(os.getgid())
    subprocess.run(["docker", "run", "-d", "--name", FALKOR_CONTAINER, "--user", owner, "--restart", "unless-stopped", "-e", "REDIS_ARGS=--appendonly yes", "-v", str(data_dir) + ":/var/lib/falkordb/data", "-p", "127.0.0.1:" + str(FALKOR_PORT) + ":6379", FALKOR_IMAGE], check=True, capture_output=True)
    time.sleep(3)


def job_command(run_dir, bench, item_id, system):
    if system == "mochi-tree":
        return ["mise", "exec", "--", "node", str(BENCH_DIR / "mochi" / "tree.ts"), "--run-dir", str(run_dir), "--bench", bench, "--item", item_id]
    return [sys.executable, "-m", "memory_bench.job", "--run-dir", str(run_dir), "--bench", bench, "--item", item_id, "--system", system]


def job_complete(run_dir, item, system):
    if (item_dir(run_dir, item["bench"], system, item["item_id"]) / "filtered.json").exists():
        return True
    variants = MOCHI_VARIANTS if system == "mochi-tree" else [system]
    for variant in variants:
        answered = {row["qid"] for row in read_jsonl(item_dir(run_dir, item["bench"], variant, item["item_id"]) / "answers.jsonl")}
        for question in item["questions"]:
            if question["qid"] not in answered:
                return False
    return True


async def run_job(run_dir, item, system, gate):
    if job_complete(run_dir, item, system):
        return None
    async with gate:
        directory = item_dir(run_dir, item["bench"], system, item["item_id"])
        directory.mkdir(parents=True, exist_ok=True)
        command = job_command(run_dir, item["bench"], item["item_id"], system)
        cwd = REPO_DIR if system == "mochi-tree" else BENCH_DIR
        env = clean_env()
        for attempt in range(1, JOB_ATTEMPTS + 1):
            started = time.time()
            with open(directory / "job.log", "a") as log:
                log.write("\n$ " + shlex.join(command) + "\n")
                log.flush()
                process = await asyncio.create_subprocess_exec(*command, cwd=cwd, env=env, stdout=log, stderr=log)
                code = await process.wait()
            elapsed = round(time.time() - started, 1)
            print(item["bench"], item["item_id"], system, "attempt", attempt, "exit", code, "after", elapsed, "s", flush=True)
            if code == 0:
                return code
            append_jsonl(run_dir / "failures.jsonl", {"ts": time.time(), "bench": item["bench"], "item": item["item_id"], "system": system, "attempt": attempt, "exit": code, "log": str(directory / "job.log")})
        if code == CONTENT_FILTER_EXIT:
            write_json_atomic(directory / "filtered.json", {"ts": time.time(), "attempts": JOB_ATTEMPTS, "log": str(directory / "job.log")})
            print(item["bench"], item["item_id"], system, "recorded as filtered", flush=True)
        return code


async def judge_all(run_dir, items, systems):
    gate = asyncio.Semaphore(JUDGE_CONCURRENCY)
    clients = {}
    tasks = []

    async def judge_one(client, bench, question, answer_row, judgments_file):
        async with gate:
            verdict = await judge(client, bench, question, answer_row["answer"])
        verdict["qid"] = question["qid"]
        append_jsonl(judgments_file, verdict)

    for item in items:
        questions = {question["qid"]: question for question in item["questions"]}
        for system in systems:
            directory = item_dir(run_dir, item["bench"], system, item["item_id"])
            judged = {row["qid"] for row in read_jsonl(directory / "judgments.jsonl")}
            for answer_row in read_jsonl(directory / "answers.jsonl"):
                if answer_row["qid"] in judged:
                    continue
                key = (system, item["bench"], item["item_id"])
                if key not in clients:
                    clients[key] = AsyncOpenAI(api_key=BENCH_KEY, base_url=proxy_url(system, item["bench"], item["item_id"], "judge"), timeout=600, max_retries=6)
                tasks.append(judge_one(clients[key], item["bench"], questions[answer_row["qid"]], answer_row, directory / "judgments.jsonl"))
    results = await asyncio.gather(*tasks, return_exceptions=True)
    errors = [result for result in results if isinstance(result, Exception)]
    for error in errors:
        append_jsonl(run_dir / "failures.jsonl", {"ts": time.time(), "phase": "judge", "error": repr(error)[:2000]})
    return len(tasks), len(errors)


def record_run(run_dir, command_line, systems, items):
    path = run_dir / "run.json"
    record = json.loads(path.read_text()) if path.exists() else {"commands": [], "systems": [], "items": []}
    if command_line not in record["commands"]:
        record["commands"].append(command_line)
    known = set(record["systems"]) | set(systems)
    record["systems"] = [system for system in SYSTEMS if system in known]
    for item in items:
        pair = [item["bench"], item["item_id"]]
        if pair not in record["items"]:
            record["items"].append(pair)
    write_json_atomic(path, record)


async def run(args, command_line):
    run_dir = RUNS_DIR / args.run_id
    run_dir.mkdir(parents=True, exist_ok=True)
    items = prepare_items(run_dir, args)
    systems = SYSTEMS if args.systems == "all" else args.systems.split(",")
    lme_systems = systems if not args.lme_systems else args.lme_systems.split(",")
    record_run(run_dir, command_line, sorted(set(systems) | set(lme_systems)), items)
    if "graphiti" in systems or "graphiti" in lme_systems:
        ensure_falkordb(run_dir)
    proxy = start_proxy(run_dir)
    try:
        gate = asyncio.Semaphore(args.jobs)
        jobs = []
        for system in SYSTEMS:
            for item in items:
                chosen = lme_systems if item["bench"] == "longmemeval" else systems
                if system in chosen:
                    jobs.append(run_job(run_dir, item, system, gate))
        await asyncio.gather(*jobs)
        judged_systems = []
        for system in set(systems) | set(lme_systems):
            judged_systems.extend(MOCHI_VARIANTS if system == "mochi-tree" else [system])
        count, errors = await judge_all(run_dir, items, judged_systems)
        print("judged", count, "answers,", errors, "judge errors", flush=True)
    finally:
        proxy.terminate()
        proxy.wait()
    summary.write(run_dir)


def main():
    parser = argparse.ArgumentParser(prog="memory_bench.run")
    sub = parser.add_subparsers(dest="command", required=True)
    run_parser = sub.add_parser("run")
    run_parser.add_argument("--run-id", required=True)
    run_parser.add_argument("--locomo", default="", help="comma-separated sample ids, or all")
    run_parser.add_argument("--lme-per-type", type=int, default=0)
    run_parser.add_argument("--lme-items", default="")
    run_parser.add_argument("--systems", default="all")
    run_parser.add_argument("--lme-systems", default="", help="systems for LongMemEval items; default: --systems")
    run_parser.add_argument("--jobs", type=int, default=8)
    summary_parser = sub.add_parser("summary")
    summary_parser.add_argument("--run-id", required=True)
    sub.add_parser("down")
    args = parser.parse_args()
    if args.command == "run":
        command_line = "unset HTTPS_PROXY; cd bench && mise exec -- uv run python -m memory_bench.run " + shlex.join(sys.argv[1:])
        asyncio.run(run(args, command_line))
    elif args.command == "summary":
        summary.write(RUNS_DIR / args.run_id)
    elif args.command == "down":
        subprocess.run(["docker", "rm", "-f", FALKOR_CONTAINER], check=False)


if __name__ == "__main__":
    main()
