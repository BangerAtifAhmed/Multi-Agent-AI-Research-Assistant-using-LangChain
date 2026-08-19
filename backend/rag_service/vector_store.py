"""Shared retrieval core.

This is the original PDF pipeline (hash-keyed Chroma collection, PyPDFLoader,
RecursiveCharacterTextSplitter, similarity search) pulled into one module so the
CLI, the FastAPI service and the document endpoints all use exactly the same
index. Nothing about the storage format changed, so collections that were built
by the original scripts keep working.
"""

import hashlib
import threading
from pathlib import Path

from langchain_chroma import Chroma
from langchain_community.document_loaders import PyPDFLoader
from langchain_text_splitters import RecursiveCharacterTextSplitter

import settings

_embeddings = None
_embeddings_lock = threading.Lock()
_store_cache: dict[str, Chroma] = {}
_store_lock = threading.Lock()


def get_pdf_hash(pdf_path):
    sha256 = hashlib.sha256()

    with open(pdf_path, "rb") as f:
        for chunk in iter(lambda: f.read(4096), b""):
            sha256.update(chunk)

    return sha256.hexdigest()


class _LangChainAdapter:
    """Exposes an EmbeddingProvider through LangChain's embeddings interface.

    The legacy Chroma CLI (`python pipeline.py`) expects an object with
    embed_query/embed_documents, so the provider is handed to it unchanged.
    """

    def __init__(self, provider):
        self._provider = provider

    def embed_query(self, text):
        return self._provider.embed_query(text)

    def embed_documents(self, texts):
        return self._provider.embed_documents(list(texts))


def get_embeddings():
    """The configured embedding provider, wrapped for LangChain.

    Provider selection, dimension verification and caching all live in
    embeddings.py; this stays a thin adapter so the CLI keeps working.
    """
    global _embeddings

    if _embeddings is not None:
        return _embeddings

    with _embeddings_lock:
        if _embeddings is not None:
            return _embeddings

        import embeddings as embedding_providers

        _embeddings = _LangChainAdapter(embedding_providers.get_provider())

    return _embeddings


def get_vector_store(collection_name: str, embeddings=None) -> Chroma:
    """Open (and cache) the Chroma collection for a document hash."""
    with _store_lock:
        cached = _store_cache.get(collection_name)
        if cached is not None:
            return cached

        store = Chroma(
            collection_name=collection_name,
            embedding_function=embeddings or get_embeddings(),
            persist_directory=str(settings.CHROMA_PERSIST_DIR),
        )
        _store_cache[collection_name] = store
        return store


def index_pdf(pdf_path: str, embeddings=None) -> dict:
    """Ensure a PDF is indexed. Returns {collection, chunks, indexed}."""
    path = Path(pdf_path)
    if not path.exists():
        raise FileNotFoundError(f"PDF not found: {pdf_path}")

    doc_hash = get_pdf_hash(path)
    store = get_vector_store(doc_hash, embeddings)

    existing = store._collection.count()
    if existing:
        return {"collection": doc_hash, "chunks": existing, "indexed": False}

    loader = PyPDFLoader(
        file_path=str(path),
        mode="page",
        pages_delimiter="\n\n",
    )
    docs = loader.load()

    splitter = RecursiveCharacterTextSplitter(
        chunk_size=settings.CHUNK_SIZE,
        chunk_overlap=settings.CHUNK_OVERLAP,
    )
    chunks = splitter.split_documents(docs)

    for chunk in chunks:
        chunk.metadata.setdefault("source", str(path))
        chunk.metadata["document_name"] = path.name

    if chunks:
        store.add_documents(chunks)

    return {"collection": doc_hash, "chunks": len(chunks), "indexed": True}


def collection_count(collection_name: str) -> int:
    try:
        return get_vector_store(collection_name)._collection.count()
    except Exception:
        return 0


def _relevance(distance: float) -> float:
    """Map a Chroma distance (lower is better) onto a 0..1 relevance score."""
    try:
        return round(1.0 / (1.0 + max(float(distance), 0.0)), 4)
    except (TypeError, ValueError):
        return 0.0


def retrieve(query: str, pdf_path: str, k: int | None = None) -> list[dict]:
    """Similarity search over one document, returned as source dictionaries.

    Keeps the original behaviour (similarity search, k=5) and adds a distance
    filter plus real metadata (page, document name, score) for citations.
    """
    k = k or settings.RETRIEVAL_K
    path = Path(pdf_path)
    doc_hash = get_pdf_hash(path)

    store = get_vector_store(doc_hash)
    if store._collection.count() == 0:
        index_pdf(str(path))

    fetch_k = max(k, settings.RETRIEVAL_FETCH_K)
    pairs = store.similarity_search_with_score(query, k=fetch_k)

    kept = [
        (doc, score)
        for doc, score in pairs
        if score is None or float(score) <= settings.MAX_RETRIEVAL_DISTANCE
    ]
    # Never return nothing purely because of the filter: fall back to the best hits.
    if not kept:
        kept = pairs

    sources = []
    for doc, score in kept[:k]:
        metadata = doc.metadata or {}
        source_path = metadata.get("source") or str(path)
        page = metadata.get("page")
        sources.append(
            {
                "type": "document",
                "title": metadata.get("document_name") or Path(source_path).name,
                "documentName": Path(source_path).name,
                "page": (page + 1) if isinstance(page, int) else page,
                "snippet": doc.page_content[:600],
                "content": doc.page_content,
                "score": _relevance(score),
                "distance": round(float(score), 4) if score is not None else None,
            }
        )

    return sources


def list_documents() -> list[dict]:
    """Every PDF the service can answer from, with its index status."""
    seen_paths: set[str] = set()
    seen_hashes: set[str] = set()
    documents: list[dict] = []

    for directory in settings.DOCUMENT_DIRS:
        if not directory.exists():
            continue
        for path in sorted(directory.glob("*.pdf")):
            resolved = str(path.resolve())
            if resolved in seen_paths:
                continue
            seen_paths.add(resolved)

            try:
                doc_hash = get_pdf_hash(path)
                chunks = collection_count(doc_hash)
            except OSError:
                continue

            # The same file can sit in both scanned directories (for example an
            # upload of a PDF that already lives at the project root). The
            # collection is keyed by content hash, so list it only once.
            if doc_hash in seen_hashes:
                continue
            seen_hashes.add(doc_hash)

            documents.append(
                {
                    "id": doc_hash,
                    "name": path.name,
                    "path": resolved,
                    "sizeBytes": path.stat().st_size,
                    "indexed": chunks > 0,
                    "chunks": chunks,
                }
            )

    return documents


def resolve_document(document_id: str | None, document_path: str | None) -> dict | None:
    """Find a document by hash id or by path."""
    if document_path:
        path = Path(document_path)
        if path.exists():
            doc_hash = get_pdf_hash(path)
            return {
                "id": doc_hash,
                "name": path.name,
                "path": str(path.resolve()),
                "chunks": collection_count(doc_hash),
            }
        return None

    if not document_id:
        return None

    for doc in list_documents():
        if doc["id"] == document_id:
            return doc

    return None
