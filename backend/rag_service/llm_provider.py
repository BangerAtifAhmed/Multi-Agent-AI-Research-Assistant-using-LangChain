"""The chat model used by every chain, with an automatic Hugging Face fallback.

Mistral stays the primary model. Nothing about the prompts, the chains, the
retrieval pipeline, the router or the streaming contract changes; this module
only adds a safety net:

    FallbackChatModel
    ├── primary   ChatMistralAI          - answers every request
    └── fallback  HuggingFaceChatModel   - meta-llama/Llama-3.1-8B-Instruct,
                                           used ONLY when the primary raises

When a Mistral call fails for a reason the provider owns (connection error,
timeout, rate limit, 5xx, rejected credentials) the *same* rendered messages are
replayed against Llama 3.1 8B Instruct on the Hugging Face Inference API. A
successful Mistral call is never second-guessed, and a failure caused by this
code rather than by the provider is re-raised instead of being retried.

Because both sides receive the messages LangChain already rendered from the
existing ChatPromptTemplates, the prompt and context format is identical
whichever model answers.

Streaming: the fallback can only take over *before* the first token reaches the
caller. Once tokens are on the wire, restarting would duplicate text in the
user's browser, so a mid-stream failure is raised as-is and handled by
rag_engine's error mapping.

Configuration lives in settings.py / backend/.env (LLM_FALLBACK_*). Setting
LLM_FALLBACK_ENABLED=false - or simply leaving the Hugging Face token unset -
returns the bare ChatMistralAI, exactly as before this module existed.
"""

from __future__ import annotations

import json
import time
from collections.abc import Iterator, Sequence
from typing import Any

import requests
from langchain_core.callbacks import CallbackManagerForLLMRun
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import (
    AIMessage,
    AIMessageChunk,
    BaseMessage,
    convert_to_openai_messages,
)
from langchain_core.messages.tool import tool_call_chunk
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult
from langchain_core.utils.function_calling import convert_to_openai_tool
from pydantic import PrivateAttr, SecretStr

import settings

#: Sentinel for "the primary produced no chunks at all".
_EXHAUSTED = object()


def _log(message: str) -> None:
    """One line per LLM call, prefixed like the rest of the service's output."""
    print(f"[llm] {message}", flush=True)


def _brief(exc: BaseException) -> str:
    """A short, log-safe rendering of a provider error."""
    return f"{type(exc).__name__}: {str(exc)[:200]}"


# ---------------------------------------------------------------------------
# Error classification
# ---------------------------------------------------------------------------


class HuggingFaceLLMError(RuntimeError):
    """The Hugging Face fallback could not produce an answer.

    `kind` is one of the reasons below and decides whether the request is worth
    retrying; `status` is the HTTP status when there was one.
    """

    def __init__(self, message: str, *, kind: str = "error", status: int | None = None):
        super().__init__(message)
        self.kind = kind
        self.status = status


#: Reasons that are worth another attempt against the same endpoint.
RETRYABLE_KINDS = frozenset({"rate_limit", "timeout", "connection", "unavailable"})

#: Exceptions that mean *this code* is wrong, not the provider. Replaying the
#: same request against another model would fail in exactly the same way, so
#: they are re-raised rather than triggering the fallback.
LOCAL_ERRORS = (
    TypeError,
    AttributeError,
    KeyError,
    IndexError,
    ImportError,
    NotImplementedError,
    RecursionError,
)

_HINTS = (
    ("rate_limit", ("rate limit", "rate_limit", "too many requests", "429")),
    ("timeout", ("timeout", "timed out")),
    (
        "unavailable",
        ("502", "503", "504", "unavailable", "overloaded", "capacity", "bad gateway"),
    ),
    ("auth", ("401", "403", "unauthorized", "unauthorised", "forbidden", "invalid api key")),
    ("connection", ("connection", "network", "reset by peer", "ssl", "dns")),
)


def _status_code(exc: BaseException) -> int | None:
    """HTTP status behind an exception, whichever client raised it.

    Covers httpx.HTTPStatusError (what langchain-mistralai raises),
    requests.HTTPError, and HuggingFaceLLMError.
    """
    for candidate in (
        getattr(exc, "status", None),
        getattr(exc, "status_code", None),
        getattr(getattr(exc, "response", None), "status_code", None),
    ):
        if isinstance(candidate, int):
            return candidate
    return None


