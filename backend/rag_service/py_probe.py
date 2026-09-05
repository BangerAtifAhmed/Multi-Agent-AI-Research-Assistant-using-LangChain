"""Probe: does /generate/stream always terminate the NDJSON body?"""
from __future__ import annotations

import json
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import main  # noqa: E402
import rag_engine  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

client = TestClient(main.app)


def probe(name, fake_generate, budget=6.0):
    original = rag_engine.generate
    main.rag_engine.generate = fake_generate
    started = time.time()
    result = {}

    def run():
        try:
            with client.stream(
                "POST", "/generate/stream", json={"query": "hi", "mode": "llm"}
            ) as response:
                events = []
                for line in response.iter_lines():
                    if line:
                        events.append(json.loads(line).get("type"))
                result["events"] = events
        except Exception as exc:  # noqa: BLE001
            result["error"] = f"{type(exc).__name__}: {exc}"

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    thread.join(budget)
    main.rag_engine.generate = original

    if thread.is_alive():
        print(f"  {name}: STILL OPEN after {budget}s  <-- STREAM NEVER ENDED")
    else:
        print(f"  {name}: closed in {time.time() - started:.2f}s  {result}")


print("=== /generate/stream termination probe ===")

probe("normal", lambda **kw: iter([
    {"type": "token", "text": "hi"},
    {"type": "done", "finishReason": "stop"},
]))


def raising(**kw):
    raise RuntimeError("Error response 429 while fetching")
    yield


probe("generator raises", raising)


def real_error_path(**kw):
    # What rag_engine.generate actually yields when the LLM is rate limited.
    yield {"type": "error", "code": "LLM_RATE_LIMITED", "message": "rate limited"}


probe("rag_engine error path", real_error_path)


def stalled(**kw):
    # An upstream that accepted the connection and then went quiet.
    time.sleep(600)
    yield {"type": "done", "finishReason": "stop"}


probe("upstream stalls", stalled, budget=5.0)
