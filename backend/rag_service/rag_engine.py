"""Streaming LLM engine.

Retrieval now happens in Express against PostgreSQL + pgvector, so this module
is responsible for the parts that need the Python stack: embeddings, the Tavily
web research tools, query rewriting, and streaming generation through the
project's original LangChain prompt chains.

Everything is a generator that yields events the moment they happen; nothing
buffers a full answer before emitting it.
"""

from __future__ import annotations

import threading
from typing import Iterator

import settings
from agents import (
    condense_chain,
    general_chat_chain,
    crictic_chain,
    hybrid_chat_chain,
    pdf_chat_chain,
    web_chat_chain,
)
from tools import scrape_text, tavily_search_raw

MAX_HISTORY_MESSAGES = 6
MAX_HISTORY_CHARS_PER_MESSAGE = 800
MAX_CONTEXT_CHARS = 12000


class Cancelled(Exception):
    """Raised internally when the client aborted the request."""


def _check(cancel: threading.Event | None) -> None:
    if cancel is not None and cancel.is_set():
        raise Cancelled()


def format_history(history: list[dict] | None) -> str:
    """Render the recent turns as plain text for the prompt."""
    if not history:
        return "(no previous messages)"

    recent = history[-MAX_HISTORY_MESSAGES:]
    lines = []
    for message in recent:
        role = "User" if message.get("role") == "user" else "Assistant"
        content = (message.get("content") or "").strip()
        if not content:
            continue
        if len(content) > MAX_HISTORY_CHARS_PER_MESSAGE:
            content = content[:MAX_HISTORY_CHARS_PER_MESSAGE] + " ..."
        lines.append(f"{role}: {content}")

    return "\n".join(lines) if lines else "(no previous messages)"


def condense_question(question: str, history: list[dict] | None) -> str:
    """Rewrite a follow-up into a standalone query. Falls back to the original."""
    history_text = format_history(history)
    try:
        rewritten = condense_chain.invoke(
            {"history": history_text, "question": question}
        )
        rewritten = (rewritten or "").strip().strip('"')
        if 0 < len(rewritten) <= 400:
            return rewritten
    except Exception:
        pass
    return question


def web_research(query: str, max_results: int = 5) -> dict:
    """Tavily search plus a deep scrape of the top result."""
    results = tavily_search_raw(query, max_results=max_results)

    sources = []
    for result in results:
        score = result.get("score")
        sources.append(
            {
                "type": "web",
                "title": result.get("title") or result.get("url"),
                "url": result.get("url"),
                "snippet": (result.get("content") or "")[:600],
                "score": round(float(score), 4) if isinstance(score, (int, float)) else None,
            }
        )

    scraped = None
    if sources and sources[0].get("url"):
        try:
            scraped = scrape_text(sources[0]["url"])
            sources[0]["scraped"] = True
        except Exception:
            scraped = None

    return {"sources": sources, "scraped": scraped}


def _stream_chain(chain, payload: dict, cancel=None, event_type: str = "token") -> Iterator[dict]:
    """Forward chunks from a LangChain chain the instant they arrive."""
    for chunk in chain.stream(payload):
        _check(cancel)
        if chunk:
            yield {"type": event_type, "text": chunk}


def generate(
    query: str,
    mode: str = "document",
    document_context: str = "",
    web_context: str = "",
    history: list[dict] | None = None,
    critique: bool = False,
    cancel: threading.Event | None = None,
) -> Iterator[dict]:
    """Stream an answer for pre-retrieved context."""

    try:
        history_text = format_history(history)
        answer_parts: list[str] = []

        document_context = (document_context or "")[:MAX_CONTEXT_CHARS]
        web_context = (web_context or "")[:MAX_CONTEXT_CHARS]

        if mode == "llm":
            # Router decided no retrieval is needed: answer from the model alone.
            stream = _stream_chain(
                general_chat_chain,
                {"history": history_text, "question": query},
                cancel,
            )
        elif mode == "document":
            stream = _stream_chain(
                pdf_chat_chain,
                {
                    "history": history_text,
                    "context": document_context or "(no relevant passages found)",
                    "question": query,
                },
                cancel,
            )
        elif mode == "web":
            stream = _stream_chain(
                web_chat_chain,
                {
                    "history": history_text,
                    "research": web_context or "(no web results found)",
                    "question": query,
                },
                cancel,
            )
        else:
            stream = _stream_chain(
                hybrid_chat_chain,
                {
                    "history": history_text,
                    "pdf_research": document_context or "(no relevant passages found)",
                    "web_research": web_context or "(no web results found)",
                    "question": query,
                },
                cancel,
            )

        for event in stream:
            answer_parts.append(event["text"])
            yield event

        answer = "".join(answer_parts)

        if critique and answer.strip():
            yield {"type": "status", "stage": "critiquing", "label": "Reviewing the answer"}
            for event in _stream_chain(
                crictic_chain, {"report": answer}, cancel, event_type="critique_token"
            ):
                yield event

        yield {"type": "done", "finishReason": "stop"}

    except Cancelled:
        yield {"type": "done", "finishReason": "aborted"}
    except Exception as exc:  # noqa: BLE001 - normalised for the API layer
        # The provider's raw error can contain the endpoint URL and request
        # details, so it is logged here and never returned to the browser.
        detail = str(exc)
        print(f"[generate] LLM call failed: {detail[:500]}")

        lowered = detail.lower()
        if "429" in detail or "rate limit" in lowered:
            code, message = (
                "LLM_RATE_LIMITED",
                "The language model is rate limited right now. Please try again in a moment.",
            )
        elif "503" in detail or "502" in detail or "unavailable" in lowered:
            code, message = (
                "LLM_UNAVAILABLE",
                "The language model service is temporarily unavailable. Please try again.",
            )
        elif "401" in detail or "unauthor" in lowered or "api key" in lowered:
            code, message = (
                "LLM_AUTH_FAILED",
                "The assistant is not configured correctly. Please contact the administrator.",
            )
        elif "timeout" in lowered or "timed out" in lowered:
            code, message = (
                "LLM_TIMEOUT",
                "The language model took too long to respond. Please try again.",
            )
        else:
            code, message = (
                "LLM_FAILED",
                "The assistant could not generate an answer. Please try again.",
            )

        yield {"type": "error", "code": code, "message": message}
