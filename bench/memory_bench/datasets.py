import json
import random
from datetime import datetime
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
LOCOMO_FILE = DATA_DIR / "locomo" / "locomo10.json"
LONGMEMEVAL_FILE = DATA_DIR / "longmemeval" / "longmemeval_s_cleaned.json"

LOCOMO_CATEGORIES = {1: "multi-hop", 2: "temporal", 3: "open-domain", 4: "single-hop", 5: "adversarial"}
LOCOMO_ADVERSARIAL = "adversarial"
NOT_MENTIONED = "Not mentioned in the conversation"
LONGMEMEVAL_SEED = 20261027


def parse_locomo_date(text):
    return datetime.strptime(text, "%I:%M %p on %d %B, %Y")


def parse_longmemeval_date(text):
    return datetime.strptime(text, "%Y/%m/%d (%a) %H:%M")


def render_turn(turn):
    return "[" + turn["date"] + "] " + turn["speaker"] + ": " + turn["text"]


def locomo_turn_text(turn):
    text = turn["text"]
    if turn.get("blip_caption"):
        text = text + " [shares an image: " + turn["blip_caption"] + "]"
    return text


def locomo_session_numbers(conversation):
    numbers = []
    for key in conversation:
        if key.startswith("session_") and not key.endswith("_date_time"):
            numbers.append(int(key.split("_")[1]))
    numbers.sort()
    return numbers


def locomo_item(sample):
    conversation = sample["conversation"]
    turns = []
    for number in locomo_session_numbers(conversation):
        date = conversation["session_" + str(number) + "_date_time"]
        for turn in conversation["session_" + str(number)]:
            turns.append({
                "role": "user",
                "speaker": turn["speaker"],
                "date": date,
                "timestamp": parse_locomo_date(date).isoformat(),
                "session": number,
                "text": locomo_turn_text(turn),
            })
    questions = []
    for index, qa in enumerate(sample["qa"]):
        category = LOCOMO_CATEGORIES[qa["category"]]
        if category == LOCOMO_ADVERSARIAL:
            answer = NOT_MENTIONED
        else:
            answer = str(qa["answer"])
        questions.append({
            "qid": sample["sample_id"] + "-q" + str(index),
            "question": qa["question"],
            "answer": answer,
            "category": category,
            "category_number": qa["category"],
            "question_date": None,
            "abstention": category == LOCOMO_ADVERSARIAL,
        })
    return {"bench": "locomo", "item_id": sample["sample_id"], "turns": turns, "questions": questions}


def load_locomo(item_ids):
    samples = json.loads(LOCOMO_FILE.read_text())
    items = []
    for sample in samples:
        if not item_ids or sample["sample_id"] in item_ids:
            items.append(locomo_item(sample))
    return items


def longmemeval_item(entry):
    turns = []
    for number, session in enumerate(entry["haystack_sessions"]):
        date = entry["haystack_dates"][number]
        for turn in session:
            turns.append({
                "role": turn["role"],
                "speaker": "User" if turn["role"] == "user" else "Assistant",
                "date": date,
                "timestamp": parse_longmemeval_date(date).isoformat(),
                "session": number + 1,
                "text": turn["content"],
            })
    question = {
        "qid": entry["question_id"],
        "question": entry["question"],
        "answer": str(entry["answer"]),
        "category": entry["question_type"],
        "question_date": entry["question_date"],
        "abstention": entry["question_id"].endswith("_abs"),
    }
    return {"bench": "longmemeval", "item_id": entry["question_id"], "turns": turns, "questions": [question]}


def stratified_longmemeval(entries, per_type):
    by_type = {}
    for entry in entries:
        by_type.setdefault(entry["question_type"], []).append(entry)
    chosen = []
    for question_type in sorted(by_type):
        group = sorted(by_type[question_type], key=lambda entry: entry["question_id"])
        random.Random(LONGMEMEVAL_SEED).shuffle(group)
        chosen.extend(group[:per_type])
    return chosen


def load_longmemeval(per_type, item_ids):
    entries = json.loads(LONGMEMEVAL_FILE.read_text())
    if item_ids:
        selected = [entry for entry in entries if entry["question_id"] in item_ids]
    else:
        selected = stratified_longmemeval(entries, per_type)
    return [longmemeval_item(entry) for entry in selected]
