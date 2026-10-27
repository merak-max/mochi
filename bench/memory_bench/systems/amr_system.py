import json
import re
import shutil
from pathlib import Path

from openai import AsyncOpenAI

from memory_bench.common import ANSWER_EFFORT, ANSWER_SYSTEM, BENCH_KEY, LUNA, MEMORY_EFFORT, memory_prompt
from memory_bench.datasets import parse_locomo_date, parse_longmemeval_date

SPEC_DIR = Path(__file__).resolve().parent.parent / "amr_spec"
DREAM_EVERY = 5
MAX_INGEST_TOOL_CALLS = 40
MAX_ANSWER_TOOL_CALLS = 8
READ_LIMIT_CHARS = 50000
GREP_LIMIT_LINES = 100
INITIAL_MEMORY = "# Memory\n\n## Index\n"


def section(path, heading):
    text = (SPEC_DIR / path).read_text()
    start = text.index(heading + "\n")
    end = text.find("\n## ", start + len(heading))
    return text[start:] if end == -1 else text[start:end + 1]


def spec_format():
    text = (SPEC_DIR / "SPEC.md").read_text()
    return text[text.index("## Repository layout"):]


READ_SECTION = section("SKILL.md", "## 2. Read what the task needs")
SAVE_SECTION = section("SKILL.md", "## 3. Save useful memory")
DREAM_SECTION = section("README.md", "## Dreaming")
FORMAT_SECTION = spec_format()

SESSION_INSTRUCTIONS = """You keep a memory repo that follows the Agent Memory Repo spec. Its root is the root of your file tools. A conversation session just ended; its transcript is below. Update the memory repo with what is worth keeping from it, then reply with one line saying what you changed.

""" + READ_SECTION + "\n" + SAVE_SECTION + "\n" + FORMAT_SECTION

DREAM_INSTRUCTIONS = """You are the Dreaming agent for a memory repo that follows the Agent Memory Repo spec. Its root is the root of your file tools. Read the existing memory and the sessions since your last run, below, then do both jobs and reply with one line saying what you changed.

""" + DREAM_SECTION + "\n" + FORMAT_SECTION

ANSWER_INSTRUCTIONS = ANSWER_SYSTEM + """

Your memory is a memory repo that follows the Agent Memory Repo spec. Its MEMORY.md is in the prompt; reach its other files with the list, grep and read tools.

""" + READ_SECTION

