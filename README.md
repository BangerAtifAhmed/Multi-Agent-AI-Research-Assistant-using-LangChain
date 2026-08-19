# AI Research Assistant — Multi-User RAG Search

A production-style, multi-user AI search engine. Users sign in with Google or
email/password, upload documents to a private library, and ask questions that are
answered from **their own documents** with streamed, cited responses.

**React + Express + Neon PostgreSQL + pgvector + Upstash Redis + Google OAuth +
email/password auth + RAG + chat history + document library + real LLM streaming
+ rate limiting + caching.**

The original project's RAG pipeline is preserved throughout: the same Mistral
model, the same local `all-mpnet-base-v2` embeddings, the same PyPDF loading and
1000/100 chunking, and the same Tavily web-research agents.

---

## Architecture

```text
                         USERS
                           │
                           ▼
                    ┌─────────────┐
                    │ React       │   Vite, port 5173
                    │ Frontend    │   HttpOnly cookie, no tokens in JS
                    └──────┬──────┘
                           │
                     HTTP / SSE
                           │
                    ┌──────▼──────┐
                    │ Express     │   port 3000 — owns every secret
                    │ Backend     │
                    └──────┬──────┘
                           │
        ┌──────────────────┼────────────────────┐
        │                  │                    │
        ▼                  ▼                    ▼
   Google OAuth       PostgreSQL              Redis
   Email/Password     + pgvector            Rate limit
        │                  │                  Cache
        │          ┌───────┴────────┐
        │          │                │
        │       Users           Documents
        │       Sessions        Chunks
        │       Chats           Embeddings
        │       Messages        Citations
        │
        └──────────────────────┐
                               ▼
                              RAG
                               │
                               ▼
                              LLM
                               │
                               ▼
                       Streaming Response
                               │
                               ▼
                            React
```

### Where the Python service fits

Similarity search runs in **PostgreSQL**, so ownership filtering happens inside
the same SQL statement as the vector search. The Python service exists only for
the parts that need the ML stack, and it is private to the backend — bound to
`127.0.0.1`, started and stopped by Express, never reachable from a browser:

| Runs in Express | Runs in the Python RAG service |
| --- | --- |
| Auth, sessions, rate limiting, caching | Embeddings (local CUDA, 768-dim) |
| **pgvector similarity search (user-scoped)** | Text extraction + chunking |
| Context assembly and citation numbering | Tavily web search + page scraping |
| Chat history, conversations, documents | Query rewriting, LLM streaming |

Keeping the embedding model in Python is deliberate: the vectors stored in
`document_chunks.embedding` are produced by `sentence-transformers/all-mpnet-base-v2`,
and re-implementing that elsewhere would produce vectors that do not match what
is already indexed.

---

## Folder structure

```text
project-root/
├── frontend/                    React ONLY
│   ├── src/
│   │   ├── components/          Sidebar, ChatWindow, MessageList, Message,
│   │   │   └── auth/            ChatInput, SourceCard, DocumentCard, …
│   │   ├── context/             AuthContext (session state)
│   │   ├── hooks/               useChatStream, useConversations, useAutoScroll
│   │   ├── pages/               AppShell, ChatView, LibraryPage, ProfilePage,
│   │   │                        LoginPage, SignupPage
│   │   ├── services/            apiClient, authApi, chatApi, conversationApi,
│   │   │                        documentApi
│   │   ├── styles/              app.css
│   │   ├── utils/               markdown, date, groupConversations
│   │   ├── App.jsx  main.jsx  index.css
│   ├── public/
│   ├── .env.example
│   └── package.json
│
├── backend/                     Express + RAG + PostgreSQL + Redis ONLY
│   ├── migrations/              001…007 SQL migrations
│   ├── src/
│   │   ├── config/              index.js, database.js (pg pool), redis.js
│   │   ├── controllers/         auth, chat, conversation, document, user, health
│   │   ├── middleware/          authMiddleware, rateLimit, upload, errorHandler
│   │   ├── models/              userModel, sessionModel, conversationModel,
│   │   │                        messageModel, documentModel, chunkModel
│   │   ├── rag/                 ragClient, ragProcess, contextWindow
│   │   ├── routes/              auth, chat, conversations, documents, user
│   │   ├── scripts/             migrate.js
│   │   ├── services/            authService, googleOAuthService, chatService,
│   │   │                        retrievalService, ingestService, cacheService,
│   │   │                        storageService, conversationService, titleService
│   │   ├── utils/               sse, logger, ApiError
│   │   └── server.js
│   ├── rag_service/             private Python service (embeddings, LLM, tools)
│   │   ├── agents.py            Mistral chains + search/scrape agents
│   │   ├── tools.py             Tavily search + BeautifulSoup scraper
│   │   ├── extraction.py        PDF/TXT/MD/DOCX → chunks
│   │   ├── rag_engine.py        query rewriting, web research, streaming
│   │   ├── vector_store.py      embeddings (+ the legacy Chroma store)
│   │   ├── pipeline.py          the original CLI, still runnable
│   │   ├── main.py              FastAPI service (loopback only)
│   │   └── settings.py
│   ├── .env                     secrets — git-ignored
│   ├── .env.example
│   └── package.json
│
├── README.md
└── .gitignore
```

