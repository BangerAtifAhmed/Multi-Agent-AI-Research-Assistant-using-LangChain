"""Central configuration for the RAG service.

Every path and model choice that used to be hard-coded in the original scripts
lives here now, so the CLI, the FastAPI service and the Express backend all
resolve the same vector store, the same embedding model and the same LLM.

Defaults intentionally match the original project exactly:
  * chroma_persist/ at the repository root (existing collections keep working)
  * local sentence-transformers all-mpnet-base-v2 on CUDA
  * Mistral "mistral-small-2506"
"""

import os
from pathlib import Path

from dotenv import load_dotenv

# backend/rag_service/settings.py -> backend/rag_service -> backend -> <repo root>
RAG_SERVICE_DIR = Path(__file__).resolve().parent
BACKEND_DIR = RAG_SERVICE_DIR.parent
PROJECT_ROOT = BACKEND_DIR.parent

# backend/.env is the single source of truth for secrets. The legacy root .env
# is still honoured as a fallback so nothing breaks for an existing checkout.
load_dotenv(BACKEND_DIR / ".env")
load_dotenv(PROJECT_ROOT / ".env")


def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, default))
    except (TypeError, ValueError):
        return default


def _env_path(name: str, default: Path) -> Path:
    raw = os.getenv(name)
    if not raw:
        return default
    candidate = Path(raw).expanduser()
    if not candidate.is_absolute():
        candidate = (PROJECT_ROOT / candidate).resolve()
    return candidate


# --- Vector store -----------------------------------------------------------
# Unchanged location: the repo-root chroma_persist/ directory that already holds
# the indexed collections.
CHROMA_PERSIST_DIR = _env_path("CHROMA_PERSIST_DIR", PROJECT_ROOT / "chroma_persist")

# --- Documents --------------------------------------------------------------
# Uploads land in data/documents; the repository root is also scanned so the
# PDFs that already live there (GRU.pdf, deeplearning.pdf) stay available.
UPLOAD_DIR = _env_path("DOCUMENTS_DIR", PROJECT_ROOT / "data" / "documents")
DOCUMENT_DIRS = [UPLOAD_DIR, PROJECT_ROOT]

# --- Embeddings -------------------------------------------------------------
# EMBEDDING_PROVIDER is the modern switch:
#   local -> sentence-transformers in this process (development default)
#   api   -> a hosted embedding API (production, no model download)
#
# USE_LOCAL_EMBEDDINGS is the older boolean and still works: it is only
# consulted when EMBEDDING_PROVIDER is not set, so existing .env files behave
# exactly as before.
USE_LOCAL_EMBEDDINGS = _env_bool("USE_LOCAL_EMBEDDINGS", True)
EMBEDDING_PROVIDER = (
    os.getenv("EMBEDDING_PROVIDER") or ("local" if USE_LOCAL_EMBEDDINGS else "api")
).strip().lower()

# The dimension of the pgvector column. The provider is checked against this at
# startup; a mismatch is a hard error rather than a corrupted index.
EMBEDDING_DIMENSION = _env_int("EMBEDDING_DIMENSION", 768)

