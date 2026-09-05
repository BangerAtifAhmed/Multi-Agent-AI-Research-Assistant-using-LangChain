"""Stream lifecycle tests.

    python tests/test_stream_lifecycle.py

The bug these exist to prevent: an LLM failure that ended the generation stream
without a terminal frame, or a wedged upstream that ended it not at all. Express
turns the end of this NDJSON stream into the end of the browser's SSE stream, so
either one leaves the chat UI generating forever, still showing "Stop", with no
way for the user to send another prompt.

The rule enforced throughout: every request to /generate/stream terminates, and
the last frame is always `done`.

  1. a normal answer                 -> tokens, done, stream closed
  2. Mistral 429 -> Llama fallback    -> tokens, done, stream closed
  3. Mistral 429 and Llama fails too  -> error, done, stream closed
  4. the pipeline raises              -> error, done, stream closed
  5. the upstream stalls              -> heartbeats, then error + done, closed
  6. the client goes away             -> generation is cancelled, stream closed

No network and no credentials: both models are stubbed.
"""

from __future__ import annotations

import io
import json
import sys
import threading
import time
from contextlib import redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi.testclient import TestClient  # noqa: E402
from langchain_core.language_models import BaseChatModel  # noqa: E402
from langchain_core.messages import AIMessage, AIMessageChunk  # noqa: E402
from langchain_core.outputs import (  # noqa: E402
    ChatGeneration,
    ChatGenerationChunk,
    ChatResult,
)
from pydantic import SecretStr  # noqa: E402

import llm_provider  # noqa: E402
import settings  # noqa: E402

try:
    import httpx
except ImportError:  # pragma: no cover - httpx ships with langchain-mistralai
    httpx = None

passed = failed = 0


def check(name: str, condition: bool, detail: str = "") -> None:
    global passed, failed
    if condition:
        passed += 1
        print(f"PASS  {name}" + (f" -- {detail}" if detail else ""))
    else:
        failed += 1
        print(f"FAIL  {name}" + (f" -- {detail}" if detail else ""))


# Retry backoff must not actually sleep during the tests. Only the module's own
# reference is replaced - assigning to `time.sleep` would disarm the real sleeps
# these tests rely on to imitate a stalled provider.
llm_provider.time = SimpleNamespace(sleep=lambda _seconds: None)


# ---------------------------------------------------------------------------
# Test doubles
# ---------------------------------------------------------------------------


class StubChatModel(BaseChatModel):
    """Streams fixed text, or raises a fixed error instead."""

    text: str = "answer"
    error: Any = None
    #: Block for this long before producing anything, imitating a provider that
    #: accepted the connection and then went quiet.
    stall_seconds: float = 0.0

    @property
    def _llm_type(self) -> str:
        return "stub"

    def _generate(self, messages, stop=None, run_manager=None, **kwargs) -> ChatResult:
        if self.error is not None:
            raise self.error
        return ChatResult(generations=[ChatGeneration(message=AIMessage(content=self.text))])

    def _stream(self, messages, stop=None, run_manager=None, **kwargs):
        if self.stall_seconds:
            time.sleep(self.stall_seconds)
        if self.error is not None:
            raise self.error
        for word in self.text.split():
            yield ChatGenerationChunk(message=AIMessageChunk(content=word + " "))

    def bind_tools(self, tools, **kwargs):
        return self.bind(tools=list(tools), **kwargs)


class FakeResponse:
    def __init__(self, status_code=200, body=None, text="", lines=None):
        self.status_code = status_code
        self._body = body
        self.text = text if text else ("" if body is None else str(body))
        self._lines = lines or []

    def json(self):
        if self._body is None:
            raise ValueError("no json")
        return self._body

    def iter_lines(self):
        for line in self._lines:
            yield line if isinstance(line, bytes) else line.encode("utf-8")

    def close(self):
        pass


class FakeSession:
    """Replays a scripted list of responses/exceptions."""

    def __init__(self, *responses):
        self.responses = list(responses)
        self.requests: list[dict] = []

    def post(self, url, headers=None, json=None, timeout=None, stream=False):
        self.requests.append({"url": url, "stream": stream})
        if not self.responses:
            raise AssertionError("the fake session ran out of scripted responses")
        item = self.responses.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


def hf_model(session: FakeSession) -> llm_provider.HuggingFaceChatModel:
    model = llm_provider.HuggingFaceChatModel(
        model="meta-llama/Llama-3.1-8B-Instruct",
        api_token=SecretStr("hf_test_token_not_real"),
        max_retries=2,
    )
    model._session = session
    return model