---

## Running the project

**Prerequisites**

- Node.js 20+
- Python 3.10+ with `backend/rag_service/requirements.txt` installed
- A Neon PostgreSQL database, an Upstash Redis instance, a Mistral API key
- Optional: Google OAuth credentials, a Tavily key for web mode

### 1. Backend

```bash
cd backend
npm install
cp .env.example .env      # fill in DATABASE_URL, secrets, etc.
npm run migrate           # create the schema (safe to re-run)
npm run dev
```

Express starts on <http://localhost:3000> and launches the Python RAG service
itself. The **first boot takes 1–3 minutes** while torch and the embedding model
load; `GET /api/health` reports progress.

### 2. Frontend

```bash
cd frontend
npm install
npm run dev
```

Open <http://localhost:5173>.

### Migrations

```bash
npm run migrate           # apply pending migrations
npm run migrate:status     # show applied vs pending
```

Each file in `backend/migrations/` runs once, inside a transaction, and is
recorded in `schema_migrations` with a checksum. A fresh clone reaches the same
schema with one command. Add new migrations as new files; never edit an applied one.

### The original CLI still works

```bash
cd backend/rag_service
python pipeline.py
```

Web / PDF / Hybrid research and the critic scoring behave exactly as before,
against the legacy Chroma store in `chroma_persist/`.

---

## Database

**Neon PostgreSQL** is the source of truth for everything permanent, with
**pgvector** for embeddings.

| Table | Holds |
| --- | --- |
| `users` | name, email, `password_hash`, `google_id`, avatar |
| `sessions` | server-side sessions (so logout is a real revocation) |
| `documents` | per-user metadata, `storage_key`, status, chunk count |
| `document_chunks` | content, metadata, **`embedding vector(768)`**, `user_id` |
| `conversations` | per-user chats, mode, selected document |
| `messages` | role, content, metadata (finish reason, critic review) |
| `message_sources` | citations linked to a message, chunk and document |

Notes:

- **`vector(768)`** matches the embedding model exactly — verified by embedding a
  probe string against the running model, not assumed.
- `document_chunks` carries a denormalised `user_id` so the ownership filter is
  part of the vector query itself.
- Cosine distance (`<=>`) with an **HNSW** index; embeddings are L2-normalised,
  so similarity is `1 - distance`.
- Foreign keys cascade: deleting a user or document removes its chunks,
  conversations, messages and citations.

Original files are **not** stored in PostgreSQL. `storageService` writes them
through a driver interface (`local` by default, S3/R2 droppable in) and the
database keeps only the `storage_key`.

---

## Authentication

Two methods, one account model:

- **Email/password** — bcrypt (12 rounds), minimum 8 characters, confirm-password
  checked server-side. Login failures are deliberately indistinguishable between
  "no such user" and "wrong password", and both paths run a bcrypt comparison so
  timing does not leak account existence.
- **Google OAuth 2.0** — the full authorization-code exchange happens in Express.
  The browser only ever sees a redirect; the client secret never leaves the
  server. Scopes are limited to `openid email profile`.

