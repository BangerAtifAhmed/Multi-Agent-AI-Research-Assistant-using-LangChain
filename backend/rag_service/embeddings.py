"""Embedding providers.

    EmbeddingProvider (interface)
    ├── LocalEmbeddingProvider   sentence-transformers, loaded in-process
    └── ApiEmbeddingProvider     hosted inference over HTTP

The rest of the pipeline only ever calls `embed_query` / `embed_documents` and
never learns which provider is active.

Two invariants are enforced here rather than left to configuration discipline:

  * the provider's real output dimension must equal EMBEDDING_DIMENSION, which
    is the dimension of the pgvector column. A mismatch raises at startup
    instead of writing unusable vectors.
  * queries and documents are embedded by the same provider instance, so a
    deployment cannot answer questions with one model against vectors written
    by another.
"""

from __future__ import annotations

import threading
import time
from abc import ABC, abstractmethod

import requests

import settings


class EmbeddingError(RuntimeError):
    """Raised when embeddings cannot be produced or are misconfigured."""


class EmbeddingProvider(ABC):
    """Common interface for every embedding backend."""

    #: Provider key, e.g. "local" or "api".
    name: str = "unknown"
    #: Model identifier, e.g. "sentence-transformers/all-mpnet-base-v2".
    model_id: str = "unknown"

    @abstractmethod
    def embed_query(self, text: str) -> list[float]:
        """Embed one search query."""

    @abstractmethod
    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        """Embed a batch of passages, preserving input order."""

    @property
    def dimension(self) -> int:
        """Actual output dimension, measured once against the real backend."""
        if getattr(self, "_dimension", None) is None:
            probe = self.embed_query("dimension probe")
            self._dimension = len(probe)
        return self._dimension

    @property
    def fingerprint(self) -> str:
        """Identity of the vectors this provider produces.

        Deliberately *excludes* the provider: the local model and a hosted API
        serving the same model produce the same vectors, so they share a
        fingerprint and their vectors are interchangeable.
        """
        return self.model_id

    def describe(self) -> dict:
        """Safe summary for health endpoints - never includes credentials."""
        return {
            "provider": self.name,
            "model": self.model_id,
            "dimension": self.dimension,
        }


class LocalEmbeddingProvider(EmbeddingProvider):
    """sentence-transformers loaded into this process (development default)."""

    name = "local"

    def __init__(self, model_path: str, device: str = "cpu"):
        from langchain_huggingface import HuggingFaceEmbeddings

        self.model_id = normalise_model_id(model_path)
        self._dimension = None
        print(f"[embeddings] loading local model {self.model_id} on {device}")
        self._model = HuggingFaceEmbeddings(
            model_name=model_path,
            model_kwargs={"device": device},
        )

    def embed_query(self, text: str) -> list[float]:
        return self._model.embed_query(text)

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        return self._model.embed_documents(texts)