def sse(*contents: str) -> list[str]:
    lines = [": keep-alive", ""]
    for content in contents:
        lines.append('data: {"choices":[{"delta":{"content":"%s"},"index":0}]}' % content)
        lines.append("")
    lines.append("data: [DONE]")
    return lines


def mistral_error(status: int = 429) -> Exception:
    """Exactly what langchain-mistralai raises for an HTTP error."""
    request = httpx.Request("POST", "https://api.mistral.ai/v1/chat/completions")
    return httpx.HTTPStatusError(
        f"Error response {status} while fetching https://api.mistral.ai/v1/chat/completions",
        request=request,
        response=httpx.Response(status, request=request),
    )


# The real service wiring, so the chains under test are the ones it runs.
settings.MISTRAL_API_KEY = settings.MISTRAL_API_KEY or "not-a-real-mistral-key"
settings.LLM_FALLBACK_API_TOKEN = "hf_test_token_not_real"
_buffer = io.StringIO()
with redirect_stdout(_buffer):
    import agents  # noqa: E402
    import main  # noqa: E402
    import rag_engine  # noqa: E402

client = TestClient(main.app)


def wire(primary: StubChatModel, fallback=None) -> None:
    """Point the live chains at a scripted primary and fallback."""
    agents.llm.primary = primary
    agents.llm.fallback = fallback


def quietly(action):
    """Run `action`, keeping the service's own log out of the test output."""
    buffer = io.StringIO()
    with redirect_stdout(buffer):
        result = action()
    return result, buffer.getvalue()


def request_stream(budget: float = 20.0, **overrides):
    """POST /generate/stream and read it to completion, or report a hang.

    Returns (frames, closed). `closed` is False when the response body was still
    open after `budget` seconds - the failure this whole file is about.
    """
    body = {"query": "What is a GRU?", "mode": "llm", **overrides}
    result: dict = {"frames": []}

    def run():
        try:
            with client.stream("POST", "/generate/stream", json=body) as response:
                result["status"] = response.status_code
                for line in response.iter_lines():
                    if line:
                        result["frames"].append(json.loads(line))
            result["closed"] = True
        except Exception as exc:  # noqa: BLE001
            result["error"] = f"{type(exc).__name__}: {exc}"
            result["closed"] = True

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    thread.join(budget)
    return result["frames"], bool(result.get("closed"))


def kinds(frames) -> list[str]:
    return [frame.get("type") for frame in frames]


def text_of(frames, kind: str = "token") -> str:
    return "".join(frame.get("text", "") for frame in frames if frame.get("type") == kind)


print("=== 1. A normal answer ===")

wire(StubChatModel(text="Gated recurrent units."))
(frames, closed), _ = quietly(lambda: request_stream())
check("the stream closes", closed)
check("tokens are streamed", text_of(frames).strip() == "Gated recurrent units.", text_of(frames))
check("the last frame is done", kinds(frames)[-1] == "done", str(kinds(frames)))
check(
    "it finishes normally",
    frames[-1].get("finishReason") == "stop",
    str(frames[-1]),
)
check("no error frame is sent", "error" not in kinds(frames), str(kinds(frames)))


print("\n=== 2. Mistral 429 -> Hugging Face Llama fallback ===")

if httpx is None:  # pragma: no cover
    check("httpx is available for the 429 tests", False, "httpx not installed")
else:
    session = FakeSession(FakeResponse(200, lines=sse("Gated ", "recurrent ", "units.")))
    wire(StubChatModel(error=mistral_error(429)), hf_model(session))
    (frames, closed), log = quietly(lambda: request_stream())

    check("the stream closes", closed)
    check(
        "the fallback answered",
        text_of(frames).strip() == "Gated recurrent units.",
        text_of(frames),
    )
    check("the last frame is done", kinds(frames)[-1] == "done", str(kinds(frames)))
    check("it finishes normally", frames[-1].get("finishReason") == "stop", str(frames[-1]))
    check(
        "the rate-limit message never reaches the client",
        not any("rate limited" in json.dumps(frame) for frame in frames),
    )
    check("the fallback was used", "[fallback]" in log, log.strip()[-90:])


print("\n=== 3. Mistral 429 and the fallback fails too ===")

