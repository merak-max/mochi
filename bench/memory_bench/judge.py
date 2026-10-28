import json
import re
import string
from collections import Counter

from nltk.stem import PorterStemmer

from memory_bench.common import JUDGE_MODEL

LONGMEMEVAL_TEMPLATES = {
    "plain": "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. \n\nQuestion: {}\n\nCorrect Answer: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only.",
    "temporal-reasoning": "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. In addition, do not penalize off-by-one errors for the number of days. If the question asks for the number of days/weeks/months, etc., and the model makes off-by-one errors (e.g., predicting 19 days when the answer is 18), the model's response is still correct. \n\nQuestion: {}\n\nCorrect Answer: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only.",
    "knowledge-update": "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response contains some previous information along with an updated answer, the response should be considered as correct as long as the updated answer is the required answer.\n\nQuestion: {}\n\nCorrect Answer: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only.",
    "single-session-preference": "I will give you a question, a rubric for desired personalized response, and a response from a model. Please answer yes if the response satisfies the desired response. Otherwise, answer no. The model does not need to reflect all the points in the rubric. The response is correct as long as it recalls and utilizes the user's personal information correctly.\n\nQuestion: {}\n\nRubric: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only.",
    "abstention": "I will give you an unanswerable question, an explanation, and a response from a model. Please answer yes if the model correctly identifies the question as unanswerable. The model could say that the information is incomplete, or some other information is given but the asked information is not.\n\nQuestion: {}\n\nExplanation: {}\n\nModel Response: {}\n\nDoes the model correctly identify the question as unanswerable? Answer yes or no only.",
}

LOCOMO_JUDGE = """
Your task is to label an answer to a question as ’CORRECT’ or ’WRONG’. You will be given the following data:
    (1) a question (posed by one user to another user),
    (2) a ’gold’ (ground truth) answer,
    (3) a generated answer
which you will score as CORRECT/WRONG.

The point of the question is to ask about something one user should know about the other user based on their prior conversations.
The gold answer will usually be a concise and short answer that includes the referenced topic, for example:
Question: Do you remember what I got the last time I went to Hawaii?
Gold answer: A shell necklace
The generated answer might be much longer, but you should be generous with your grading - as long as it touches on the same topic as the gold answer, it should be counted as CORRECT.

For time related questions, the gold answer will be a specific date, month, year, etc. The generated answer might be much longer or use relative time references (like "last Tuesday" or "next month"), but you should be generous with your grading - as long as it refers to the same date or time period as the gold answer, it should be counted as CORRECT. Even if the format differs (e.g., "May 7th" vs "7 May"), consider it CORRECT if it's the same date.

Now it’s time for the real question:
Question: {question}
Gold answer: {gold_answer}
Generated answer: {generated_answer}

First, provide a short (one sentence) explanation of your reasoning, then finish with CORRECT or WRONG.
Do NOT include both CORRECT and WRONG in your response, or it will break the evaluation script.

Just return the label CORRECT or WRONG in a json format with the key as "label".
"""

STEMMER = PorterStemmer()


def longmemeval_prompt(question, response):
    if question["abstention"]:
        template = LONGMEMEVAL_TEMPLATES["abstention"]
    elif question["category"] in LONGMEMEVAL_TEMPLATES:
        template = LONGMEMEVAL_TEMPLATES[question["category"]]
    elif question["category"] in ("single-session-user", "single-session-assistant", "multi-session"):
        template = LONGMEMEVAL_TEMPLATES["plain"]
    else:
        raise ValueError("no LongMemEval judge template for " + question["category"])
    return template.format(question["question"], question["answer"], response)


def normalize_answer(text):
    text = text.replace(",", "")
    text = text.lower()
    text = "".join(character for character in text if character not in set(string.punctuation))
    text = re.sub(r"\b(a|an|the|and)\b", " ", text)
    return " ".join(text.split())


def f1_score(prediction, truth):
    prediction_tokens = [STEMMER.stem(word) for word in normalize_answer(prediction).split()]
    truth_tokens = [STEMMER.stem(word) for word in normalize_answer(truth).split()]
    common = Counter(prediction_tokens) & Counter(truth_tokens)
    same = sum(common.values())
    if same == 0:
        return 0.0
    precision = same / len(prediction_tokens)
    recall = same / len(truth_tokens)
    return 2 * precision * recall / (precision + recall)


def multi_answer_f1(prediction, truth):
    predictions = [part.strip() for part in prediction.split(",")]
    truths = [part.strip() for part in truth.split(",")]
    total = 0.0
    for single_truth in truths:
        total += max(f1_score(single_prediction, single_truth) for single_prediction in predictions)
    return total / len(truths)


def locomo_f1(question, response):
    number = question["category_number"]
    answer = question["answer"]
    if number == 5:
        lowered = response.lower()
        return 1.0 if ("no information available" in lowered or "not mentioned" in lowered) else 0.0
    if number == 3:
        answer = answer.split(";")[0].strip()
    if number == 1:
        return multi_answer_f1(response, answer)
    return f1_score(response, answer)


def parse_locomo_label(text):
    try:
        label = json.loads(text)["label"]
    except (json.JSONDecodeError, KeyError, TypeError):
        match = re.search(r"\b(CORRECT|WRONG)\b", text)
        if match is None:
            raise ValueError("judge gave no label: " + text[:200])
        label = match.group(1)
    return label.strip().upper() == "CORRECT"


async def judge(client, bench, question, response, model=JUDGE_MODEL):
    if bench == "locomo":
        prompt = LOCOMO_JUDGE.format(question=question["question"], gold_answer=question["answer"], generated_answer=response)
        reply = await client.responses.create(model=model, input=prompt, text={"format": {"type": "json_object"}}, store=False)
        text = reply.output_text.strip()
        return {"correct": parse_locomo_label(text), "judge_text": text, "f1": locomo_f1(question, response)}
    prompt = longmemeval_prompt(question, response)
    reply = await client.responses.create(model=model, input=prompt, store=False)
    text = reply.output_text.strip()
    return {"correct": "yes" in text.lower(), "judge_text": text}