**CSRF/state:** every `/api/auth/google` request mints a single-use `state` token
stored server-side (Redis, with an in-memory fallback). The callback consumes it;
a replayed or forged state is rejected and redirects to
`/login?error=INVALID_OAUTH_STATE`.

**Account linking:** if a Google sign-in matches an existing email, the accounts
are linked *only when Google reports the email as verified*, and the existing
password is left intact. An unverified Google email cannot claim an existing
account. Signing up with a password on a Google-only email returns a clear
"continue with Google" message rather than a duplicate user.

**Sessions:** an opaque id in an **HttpOnly** cookie, signed with an HMAC so a
tampered id is rejected before any database query. Postgres is the source of
truth (logout deletes the row); Redis caches the lookup. Cookies are `Secure` +
`SameSite=None` in production, `Lax` in development. No token is ever readable by
JavaScript or stored in `localStorage`.

---

## User-scoped RAG

This is enforced in SQL, not in React:

```sql
SELECT c.id, c.content, c.metadata, c.embedding <=> $1::vector AS distance
FROM document_chunks c
JOIN documents d ON d.id = c.document_id
WHERE c.user_id = $2          -- the session's user, never a client-supplied id
  AND d.status = 'ready'
ORDER BY c.embedding <=> $1::vector
LIMIT $3
```

- `user_id` always comes from the session cookie. A `userId` in a request body is
  ignored entirely.
- A `documentId` from the client is checked for ownership before it is used; an
  unowned id returns `404 Document not found` — the same response as a
  non-existent one, so ids cannot be probed.
- Every document route resolves ownership in the `WHERE` clause, so a valid id
  belonging to somebody else simply matches no rows.
- **Cache isolation:** anything derived from private documents is cached under a
  key containing the owner's id (`cache:retrieval:<userId>:<hash>`). Only query
  embeddings (model-deterministic) and web search results (not user-derived) use
  shared keys.

---

## RAG pipeline

```text
User query
    ↓
Query rewriting          (follow-ups become standalone queries)
    ↓
Embedding                (local all-mpnet-base-v2, 768-dim, cached in Redis)
    ↓
pgvector search          (cosine + HNSW, filtered to this user's chunks)
    ↓
Distance filtering       (drops weak matches, keeps top k=5)
    ↓
Context construction     (numbered [1]…[n] blocks, capped at 12k characters)
    ↓
LLM                      (Mistral, streaming)
    ↓
Streaming response       (+ optional critic pass)
```

Web and Hybrid modes add live Tavily search and a scrape of the top result.
Ingestion is unchanged: PyPDF per page → `RecursiveCharacterTextSplitter`
(1000 / 100) → embeddings → `document_chunks`.

Citations are built only from what retrieval actually returned — document name,
page number, similarity score, and for web results the real URL. Nothing is
invented.

---

## Document formats

Uploads go through one pipeline regardless of format:

```text
Document -> format-specific extraction -> [OCR if scanned] -> normalised text
        -> RecursiveCharacterTextSplitter (1000 / 100)
        -> local all-mpnet-base-v2 -> 768-dim vectors -> pgvector
```

The embedding model and dimension are unchanged.

| Format | Library | System dependency | Metadata kept |
| --- | --- | --- | --- |
| **PDF** (text) | `pypdf` | none | page number |
| **PDF** (scanned) | `pytesseract` + `pymupdf` | **Tesseract OCR** | page number |
| **DOCX** | `python-docx` | none | paragraph, heading/section, table |
| **PPTX** | `python-pptx` | none | slide number, slide title, notes |
| **TXT** | stdlib | none | line number |
| **MD** | stdlib | none | line number, heading/section |
| **DOC** (legacy) | LibreOffice → `python-docx` | **LibreOffice** | as DOCX |
| **PPT** (legacy) | LibreOffice → `python-pptx` | **LibreOffice** | as PPTX |

### Honest capability reporting

`GET /api/documents/formats` returns what the server *accepts* and what it can
*actually process* right now. If Tesseract or LibreOffice is missing, those
formats are reported unavailable and the Library shows a notice — a scanned PDF
fails with "install Tesseract", never with a silent empty document.

Capabilities are detected once at RAG-service startup, so restart the backend
after installing a system dependency.

### OCR behaviour

