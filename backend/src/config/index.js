import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const currentDir = path.dirname(fileURLToPath(import.meta.url));

/** backend/ */
export const BACKEND_DIR = path.resolve(currentDir, '..', '..');
/** repository root (holds chroma_persist/, data/, the PDFs) */
export const PROJECT_ROOT = path.resolve(BACKEND_DIR, '..');

// Loaded before anything else reads process.env.
dotenv.config({ path: path.join(BACKEND_DIR, '.env'), quiet: true });

/** Values may be quoted in .env; dotenv keeps quotes when the value has spaces. */
const str = (value, fallback = '') => {
  if (value === undefined || value === null) return fallback;
  const trimmed = String(value).trim().replace(/^["']|["']$/g, '');
  return trimmed || fallback;
};

const bool = (value, fallback) => {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
};

const int = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const resolveFrom = (base, value, fallback) => {
  const raw = str(value) || fallback;
  return path.isAbsolute(raw) ? raw : path.resolve(base, raw);
};

const isProduction = str(process.env.NODE_ENV, 'development') === 'production';
const frontendUrl = str(process.env.FRONTEND_URL, 'http://localhost:5173');

const corsOrigins = str(process.env.CORS_ORIGIN, `${frontendUrl},http://127.0.0.1:5173`)
  .split(',')
  .map((origin) => origin.trim().replace(/\/+$/, ''))
  .filter(Boolean);

export const config = {
  env: str(process.env.NODE_ENV, 'development'),
  isProduction,
  port: int(process.env.PORT, 3000),
  frontendUrl: frontendUrl.replace(/\/+$/, ''),
  corsOrigins: [...new Set(corsOrigins.concat(frontendUrl.replace(/\/+$/, '')))],

  // --- PostgreSQL (Neon) ---------------------------------------------------
  database: {
    url: str(process.env.DATABASE_URL),
    poolMax: int(process.env.DATABASE_POOL_MAX, 10),
    idleTimeoutMs: int(process.env.DATABASE_IDLE_TIMEOUT, 30_000),
    connectionTimeoutMs: int(process.env.DATABASE_CONNECT_TIMEOUT, 15_000),
  },

  // --- Redis (Upstash) -----------------------------------------------------
  redis: {
    // Preferred: Upstash REST over HTTPS (works where outbound 6379 is blocked).
    restUrl: str(process.env.UPSTASH_REDIS_REST_URL).replace(/\/+$/, ''),
    restToken: str(process.env.UPSTASH_REDIS_REST_TOKEN),
    // Fallback: a normal Redis TCP connection.
    url: str(process.env.REDIS_URL),
    keyPrefix: str(process.env.REDIS_KEY_PREFIX, 'ragchat'),
    // The app must keep serving if Redis is down; only rate limiting and
    // caching degrade. Set to false to hard-fail instead.
    optional: bool(process.env.REDIS_OPTIONAL, true),
  },

  // --- Sessions / auth -----------------------------------------------------
  auth: {
    sessionSecret: str(process.env.SESSION_SECRET),
    cookieName: str(process.env.SESSION_COOKIE_NAME, 'rag_session'),
    sessionTtlDays: int(process.env.SESSION_TTL_DAYS, 30),
    bcryptRounds: int(process.env.BCRYPT_ROUNDS, 12),
    // Cross-site in dev (5173 -> 3000) needs SameSite=None+Secure in production.
    cookieSameSite: str(process.env.COOKIE_SAMESITE, isProduction ? 'none' : 'lax'),
    cookieSecure: bool(process.env.COOKIE_SECURE, isProduction),
    cookieDomain: str(process.env.COOKIE_DOMAIN) || undefined,
  },

  google: {
    clientId: str(process.env.GOOGLE_CLIENT_ID),
    clientSecret: str(process.env.GOOGLE_CLIENT_SECRET),
    callbackUrl: str(
      process.env.GOOGLE_CALLBACK_URL,
      `http://localhost:${int(process.env.PORT, 3000)}/api/auth/google/callback`,
    ),
    get enabled() {
      return Boolean(this.clientId && this.clientSecret);
    },
  },

  // --- Rate limits (requests / window) -------------------------------------
  rateLimits: {
    login: { points: int(process.env.RATE_LIMIT_LOGIN, 5), windowSeconds: 15 * 60 },
    signup: { points: int(process.env.RATE_LIMIT_SIGNUP, 5), windowSeconds: 60 * 60 },
    oauth: { points: int(process.env.RATE_LIMIT_OAUTH, 20), windowSeconds: 15 * 60 },
    chat: { points: int(process.env.RATE_LIMIT_CHAT, 20), windowSeconds: 60 },
    upload: { points: int(process.env.RATE_LIMIT_UPLOAD, 10), windowSeconds: 60 * 60 },
    api: { points: int(process.env.RATE_LIMIT_API, 300), windowSeconds: 60 },
  },

  // --- Daily chat quota ------------------------------------------------------
  // A per-user allowance rather than a burst limit: one counter per calendar
  // day, keyed by the authenticated user id, reset by key expiry at midnight.
  chatDailyLimit: {
    max: int(process.env.CHAT_DAILY_LIMIT, 10),
    // The zone that decides when "tomorrow" starts. UTC by default so the
    // boundary is the same everywhere the service runs; set an IANA zone
    // (e.g. Asia/Kolkata) to reset at local midnight instead.
    timeZone: str(process.env.CHAT_DAILY_LIMIT_TIMEZONE, 'UTC'),
    // Matches REDIS_OPTIONAL: a Redis outage must not take chat offline. Set
    // false to refuse chats instead of serving them uncounted.
    failOpen: bool(process.env.CHAT_DAILY_LIMIT_FAIL_OPEN, true),
  },

  cache: {
    retrievalTtlSeconds: int(process.env.CACHE_RETRIEVAL_TTL, 300),
    embeddingTtlSeconds: int(process.env.CACHE_EMBEDDING_TTL, 3600),
    webResearchTtlSeconds: int(process.env.CACHE_WEB_TTL, 900),
  },

  // --- RAG service (private Python process) --------------------------------
  rag: {
    url: str(process.env.RAG_SERVICE_URL, 'http://127.0.0.1:8000').replace(/\/+$/, ''),
    host: str(process.env.RAG_SERVICE_HOST, '127.0.0.1'),
    port: int(process.env.RAG_SERVICE_PORT, 8000),
    autostart: bool(process.env.RAG_SERVICE_AUTOSTART, true),
    pythonBin: str(process.env.PYTHON_BIN, 'python'),
    serviceDir: path.join(BACKEND_DIR, 'rag_service'),
    token: str(process.env.RAG_SERVICE_TOKEN),
    startupTimeoutMs: int(process.env.RAG_SERVICE_STARTUP_TIMEOUT, 180_000),
    // Longest gap allowed between frames on the generation stream. The RAG
    // service sends a heartbeat every few seconds while it is working - a
    // slow model or a fallback retry keeps arriving - so silence for this
    // long means the service is wedged, not busy.
    streamIdleTimeoutMs: int(process.env.RAG_STREAM_IDLE_TIMEOUT, 90_000),
  },

  // --- Retrieval -----------------------------------------------------------
  retrieval: {
    embeddingDimension: int(process.env.EMBEDDING_DIMENSION, 768),
    k: int(process.env.RETRIEVAL_K, 5),
    fetchK: int(process.env.RETRIEVAL_FETCH_K, 12),
    // Cosine distance in [0,2]; anything above this is treated as irrelevant.
    // Cosine distance, not the L2 distance the legacy Chroma CLI path uses.
    maxDistance: Number.parseFloat(str(process.env.RETRIEVAL_MAX_DISTANCE, '0.75')),
    embedBatchSize: int(process.env.EMBED_BATCH_SIZE, 64),
    // Chunks carried per streamed extraction frame. Peak ingestion memory is
    // one batch, so lower it on a very small instance.
    ingestBatchSize: int(process.env.INGEST_BATCH_SIZE, 64),
    // Minimum gap between live progress writes during ingestion. Low enough to
    // look real-time at a 1.5s poll, high enough not to hammer the database.
    progressIntervalMs: int(process.env.PROGRESS_INTERVAL_MS, 700),
  },

  history: {
    maxMessages: int(process.env.HISTORY_MESSAGE_LIMIT, 6),
    maxChars: int(process.env.HISTORY_CHAR_LIMIT, 6000),
    maxCharsPerMessage: 1200,
  },

  storage: {
    // 'local' (volume-backed) or 's3' (any S3-compatible object storage).
    // More than one replica requires 's3': a volume is per-host.
    driver: str(process.env.STORAGE_DRIVER, 'local'),
    dir: resolveFrom(PROJECT_ROOT, process.env.STORAGE_DIR, './data/uploads'),
    s3: {
      bucket: str(process.env.S3_BUCKET),
      region: str(process.env.S3_REGION, 'us-east-1'),
      // Set for R2 / MinIO / Spaces; leave empty for AWS S3.
      endpoint: str(process.env.S3_ENDPOINT),
      forcePathStyle: bool(process.env.S3_FORCE_PATH_STYLE, Boolean(str(process.env.S3_ENDPOINT))),
      // Prefer an instance role / IRSA over static keys in production.
      accessKeyId: str(process.env.S3_ACCESS_KEY_ID),
      secretAccessKey: str(process.env.S3_SECRET_ACCESS_KEY),
      serverSideEncryption: str(process.env.S3_SERVER_SIDE_ENCRYPTION),
    },
  },

  uploads: {
    maxSizeBytes: int(process.env.UPLOAD_MAX_BYTES, 25 * 1024 * 1024),
    allowedMimeTypes: str(
      process.env.UPLOAD_ALLOWED_MIME,
      'application/pdf,text/plain,text/markdown,text/x-markdown,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation',
    )
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
    allowedExtensions: ['.pdf', '.doc', '.docx', '.ppt', '.pptx', '.txt', '.md'],
  },

  limits: {
    maxMessageLength: int(process.env.MAX_MESSAGE_LENGTH, 8000),
    maxTitleLength: 60,
    // Hard ceiling on one chat turn, after which the SSE response is closed
    // with an error however stuck the pipeline is. Generous on purpose: it is
    // a backstop for a turn that will never finish, not a quality-of-service
    // timeout, and it has to outlast a rate-limited Mistral call retrying and
    // then failing over to Hugging Face.
    chatTurnTimeoutMs: int(process.env.CHAT_TURN_TIMEOUT, 600_000),
  },
};

/** Fails fast on missing configuration that the app cannot run without. */
export function assertRequiredConfig() {
  const missing = [];
  if (!config.database.url) missing.push('DATABASE_URL');
  if (!config.auth.sessionSecret) missing.push('SESSION_SECRET');

  if (missing.length) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}. ` +
        'Copy backend/.env.example to backend/.env and fill them in.',
    );
  }

  if (config.isProduction && config.auth.sessionSecret.length < 32) {
    throw new Error('SESSION_SECRET must be at least 32 characters in production.');
  }
}

export default config;
