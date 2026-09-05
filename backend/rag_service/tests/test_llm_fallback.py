"""Fallback LLM tests.

    python tests/test_llm_fallback.py

Covers the three paths that matter:

  1. Mistral succeeds        -> Llama is never called
  2. Mistral fails           -> the same request is replayed on Llama 3.1 8B
  3. Llama fails too         -> the primary's error is what the caller sees

plus the Hugging Face transport itself (rate limits, timeouts, a cold model,
a rejected token, SSE streaming) and the guarantee that the fallback receives
byte-for-byte the same rendered prompt as the primary would have.

No network and no credentials: both models are stubbed, and the Hugging Face
client is driven through a fake requests.Session.
"""

from __future__ import annotations

import io
import sys
from contextlib import redirect_stdout
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import requests  # noqa: E402
from langchain_core.language_models import BaseChatModel  # noqa: E402
from langchain_core.messages import (  # noqa: E402
    AIMessage,
    AIMessageChunk,
    HumanMessage,
    SystemMessage,
)
from langchain_core.output_parsers import StrOutputParser  # noqa: E402
from langchain_core.outputs import (  # noqa: E402
    ChatGeneration,
    ChatGenerationChunk,
    ChatResult,
)
from langchain_core.prompts import ChatPromptTemplate  # noqa: E402
from pydantic import SecretStr  # noqa: E402

import llm_provider  # noqa: E402
import settings  # noqa: E402

passed = failed = 0


def check(name: str, condition: bool, detail: str = "") -> None:
    global passed, failed
    if condition:
        passed += 1
        print(f"PASS  {name}" + (f" -- {detail}" if detail else ""))
    else:
        failed += 1
        print(f"FAIL  {name}" + (f" -- {detail}" if detail else ""))


# Retries must not actually sleep during the tests.
llm_provider.time.sleep = lambda _seconds: None


# ---------------------------------------------------------------------------
# Test doubles
# ---------------------------------------------------------------------------


class StubChatModel(BaseChatModel):
    """A chat model that returns fixed text, or raises a fixed error.

    Records every list of messages it was asked to answer, which is how the
    tests prove the fallback saw the same prompt as the primary.
    """

    text: str = "answer"
    error: Any = None
    #: Fail only on prompts containing this text (None = fail on every prompt).
    #: Lets one stub succeed for the answer and fail for the critique.
    error_on: str | None = None
    #: Tokens to emit before failing mid-stream (None = never fail mid-stream).
    fail_after_tokens: int | None = None
    seen: Any = None
    calls: int = 0

    def __init__(self, **data: Any):
        super().__init__(**data)
        self.seen = []

    @property
    def _llm_type(self) -> str:
        return "stub"

    def _record(self, messages):
        self.seen.append(messages)
        self.calls += 1

    def _should_fail(self, messages) -> bool:
        if self.error is None:
            return False
        if self.error_on is None:
            return True
        return any(self.error_on in str(getattr(m, "content", "")) for m in messages)

    def _generate(self, messages, stop=None, run_manager=None, **kwargs) -> ChatResult:
        self._record(messages)
        if self._should_fail(messages):
            raise self.error
        return ChatResult(generations=[ChatGeneration(message=AIMessage(content=self.text))])

    def _stream(self, messages, stop=None, run_manager=None, **kwargs):
        self._record(messages)
        failing = self._should_fail(messages)
        if failing and self.fail_after_tokens is None:
            raise self.error
        for index, word in enumerate(self.text.split()):
            if failing and self.fail_after_tokens is not None and index == self.fail_after_tokens:
                raise self.error
            yield ChatGenerationChunk(message=AIMessageChunk(content=word + " "))

    def bind_tools(self, tools, **kwargs):
        return self.bind(tools=list(tools), **kwargs)


class FakeResponse:
    def __init__(self, status_code=200, body=None, text="", lines=None):
        self.status_code = status_code
        self._body = body
        self.text = text if text else ("" if body is None else str(body))
        self._lines = lines or []
        self.closed = False

    def json(self):
        if self._body is None:
            raise ValueError("no json")
        return self._body

    def iter_lines(self):
        for line in self._lines:
            yield line if isinstance(line, bytes) else line.encode("utf-8")

    def close(self):
        self.closed = True


class FakeSession:
    """Replays a scripted list of responses/exceptions, recording the requests."""

    def __init__(self, *responses):
        self.responses = list(responses)
        self.requests: list[dict] = []

    def post(self, url, headers=None, json=None, timeout=None, stream=False):
        self.requests.append(
            {"url": url, "headers": headers, "json": json, "timeout": timeout, "stream": stream}
        )
        if not self.responses:
            raise AssertionError(
                f"the fake session ran out of scripted responses after "
                f"{len(self.requests)} request(s)"
            )
        item = self.responses.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