A PDF page is sent to OCR only when its embedded text is under 40 characters, so
normal text PDFs are never OCRed. In a **mixed** PDF only the image pages go
through OCR; the text pages are read directly. `extraction_info` records
`usedOcr` and `ocrPages`.

PDF rendering for OCR uses PyMuPDF rather than `pdf2image`, which removes the
usual poppler system dependency.

### Installing the system dependencies

**Windows**

```powershell
winget install UB-Mannheim.TesseractOCR
winget install TheDocumentFoundation.LibreOffice
```

**macOS**

```bash
brew install tesseract
brew install --cask libreoffice
```

**Debian / Ubuntu**

```bash
sudo apt-get install -y tesseract-ocr tesseract-ocr-eng \
    libreoffice-writer libreoffice-impress
```

**Docker** — `backend/Dockerfile` installs all of it:

```bash
docker build -t rag-backend ./backend
docker run --env-file backend/.env -p 3000:3000 rag-backend
```

Binaries are auto-detected from `PATH` and the usual install locations. To point
at them explicitly, set these in `backend/.env` — **unquoted on Windows**, because
dotenv processes escape sequences inside double-quoted values:

```env
LIBREOFFICE_PATH=C:\Program Files\LibreOffice\program\soffice.exe
TESSERACT_PATH=C:\Program Files\Tesseract-OCR\tesseract.exe
```

On Linux they are `/usr/bin/soffice` and `/usr/bin/tesseract`; the Docker image
sets both already, so nothing is needed there. `SOFFICE_CMD` and `TESSERACT_CMD`
still work as legacy aliases.

An explicit path that does not exist is not fatal: the service logs a warning and
falls back to automatic detection.

### Which formats actually use LibreOffice

Only the **legacy binary** formats. `.doc` and `.ppt` are converted to `.docx` /
`.pptx` first, then read by the same extractors as everything else. Modern
`.docx` / `.pptx` are read **directly** by python-docx / python-pptx — faster, and
it preserves the paragraph and slide metadata a LibreOffice round-trip would
lose. PDF, OCR, TXT and MD never touch LibreOffice.

Check what the server resolved:

```bash
curl http://localhost:3000/api/health          # ingestion.libreOffice / ingestion.ocr
curl http://localhost:3000/api/documents/formats   # per-format availability (needs a session)
```

After installing a dependency, restart the backend, or re-probe without a
restart via the private service:

```bash
curl "http://127.0.0.1:8000/capabilities?refresh=true"
```

### Python packages

```bash
cd backend/rag_service
pip install -r requirements.txt
```

### Upload validation

Extension, declared MIME type **and the file's magic bytes** must all agree, so a
shell script renamed `.pdf` is rejected before any parser opens it. Executables
are refused outright, and size is capped by `UPLOAD_MAX_BYTES` (25 MB default).
Office documents are parsed with pure-Python libraries that never execute macros;
the LibreOffice converter runs `--headless` with macros disabled.

### Processing status

Uploads return **202** and process in the background. The Library polls and shows
the live stage:

```text
uploading -> extracting -> [ocr] -> chunking -> embedding -> ready
                                                         \-> failed
```

A failed document keeps a specific reason: a corrupted DOCX says the file could
not be read, which is different from a document that genuinely contains no text.

### Tests

```bash
cd backend/rag_service
python tests/test_extraction.py     # builds fixtures, then tests every format
```

Covers PDF with selectable text, scanned PDF (OCR), mixed-content PDF, DOCX,
PPTX, TXT, MD, unsupported extension, corrupted DOCX/PDF, and empty documents.
Cases needing an absent system dependency are reported as SKIP with the reason.

---

## Streaming architecture

Real end-to-end streaming — no buffered response, no simulated typing:

```text
Mistral emits a chunk
   → LangChain .stream() yields it
   → FastAPI writes one NDJSON line       (worker thread → asyncio queue)
   → Express writes one SSE frame
   → the browser's fetch reader yields it
   → React appends it and paints on the next animation frame
```

Measured end to end: a typical answer arrives as 200–280 separate token events.

**Stop generating** propagates the whole way back. The browser aborts its
`fetch`; Express sees the socket close and aborts its upstream request; FastAPI's
generator is cancelled and sets a stop flag the worker checks between chunks.
Whatever was generated is saved and marked `aborted`.