# --- Hosted embedding API ----------------------------------------------------
# Credentials come from the environment only; nothing is hard-coded.
EMBEDDING_API_KEY = os.getenv("EMBEDDING_API_KEY", "") or os.getenv(
    "HUGGINGFACEHUB_API_TOKEN", ""
)
EMBEDDING_MODEL = os.getenv("EMBEDDING_MODEL", "sentence-transformers/all-mpnet-base-v2")
EMBEDDING_API_URL = os.getenv("EMBEDDING_API_URL") or (
    # Default: the same model the local provider uses, served by Hugging Face.
    f"https://router.huggingface.co/hf-inference/models/{EMBEDDING_MODEL}"
    "/pipeline/feature-extraction"
)
EMBEDDING_API_BATCH_SIZE = _env_int("EMBEDDING_API_BATCH_SIZE", 32)
EMBEDDING_API_TIMEOUT = _env_int("EMBEDDING_API_TIMEOUT", 60)
LOCAL_EMBEDDING_MODEL = os.getenv(
    "LOCAL_EMBEDDING_MODEL",
    r"C:\OpenSourcesModels\HuggingFace\Embeddings\hub"
    r"\models--sentence-transformers--all-mpnet-base-v2\snapshots"
    r"\e8c3b32edf5434bc2275fc9bab85f82640a19130",
)
EMBEDDING_DEVICE = os.getenv("EMBEDDING_DEVICE", "cuda")
HF_ENDPOINT_EMBEDDING_MODEL = os.getenv(
    "HF_ENDPOINT_EMBEDDING_MODEL", "BAAI/bge-small-en-v1.5"
)
HUGGINGFACEHUB_API_TOKEN = os.getenv("HUGGINGFACEHUB_API_TOKEN")

# --- LLM --------------------------------------------------------------------
MISTRAL_API_KEY = os.getenv("MISTRAL_API_KEY")
MISTRAL_MODEL = os.getenv("MISTRAL_MODEL", "mistral-small-2506")
LLM_TEMPERATURE = float(os.getenv("LLM_TEMPERATURE", "0"))
LLM_MAX_TOKENS = _env_int("LLM_MAX_TOKENS", 2000)

# --- Fallback LLM (Hugging Face) ---------------------------------------------
# Mistral above stays the primary model. These only take effect when a Mistral
# call fails for a provider-side reason; see llm_provider.py. Turning the
# fallback off restores the exact pre-fallback behaviour.
LLM_FALLBACK_ENABLED = _env_bool("LLM_FALLBACK_ENABLED", True)
LLM_FALLBACK_MODEL = os.getenv("LLM_FALLBACK_MODEL", "meta-llama/Llama-3.1-8B-Instruct")
LLM_FALLBACK_API_URL = os.getenv(
    "LLM_FALLBACK_API_URL", "https://router.huggingface.co/v1/chat/completions"
)
# Credentials come from the environment only; nothing is hard-coded. A separate
# HF_LLM_API_TOKEN is honoured so the fallback can use its own token, but by
# default it reuses the Hugging Face token this deployment already has.
LLM_FALLBACK_API_TOKEN = os.getenv("HF_LLM_API_TOKEN") or os.getenv(
    "HUGGINGFACEHUB_API_TOKEN", ""
)
LLM_FALLBACK_TIMEOUT = _env_int("LLM_FALLBACK_TIMEOUT", 60)
# Retries within the fallback itself, for a rate limit or a cold model.
LLM_FALLBACK_MAX_RETRIES = _env_int("LLM_FALLBACK_MAX_RETRIES", 2)

# --- Retrieval / chunking ---------------------------------------------------
CHUNK_SIZE = _env_int("CHUNK_SIZE", 1000)
CHUNK_OVERLAP = _env_int("CHUNK_OVERLAP", 100)
RETRIEVAL_K = _env_int("RETRIEVAL_K", 5)
# Fetch a wider candidate pool, then keep the top RETRIEVAL_K after filtering.
RETRIEVAL_FETCH_K = _env_int("RETRIEVAL_FETCH_K", 12)
# Chroma returns a distance; anything above this is dropped as irrelevant.
MAX_RETRIEVAL_DISTANCE = float(os.getenv("MAX_RETRIEVAL_DISTANCE", "1.5"))

# --- Tools ------------------------------------------------------------------
TAVILY_API_KEY = os.getenv("TAVILY_API_KEY")

# --- Service ----------------------------------------------------------------
RAG_SERVICE_HOST = os.getenv("RAG_SERVICE_HOST", "127.0.0.1")
RAG_SERVICE_PORT = _env_int("RAG_SERVICE_PORT", 8000)