def hf_model(session: FakeSession, **overrides) -> llm_provider.HuggingFaceChatModel:
    options = {
        "model": "meta-llama/Llama-3.1-8B-Instruct",
        "api_url": "https://router.huggingface.co/v1/chat/completions",
        "api_token": SecretStr("hf_test_token_not_real"),
        "max_tokens": 2000,
        "max_retries": 2,
        **overrides,
    }
    model = llm_provider.HuggingFaceChatModel(**options)
    model._session = session
    return model


def completion(content: str) -> dict:
    return {
        "choices": [{"message": {"role": "assistant", "content": content}, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 10, "completion_tokens": 4, "total_tokens": 14},
    }


def sse(*contents: str) -> list[str]:
    lines = [": keep-alive", ""]
    for content in contents:
        lines.append(
            'data: {"choices":[{"delta":{"content":"%s"},"index":0}]}' % content
        )
        lines.append("")
    lines.append("data: [DONE]")
    return lines


def composite(primary: StubChatModel, fallback: StubChatModel | None):
    return llm_provider.FallbackChatModel(
        primary=primary,
        fallback=fallback,
        primary_label="mistral:mistral-small-2506",
        fallback_label="huggingface:meta-llama/Llama-3.1-8B-Instruct",
    )


def capture(call):
    """Run `call`, returning (result_or_exception, captured log output)."""
    buffer = io.StringIO()
    with redirect_stdout(buffer):
        try:
            result = call()
        except BaseException as exc:  # noqa: BLE001 - the exception is the result
            result = exc
    return result, buffer.getvalue()


QUESTION = [SystemMessage("You are an expert research assistant."), HumanMessage("What is a GRU?")]

# Errors that a provider - not this code - is responsible for.
TRANSIENT = {
    "timeout": requests.Timeout("Read timed out"),
    "connection": requests.ConnectionError("Connection aborted"),
    "rate_limit": llm_provider.HuggingFaceLLMError("429 too many requests", kind="rate_limit"),
    "unavailable": RuntimeError("Error response 503 while fetching https://api.mistral.ai"),
}

try:
    import httpx

    _request = httpx.Request("POST", "https://api.mistral.ai/v1/chat/completions")
    TRANSIENT["rate_limit_httpx"] = httpx.HTTPStatusError(
        "Error response 429 while fetching https://api.mistral.ai",
        request=_request,
        response=httpx.Response(429, request=_request),
    )
    TRANSIENT["auth_httpx"] = httpx.HTTPStatusError(
        "Error response 401 while fetching https://api.mistral.ai",
        request=_request,
        response=httpx.Response(401, request=_request),
    )
except ImportError:  # pragma: no cover - httpx ships with langchain-mistralai
    httpx = None


# ---------------------------------------------------------------------------
print("=== 1. Mistral succeeds: Llama is never used ===")
# ---------------------------------------------------------------------------

primary = StubChatModel(text="answer from mistral")
fallback = StubChatModel(text="answer from llama")
model = composite(primary, fallback)

answer, log = capture(lambda: model.invoke(QUESTION))
check("invoke is served by the primary", answer.content == "answer from mistral", answer.content)
check("the fallback is not called on success", fallback.calls == 0, f"{fallback.calls} calls")
check("the primary is called exactly once", primary.calls == 1, f"{primary.calls} calls")
check("last_provider names Mistral", model.last_provider.startswith("mistral:"), model.last_provider)
check("last_used_fallback is False", model.last_used_fallback is False)
check("the log names Mistral as the source", "answered by mistral:" in log, log.strip())
check("the log does not mention the fallback", "fallback" not in log, log.strip())

streamed, log = capture(lambda: "".join(c.content for c in model.stream(QUESTION)))
check("stream is served by the primary", streamed.strip() == "answer from mistral", streamed)
check("the fallback is not called on a successful stream", fallback.calls == 0)
check("the stream log names Mistral", "answered by mistral:" in log, log.strip())

# A chain built exactly like the ones in agents.py must be unaffected.
prompt = ChatPromptTemplate.from_messages(
    [("system", "You are an expert research assistant."), ("human", "Context:\n{context}\n\n{question}")]
)
chain = prompt | model | StrOutputParser()
result, _ = capture(lambda: chain.invoke({"context": "a GRU is a gated RNN", "question": "What is a GRU?"}))
check("an existing prompt chain still works", result == "answer from mistral", str(result))
result, _ = capture(lambda: "".join(chain.stream({"context": "c", "question": "q"})))
check("an existing prompt chain still streams", result.strip() == "answer from mistral", str(result))


# ---------------------------------------------------------------------------
print("\n=== 2. Mistral fails: Llama takes over ===")
# ---------------------------------------------------------------------------

for reason, error in TRANSIENT.items():
    primary = StubChatModel(text="unused", error=error)
    fallback = StubChatModel(text="answer from llama")
    model = composite(primary, fallback)

    answer, log = capture(lambda: model.invoke(QUESTION))
    served = isinstance(answer, AIMessage) and answer.content == "answer from llama"
    check(f"invoke falls back on a {reason} error", served, str(answer)[:80])
    check(f"the fallback ran once for {reason}", fallback.calls == 1, f"{fallback.calls} calls")
    check(
        f"the log explains the {reason} failover",
        "-> retrying on huggingface:" in log and "answered by huggingface:" in log,
        log.strip().replace("\n", " | ")[:160],
    )
    check(
        f"the log marks the answer as a fallback for {reason}",
        "[fallback]" in log,
        log.strip().replace("\n", " | ")[:160],
    )

    primary = StubChatModel(text="unused", error=error)
    fallback = StubChatModel(text="answer from llama")
    model = composite(primary, fallback)
    streamed, log = capture(lambda: "".join(c.content for c in model.stream(QUESTION)))
    check(
        f"stream falls back on a {reason} error",
        streamed.strip() == "answer from llama",
        str(streamed)[:80],
    )
    check(f"last_used_fallback is True for {reason}", model.last_used_fallback is True)

# The point of the whole exercise: the fallback must answer the same question,
# with the same system prompt and the same retrieved context.
primary = StubChatModel(text="unused", error=requests.Timeout("boom"))
fallback = StubChatModel(text="answer from llama")
model = composite(primary, fallback)
chain = prompt | model | StrOutputParser()
capture(lambda: chain.invoke({"context": "a GRU is a gated RNN", "question": "What is a GRU?"}))

primary_messages = primary.seen[0]
fallback_messages = fallback.seen[0]
check(
    "the fallback receives the identical rendered prompt",
    [(type(m).__name__, m.content) for m in primary_messages]
    == [(type(m).__name__, m.content) for m in fallback_messages],
    str([m.content for m in fallback_messages])[:120],
)
check(
    "the retrieved context survives the failover",
    "a GRU is a gated RNN" in fallback_messages[-1].content,
    fallback_messages[-1].content[:80],
)

# Per-call kwargs (the router's /classify caps max_tokens) must reach both.
primary = StubChatModel(text="unused", error=requests.Timeout("boom"))
fallback = StubChatModel(text="web")
model = composite(primary, fallback)
answer, _ = capture(lambda: model.invoke("classify this", max_tokens=5))
check("per-call kwargs do not break the failover", getattr(answer, "content", None) == "web", str(answer)[:80])


# ---------------------------------------------------------------------------
print("\n=== 3. Llama fails too ===")
# ---------------------------------------------------------------------------

primary = StubChatModel(text="unused", error=RuntimeError("Error response 503 from mistral"))
fallback = StubChatModel(text="unused", error=llm_provider.HuggingFaceLLMError(
    "Rate limited by Hugging Face", kind="rate_limit", status=429
))
model = composite(primary, fallback)

error, log = capture(lambda: model.invoke(QUESTION))
check("both failing raises", isinstance(error, Exception), type(error).__name__)
check(
    "the caller sees the primary's error",
    isinstance(error, RuntimeError) and "503" in str(error),
    str(error)[:80],
)
check(
    "the fallback failure is kept as the exception context",
    isinstance(error.__context__, llm_provider.HuggingFaceLLMError),
    type(error.__context__).__name__,
)
check(
    "the log reports both failures",
    "-> retrying on huggingface:" in log and "fallback also failed" in log,
    log.strip().replace("\n", " | ")[:200],
)
check("no answer is reported as served", "answered by" not in log, log.strip()[:120])

error, log = capture(lambda: list(model.stream(QUESTION)))
check("both failing raises while streaming", isinstance(error, RuntimeError), type(error).__name__)
check("the streaming double failure is logged", "fallback also failed" in log, log.strip()[:120])

# With no fallback configured the behaviour is exactly what it was before.
primary = StubChatModel(text="unused", error=requests.Timeout("boom"))
model = composite(primary, None)
error, log = capture(lambda: model.invoke(QUESTION))
check("without a fallback the primary error propagates", isinstance(error, requests.Timeout))
check("the missing fallback is logged", "no fallback configured" in log, log.strip()[:120])


# ---------------------------------------------------------------------------
print("\n=== 4. When NOT to fall back ===")
# ---------------------------------------------------------------------------

primary = StubChatModel(text="unused", error=TypeError("expected str, got dict"))
fallback = StubChatModel(text="answer from llama")
model = composite(primary, fallback)
error, log = capture(lambda: model.invoke(QUESTION))
check("a local bug is re-raised, not failed over", isinstance(error, TypeError), type(error).__name__)
check("a local bug does not reach the fallback", fallback.calls == 0, f"{fallback.calls} calls")
check("the log says why it was not replayed", "not a provider error" in log, log.strip()[:140])

check("should_fallback is False for TypeError", llm_provider.should_fallback(TypeError()) is False)
check("should_fallback is False for KeyError", llm_provider.should_fallback(KeyError()) is False)
check(
    "should_fallback is False for a cancelled request",
    llm_provider.should_fallback(GeneratorExit()) is False,
)
check(
    "should_fallback is True for a timeout",
    llm_provider.should_fallback(requests.Timeout()) is True,
)

# A failure after tokens are already on the wire cannot be restarted.
primary = StubChatModel(
    text="partial answer that stops here",
    error=RuntimeError("Error response 503 mid-stream"),
    fail_after_tokens=2,
)
fallback = StubChatModel(text="answer from llama")
model = composite(primary, fallback)


def _drain():
    return [chunk.text for chunk in model.stream(QUESTION)]


error, log = capture(_drain)
check("a mid-stream failure is raised", isinstance(error, RuntimeError), type(error).__name__)
check("a mid-stream failure does not restart on the fallback", fallback.calls == 0)
check("the mid-stream decision is logged", "failed mid-stream" in log, log.strip().replace("\n", " | ")[:200])


# ---------------------------------------------------------------------------
print("\n=== 5. classify_error ===")
# ---------------------------------------------------------------------------

expected = [
    (requests.Timeout("Read timed out"), "timeout"),
    (requests.ConnectionError("Connection aborted"), "connection"),
    (RuntimeError("Error response 429 while fetching x"), "rate_limit"),
    (RuntimeError("Error response 503 while fetching x"), "unavailable"),
    (RuntimeError("Error response 401 while fetching x"), "auth"),
    (llm_provider.HuggingFaceLLMError("x", kind="rate_limit", status=429), "rate_limit"),
    (llm_provider.HuggingFaceLLMError("x", kind="empty"), "empty"),
    (RuntimeError("something else entirely"), "error"),
]
for error, reason in expected:
    actual = llm_provider.classify_error(error)
    check(f"classify_error -> {reason}", actual == reason, f"got {actual}")

if httpx is not None:
    check(
        "an httpx 429 from langchain-mistralai is a rate limit",
        llm_provider.classify_error(TRANSIENT["rate_limit_httpx"]) == "rate_limit",
    )
    check(
        "an httpx 401 from langchain-mistralai is an auth failure",
        llm_provider.classify_error(TRANSIENT["auth_httpx"]) == "auth",
    )


# ---------------------------------------------------------------------------
print("\n=== 6. The Hugging Face client ===")
# ---------------------------------------------------------------------------

session = FakeSession(FakeResponse(200, completion("Llama says hello")))
model = hf_model(session)
answer, _ = capture(lambda: model.invoke(QUESTION))
check("a 200 response is parsed", answer.content == "Llama says hello", str(answer)[:60])
check("token usage is reported", answer.usage_metadata["total_tokens"] == 14, str(answer.usage_metadata))

request = session.requests[0]
check("the configured endpoint is used", request["url"].endswith("/v1/chat/completions"), request["url"])
check("the Llama model id is sent", request["json"]["model"] == "meta-llama/Llama-3.1-8B-Instruct")
check("max_tokens is sent", request["json"]["max_tokens"] == 2000, str(request["json"].get("max_tokens")))
check("the timeout is applied", request["timeout"] == 60, str(request["timeout"]))
check(
    "the prompt is sent in OpenAI chat format",
    [m["role"] for m in request["json"]["messages"]] == ["system", "user"],
    str([m["role"] for m in request["json"]["messages"]]),
)
check(
    "the system prompt is preserved verbatim",
    request["json"]["messages"][0]["content"] == "You are an expert research assistant.",
    request["json"]["messages"][0]["content"],
)
check(
    "the token travels in the header, never in the body",
    request["headers"]["Authorization"].startswith("Bearer ")
    and "hf_test_token_not_real" not in str(request["json"]),
)

# Per-call overrides.
session = FakeSession(FakeResponse(200, completion("ok")))
model = hf_model(session)
capture(lambda: model.invoke(QUESTION, max_tokens=5))
check("max_tokens can be overridden per call", session.requests[0]["json"]["max_tokens"] == 5)
check(
    "unknown kwargs are not forwarded to the API",
    "callbacks" not in session.requests[0]["json"] and "stop" not in session.requests[0]["json"],
    str(sorted(session.requests[0]["json"])),
)

# Rate limit, then success.
session = FakeSession(
    FakeResponse(429, {"error": {"message": "rate limit reached"}}),
    FakeResponse(200, completion("recovered")),
)
model = hf_model(session)
answer, log = capture(lambda: model.invoke(QUESTION))
check("a 429 is retried and then succeeds", getattr(answer, "content", None) == "recovered", str(answer)[:60])
check("the retry is logged", "retrying in" in log, log.strip()[:100])

# A persistent 503 gives up after max_retries.
session = FakeSession(*[FakeResponse(503, {"error": "service unavailable"})] * 5)
model = hf_model(session, max_retries=2)
error, _ = capture(lambda: model.invoke(QUESTION))
check("a persistent 503 raises", isinstance(error, llm_provider.HuggingFaceLLMError), type(error).__name__)
check("a 503 is classified as unavailable", getattr(error, "kind", None) == "unavailable", str(error)[:80])
check("503 is retried max_retries times", len(session.requests) == 3, f"{len(session.requests)} attempts")

# Errors that retrying cannot fix are raised on the first attempt.
for status, kind in ((401, "auth"), (403, "auth"), (404, "not_found"), (400, "error")):
    session = FakeSession(*[FakeResponse(status, {"error": "nope"})] * 5)
    model = hf_model(session)
    error, _ = capture(lambda: model.invoke(QUESTION))
    check(f"HTTP {status} is classified as {kind}", getattr(error, "kind", None) == kind, str(error)[:70])
    check(f"HTTP {status} is not retried", len(session.requests) == 1, f"{len(session.requests)} attempts")

# A cold model reports its error with a 200 status.
session = FakeSession(
    FakeResponse(200, {"error": "Model meta-llama/Llama-3.1-8B-Instruct is currently loading",
                       "estimated_time": 20.0}),
    FakeResponse(200, completion("warm now")),
)
model = hf_model(session)
answer, _ = capture(lambda: model.invoke(QUESTION))
check("a loading model is retried, not surfaced", getattr(answer, "content", None) == "warm now", str(answer)[:60])

session = FakeSession(*[FakeResponse(200, {"error": "Model is currently loading"})] * 5)
model = hf_model(session)
error, _ = capture(lambda: model.invoke(QUESTION))
check("a model that never loads raises", getattr(error, "kind", None) == "unavailable", str(error)[:80])

# Transport failures.
session = FakeSession(*[requests.Timeout("Read timed out")] * 5)
model = hf_model(session)
error, _ = capture(lambda: model.invoke(QUESTION))
check("a timeout is classified as a timeout", getattr(error, "kind", None) == "timeout", str(error)[:80])
check("a timeout mentions the limit", "60s" in str(error), str(error)[:80])

session = FakeSession(*[requests.ConnectionError("dns failure")] * 5)
model = hf_model(session)
error, _ = capture(lambda: model.invoke(QUESTION))
check("a connection error is classified", getattr(error, "kind", None) == "connection", str(error)[:80])

# Malformed and empty responses.
session = FakeSession(FakeResponse(200, {"choices": []}))
error, _ = capture(lambda: hf_model(session).invoke(QUESTION))
check("no choices raises", getattr(error, "kind", None) == "empty", str(error)[:80])

session = FakeSession(FakeResponse(200, None, text="<html>gateway</html>"))
error, _ = capture(lambda: hf_model(session).invoke(QUESTION))
check("a non-JSON 200 raises", isinstance(error, llm_provider.HuggingFaceLLMError), str(error)[:80])

# Streaming.
session = FakeSession(FakeResponse(200, lines=sse("Llama ", "streams ", "tokens")))
model = hf_model(session)
streamed, _ = capture(lambda: "".join(c.content for c in model.stream(QUESTION)))
check("SSE chunks are streamed", streamed == "Llama streams tokens", repr(streamed))
check("stream=true is requested", session.requests[0]["json"]["stream"] is True)

session = FakeSession(FakeResponse(200, lines=["data: [DONE]"]))
error, _ = capture(lambda: list(hf_model(session).stream(QUESTION)))
check("an empty stream raises", getattr(error, "kind", None) == "empty", str(error)[:80])

session = FakeSession(*[FakeResponse(503, {"error": "cold"})] * 5)
error, _ = capture(lambda: list(hf_model(session).stream(QUESTION)))
check("a stream that cannot connect raises", getattr(error, "kind", None) == "unavailable", str(error)[:80])

# Missing credentials must fail before any request is made.
session = FakeSession(FakeResponse(200, completion("never reached")))
model = hf_model(session)
model.api_token = None
error, _ = capture(lambda: model.invoke(QUESTION))
check("a missing token raises", getattr(error, "kind", None) == "auth", str(error)[:90])
check("a missing token makes no HTTP call", len(session.requests) == 0)
check("the missing-token error names the env vars", "HF_LLM_API_TOKEN" in str(error), str(error)[:90])

# Credentials must never leak into logs, reprs or health output.
model = hf_model(FakeSession())
check("repr hides the token", "hf_test_token_not_real" not in repr(model), repr(model)[:90])
check("describe() hides the token", "hf_test_token_not_real" not in str(model.describe()), str(model.describe()))
check("describe() reports the model", model.describe()["model"] == "meta-llama/Llama-3.1-8B-Instruct")


# ---------------------------------------------------------------------------
print("\n=== 7. Fallback end to end, through a real chain ===")
# ---------------------------------------------------------------------------

session = FakeSession(FakeResponse(200, completion("A GRU is a gated recurrent unit.")))
llama = hf_model(session)
primary = StubChatModel(text="unused", error=requests.Timeout("Read timed out"))
model = llm_provider.FallbackChatModel(
    primary=primary,
    fallback=llama,
    primary_label="mistral:mistral-small-2506",
    fallback_label="huggingface:meta-llama/Llama-3.1-8B-Instruct",
)
chain = prompt | model | StrOutputParser()
answer, log = capture(lambda: chain.invoke({"context": "GRUs gate their state", "question": "What is a GRU?"}))
check(
    "a real chain fails over to the Hugging Face client",
    answer == "A GRU is a gated recurrent unit.",
    str(answer)[:70],
)
check(
    "the Hugging Face request carries the chain's context",
    "GRUs gate their state" in session.requests[0]["json"]["messages"][1]["content"],
    session.requests[0]["json"]["messages"][1]["content"][:80],
)
check(
    "the log identifies the Hugging Face Llama fallback",
    "answered by huggingface:meta-llama/Llama-3.1-8B-Instruct [fallback]" in log,
    log.strip().replace("\n", " | ")[:200],
)

session = FakeSession(FakeResponse(200, lines=sse("A GRU ", "is gated.")))
llama = hf_model(session)
model = llm_provider.FallbackChatModel(
    primary=StubChatModel(text="unused", error=requests.Timeout("Read timed out")),
    fallback=llama,
    primary_label="mistral:mistral-small-2506",
    fallback_label="huggingface:meta-llama/Llama-3.1-8B-Instruct",
)
chain = prompt | model | StrOutputParser()
streamed, _ = capture(lambda: "".join(chain.stream({"context": "c", "question": "q"})))
check("a real chain streams from the fallback", streamed == "A GRU is gated.", repr(streamed))


# ---------------------------------------------------------------------------
print("\n=== 8. Mistral HTTP 429 -> Hugging Face, through rag_engine ===")
# ---------------------------------------------------------------------------
#
# The regression test for the symptom this exists to fix: a 429 from Mistral
# used to reach the browser as "The language model is rate limited right now."
# It must now be answered by Llama 3.1 8B instead, and that message must appear
# ONLY when Hugging Face has failed as well.

RATE_LIMIT_MESSAGE = "The language model is rate limited right now"


def mistral_error(status: int, body: str = "") -> Exception:
    """Exactly what langchain-mistralai raises for an HTTP error.

    Its tenacity decorator only retries httpx.RequestError / StreamError, and is
    built with reraise=True, so a 429 arrives here as the original
    httpx.HTTPStatusError rather than a RetryError.
    """
    request = httpx.Request("POST", "https://api.mistral.ai/v1/chat/completions")
    return httpx.HTTPStatusError(
        f"Error response {status} while fetching https://api.mistral.ai/v1/chat/completions: {body}",
        request=request,
        response=httpx.Response(status, request=request),
    )


if httpx is None:  # pragma: no cover - httpx ships with langchain-mistralai
    check("httpx is available for the 429 tests", False, "httpx not installed")
else:
    # The real service wiring: import agents/rag_engine with the fallback on, so
    # the chains under test are the ones the running service actually uses.
    settings.MISTRAL_API_KEY = settings.MISTRAL_API_KEY or "not-a-real-mistral-key"
    settings.LLM_FALLBACK_API_TOKEN = "hf_test_token_not_real"
    _buffer = io.StringIO()
    with redirect_stdout(_buffer):
        import agents  # noqa: E402
        import rag_engine  # noqa: E402

    check(
        "the service's chains are built on the fallback model",
        isinstance(agents.llm, llm_provider.FallbackChatModel),
        type(agents.llm).__name__,
    )

    def wire(hf_session: FakeSession, primary_error: Exception | None = None, **stub):
        """Point the live chains at a failing Mistral and a scripted Llama."""
        agents.llm.primary = StubChatModel(
            text=stub.pop("text", "unused"),
            error=primary_error if primary_error is not None else mistral_error(429),
            **stub,
        )
        agents.llm.fallback = hf_model(hf_session)

    def emitted(events, kind: str) -> str:
        return "".join(event["text"] for event in events if event["type"] == kind)

    # --- the headline case ------------------------------------------------
    session = FakeSession(FakeResponse(200, lines=sse("Gated ", "recurrent ", "units.")))
    wire(session)
    events, log = capture(lambda: list(rag_engine.generate("What is a GRU?", mode="llm")))

    kinds = [event["type"] for event in events]
    check(
        "a Mistral 429 is answered by Llama",
        emitted(events, "token") == "Gated recurrent units.",
        repr(emitted(events, "token")),
    )
    check("no error event reaches the client", "error" not in kinds, str(kinds))
    check(
        "the rate-limit message is never sent",
        RATE_LIMIT_MESSAGE not in str(events),
        str(events)[:160],
    )
    check(
        "the turn finishes normally",
        events[-1] == {"type": "done", "finishReason": "stop"},
        str(events[-1]),
    )
    check(
        "the log names Mistral's 429 and the Hugging Face takeover",
        "failed (rate_limit:" in log and "answered by huggingface:" in log,
        log.strip().replace("\n", " | ")[:200],
    )
    check("the log never exposes the token", "hf_test_token_not_real" not in log)

    # --- every retrieval mode keeps its context ----------------------------
    session = FakeSession(FakeResponse(200, lines=sse("Update ", "and reset ", "gates.")))
    wire(session)
    events, _ = capture(
        lambda: list(
            rag_engine.generate(
                "What gates does it have?",
                mode="document",
                document_context="[1] A GRU has an update gate and a reset gate. (GRU.pdf, page 3)",
                history=[
                    {"role": "user", "content": "tell me about GRUs"},
                    {"role": "assistant", "content": "GRUs are gated RNNs."},
                ],
            )
        )
    )
    sent = session.requests[0]["json"]["messages"]
    check(
        "document mode is answered by Llama",
        emitted(events, "token") == "Update and reset gates.",
        repr(emitted(events, "token")),
    )
    check(
        "the retrieved chunks reach Llama unchanged",
        "[1] A GRU has an update gate and a reset gate. (GRU.pdf, page 3)" in sent[-1]["content"],
        sent[-1]["content"][:120],
    )
    check(
        "the conversation history reaches Llama",
        "GRUs are gated RNNs." in sent[-1]["content"],
        sent[-1]["content"][:120],
    )
    check(
        "the citation rules survive the failover",
        "Cite the numbered sources" in sent[0]["content"],
        sent[0]["content"][:120],
    )

    for mode, context in (("web", "webContext"), ("hybrid", "both")):
        session = FakeSession(FakeResponse(200, lines=sse("Answer ", "from Llama.")))
        wire(session)
        events, _ = capture(
            lambda: list(
                rag_engine.generate(
                    "What happened?",
                    mode=mode,
                    document_context="[1] a document passage",
                    web_context="[2] a web result from Tavily",
                )
            )
        )
        body = session.requests[0]["json"]["messages"][-1]["content"]
        check(
            f"{mode} mode is answered by Llama on a 429",
            emitted(events, "token") == "Answer from Llama.",
            repr(emitted(events, "token")),
        )
        check(
            f"{mode} mode keeps its web research through the failover",
            "[2] a web result from Tavily" in body,
            body[:120],
        )

    # --- only when BOTH fail does the user see the message -----------------
    session = FakeSession(*[FakeResponse(429, {"error": {"message": "hf rate limited"}})] * 6)
    wire(session)
    events, log = capture(lambda: list(rag_engine.generate("What is a GRU?", mode="llm")))

    errors = [event for event in events if event["type"] == "error"]
    check("both rate limited -> exactly one error event", len(errors) == 1, str(events)[:120])
    check(
        "the error code is still LLM_RATE_LIMITED",
        errors and errors[0]["code"] == "LLM_RATE_LIMITED",
        str(errors[:1])[:120],
    )
    check(
        "the original rate-limit message is used",
        errors and errors[0]["message"].startswith(RATE_LIMIT_MESSAGE),
        str(errors[:1])[:120],
    )
    check("no tokens are emitted when both fail", emitted(events, "token") == "")
    check(
        "both failures are logged before the error",
        "-> retrying on huggingface:" in log and "fallback also failed" in log,
        log.strip().replace("\n", " | ")[:200],
    )
    check("the failure log never exposes the token", "hf_test_token_not_real" not in log)

    # --- the same treatment for other transient Mistral failures -----------
    _request = httpx.Request("POST", "https://api.mistral.ai/v1/chat/completions")
    transient = {
        "429 rate limit": mistral_error(429, '{"message":"Requests rate limit exceeded"}'),
        "500 internal error": mistral_error(500),
        "502 bad gateway": mistral_error(502),
        "503 service unavailable": mistral_error(503),
        "504 gateway timeout": mistral_error(504),
        "read timeout": httpx.ReadTimeout("timed out", request=_request),
        "connect timeout": httpx.ConnectTimeout("timed out", request=_request),
        "connection error": httpx.ConnectError("connection refused", request=_request),
        "remote protocol error": httpx.RemoteProtocolError("peer closed", request=_request),
    }
    for label, error in transient.items():
        session = FakeSession(FakeResponse(200, lines=sse("Llama ", "answered.")))
        wire(session, primary_error=error)
        events, _ = capture(lambda: list(rag_engine.generate("q", mode="llm")))
        check(
            f"a Mistral {label} is answered by Llama",
            emitted(events, "token") == "Llama answered."
            and "error" not in [event["type"] for event in events],
            repr(emitted(events, "token")),
        )

    # --- the non-streaming paths fail over too -----------------------------
    session = FakeSession(FakeResponse(200, completion("What is a gated recurrent unit?")))
    wire(session)
    rewritten, log = capture(
        lambda: rag_engine.condense_question(
            "what is it?", [{"role": "user", "content": "tell me about GRUs"}]
        )
    )
    check(
        "query rewriting falls back instead of giving up on a 429",
        rewritten == "What is a gated recurrent unit?",
        str(rewritten),
    )

    session = FakeSession(FakeResponse(200, completion("web")))
    wire(session)
    answer, _ = capture(lambda: agents.llm.invoke("Route this question.", max_tokens=5))
    check(
        "the router's /classify call falls back on a 429",
        getattr(answer, "content", None) == "web",
        str(answer)[:60],
    )
    check("the fallback honours the router's token cap", session.requests[0]["json"]["max_tokens"] == 5)

    # --- a delivered answer is never turned into a rate-limit error ---------
    # The answer streams from Mistral; only the optional critique pass 429s.
    session = FakeSession(FakeResponse(200, lines=sse("Score: 8/10")))
    agents.llm.primary = StubChatModel(
        text="A GRU is gated.", error=mistral_error(429), error_on="research critic"
    )
    agents.llm.fallback = hf_model(session)
    events, log = capture(lambda: list(rag_engine.generate("q", mode="llm", critique=True)))
    check(
        "the answer still comes from Mistral",
        emitted(events, "token").strip() == "A GRU is gated.",
        repr(emitted(events, "token")),
    )
    check(
        "a 429 on the critique falls back to Llama as well",
        emitted(events, "critique_token") == "Score: 8/10",
        repr(emitted(events, "critique_token")),
    )
    check("no error event when the critique failed over", "error" not in [e["type"] for e in events])

    agents.llm.primary = StubChatModel(
        text="A GRU is gated.", error=mistral_error(429), error_on="research critic"
    )
    agents.llm.fallback = hf_model(
        FakeSession(*[FakeResponse(429, {"error": "hf rate limited"})] * 6)
    )
    events, log = capture(lambda: list(rag_engine.generate("q", mode="llm", critique=True)))
    kinds = [event["type"] for event in events]
    check(
        "a delivered answer survives a critique both models failed",
        emitted(events, "token").strip() == "A GRU is gated.",
        repr(emitted(events, "token")),
    )
    check("a failed critique emits no error event", "error" not in kinds, str(kinds))
    check(
        "a failed critique still finishes the turn",
        events[-1] == {"type": "done", "finishReason": "stop"},
        str(events[-1]),
    )
    check("the skipped critique is logged", "critique skipped" in log, log.strip()[:140])


# ---------------------------------------------------------------------------
print("\n=== 9. Configuration ===")
# ---------------------------------------------------------------------------

original = (
    settings.LLM_FALLBACK_ENABLED,
    settings.LLM_FALLBACK_API_TOKEN,
    settings.LLM_FALLBACK_MODEL,
)
try:
    settings.LLM_FALLBACK_ENABLED = False
    settings.LLM_FALLBACK_API_TOKEN = "hf_test_token_not_real"
    built, _ = capture(llm_provider.build_fallback_llm)
    check("LLM_FALLBACK_ENABLED=false disables the fallback", built is None, str(built)[:60])

    settings.LLM_FALLBACK_ENABLED = True
    settings.LLM_FALLBACK_API_TOKEN = ""
    built, log = capture(llm_provider.build_fallback_llm)
    check("a missing token disables the fallback", built is None, str(built)[:60])
    check("the disabled fallback is logged", "fallback disabled" in log, log.strip()[:120])

    settings.LLM_FALLBACK_API_TOKEN = "hf_test_token_not_real"
    settings.LLM_FALLBACK_MODEL = "meta-llama/Llama-3.1-8B-Instruct"
    built, _ = capture(llm_provider.build_fallback_llm)
    check(
        "the fallback is built from the environment",
        isinstance(built, llm_provider.HuggingFaceChatModel)
        and built.model == "meta-llama/Llama-3.1-8B-Instruct",
        str(built)[:60],
    )
    check(
        "the default endpoint is the Hugging Face Inference API",
        "huggingface.co" in built.api_url and built.api_url.endswith("/v1/chat/completions"),
        built.api_url,
    )
    check(
        "the fallback matches the primary's generation settings",
        built.temperature == settings.LLM_TEMPERATURE and built.max_tokens == settings.LLM_MAX_TOKENS,
        f"temperature={built.temperature} max_tokens={built.max_tokens}",
    )

    described = llm_provider.describe()
    check("describe() reports the fallback model", described["model"] == "meta-llama/Llama-3.1-8B-Instruct")
    check("describe() reports it as configured", described["configured"] is True)
    check(
        "describe() never includes the token",
        "hf_test_token_not_real" not in str(described),
        str(described),
    )
finally:
    (
        settings.LLM_FALLBACK_ENABLED,
        settings.LLM_FALLBACK_API_TOKEN,
        settings.LLM_FALLBACK_MODEL,
    ) = original

# Tools must be bound on both models, or the agents lose their fallback.
primary = StubChatModel(text="p")
fallback = StubChatModel(text="f")
bound, _ = capture(lambda: composite(primary, fallback).bind_tools([{"type": "function",
    "function": {"name": "web_search", "description": "search", "parameters": {"type": "object", "properties": {}}}}]))
check("bind_tools returns a fallback-aware model", isinstance(bound, llm_provider.FallbackChatModel))
check("bind_tools binds the fallback too", bound.fallback is not None)
check("bind_tools keeps the labels", bound.primary_label.startswith("mistral:"), bound.primary_label)


print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
