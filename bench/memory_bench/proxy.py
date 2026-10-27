import argparse
import json
import os
import time

import aiohttp
from aiohttp import web

UPSTREAM = "https://bifrost.shau.me/openai/"
OUTPUT_TEXT_LIMIT = 4000


def usage_numbers(usage):
    if not usage:
        return {"input_tokens": 0, "cached_tokens": 0, "cache_write_tokens": 0, "output_tokens": 0, "reasoning_tokens": 0}
    if "input_tokens" in usage:
        input_details = usage.get("input_tokens_details") or {}
        output_details = usage.get("output_tokens_details") or {}
        return {
            "input_tokens": usage.get("input_tokens") or 0,
            "cached_tokens": input_details.get("cached_tokens") or 0,
            "cache_write_tokens": input_details.get("cache_write_tokens") or input_details.get("cached_write_tokens") or 0,
            "output_tokens": usage.get("output_tokens") or 0,
            "reasoning_tokens": output_details.get("reasoning_tokens") or 0,
        }
    prompt_details = usage.get("prompt_tokens_details") or {}
    completion_details = usage.get("completion_tokens_details") or {}
    return {
        "input_tokens": usage.get("prompt_tokens") or 0,
        "cached_tokens": prompt_details.get("cached_tokens") or 0,
        "cache_write_tokens": prompt_details.get("cache_write_tokens") or 0,
        "output_tokens": usage.get("completion_tokens") or 0,
        "reasoning_tokens": completion_details.get("reasoning_tokens") or 0,
    }


def find_cost(body):
    if not isinstance(body, dict):
        return None
    for holder in (body.get("usage") or {}, body.get("extra_fields") or {}, body):
        if isinstance(holder, dict) and "cost" in holder:
            return holder["cost"]
    return None


def output_text(body):
    if not isinstance(body, dict):
        return ""
    if "output" in body:
        parts = []
        for item in body.get("output") or []:
            if item.get("type") == "message":
                for content in item.get("content") or []:
                    if content.get("type") == "output_text":
                        parts.append(content.get("text", ""))
            if item.get("type") == "function_call":
                parts.append("[call " + item.get("name", "") + " " + item.get("arguments", "") + "]")
        return "".join(parts)
    if "choices" in body:
        choices = body.get("choices") or [{}]
        message = choices[0].get("message") or {}
        return message.get("content") or ""
    return ""


def requested_effort(request):
    reasoning = request.get("reasoning")
    if isinstance(reasoning, dict) and "effort" in reasoning:
        return reasoning["effort"]
    return request.get("reasoning_effort")


def completed_response_from_sse(text):
    final = None
    for line in text.splitlines():
        if not line.startswith("data:"):
            continue
        data = line[5:].strip()
        if data == "" or data == "[DONE]":
            continue
        try:
            event = json.loads(data)
        except json.JSONDecodeError:
            continue
        if event.get("type") in ("response.completed", "response.incomplete", "response.failed"):
            final = event.get("response")
        elif "choices" in event and event.get("usage"):
            final = event
    return final


class Proxy:
    def __init__(self, log_path, key):
        self.log_file = open(log_path, "a", buffering=1)
        self.key = key
        self.session = None

    async def start(self, app):
        self.session = aiohttp.ClientSession(trust_env=False, timeout=aiohttp.ClientTimeout(total=1800))

    async def stop(self, app):
        await self.session.close()
        self.log_file.close()

    def write(self, record):
        self.log_file.write(json.dumps(record) + "\n")

    async def handle(self, request):
        system = request.match_info["system"]
        bench = request.match_info["bench"]
        item = request.match_info["item"]
        phase = request.match_info["phase"]
        tail = request.match_info["tail"]
        body = await request.read()
        try:
            parsed_request = json.loads(body) if body else {}
        except json.JSONDecodeError:
            parsed_request = {}
        headers = {"Authorization": "Bearer " + self.key}
        if request.headers.get("Content-Type"):
            headers["Content-Type"] = request.headers["Content-Type"]
        url = UPSTREAM + tail
        if request.query_string:
            url = url + "?" + request.query_string
        record = {
            "ts": time.time(),
            "system": system,
            "bench": bench,
            "item": item,
            "phase": phase,
            "endpoint": tail,
            "model": parsed_request.get("model"),
            "effort": requested_effort(parsed_request),
            "request_bytes": len(body),
        }
        started = time.monotonic()
        try:
            async with self.session.request(request.method, url, data=body, headers=headers) as upstream:
                content_type = upstream.headers.get("Content-Type", "")
                record["status"] = upstream.status
                if "text/event-stream" in content_type:
                    response = web.StreamResponse(status=upstream.status, headers={"Content-Type": content_type})
                    await response.prepare(request)
                    chunks = []
                    async for chunk in upstream.content.iter_any():
                        chunks.append(chunk)
                        await response.write(chunk)
                    await response.write_eof()
                    final = completed_response_from_sse(b"".join(chunks).decode("utf-8", "replace"))
                    record["stream"] = True
                    record.update(usage_numbers((final or {}).get("usage")))
                    record["cost"] = find_cost(final)
                    record["output_text"] = output_text(final)[:OUTPUT_TEXT_LIMIT]
                    if final is None:
                        record["error"] = "stream ended without a completed response"
                    elif final.get("status") not in (None, "completed"):
                        record["error"] = "response status " + str(final.get("status"))
                    record["latency_ms"] = round((time.monotonic() - started) * 1000)
                    self.write(record)
                    return response
                raw = await upstream.read()
                try:
                    parsed = json.loads(raw)
                except json.JSONDecodeError:
                    parsed = None
                record["stream"] = False
                record.update(usage_numbers((parsed or {}).get("usage") if isinstance(parsed, dict) else None))
                record["cost"] = find_cost(parsed)
                record["output_text"] = output_text(parsed)[:OUTPUT_TEXT_LIMIT]
                if upstream.status >= 400:
                    record["error"] = raw.decode("utf-8", "replace")[:OUTPUT_TEXT_LIMIT]
                record["latency_ms"] = round((time.monotonic() - started) * 1000)
                self.write(record)
                return web.Response(status=upstream.status, body=raw, headers={"Content-Type": content_type or "application/json"})
        except Exception as error:
            record["status"] = 599
            record["error"] = repr(error)[:OUTPUT_TEXT_LIMIT]
            record["latency_ms"] = round((time.monotonic() - started) * 1000)
            self.write(record)
            raise


async def health(request):
    return web.Response(text="ok")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--log", required=True)
    parser.add_argument("--port", type=int, required=True)
    args = parser.parse_args()
    key = os.environ.get("BIFROST_VIRTUAL_KEY", "")
    if key == "":
        raise SystemExit("BIFROST_VIRTUAL_KEY is not set")
    proxy = Proxy(args.log, key)
    app = web.Application(client_max_size=256 * 1024 * 1024)
    app.on_startup.append(proxy.start)
    app.on_cleanup.append(proxy.stop)
    app.router.add_get("/health", health)
    app.router.add_route("*", "/t/{system}/{bench}/{item}/{phase}/{tail:.*}", proxy.handle)
    web.run_app(app, host="127.0.0.1", port=args.port, print=None, access_log=None)


if __name__ == "__main__":
    main()