def classify_error(exc: BaseException) -> str:
    """A short, log-friendly reason for a failed LLM call.

    Used for the log line only - `should_fallback` decides what actually
    happens - so an unrecognised error is simply reported as "error".
    """
    status = _status_code(exc)
    if status is not None:
        if status == 429:
            return "rate_limit"
        if status in (408, 504):
            return "timeout"
        if status >= 500:
            return "unavailable"
        if status in (401, 403):
            return "auth"
        return f"http_{status}"

    kind = getattr(exc, "kind", None)
    if isinstance(kind, str) and kind:
        return kind

    text = f"{type(exc).__name__}: {exc}".lower()
    for name, hints in _HINTS:
        if any(hint in text for hint in hints):
            return name
    return "error"


def should_fallback(exc: BaseException) -> bool:
    """Whether `exc` is the provider's fault and so worth replaying elsewhere.

    Everything that reaches the model client is treated as a provider problem -
    transport errors, timeouts, rate limits, 4xx/5xx responses - because all of
    them leave the user without an answer and another model may well have one.
    The exceptions are the programming errors in LOCAL_ERRORS, which would
    reproduce identically on any model, and BaseExceptions such as the
    GeneratorExit raised when the browser disconnects mid-stream.
    """
    if not isinstance(exc, Exception):
        return False
    return not isinstance(exc, LOCAL_ERRORS)


# ---------------------------------------------------------------------------
# The Hugging Face fallback model
# ---------------------------------------------------------------------------


def _parse_tool_calls(raw: Any) -> list[dict]:
    """OpenAI-shaped tool_calls -> LangChain tool calls."""
    calls: list[dict] = []
    for index, item in enumerate(raw or []):
        function = (item or {}).get("function") or {}
        arguments = function.get("arguments") or "{}"
        try:
            parsed = json.loads(arguments) if isinstance(arguments, str) else arguments
        except ValueError:
            parsed = {}
        calls.append(
            {
                "name": function.get("name") or "",
                "args": parsed if isinstance(parsed, dict) else {},
                "id": item.get("id") or f"call_{index}",
                "type": "tool_call",
            }
        )
    return calls


def _parse_tool_call_chunks(raw: Any) -> list:
    """OpenAI-shaped streaming tool_calls deltas -> LangChain tool call chunks."""
    chunks = []
    for index, item in enumerate(raw or []):
        function = (item or {}).get("function") or {}
        chunks.append(
            tool_call_chunk(
                name=function.get("name"),
                args=function.get("arguments"),
                id=item.get("id"),
                index=item.get("index", index),
            )
        )
    return chunks