Rendering is batched with `requestAnimationFrame`, so a fast stream cannot flood
React. Finished messages are memoised and the sidebar never re-renders while
tokens stream.

---

## Redis

Used for rate limiting, caching and short-lived state. **Postgres remains the
source of truth**; if Redis is unavailable the API keeps serving and only these
features degrade (set `REDIS_OPTIONAL=false` to hard-fail instead).

Two drivers are supported, chosen automatically:

- `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` — the HTTPS REST API.
  Preferred, and the only option where outbound port 6379 is blocked.
- `REDIS_URL` — a normal connection via ioredis. Upstash requires TLS, so a
  `redis://` URL is automatically upgraded to `rediss://`.

**Rate limits** (fixed window, keyed by user id when authenticated, otherwise by
client IP):

| Endpoint | Default limit |
| --- | --- |
| `POST /api/auth/login` | 5 / 15 min / IP |
| `POST /api/auth/signup` | 5 / hour / IP |
| `GET /api/auth/google` | 20 / 15 min / IP |
| `POST /api/chat` | 20 / min / user |
| `POST /api/documents` | 10 / hour / user |
| everything under `/api` | 300 / min (safety net) |

Exceeding a limit returns **429** with `Retry-After` and `X-RateLimit-*` headers.

---

## API endpoints

All routes except `/api/health` and `/api/auth/*` require a session.

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/api/auth/signup` | Create an account (name, email, password, confirmPassword) |
| `POST` | `/api/auth/login` | Sign in |
| `POST` | `/api/auth/logout` | Revoke the current session |
| `GET` | `/api/auth/me` | The signed-in user |
| `GET` | `/api/auth/config` | Whether Google sign-in is configured |
| `GET` | `/api/auth/google` | Start the Google OAuth flow |
| `GET` | `/api/auth/google/callback` | OAuth callback (redirects to the frontend) |
| `POST` | `/api/chat` | Send a message, receive an SSE stream |
| `GET` | `/api/conversations` | List the user's conversations |
| `POST` | `/api/conversations` | Create a conversation |
| `GET` | `/api/conversations/:id` | One conversation |
| `GET` | `/api/conversations/:id/messages` | Full message history with citations |
| `PATCH` | `/api/conversations/:id` | Rename / change mode or document |
| `DELETE` | `/api/conversations/:id` | Delete a conversation |
| `DELETE` | `/api/conversations/:id/messages` | Clear messages |
| `GET` | `/api/documents` | The user's library |
| `POST` | `/api/documents` | Upload + index a document (multipart `file`) |
| `DELETE` | `/api/documents/:id` | Delete a document, its chunks and its file |
| `GET` | `/api/user` | Profile and usage statistics |
| `PATCH` | `/api/user` | Update the display name |
| `POST` | `/api/user/logout-all` | Revoke every session |
| `GET` | `/api/health` | Express, PostgreSQL, Redis and RAG status |

### `POST /api/chat`

```jsonc
{
  "conversationId": "uuid | null",   // null starts a new conversation
  "message": "What is a GRU?",
  "mode": "document | web | hybrid",
  "documentId": "uuid | null",       // null searches the whole library
  "critique": false
}
```

Response is `text/event-stream`:

| Event | Payload |
| --- | --- |
| `meta` | conversation, persisted user message, assistant message id |
| `status` | pipeline stage (`rewriting`, `retrieving`, `searching`, `generating`) |
| `sources` | citations, sent before the first token |
| `token` | `{ "text": "…" }` — one chunk of the answer |
| `critique` | one chunk of the optional critic review |
| `done` | finish reason (`stop` / `aborted` / `error`) and the saved message |
| `error` | user-safe error message |

### `GET /api/health`

```json
{
  "status": "ok",
  "database": "connected",
  "redis": "connected",
  "rag": { "state": "ready", "model": "mistral-small-2506", "embeddingsLoaded": true },
  "auth": { "google": true }
}
```

`status` is `degraded` when Redis is down but the database is up, and
`unhealthy` (503) when the database is unreachable. No hostname, credential or
connection string is ever included.

---

## Security

- bcrypt password hashing; passwords never logged or returned
- HttpOnly, Secure (in production), SameSite cookies; HMAC-signed session ids
- Server-side session revocation on logout, plus "sign out everywhere"
- Single-use OAuth `state` tokens
- `requireAuth` on every chat, conversation, document and user route
- Ownership enforced in SQL on every read, write and delete
- Redis-backed rate limiting with stricter limits on auth endpoints
- Upload validation: extension, MIME type and size; files stored under a
  per-user, randomly named storage key so a filename cannot traverse or collide
- Parameterised SQL everywhere; no string-concatenated queries
- CORS restricted to the configured frontend origin, with credentials
- `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy` on every response
- Errors are normalised: stack traces, driver errors, file paths and API keys are
  logged server-side and never sent to the browser

`DATABASE_URL`, `REDIS_URL`, `GOOGLE_CLIENT_SECRET`, `MISTRAL_API_KEY`,
`TAVILY_API_KEY` and `SESSION_SECRET` exist only in `backend/.env`. The frontend
has exactly one variable, `VITE_API_URL`.

---

## Environment variables

See `backend/.env.example` for the full annotated list. The essentials:

```env
DATABASE_URL=
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_CALLBACK_URL=http://localhost:3000/api/auth/google/callback
FRONTEND_URL=http://localhost:5173
MISTRAL_API_KEY=
TAVILY_API_KEY=
SESSION_SECRET=
PYTHON_BIN=python
PORT=3000
```

Frontend (`frontend/.env`): `VITE_API_URL=http://localhost:3000/api` — nothing
sensitive, ever.

