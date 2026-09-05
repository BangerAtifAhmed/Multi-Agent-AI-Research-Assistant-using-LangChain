"""Private RAG microservice.

Only the Express backend talks to this process; it binds to 127.0.0.1 and is
never exposed to the browser. It owns the parts of the pipeline that need the
Python ML stack:

  * embeddings  - the local CUDA sentence-transformers model (768-dim)
  * extraction  - PyPDFLoader + RecursiveCharacterTextSplitter
  * web research - Tavily search and page scraping
  * generation  - the original LangChain prompt chains, streamed

Similarity search itself lives in Express/PostgreSQL (pgvector), so that
ownership filtering happens in the same SQL statement as the vector search.

Streaming contract: newline-delimited JSON, flushed per event.
"""

from __future__ import annotations

import asyncio
import json
import os
import queue
import threading
from pathlib import Path

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

import capabilities
import embeddings as embedding_providers
import extraction
import llm_provider
import rag_engine
import settings
import vector_store

app = FastAPI(title="RAG Service", version="2.0.0", docs_url=None, redoc_url=None)

SERVICE_TOKEN = os.getenv("RAG_SERVICE_TOKEN") or None
_QUEUE_SENTINEL = object()


def _authorize(token: str | None) -> None:
    if SERVICE_TOKEN and token != SERVICE_TOKEN:
        raise HTTPException(status_code=401, detail="Invalid service token")


class ChatMessage(BaseModel):
    role: str
    content: str


class EmbedRequest(BaseModel):
    texts: list[str]
    # "query" and "passage" are separate so an asymmetric model could be swapped
    # in later without changing the Express side.
    kind: str = "passage"


class ExtractRequest(BaseModel):
    path: str
    name: str | None = None
    # Chunks per streamed frame. Bounds memory on both sides of the pipe.
    batchSize: int = 64


class CondenseRequest(BaseModel):
    question: str
    history: list[ChatMessage] = Field(default_factory=list)


class WebResearchRequest(BaseModel):
    query: str
    maxResults: int = 5


class GenerateRequest(BaseModel):
    query: str
    mode: str = "document"
    documentContext: str = ""
    webContext: str = ""
    history: list[ChatMessage] = Field(default_factory=list)
    critique: bool = False


def _embedding_status() -> dict:
    """Provider/model/dimension for health checks. Never includes credentials."""
    try:
        return embedding_providers.get_provider().describe()
    except Exception as exc:  # noqa: BLE001
        return {"provider": settings.EMBEDDING_PROVIDER, "model": None,
                "dimension": None, "error": str(exc)[:200]}


@app.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "model": settings.MISTRAL_MODEL,
        # Whether a failed Mistral call has somewhere to fail over to. Model and
        # endpoint only - the token is never included.
        "llmFallback": llm_provider.describe(),
        "embedding": _embedding_status(),
        "embeddingsLoaded": vector_store._embeddings is not None,
        "webSearch": bool(settings.TAVILY_API_KEY),
        # Ingestion capabilities, so a missing OCR engine or LibreOffice is
        # visible from the health check rather than only at upload time.
        **capabilities.summary(),
    }


@app.post("/warmup")
def warmup() -> dict:
    """Build the embedding provider up front so the first request is not slow."""
    provider = embedding_providers.get_provider()
    return {"status": "ready", "embedding": provider.describe()}


@app.post("/embed")
def embed(body: EmbedRequest, x_service_token: str | None = Header(default=None)) -> dict:
    _authorize(x_service_token)

    texts = [text for text in body.texts if text and text.strip()]
    if not texts:
        raise HTTPException(status_code=400, detail="No texts to embed")

    provider = embedding_providers.get_provider()
    try:
        if body.kind == "query" and len(texts) == 1:
            vectors = [provider.embed_query(texts[0])]
        else:
            vectors = provider.embed_documents(texts)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"Embedding failed: {exc}") from exc

    return {
        "embeddings": vectors,
        "dimension": len(vectors[0]) if vectors else 0,
        "model": provider.fingerprint,
        "provider": provider.name,
    }


@app.get("/capabilities")
def get_capabilities(
    refresh: bool = False, x_service_token: str | None = Header(default=None)
) -> dict:
    """Which formats this deployment can genuinely process right now.

    `?refresh=true` re-probes the filesystem, so a newly installed LibreOffice
    or Tesseract is picked up without restarting the service.
    """
    _authorize(x_service_token)
    if refresh:
        capabilities.reset_cache()

    return {"formats": capabilities.capabilities(), **capabilities.summary()}