class HuggingFaceChatModel(BaseChatModel):
    """meta-llama/Llama-3.1-8B-Instruct served by the Hugging Face Inference API.

    Talks to the router's OpenAI-compatible /v1/chat/completions endpoint, which
    is what serves Llama 3.1 Instruct, and speaks it with plain `requests` for
    the same reason ApiEmbeddingProvider does: every failure mode the endpoint
    has - rate limits, a model that is still loading, a gateway timeout, a
    rejected token - is then classified here instead of surfacing as an opaque
    client exception.
    """

    model: str = "meta-llama/Llama-3.1-8B-Instruct"
    api_url: str = "https://router.huggingface.co/v1/chat/completions"
    #: Read from the environment by build_fallback_llm; never hard-coded, and
    #: SecretStr keeps it out of reprs, logs and serialised chain state.
    api_token: SecretStr | None = None
    temperature: float = 0.0
    max_tokens: int = 2000
    timeout: int = 60
    max_retries: int = 2

    _session: Any = PrivateAttr(default=None)

    #: Request fields a caller may override per call; anything else LangChain
    #: passes through (max_retries, callbacks, ...) is not part of the payload.
    _OVERRIDABLE = frozenset(
        {
            "temperature",
            "max_tokens",
            "top_p",
            "seed",
            "stop",
            "tools",
            "tool_choice",
            "response_format",
            "presence_penalty",
            "frequency_penalty",
        }
    )

    @property
    def _llm_type(self) -> str:
        return "huggingface-router-chat"

    @property
    def _identifying_params(self) -> dict:
        return {"model": self.model, "api_url": self.api_url}

    @property
    def session(self) -> requests.Session:
        """Pooled connections, so a fallback burst does not re-handshake TLS."""
        if self._session is None:
            self._session = requests.Session()
        return self._session

    def describe(self) -> dict:
        """Safe summary for health endpoints - never includes the token."""
        return {
            "provider": "huggingface",
            "model": self.model,
            "endpoint": self.api_url,
            "configured": self.api_token is not None,
        }

    # -- request building ---------------------------------------------------

    def _headers(self) -> dict:
        token = self.api_token.get_secret_value() if self.api_token else ""
        return {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        }

    def _payload(
        self, messages: list[BaseMessage], stop: list[str] | None, stream: bool, **kwargs: Any
    ) -> dict:
        payload: dict = {
            "model": self.model,
            # The messages LangChain already rendered from the existing
            # prompt templates, so the fallback sees the same system prompt,
            # the same history and the same retrieved context as Mistral would.
            "messages": convert_to_openai_messages(messages),
            "temperature": self.temperature,
            "max_tokens": self.max_tokens,
            "stream": stream,
        }
        if stop:
            payload["stop"] = stop
        for key, value in kwargs.items():
            if key in self._OVERRIDABLE and value is not None:
                payload[key] = value
        return payload

    # -- transport ----------------------------------------------------------

    @staticmethod
    def _detail(response: requests.Response) -> str:
        """A short reason from an error response, without echoing the request."""
        try:
            body = response.json()
        except ValueError:
            return (response.text or "")[:180]
        if isinstance(body, dict):
            error = body.get("error")
            if isinstance(error, dict):
                return str(error.get("message") or error)[:180]
            if error:
                return str(error)[:180]
        return str(body)[:180]

    @staticmethod
    def _error_in_body(body: Any) -> HuggingFaceLLMError | None:
        """Catch the errors the endpoint reports with a 200 status.

        A model that is cold, or a provider that is momentarily out of capacity,
        can come back as `{"error": "..."}` rather than an HTTP error.
        """
        if not isinstance(body, dict):
            return None
        error = body.get("error")
        if not error:
            return None

        message = error.get("message") if isinstance(error, dict) else error
        message = str(message or error)[:180]

        if "loading" in message.lower():
            wait = body.get("estimated_time")
            suffix = f" (~{float(wait):.0f}s)" if isinstance(wait, (int, float)) else ""
            return HuggingFaceLLMError(
                f"model '{body.get('model', '')}' is still loading on Hugging Face{suffix}",
                kind="unavailable",
            )
        return HuggingFaceLLMError(f"Hugging Face returned an error: {message}", kind="error")

    def _post(self, payload: dict, *, stream: bool) -> requests.Response:
        """One HTTP attempt, with every failure mapped to HuggingFaceLLMError."""
        if self.api_token is None:
            raise HuggingFaceLLMError(
                "No Hugging Face token: set HF_LLM_API_TOKEN or HUGGINGFACEHUB_API_TOKEN.",
                kind="auth",
            )

        try:
            response = self.session.post(
                self.api_url,
                headers=self._headers(),
                json=payload,
                timeout=self.timeout,
                stream=stream,
            )
        except requests.Timeout as exc:
            raise HuggingFaceLLMError(
                f"Hugging Face did not respond within {self.timeout}s", kind="timeout"
            ) from exc
        except requests.RequestException as exc:
            raise HuggingFaceLLMError(
                f"Could not reach the Hugging Face API ({type(exc).__name__})", kind="connection"
            ) from exc

        status = response.status_code
        if status == 200:
            return response

        detail = self._detail(response)
        response.close()

        if status == 429:
            raise HuggingFaceLLMError(
                f"Rate limited by Hugging Face: {detail}", kind="rate_limit", status=429
            )
        if status in (500, 502, 503, 504):
            raise HuggingFaceLLMError(
                f"Hugging Face is unavailable (HTTP {status}): {detail}",
                kind="unavailable",
                status=status,
            )
        if status in (401, 403):
            raise HuggingFaceLLMError(
                f"Hugging Face rejected the API token (HTTP {status})", kind="auth", status=status
            )
        if status == 404:
            raise HuggingFaceLLMError(
                f"Model '{self.model}' is not available at this endpoint (HTTP 404)",
                kind="not_found",
                status=404,
            )
        raise HuggingFaceLLMError(
            f"Hugging Face returned HTTP {status}: {detail}", kind="error", status=status
        )

    def _with_retries(self, attempt):
        """Retry the retryable kinds with exponential backoff, then give up."""
        last: HuggingFaceLLMError | None = None
        for number in range(self.max_retries + 1):
            try:
                return attempt()
            except HuggingFaceLLMError as exc:
                if exc.kind not in RETRYABLE_KINDS:
                    raise
                last = exc
                if number < self.max_retries:
                    delay = min(2**number, 8)
                    _log(
                        f"huggingface {exc.kind}, retrying in {delay}s "
                        f"({number + 1}/{self.max_retries})"
                    )
                    time.sleep(delay)
        raise last  # type: ignore[misc]  # max_retries >= 0, so last is set

    # -- BaseChatModel ------------------------------------------------------

    def _generate(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: CallbackManagerForLLMRun | None = None,
        **kwargs: Any,
    ) -> ChatResult:
        payload = self._payload(messages, stop, stream=False, **kwargs)

        def attempt() -> dict:
            response = self._post(payload, stream=False)
            try:
                body = response.json()
            except ValueError as exc:
                raise HuggingFaceLLMError(
                    "Hugging Face returned a response that is not JSON", kind="error"
                ) from exc
            finally:
                response.close()

            error = self._error_in_body(body)
            if error is not None:
                raise error
            return body

        body = self._with_retries(attempt)

        choices = body.get("choices") or []
        if not choices:
            raise HuggingFaceLLMError("Hugging Face returned no completion", kind="empty")

        choice = choices[0] or {}
        message = choice.get("message") or {}
        content = message.get("content") or ""
        tool_calls = _parse_tool_calls(message.get("tool_calls"))
        if not content and not tool_calls:
            raise HuggingFaceLLMError("Hugging Face returned an empty completion", kind="empty")

        usage = body.get("usage") or {}
        answer = AIMessage(
            content=content,
            tool_calls=tool_calls,
            response_metadata={
                "model_provider": "huggingface",
                "model_name": self.model,
                "finish_reason": choice.get("finish_reason"),
            },
            usage_metadata={
                "input_tokens": usage.get("prompt_tokens", 0),
                "output_tokens": usage.get("completion_tokens", 0),
                "total_tokens": usage.get("total_tokens", 0),
            }
            if usage
            else None,
        )
        return ChatResult(
            generations=[ChatGeneration(message=answer)],
            llm_output={"model_name": self.model},
        )

    def _stream(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: CallbackManagerForLLMRun | None = None,
        **kwargs: Any,
    ) -> Iterator[ChatGenerationChunk]:
        payload = self._payload(messages, stop, stream=True, **kwargs)
        # Only opening the connection is retried. Once the body is being read a
        # retry would re-send tokens the caller has already seen.
        response = self._with_retries(lambda: self._post(payload, stream=True))

        emitted = False
        try:
            for raw in response.iter_lines():
                if not raw:
                    continue
                line = raw.decode("utf-8", errors="replace").strip()
                if line.startswith(":"):
                    continue  # SSE keep-alive comment
                if line.startswith("data:"):
                    line = line[len("data:") :].strip()
                if not line:
                    continue
                if line == "[DONE]":
                    break

                try:
                    event = json.loads(line)
                except ValueError:
                    continue

                error = self._error_in_body(event)
                if error is not None:
                    raise error

                for choice in event.get("choices") or []:
                    delta = (choice or {}).get("delta") or {}
                    text = delta.get("content") or ""
                    tool_chunks = _parse_tool_call_chunks(delta.get("tool_calls"))
                    if not text and not tool_chunks:
                        continue
                    chunk = ChatGenerationChunk(
                        message=AIMessageChunk(content=text, tool_call_chunks=tool_chunks)
                    )
                    if run_manager is not None and text:
                        run_manager.on_llm_new_token(text, chunk=chunk)
                    emitted = True
                    yield chunk
        finally:
            response.close()

        if not emitted:
            # Nothing has been yielded yet, so raising here is still safe.
            raise HuggingFaceLLMError("Hugging Face streamed an empty completion", kind="empty")

    def bind_tools(self, tools: Sequence[Any], *, tool_choice: Any = None, **kwargs: Any):
        formatted = [convert_to_openai_tool(tool) for tool in tools]
        if tool_choice is not None:
            kwargs["tool_choice"] = tool_choice
        return self.bind(tools=formatted, **kwargs)


