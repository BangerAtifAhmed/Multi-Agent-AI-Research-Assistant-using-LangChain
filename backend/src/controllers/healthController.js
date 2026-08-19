import { checkDatabase } from '../config/database.js';
import { checkRedis } from '../config/redis.js';
import config from '../config/index.js';
import { getRagStatus } from '../rag/ragProcess.js';
import ragClient from '../rag/ragClient.js';

/**
 * Health endpoints.
 *
 *   GET /api/health        informational, used by the UI
 *   GET /api/health/live   is the process up (liveness probe)
 *   GET /api/health/ready  can it actually serve traffic (readiness probe)
 *
 * None of them leak a hostname, credential or connection string.
 */

/** Liveness: the event loop is responsive. Deliberately does no I/O. */
export function live(req, res) {
  res.json({ status: 'ok', uptimeSeconds: Math.round(process.uptime()) });
}

/**
 * Readiness: PostgreSQL reachable AND the RAG service loaded.
 *
 * Redis is excluded on purpose - it is optional by design, and a Redis outage
 * degrades rate limiting and caching rather than making the app unable to serve.
 * Returns 503 when not ready, so a container whose RAG service died is restarted
 * instead of quietly accepting chat and upload requests it cannot fulfil.
 */
export async function ready(req, res) {
  const [database, rag] = await Promise.all([
    checkDatabase().then(
      () => ({ ok: true }),
      () => ({ ok: false }),
    ),
    Promise.resolve(getRagStatus()),
  ]);

  const ragReady = rag.state === 'ready';
  const isReady = database.ok && ragReady;

  res.status(isReady ? 200 : 503).json({
    status: isReady ? 'ready' : 'not-ready',
    database: database.ok ? 'connected' : 'disconnected',
    rag: rag.state,
  });
}

/** Informational status for the UI. */
export async function health(req, res) {
  const [database, redis] = await Promise.all([
    checkDatabase().then(
      (result) => ({ connected: true, latencyMs: result.latencyMs }),
      () => ({ connected: false }),
    ),
    checkRedis().then(
      (result) => result,
      () => ({ connected: false }),
    ),
  ]);

  const ragStatus = getRagStatus();
  let ragDetails = null;
  if (ragStatus.state === 'ready') {
    ragDetails = await ragClient.health().catch(() => null);
  }

  // Redis being down degrades rate limiting and caching but not the product,
  // so it only makes the service "degraded" rather than unhealthy.
  const healthy = database.connected;
  const degraded = healthy && (!redis.connected || ragStatus.state !== 'ready');

  res.status(healthy ? 200 : 503).json({
    status: healthy ? (degraded ? 'degraded' : 'ok') : 'unhealthy',
    database: database.connected ? 'connected' : 'disconnected',
    redis: redis.connected ? 'connected' : 'disconnected',
    rag: {
      state: ragStatus.state,
      model: ragDetails?.model ?? null,
      embeddingsLoaded: ragDetails?.embeddingsLoaded ?? false,
      webSearch: ragDetails?.webSearch ?? null,
    },
    // Provider, model and dimension only - the API key is never included.
    embedding: ragDetails?.embedding ?? null,
    // Document ingestion dependencies. Booleans only: the resolved binary
    // paths stay on the server and are never sent to the browser.
    ingestion: {
      ocr: ragDetails?.ocr ?? null,
      libreOffice: ragDetails?.libreOffice ?? null,
      supportedExtensions: ragDetails?.supportedExtensions ?? null,
    },
    auth: { google: config.google.enabled },
    uptimeSeconds: Math.round(process.uptime()),
  });
}

export default { health, live, ready };