@app.post("/documents/extract")
async def extract(body: ExtractRequest, x_service_token: str | None = Header(default=None)):
    """Extraction as an NDJSON stream.

    Status events are emitted as the work happens (extracting -> ocr -> ...),
    so Express can persist a live status the Library UI can show, and a long
    OCR pass is not a silent multi-minute wait.
    """
    _authorize(x_service_token)

    events: queue.Queue = queue.Queue(maxsize=8)

    def worker() -> None:
        try:
            events.put({"type": "status", "stage": "extracting"})

            def progress(event: dict) -> None:
                # Forwarded verbatim: every field is a real count measured by
                # the extractor (pages read, pages OCRed, blocks produced).
                events.put({"type": "status", **event})

            # Chunks are streamed in bounded batches instead of one huge frame,
            # so neither this process nor Express ever holds the whole document.
            # The queue is bounded too: if Express falls behind, `put` blocks and
            # extraction pauses rather than buffering the rest of the file.
            info: dict = {}
            total = 0
            frames = 0
            for batch in extraction.iter_chunk_batches(
                body.path, body.name, body.batchSize, progress, info
            ):
                total += len(batch)
                frames += 1
                # `index` is the batch's position in the stream, so Express can
                # report "batch 8" without counting frames itself.
                events.put(
                    {"type": "chunks", "chunks": batch, "count": len(batch), "index": frames}
                )

            events.put(
                {"type": "result", "count": total, "batches": frames, "info": info}
            )
        except extraction.ExtractionError as exc:
            events.put({"type": "error", "code": exc.code, "message": str(exc)})
        except Exception as exc:  # noqa: BLE001
            events.put(
                {
                    "type": "error",
                    "code": "EXTRACTION_FAILED",
                    "message": f"Could not extract readable text from this document. ({exc})",
                }
            )
        finally:
            events.put(_QUEUE_SENTINEL)

    async def stream():
        loop = asyncio.get_running_loop()
        thread = threading.Thread(target=worker, name="extract-worker", daemon=True)
        thread.start()
        while True:
            event = await loop.run_in_executor(None, events.get)
            if event is _QUEUE_SENTINEL:
                break
            yield json.dumps(event, ensure_ascii=False) + "\n"

    return StreamingResponse(
        stream(),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/condense")
def condense(body: CondenseRequest, x_service_token: str | None = Header(default=None)) -> dict:
    _authorize(x_service_token)
    history = [message.model_dump() for message in body.history]
    return {"query": rag_engine.condense_question(body.question, history)}


class ClassifyRequest(BaseModel):
    prompt: str
    maxTokens: int = 5


@app.post("/classify")
def classify(body: ClassifyRequest, x_service_token: str | None = Header(default=None)) -> dict:
    """One-word classification used by the automatic query router.

    Capped at a handful of tokens, so the fallback path stays cheap. Express
    only calls this when its deterministic rules were inconclusive.
    """
    _authorize(x_service_token)
    try:
        from agents import llm

        answer = llm.invoke(body.prompt, max_tokens=max(1, min(body.maxTokens, 16)))
        text = getattr(answer, "content", None) or str(answer)
        return {"answer": text.strip()}
    except Exception as exc:  # noqa: BLE001
        # Routing must never break the turn; the caller falls back to a default.
        print(f"[classify] failed: {exc}")
        raise HTTPException(status_code=503, detail="Classification unavailable") from exc


@app.post("/web/research")
def web_research(
    body: WebResearchRequest, x_service_token: str | None = Header(default=None)
) -> dict:
    _authorize(x_service_token)
    if not settings.TAVILY_API_KEY:
        return {"sources": [], "scraped": None, "available": False}
    result = rag_engine.web_research(body.query, body.maxResults)
    return {**result, "available": True}


@app.post("/generate/stream")
async def generate_stream(
    body: GenerateRequest, x_service_token: str | None = Header(default=None)
):
    _authorize(x_service_token)

    query = (body.query or "").strip()
    if not query:
        return JSONResponse(status_code=400, content={"detail": "Query must not be empty"})

    history = [message.model_dump() for message in body.history]

    cancel = threading.Event()
    events: queue.Queue = queue.Queue(maxsize=512)

    def worker() -> None:
        """Run the (synchronous) LangChain pipeline off the event loop."""
        try:
            for event in rag_engine.generate(
                query=query,
                mode=body.mode,
                document_context=body.documentContext,
                web_context=body.webContext,
                history=history,
                critique=body.critique,
                cancel=cancel,
            ):
                if cancel.is_set():
                    break
                events.put(event)
        except Exception as exc:  # noqa: BLE001
            events.put(
                {
                    "type": "error",
                    "code": exc.__class__.__name__,
                    "message": str(exc) or "The language model failed.",
                }
            )
        finally:
            events.put(_QUEUE_SENTINEL)

    async def stream():
        loop = asyncio.get_running_loop()
        thread = threading.Thread(target=worker, name="rag-worker", daemon=True)
        thread.start()
        try:
            while True:
                event = await loop.run_in_executor(None, events.get)
                if event is _QUEUE_SENTINEL:
                    break
                yield json.dumps(event, ensure_ascii=False) + "\n"
        except (asyncio.CancelledError, GeneratorExit):
            # The client (Express) went away - stop generating immediately.
            cancel.set()
            raise
        finally:
            cancel.set()

    return StreamingResponse(
        stream(),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        app,
        host=settings.RAG_SERVICE_HOST,
        port=settings.RAG_SERVICE_PORT,
        log_level="info",
    )