class ApiEmbeddingProvider(EmbeddingProvider):
    """Hosted embedding API over HTTP.

    Speaks the two response shapes that cover almost every provider:

      * Hugging Face feature-extraction -> a (nested) list of floats
      * OpenAI-compatible              -> {"data": [{"embedding": [...]}, ...]}

    The request shape is chosen to match, so the same class works with Hugging
    Face, OpenAI, Jina, Together and friends by changing only EMBEDDING_API_URL.
    """

    name = "api"

    def __init__(self, url: str, api_key: str, model_id: str, batch_size: int = 32,
                 timeout: int = 60, max_retries: int = 3):
        if not url:
            raise EmbeddingError(
                "EMBEDDING_PROVIDER=api requires EMBEDDING_API_URL to be set."
            )
        if not api_key:
            raise EmbeddingError(
                "EMBEDDING_PROVIDER=api requires EMBEDDING_API_KEY to be set."
            )

        self._url = url
        self._api_key = api_key
        self.model_id = normalise_model_id(model_id)
        self._batch_size = max(1, batch_size)
        self._timeout = timeout
        self._max_retries = max_retries
        self._dimension = None
        self._openai_style = None  # detected on first call
        self._session = requests.Session()
        print(f"[embeddings] using embedding API for {self.model_id}")

    # -- request/response handling -----------------------------------------

    def _headers(self) -> dict:
        return {
            "Authorization": f"Bearer {self._api_key}",
            "Content-Type": "application/json",
        }

    def _payload(self, texts: list[str]) -> dict:
        if self._openai_style:
            return {"input": texts, "model": self.model_id}
        return {"inputs": texts}

    @staticmethod
    def _flatten(vector):
        """HF returns [[...]] or [[[...]]] depending on the pipeline."""
        while isinstance(vector, list) and vector and isinstance(vector[0], list):
            vector = vector[0]
        return vector

    def _parse(self, body, expected: int) -> list[list[float]]:
        # OpenAI-compatible
        if isinstance(body, dict) and isinstance(body.get("data"), list):
            ordered = sorted(body["data"], key=lambda item: item.get("index", 0))
            return [item["embedding"] for item in ordered]

        if isinstance(body, dict) and "embeddings" in body:
            return body["embeddings"]

        if isinstance(body, list):
            # A batch of vectors, or a single vector when one text was sent.
            if expected == 1:
                return [self._flatten(body)]
            return [self._flatten(item) for item in body]

        raise EmbeddingError(f"Unrecognised embedding API response: {str(body)[:180]}")

    def _post(self, texts: list[str]) -> list[list[float]]:
        last_error = None

        for attempt in range(self._max_retries):
            try:
                response = self._session.post(
                    self._url,
                    headers=self._headers(),
                    json=self._payload(texts),
                    timeout=self._timeout,
                )
            except requests.RequestException as exc:
                last_error = f"{type(exc).__name__}: {exc}"
                time.sleep(min(2**attempt, 8))
                continue

            if response.status_code == 200:
                return self._parse(response.json(), len(texts))

            # A 400 on the first try may just mean the other request shape.
            if response.status_code in (400, 422) and self._openai_style is None:
                self._openai_style = True
                last_error = response.text[:180]
                continue

            # Rate limited or model still loading: back off and retry.
            if response.status_code in (429, 503, 502, 504):
                last_error = f"HTTP {response.status_code}"
                time.sleep(min(2**attempt, 8))
                continue

            # The body can echo the request; never surface it to a user.
            raise EmbeddingError(
                f"Embedding API returned HTTP {response.status_code}: {response.text[:180]}"
            )

        raise EmbeddingError(f"Embedding API unavailable after retries ({last_error})")

    # -- interface ----------------------------------------------------------

    def embed_query(self, text: str) -> list[float]:
        vectors = self._post([text])
        if not vectors:
            raise EmbeddingError("Embedding API returned no vector for the query.")
        return vectors[0]

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        results: list[list[float]] = []
        for start in range(0, len(texts), self._batch_size):
            batch = texts[start : start + self._batch_size]
            vectors = self._post(batch)
            if len(vectors) != len(batch):
                raise EmbeddingError(
                    f"Embedding API returned {len(vectors)} vectors for {len(batch)} inputs."
                )
            results.extend(vectors)
        return results


def normalise_model_id(value: str) -> str:
    """Reduce a local snapshot path to the canonical Hub model id.

    The development machine points at a snapshot directory such as
    ...\\models--sentence-transformers--all-mpnet-base-v2\\snapshots\\<sha>.
    Reducing it to `sentence-transformers/all-mpnet-base-v2` means the local
    provider and the hosted API report the SAME fingerprint - which is correct,
    because they produce identical vectors.
    """
    if not value:
        return "unknown"

    text = str(value).replace("\\", "/")
    marker = "models--"
    if marker in text:
        segment = text.split(marker, 1)[1].split("/", 1)[0]
        return segment.replace("--", "/")

    # A bare path with no Hub metadata: use the directory name.
    if "/" in text and (":" in text or text.startswith("/")):
        return text.rstrip("/").split("/")[-1]

    return text


# ---------------------------------------------------------------------------
# Singleton wiring
# ---------------------------------------------------------------------------

_provider: EmbeddingProvider | None = None
_lock = threading.Lock()


def build_provider() -> EmbeddingProvider:
    """Constructs the configured provider without caching it."""
    if settings.EMBEDDING_PROVIDER == "api":
        return ApiEmbeddingProvider(
            url=settings.EMBEDDING_API_URL,
            api_key=settings.EMBEDDING_API_KEY,
            model_id=settings.EMBEDDING_MODEL,
            batch_size=settings.EMBEDDING_API_BATCH_SIZE,
            timeout=settings.EMBEDDING_API_TIMEOUT,
        )

    return LocalEmbeddingProvider(
        model_path=settings.LOCAL_EMBEDDING_MODEL,
        device=settings.EMBEDDING_DEVICE,
    )


def get_provider() -> EmbeddingProvider:
    """The one provider used for both queries and documents.

    A single instance is shared process-wide, which is what makes it impossible
    for queries and documents to be embedded by different models.
    """
    global _provider

    if _provider is not None:
        return _provider

    with _lock:
        if _provider is not None:
            return _provider

        provider = build_provider()

        # Verify the real dimension against the pgvector column before any
        # vector is written.
        actual = provider.dimension
        expected = settings.EMBEDDING_DIMENSION
        if actual != expected:
            raise EmbeddingError(
                f"Embedding dimension mismatch: provider '{provider.name}' with model "
                f"'{provider.model_id}' produces {actual}-dimensional vectors, but the "
                f"database column is vector({expected}). Either configure a model that "
                f"outputs {expected} dimensions, or migrate the schema and re-embed "
                f"every existing chunk."
            )

        print(
            f"[embeddings] provider={provider.name} model={provider.model_id} "
            f"dimension={actual}"
        )
        _provider = provider

    return _provider


def reset_provider() -> None:
    """Drops the cached provider (used by tests)."""
    global _provider
    _provider = None