if httpx is not None:
    session = FakeSession(FakeResponse(429, body={"error": "rate limited"}))
    wire(StubChatModel(error=mistral_error(429)), hf_model(session))
    (frames, closed), _ = quietly(lambda: request_stream())

    check("the stream closes", closed)
    check("an error frame is sent", "error" in kinds(frames), str(kinds(frames)))
    check(
        "the error explains the rate limit",
        any("rate limited" in frame.get("message", "") for frame in frames),
        json.dumps([f for f in frames if f.get("type") == "error"]),
    )
    # The regression: the error used to be the last frame, so nothing told the
    # browser the turn was over.
    check("the last frame is still done", kinds(frames)[-1] == "done", str(kinds(frames)))
    check("it finishes as an error", frames[-1].get("finishReason") == "error", str(frames[-1]))


print("\n=== 4. The pipeline raises outright ===")

original_generate = rag_engine.generate


def raising(**kwargs):
    raise RuntimeError("the pipeline exploded")
    yield  # pragma: no cover - makes this a generator function


main.rag_engine.generate = raising
(frames, closed), _ = quietly(lambda: request_stream())
main.rag_engine.generate = original_generate

check("the stream closes", closed)
check("an error frame is sent", "error" in kinds(frames), str(kinds(frames)))
check("the last frame is done", kinds(frames)[-1] == "done", str(kinds(frames)))
check("it finishes as an error", frames[-1].get("finishReason") == "error", str(frames[-1]))


print("\n=== 5. The upstream stalls and never answers ===")

# A generation that runs far longer than the budget. The stream must not.
def stalling(**kwargs):
    time.sleep(60)
    yield {"type": "done", "finishReason": "stop"}  # pragma: no cover


main.rag_engine.generate = stalling
main.GENERATE_HEARTBEAT_SECONDS = 0.2
main.GENERATE_BUDGET_SECONDS = 1.0
(frames, closed), log = quietly(lambda: request_stream(budget=15.0))
main.rag_engine.generate = original_generate
main.GENERATE_HEARTBEAT_SECONDS = 5.0
main.GENERATE_BUDGET_SECONDS = settings.GENERATE_BUDGET_SECONDS

check("the stream closes instead of hanging forever", closed)
check("heartbeats were sent while waiting", "heartbeat" in kinds(frames), str(kinds(frames)))
check("an error frame is sent", "error" in kinds(frames), str(kinds(frames)))
check(
    "the error says it timed out",
    any(frame.get("code") == "LLM_TIMEOUT" for frame in frames),
    str([f for f in frames if f.get("type") == "error"]),
)
check("the last frame is done", kinds(frames)[-1] == "done", str(kinds(frames)))
check("the budget is reported in the log", "budget" in log, log.strip()[:120])


print("\n=== 6. The client goes away mid-answer ===")

seen: dict = {}


def watching(cancel=None, **kwargs):
    # The cancel flag the pipeline checks between chunks; Stop in the browser
    # has to end up setting this one.
    seen["cancel"] = cancel
    for index in range(10_000):
        yield {"type": "token", "text": f"{index} "}
        time.sleep(0.01)


main.rag_engine.generate = watching

with client.stream("POST", "/generate/stream", json={"query": "q", "mode": "llm"}) as response:
    reader = response.iter_lines()
    for _ in range(3):
        next(reader)
    # Leaving the `with` block closes the connection, exactly as Express does
    # when the browser aborts the fetch.

deadline = time.time() + 5
while not seen.get("cancel", threading.Event()).is_set() and time.time() < deadline:
    time.sleep(0.05)

main.rag_engine.generate = original_generate

check("the pipeline is cancelled when the client disconnects", seen["cancel"].is_set())


print("\n=== 7. rag_engine always ends with a terminal event ===")

if httpx is not None:
    session = FakeSession(FakeResponse(429, body={"error": "rate limited"}))
    wire(StubChatModel(error=mistral_error(429)), hf_model(session))
    events, _ = quietly(lambda: list(rag_engine.generate("q", mode="llm")))
    check(
        "a failed turn ends with done, not with error",
        kinds(events)[-1] == "done",
        str(kinds(events)),
    )
    check(
        "the error frame comes first",
        kinds(events)[-2] == "error",
        str(kinds(events)),
    )

    wire(StubChatModel(text="fine"), None)
    events, _ = quietly(lambda: list(rag_engine.generate("q", mode="llm")))
    check("a successful turn ends with done", kinds(events)[-1] == "done", str(kinds(events)))

    cancel = threading.Event()
    cancel.set()
    wire(StubChatModel(text="fine"), None)
    events, _ = quietly(lambda: list(rag_engine.generate("q", mode="llm", cancel=cancel)))
    check("a cancelled turn ends with done", kinds(events)[-1] == "done", str(kinds(events)))
    check(
        "a cancelled turn says so",
        events[-1].get("finishReason") == "aborted",
        str(events[-1]),
    )


print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
