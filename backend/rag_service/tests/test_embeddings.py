"""Embedding provider tests.

    python tests/test_embeddings.py

Verifies both providers against the real backends, and - most importantly -
that they occupy the SAME embedding space, which is what makes switching
EMBEDDING_PROVIDER safe without re-embedding.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np  # noqa: E402

import embeddings as embedding_providers  # noqa: E402
import settings  # noqa: E402

passed = failed = skipped = 0


def check(name: str, condition: bool, detail: str = "") -> None:
    global passed, failed
    if condition:
        passed += 1
        print(f"PASS  {name}" + (f" -- {detail}" if detail else ""))
    else:
        failed += 1
        print(f"FAIL  {name}" + (f" -- {detail}" if detail else ""))


def skip(name: str, reason: str) -> None:
    global skipped
    skipped += 1
    print(f"SKIP  {name} -- {reason}")


TEXTS = [
    "Recurrent neural networks process sequential data.",
    "The update gate controls how much past state is carried forward.",
    "Cosine distance is appropriate for normalised vectors.",
]

cosine = lambda a, b: float(  # noqa: E731
    np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b))
)

# --------------------------------------------------------------- local ------
print("=== LOCAL provider ===")
local = embedding_providers.LocalEmbeddingProvider(
    model_path=settings.LOCAL_EMBEDDING_MODEL, device=settings.EMBEDDING_DEVICE
)
local_query = np.array(local.embed_query(TEXTS[0]), dtype=np.float32)
local_docs = [np.array(v, dtype=np.float32) for v in local.embed_documents(TEXTS)]

check("local provider reports its name", local.name == "local")
check("local dimension is 768", local.dimension == 768, str(local.dimension))
check("local query vector is 768-dim", len(local_query) == 768)
check("local batch preserves order and count", len(local_docs) == len(TEXTS))
check("local vectors are L2-normalised", abs(np.linalg.norm(local_query) - 1) < 1e-3,
      f"{np.linalg.norm(local_query):.4f}")
check(
    "local model id normalised to the Hub id",
    local.model_id == "sentence-transformers/all-mpnet-base-v2",
    local.model_id,
)
check(
    "embed_query and embed_documents agree for the same text",
    cosine(local_query, local_docs[0]) > 0.9999,
    f"{cosine(local_query, local_docs[0]):.6f}",
)

# ----------------------------------------------------------------- api ------
print("\n=== API provider ===")
api_key = settings.EMBEDDING_API_KEY
if not api_key:
    skip("API provider", "EMBEDDING_API_KEY / HUGGINGFACEHUB_API_TOKEN not set")
else:
    api = embedding_providers.ApiEmbeddingProvider(
        url=settings.EMBEDDING_API_URL,
        api_key=api_key,
        model_id=settings.EMBEDDING_MODEL,
    )
    api_query = np.array(api.embed_query(TEXTS[0]), dtype=np.float32)
    api_docs = [np.array(v, dtype=np.float32) for v in api.embed_documents(TEXTS)]

    check("api provider reports its name", api.name == "api")
    check("api dimension is 768", api.dimension == 768, str(api.dimension))
    check("api batch preserves order and count", len(api_docs) == len(TEXTS))
    check("api vectors are L2-normalised", abs(np.linalg.norm(api_query) - 1) < 1e-3,
          f"{np.linalg.norm(api_query):.4f}")

    # THE decisive check: same space, so stored vectors stay valid.
    print("\n=== Cross-provider compatibility ===")
    worst = 1.0
    for index, text in enumerate(TEXTS):
        similarity = cosine(local_docs[index], api_docs[index])
        worst = min(worst, similarity)
        check(f"local ~= api for text {index + 1}", similarity > 0.999, f"cos={similarity:.6f}")

    check(
        "query embedded by one provider matches documents from the other",
        cosine(api_query, local_docs[0]) > 0.999,
        f"cos={cosine(api_query, local_docs[0]):.6f}",
    )
    check(
        "same fingerprint, so vectors are interchangeable",
        local.fingerprint == api.fingerprint,
        f"{local.fingerprint} vs {api.fingerprint}",
    )
    check("worst-case similarity across the corpus", worst > 0.999, f"{worst:.6f}")

# ------------------------------------------------------- dimension guard ----
print("\n=== Safety guards ===")


class _WrongDimension(embedding_providers.EmbeddingProvider):
    name = "test"
    model_id = "test/wrong-dimension-1536"

    def embed_query(self, text):
        return [0.0] * 1536

    def embed_documents(self, texts):
        return [[0.0] * 1536 for _ in texts]


original_build = embedding_providers.build_provider
try:
    embedding_providers.reset_provider()
    embedding_providers.build_provider = lambda: _WrongDimension()
    embedding_providers.get_provider()
    check("a 1536-dim model is rejected against vector(768)", False, "no error raised")
except embedding_providers.EmbeddingError as exc:
    check(
        "a 1536-dim model is rejected against vector(768)",
        "1536" in str(exc) and "768" in str(exc),
        str(exc)[:90],
    )
finally:
    embedding_providers.build_provider = original_build
    embedding_providers.reset_provider()

# A missing key must fail loudly rather than silently falling back.
try:
    embedding_providers.ApiEmbeddingProvider(url="https://example.invalid", api_key="", model_id="m")
    check("api provider without a key is rejected", False, "no error raised")
except embedding_providers.EmbeddingError as exc:
    check("api provider without a key is rejected", "EMBEDDING_API_KEY" in str(exc), str(exc)[:70])

try:
    embedding_providers.ApiEmbeddingProvider(url="", api_key="k", model_id="m")
    check("api provider without a URL is rejected", False, "no error raised")
except embedding_providers.EmbeddingError as exc:
    check("api provider without a URL is rejected", "EMBEDDING_API_URL" in str(exc), str(exc)[:70])

check(
    "describe() never leaks credentials",
    "key" not in str(local.describe()).lower() and "token" not in str(local.describe()).lower(),
    str(local.describe()),
)

# A single shared instance is what guarantees queries and documents match.
embedding_providers.reset_provider()
first = embedding_providers.get_provider()
second = embedding_providers.get_provider()
check("one provider instance is shared process-wide", first is second)

print(f"\n{passed} passed, {failed} failed, {skipped} skipped")
sys.exit(1 if failed else 0)