---

## Production deployment

```text
React (static)  →  HTTPS  →  Express  →  Neon PostgreSQL + pgvector
                                      →  Upstash Redis
                                      →  Object storage
                                      →  Mistral
```

- Set every secret through the host's environment variables; never commit `.env`.
- `NODE_ENV=production` switches cookies to `Secure` + `SameSite=None`.
- Set `FRONTEND_URL` and `GOOGLE_CALLBACK_URL` to the real HTTPS domains, and add
  both to the Google Cloud OAuth client (authorised origin + redirect URI).
- Run `npm run migrate` as a release step.
- Swap `STORAGE_DRIVER` to an object-storage driver.
- The Python RAG service needs a GPU-capable host for local embeddings, or set
  `USE_LOCAL_EMBEDDINGS=false` to use a hosted embedding endpoint — but note that
  changing the model changes the vector dimension, which needs a new migration
  and a re-index.

---

## Troubleshooting

**`Missing required environment variables: DATABASE_URL, SESSION_SECRET`**
Copy `.env.example` to `.env` and fill them in. Generate a secret with
`node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`.

**`redis unavailable` / health says `degraded`**
The app still works; rate limiting and caching are off. Upstash needs TLS: use
the REST variables, or a `rediss://` URL. A `WRONGPASS` reply means the token is
wrong — copy it again from the Upstash console.

**"RAG engine unavailable" in the sidebar**
`PYTHON_BIN` probably points at the wrong interpreter. Check the backend log for
`Python executable not found`, and confirm `python -c "import langchain_chroma"`
works with that interpreter.

**First question or first upload takes minutes**
The embedding model loads on first use. `GET /api/health` shows
`embeddingsLoaded` once it is warm.

**Google sign-in returns `?error=INVALID_OAUTH_STATE`**
The state token expired (10 minutes) or was already used. Start the flow again.
If it happens every time, check that `GOOGLE_CALLBACK_URL` exactly matches the
redirect URI registered in Google Cloud Console.

**Google sign-in button does not appear**
`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` are unset; `GET /api/auth/config`
reports `{"google": false}`.

**`Port 3000 is already in use`**
Stop the other instance, or set `PORT` (and update `VITE_API_URL`).

**Upload fails with "No readable text was found"**
The file is probably a scanned PDF with no text layer; it needs OCR first.

**`vector` extension errors during migration**
Your Postgres does not have pgvector. Neon ships it — check you are pointed at
the right database.

**Embedding dimension mismatch**
The model returned a different dimension than the `vector(N)` column. Keep
`EMBEDDING_DIMENSION`, the model, and migration 004 in agreement.