# ---------------------------------------------------------------------------
# The primary + fallback composite
# ---------------------------------------------------------------------------


def _as_generation_chunk(chunk: Any) -> ChatGenerationChunk:
    """Normalise whatever the wrapped model yields into a generation chunk."""
    if isinstance(chunk, ChatGenerationChunk):
        return chunk
    if isinstance(chunk, AIMessageChunk):
        return ChatGenerationChunk(message=chunk)
    if isinstance(chunk, BaseMessage):
        return ChatGenerationChunk(
            message=AIMessageChunk(
                content=chunk.content,
                additional_kwargs=chunk.additional_kwargs,
                response_metadata=chunk.response_metadata,
            )
        )
    return ChatGenerationChunk(message=AIMessageChunk(content=str(chunk)))


def _as_chat_result(message: Any) -> ChatResult:
    """Normalise an invoke() result into a ChatResult."""
    if isinstance(message, ChatResult):
        return message
    if not isinstance(message, BaseMessage):
        message = AIMessage(content=str(message))
    return ChatResult(generations=[ChatGeneration(message=message)])


class FallbackChatModel(BaseChatModel):
    """`primary` answers; `fallback` only ever sees a request the primary lost.

    Every chain in agents.py is built on one of these instead of on
    ChatMistralAI directly, which is the whole of the integration: the prompts,
    the parsers, `.invoke()` and `.stream()` all behave exactly as before.
    """

    #: A chat model, or a RunnableBinding over one once tools are bound - hence
    #: Any rather than BaseChatModel.
    primary: Any
    fallback: Any = None
    primary_label: str = "mistral"
    fallback_label: str = "huggingface"

    #: Which label served the most recent call. Diagnostics only: with
    #: concurrent requests it reports whichever finished last.
    _last_provider: str | None = PrivateAttr(default=None)

    @property
    def _llm_type(self) -> str:
        return "primary-with-fallback"

    @property
    def _identifying_params(self) -> dict:
        return {"primary": self.primary_label, "fallback": self.fallback_label}

    @property
    def model_name(self) -> str:
        """The primary's model id, which is what this service reports it runs."""
        return self.primary_label

    @property
    def last_provider(self) -> str | None:
        return self._last_provider

    @property
    def last_used_fallback(self) -> bool:
        return self._last_provider == self.fallback_label

    # -- fallback decision --------------------------------------------------

    def _served_by(self, label: str) -> None:
        self._last_provider = label
        suffix = " [fallback]" if label == self.fallback_label else ""
        _log(f"answered by {label}{suffix}")

    def _fallback_for(self, exc: Exception) -> Any:
        """The model to replay `exc`'s request on, or None to re-raise."""
        reason = classify_error(exc)

        if not should_fallback(exc):
            _log(
                f"{self.primary_label} raised {type(exc).__name__} - not a provider "
                f"error, so the request is not replayed"
            )
            return None
        if self.fallback is None:
            _log(f"{self.primary_label} failed ({reason}: {_brief(exc)}); no fallback configured")
            return None

        _log(
            f"{self.primary_label} failed ({reason}: {_brief(exc)}) "
            f"-> retrying on {self.fallback_label}"
        )
        return self.fallback

    def _fallback_failed(self, fallback_exc: Exception) -> None:
        _log(
            f"{self.fallback_label} fallback also failed "
            f"({classify_error(fallback_exc)}: {_brief(fallback_exc)}); "
            f"reporting the original {self.primary_label} failure"
        )

    # -- BaseChatModel ------------------------------------------------------

    def _generate(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: CallbackManagerForLLMRun | None = None,
        **kwargs: Any,
    ) -> ChatResult:
        try:
            answer = self.primary.invoke(messages, stop=stop, **kwargs)
        except Exception as exc:
            target = self._fallback_for(exc)
            if target is None:
                raise
            try:
                answer = target.invoke(messages, stop=stop, **kwargs)
            except Exception as fallback_exc:
                self._fallback_failed(fallback_exc)
                # The primary is the model this service is configured to use, so
                # its error is the one the caller (and rag_engine's error
                # mapping) should see. The fallback failure stays attached as
                # __context__ and is in the log above.
                raise exc from fallback_exc
            self._served_by(self.fallback_label)
            return _as_chat_result(answer)

        self._served_by(self.primary_label)
        return _as_chat_result(answer)

    def _stream(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: CallbackManagerForLLMRun | None = None,
        **kwargs: Any,
    ) -> Iterator[ChatGenerationChunk]:
        # .stream() is lazy, so the primary's failure surfaces on the first
        # next() - which is exactly where the fallback can still take over
        # without the caller having seen any text.
        label = self.primary_label
        try:
            chunks = iter(self.primary.stream(messages, stop=stop, **kwargs))
            first = next(chunks, _EXHAUSTED)
        except Exception as exc:
            target = self._fallback_for(exc)
            if target is None:
                raise
            try:
                chunks = iter(target.stream(messages, stop=stop, **kwargs))
                first = next(chunks, _EXHAUSTED)
            except Exception as fallback_exc:
                self._fallback_failed(fallback_exc)
                raise exc from fallback_exc
            label = self.fallback_label

        self._served_by(label)

        try:
            if first is not _EXHAUSTED:
                yield self._emit(first, run_manager)
            for chunk in chunks:
                yield self._emit(chunk, run_manager)
        except Exception as exc:
            # Tokens are already on the wire. Replaying the question on the
            # fallback would repeat the beginning of the answer in the user's
            # browser, so this failure is reported instead.
            _log(
                f"{label} failed mid-stream ({classify_error(exc)}: {_brief(exc)}); "
                f"not restarting, the partial answer has already been sent"
            )
            raise

    def _emit(
        self, chunk: Any, run_manager: CallbackManagerForLLMRun | None
    ) -> ChatGenerationChunk:
        generation = _as_generation_chunk(chunk)
        text = generation.text
        if run_manager is not None and text:
            run_manager.on_llm_new_token(text, chunk=generation)
        return generation

    def bind_tools(self, tools: Sequence[Any], **kwargs: Any):
        """Bind tools on both models so an agent keeps its fallback."""
        bound_fallback = None
        if self.fallback is not None:
            try:
                bound_fallback = self.fallback.bind_tools(tools, **kwargs)
            except NotImplementedError:
                _log(
                    f"{self.fallback_label} does not support tool calling; "
                    f"tool-using agents will run without a fallback"
                )

        return FallbackChatModel(
            primary=self.primary.bind_tools(tools, **kwargs),
            fallback=bound_fallback,
            primary_label=self.primary_label,
            fallback_label=self.fallback_label,
        )


