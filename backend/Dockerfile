# Backend image: Express API + the private Python RAG service in one container.
#
# They stay together deliberately: Express supervises the Python process over
# loopback (RAG_SERVICE_AUTOSTART=true), so there is no network hop, no service
# discovery, and no way for the RAG service to be reached from outside. To split
# them later, set RAG_SERVICE_AUTOSTART=false and point RAG_SERVICE_URL at the
# other service.
#
# Build:  docker build -t rag-backend ./backend
# Run:    docker run --init --env-file backend/.env -p 3000:3000 \
#                    -v rag-uploads:/data/uploads rag-backend

# ---------------------------------------------------------------------------
# Stage 1: Python dependencies + the embedding model
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS python-deps

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-venv python3-pip build-essential \
    && rm -rf /var/lib/apt/lists/*

ENV VIRTUAL_ENV=/opt/venv \
    PATH=/opt/venv/bin:$PATH \
    PIP_NO_CACHE_DIR=1
RUN python3 -m venv $VIRTUAL_ENV

# Which embedding provider this image is built for:
#   local -> torch + sentence-transformers + the model are baked in
#   api   -> none of them are installed; embeddings come from a hosted endpoint
#
#   docker build --build-arg EMBEDDING_PROVIDER=api ./backend
ARG EMBEDDING_PROVIDER=local

COPY rag_service/requirements.txt /tmp/requirements.txt

# torch and sentence-transformers exist only to run the model in-process, so
# they are skipped entirely in API mode - that is most of the size saving.
# CPU-only torch is already ~2 GB smaller than the CUDA build.
RUN grep -v -E '^sentence-transformers' /tmp/requirements.txt > /tmp/base-requirements.txt \
 && pip install --no-cache-dir -r /tmp/base-requirements.txt \
 && if [ "$EMBEDDING_PROVIDER" = "local" ]; then \
      pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu \
      && pip install --no-cache-dir sentence-transformers; \
    else \
      echo "EMBEDDING_PROVIDER=api - skipping torch and sentence-transformers"; \
    fi

# Bake the embedding model into the image.
#
# This is the SAME model the development machine uses
# (sentence-transformers/all-mpnet-base-v2, 768 dimensions), so vectors written
# from a container are identical to those written locally and remain compatible
# with everything already in pgvector. Baking it in means no first-request
# download, no runtime dependency on huggingface.co, and a deterministic image.
ENV HF_HOME=/opt/models
RUN mkdir -p /opt/models \
 && if [ "$EMBEDDING_PROVIDER" = "local" ]; then \
      python -c "\
from sentence_transformers import SentenceTransformer; \
m = SentenceTransformer('sentence-transformers/all-mpnet-base-v2'); \
assert m.get_sentence_embedding_dimension() == 768, 'unexpected embedding dimension'; \
print('embedding model cached, dim=768')"; \
    else \
      echo "EMBEDDING_PROVIDER=api - skipping the local model download"; \
    fi

# ---------------------------------------------------------------------------
# Stage 2: runtime
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

# --- System dependencies for document ingestion -----------------------------
# tesseract-ocr / -eng : OCR for scanned PDFs
# libreoffice-writer   : legacy .doc -> .docx conversion
# libreoffice-impress  : legacy .ppt -> .pptx conversion
# python3              : runtime for the RAG service (venv comes from stage 1)
# fonts-dejavu-core    : LibreOffice and OCR rendering need at least one font
#
# LibreOffice adds ~450 MB. Drop the two libreoffice-* packages if you do not
# need legacy .doc/.ppt: the app then reports those formats as unsupported via
# /api/documents/formats and keeps working.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 \
      tesseract-ocr \
      tesseract-ocr-eng \
      libreoffice-writer \
      libreoffice-impress \
      fonts-dejavu-core \
      ca-certificates \
      tini \
    && rm -rf /var/lib/apt/lists/*

COPY --from=python-deps /opt/venv /opt/venv
COPY --from=python-deps /opt/models /opt/models

WORKDIR /app

# Production dependencies only. package.json declares no devDependencies, and
# --omit=dev keeps it that way if any are added later.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# .dockerignore keeps .env, node_modules and data/ out of this layer.
COPY . .

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# --- Runtime configuration --------------------------------------------------
# Only non-secret values are set here. Every credential (DATABASE_URL,
# MISTRAL_API_KEY, SESSION_SECRET, GOOGLE_CLIENT_SECRET, UPSTASH_*, TAVILY_*)
# must be injected at run time via --env-file or the platform's secret store.
ENV NODE_ENV=production \
    PORT=3000 \
    PATH=/opt/venv/bin:$PATH \
    PYTHON_BIN=/opt/venv/bin/python \
    RAG_SERVICE_AUTOSTART=true \
    RAG_SERVICE_HOST=127.0.0.1 \
    RAG_SERVICE_PORT=8000 \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

# The image has no GPU: the development default of "cuda" fails on model load.
# The model is resolved from the baked-in cache by its Hub id, because the
# development default is a Windows filesystem path that does not exist here.
# Same model, same 768 dimensions, so vectors stay compatible with pgvector.
# Must match the build arg: an image built without torch cannot run in local
# mode. EMBEDDING_API_KEY / EMBEDDING_API_URL are injected at run time.
ARG EMBEDDING_PROVIDER=local
ENV EMBEDDING_PROVIDER=${EMBEDDING_PROVIDER} \
    EMBEDDING_DEVICE=cpu \
    LOCAL_EMBEDDING_MODEL=sentence-transformers/all-mpnet-base-v2 \
    EMBEDDING_MODEL=sentence-transformers/all-mpnet-base-v2 \
    EMBEDDING_DIMENSION=768 \
    HF_HOME=/opt/models

# Absolute paths on purpose: the config resolves relative paths against the
# PARENT of /app, which would scatter runtime data across the container root.
ENV STORAGE_DRIVER=local \
    STORAGE_DIR=/data/uploads \
    CHROMA_PERSIST_DIR=/data/chroma \
    DOCUMENTS_DIR=/data/documents

# LibreOffice needs a writable HOME for its user profile or conversion fails.
ENV HOME=/home/app

# Point at the LibreOffice and Tesseract installed in THIS image.
#
# NOTE: a runtime --env-file overrides these. If a developer's Windows .env is
# passed in, LIBREOFFICE_PATH would arrive as a C:\... path; capabilities.py
# detects that the file does not exist, logs a warning, and falls back to PATH
# (/usr/bin/soffice), so the container still works. Use a production env file
# rather than the development one - several other values (EMBEDDING_DEVICE,
# LOCAL_EMBEDDING_MODEL, STORAGE_DIR) have no such fallback.
ENV LIBREOFFICE_PATH=/usr/bin/soffice \
    TESSERACT_PATH=/usr/bin/tesseract

# --- Non-root user ----------------------------------------------------------
RUN groupadd --system --gid 1001 app \
    && useradd --system --uid 1001 --gid app --home-dir /home/app --create-home app \
    && mkdir -p /data/uploads /data/chroma /data/documents \
    && chown -R app:app /app /data /home/app

# Uploaded originals live here. With STORAGE_DRIVER=local this MUST be a
# mounted volume or documents are lost when the container is replaced. For more
# than one replica, use STORAGE_DRIVER=s3 instead - a volume is per-host.
VOLUME ["/data/uploads"]

USER app

EXPOSE 3000

# Readiness, not liveness: this endpoint is 200 only when PostgreSQL is
# reachable AND the Python RAG service is loaded. A container whose RAG service
# died is reported unhealthy instead of silently accepting traffic it cannot
# serve. start-period covers the one-off model load.
HEALTHCHECK --interval=30s --timeout=10s --start-period=240s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# tini reaps zombies: Express spawns the Python service, which can itself spawn
# LibreOffice during .doc/.ppt conversion.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "src/server.js"]