TOOL_SCHEMAS = {
    "list": {"type": "function", "name": "list", "description": "List the files under a folder of the memory repo, with their sizes in bytes.", "parameters": {"type": "object", "properties": {"path": {"type": "string", "description": "Folder relative to the memory root; . for the root."}}, "required": ["path"], "additionalProperties": False}},
    "read": {"type": "function", "name": "read", "description": "Read a file of the memory repo.", "parameters": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"], "additionalProperties": False}},
    "grep": {"type": "function", "name": "grep", "description": "Search the memory repo case-insensitively for a regular expression. Prints file:line: text for each match.", "parameters": {"type": "object", "properties": {"pattern": {"type": "string"}, "path": {"type": "string", "description": "Folder or file relative to the memory root; . for all."}}, "required": ["pattern", "path"], "additionalProperties": False}},
    "write": {"type": "function", "name": "write", "description": "Create or replace a file of the memory repo with the given content.", "parameters": {"type": "object", "properties": {"path": {"type": "string"}, "content": {"type": "string"}}, "required": ["path", "content"], "additionalProperties": False}},
    "edit": {"type": "function", "name": "edit", "description": "Replace one exact, unique run of text in a file of the memory repo. An empty new_text removes it.", "parameters": {"type": "object", "properties": {"path": {"type": "string"}, "old_text": {"type": "string"}, "new_text": {"type": "string"}}, "required": ["path", "old_text", "new_text"], "additionalProperties": False}},
}
WRITE_TOOLS = ["list", "read", "grep", "write", "edit"]
READ_TOOLS = ["list", "read", "grep"]


class MemoryFolder:
    def __init__(self, root):
        self.root = Path(root).resolve()

    def resolve(self, relative):
        target = (self.root / relative).resolve()
        if target != self.root and self.root not in target.parents:
            raise ValueError("path is outside the memory repo: " + relative)
        return target

    def files(self, target):
        if target.is_file():
            return [target]
        return sorted(path for path in target.rglob("*") if path.is_file())

    def list(self, path):
        target = self.resolve(path)
        lines = []
        for file in self.files(target):
            lines.append(str(file.relative_to(self.root)) + " (" + str(file.stat().st_size) + " bytes)")
        return "\n".join(lines) if lines else "(no files)"

    def read(self, path):
        text = self.resolve(path).read_text()
        if len(text) > READ_LIMIT_CHARS:
            return text[:READ_LIMIT_CHARS] + "\n[cut at " + str(READ_LIMIT_CHARS) + " characters]"
        return text

    def grep(self, pattern, path):
        matcher = re.compile(pattern, re.IGNORECASE)
        lines = []
        for file in self.files(self.resolve(path)):
            for number, line in enumerate(file.read_text().splitlines(), start=1):
                if matcher.search(line):
                    lines.append(str(file.relative_to(self.root)) + ":" + str(number) + ": " + line)
        if len(lines) > GREP_LIMIT_LINES:
            return "\n".join(lines[:GREP_LIMIT_LINES]) + "\n[" + str(len(lines) - GREP_LIMIT_LINES) + " more matches]"
        return "\n".join(lines) if lines else "(no matches)"

    def write(self, path, content):
        target = self.resolve(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)
        return "wrote " + path

    def edit(self, path, old_text, new_text):
        target = self.resolve(path)
        text = target.read_text()
        count = text.count(old_text)
        if count != 1:
            return "error: old_text occurs " + str(count) + " times in " + path + "; it must occur exactly once"
        target.write_text(text.replace(old_text, new_text))
        return "edited " + path

    def run(self, name, arguments):
        try:
            if name == "list":
                return self.list(arguments.get("path", "."))
            if name == "read":
                return self.read(arguments["path"])
            if name == "grep":
                return self.grep(arguments["pattern"], arguments.get("path", "."))
            if name == "write":
                return self.write(arguments["path"], arguments["content"])
            if name == "edit":
                return self.edit(arguments["path"], arguments["old_text"], arguments["new_text"])
            return "error: no tool " + name
        except (OSError, ValueError, KeyError, re.error) as error:
            return "error: " + str(error)


async def run_agent(client, instructions, text, folder, tool_names, effort, max_calls):
    tools = [TOOL_SCHEMAS[name] for name in tool_names]
    items = [{"role": "user", "content": text}]
    calls = 0
    while True:
        choice = "none" if calls >= max_calls else "auto"
        response = await client.responses.create(model=LUNA, instructions=instructions, input=items, tools=tools, tool_choice=choice, reasoning={"effort": effort}, include=["reasoning.encrypted_content"], store=False)
        if response.status != "completed":
            raise RuntimeError("agent response ended with status " + str(response.status))
        function_calls = [item for item in response.output if item.type == "function_call"]
        if not function_calls:
            return response.output_text.strip(), calls
        for item in response.output:
            items.append(item.model_dump(exclude_none=True))
        for call in function_calls:
            if calls >= max_calls:
                output = "error: the limit of " + str(max_calls) + " tool calls is reached; reply now without tools"
            else:
                calls += 1
                output = folder.run(call.name, json.loads(call.arguments))
            items.append({"type": "function_call_output", "call_id": call.call_id, "output": output})


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


def transcript(session):
    lines = ["Session " + str(session[0]["session"]) + ", " + session[0]["date"] + ":"]
    for turn in session:
        lines.append(turn["speaker"] + ": " + turn["text"])
    return "\n".join(lines)


def session_prompt(job, session):
    number = session[0]["session"]
    day = session_day(job, session[0]["date"])
    return "Use added: " + day + " and source: session-" + str(number) + " on the entries you save from this session.\n\n<transcript>\n" + transcript(session) + "\n</transcript>"


def dream_prompt(job, recent):
    blocks = [transcript(session) for session in recent]
    today = session_day(job, recent[-1][0]["date"])
    return "Today is " + today + ". Sessions since your last run:\n\n<transcripts>\n" + "\n\n".join(blocks) + "\n</transcripts>"


def restore(memory_dir, done_dir):
    if memory_dir.exists():
        shutil.rmtree(memory_dir)
    if done_dir.exists():
        shutil.copytree(done_dir, memory_dir)
    else:
        memory_dir.mkdir(parents=True)
        (memory_dir / "MEMORY.md").write_text(INITIAL_MEMORY)


def checkpoint(memory_dir, done_dir, progress_file, progress):
    staging = done_dir.with_name(done_dir.name + ".tmp")
    if staging.exists():
        shutil.rmtree(staging)
    shutil.copytree(memory_dir, staging)
    if done_dir.exists():
        shutil.rmtree(done_dir)
    staging.replace(done_dir)
    progress_file.write_text(json.dumps(progress))


async def ingest(job):
    dreaming = job.system == "amr-dream"
    client = AsyncOpenAI(api_key=BENCH_KEY, base_url=job.url("ingest"), timeout=600, max_retries=6)
    memory_dir = job.store / "memory"
    done_dir = job.store / "memory.done"
    progress_file = job.store / "progress.json"
    progress = json.loads(progress_file.read_text()) if progress_file.exists() else {"sessions_done": 0, "last_dream": 0, "dreams": 0, "session_tool_calls": 0, "dream_tool_calls": 0, "capped": 0}
    restore(memory_dir, done_dir)
    folder = MemoryFolder(memory_dir)
    grouped = sessions(job.item["turns"])
    for index in range(progress["sessions_done"], len(grouped)):
        session = grouped[index]
        reply, calls = await run_agent(client, SESSION_INSTRUCTIONS, session_prompt(job, session), folder, WRITE_TOOLS, MEMORY_EFFORT, MAX_INGEST_TOOL_CALLS)
        progress["session_tool_calls"] += calls
        progress["capped"] += 1 if calls >= MAX_INGEST_TOOL_CALLS else 0
        progress["sessions_done"] = index + 1
        due = (index + 1) % DREAM_EVERY == 0 or index + 1 == len(grouped)
        if dreaming and due:
            recent = grouped[progress["last_dream"]:index + 1]
            reply, calls = await run_agent(client, DREAM_INSTRUCTIONS, dream_prompt(job, recent), folder, WRITE_TOOLS, MEMORY_EFFORT, MAX_INGEST_TOOL_CALLS)
            progress["dream_tool_calls"] += calls
            progress["capped"] += 1 if calls >= MAX_INGEST_TOOL_CALLS else 0
            progress["dreams"] += 1
            progress["last_dream"] = index + 1
        checkpoint(memory_dir, done_dir, progress_file, progress)
    files = [path for path in memory_dir.rglob("*") if path.is_file()]
    return progress | {"files": len(files), "memory_bytes": sum(path.stat().st_size for path in files), "memory_md_bytes": (memory_dir / "MEMORY.md").stat().st_size}


async def answer(job, question):
    if not hasattr(job, "amr_client"):
        job.amr_client = AsyncOpenAI(api_key=BENCH_KEY, base_url=job.url("answer"), timeout=600, max_retries=6)
    memory_dir = job.store / "memory.done"
    entry = (memory_dir / "MEMORY.md").read_text()
    text, calls = await run_agent(job.amr_client, ANSWER_INSTRUCTIONS, memory_prompt(entry, question), MemoryFolder(memory_dir), READ_TOOLS, ANSWER_EFFORT, MAX_ANSWER_TOOL_CALLS)
    return text, len(entry.encode("utf-8")), {"tool_calls": calls}