# ---------------------------------------------------------------------------
# Wiring
# ---------------------------------------------------------------------------


def build_primary_llm():
    """The unchanged Mistral model every chain has always used."""
    from langchain_mistralai import ChatMistralAI

    return ChatMistralAI(
        model_name=settings.MISTRAL_MODEL,
        api_key=settings.MISTRAL_API_KEY,
        temperature=settings.LLM_TEMPERATURE,
        max_tokens=settings.LLM_MAX_TOKENS,
        streaming=True,
    )


def build_fallback_llm() -> HuggingFaceChatModel | None:
    """The Hugging Face fallback, or None when it is off or unconfigured.

    A missing token disables the fallback with a warning rather than raising:
    the service must still start and serve every request Mistral can answer.
    """
    if not settings.LLM_FALLBACK_ENABLED:
        return None
    if not settings.LLM_FALLBACK_API_TOKEN:
        _log(
            "fallback disabled: set HF_LLM_API_TOKEN (or HUGGINGFACEHUB_API_TOKEN) "
            "to enable the Hugging Face Llama fallback"
        )
        return None

    return HuggingFaceChatModel(
        model=settings.LLM_FALLBACK_MODEL,
        api_url=settings.LLM_FALLBACK_API_URL,
        api_token=SecretStr(settings.LLM_FALLBACK_API_TOKEN),
        temperature=settings.LLM_TEMPERATURE,
        max_tokens=settings.LLM_MAX_TOKENS,
        timeout=settings.LLM_FALLBACK_TIMEOUT,
        max_retries=settings.LLM_FALLBACK_MAX_RETRIES,
    )


def build_llm() -> BaseChatModel:
    """The chat model agents.py hands to every chain.

    With the fallback off this returns the bare ChatMistralAI, so the service
    behaves exactly as it did before this module existed.
    """
    primary = build_primary_llm()
    fallback = build_fallback_llm()

    if fallback is None:
        _log(f"primary=mistral:{settings.MISTRAL_MODEL} fallback=none")
        return primary

    _log(
        f"primary=mistral:{settings.MISTRAL_MODEL} "
        f"fallback=huggingface:{fallback.model} (used only when the primary fails)"
    )
    return FallbackChatModel(
        primary=primary,
        fallback=fallback,
        primary_label=f"mistral:{settings.MISTRAL_MODEL}",
        fallback_label=f"huggingface:{fallback.model}",
    )


def describe() -> dict:
    """Fallback configuration for /health. Never includes the token."""
    return {
        "enabled": bool(settings.LLM_FALLBACK_ENABLED),
        "provider": "huggingface",
        "model": settings.LLM_FALLBACK_MODEL,
        "endpoint": settings.LLM_FALLBACK_API_URL,
        "configured": bool(settings.LLM_FALLBACK_API_TOKEN),
    }
