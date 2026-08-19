import app from './app.js';
import config, { assertRequiredConfig } from './config/index.js';
import { checkDatabase, closeDatabase } from './config/database.js';
import { checkRedis, closeRedis } from './config/redis.js';
import documentModel from './models/documentModel.js';
import sessionModel from './models/sessionModel.js';
import { ensureRagService, stopRagService } from './rag/ragProcess.js';
import logger from './utils/logger.js';

try {
  assertRequiredConfig();
} catch (error) {
  logger.error(error.message);
  process.exit(1);
}

const server = app.listen(config.port);

// SSE responses must not be cut off by the default socket timeout.
server.requestTimeout = 0;
server.headersTimeout = 65_000;

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    logger.error(
      `Port ${config.port} is already in use. Stop the other process, or set PORT in backend/.env.`,
    );
  } else {
    logger.error('server failed to start:', error);
  }
  // Exit before dependencies are started so no stray child process is left.
  process.exit(1);
});

server.on('listening', async () => {
  logger.info(`API listening on http://localhost:${config.port}`);
  logger.info(`CORS origins: ${config.corsOrigins.join(', ')}`);
  logger.info(`Google sign-in: ${config.google.enabled ? 'configured' : 'NOT configured'}`);

  // Dependency checks run in parallel and never block the port from binding.
  checkDatabase()
    .then((result) => logger.info(`PostgreSQL connected (${result.latencyMs}ms)`))
    .catch((error) => logger.error(`PostgreSQL unavailable: ${error.message}`));

  checkRedis().then((result) => {
    if (result.connected) logger.info(`Redis connected (${result.latencyMs}ms)`);
    else if (config.redis.optional) {
      logger.warn(`Redis unavailable (${result.reason}) - rate limiting and caching are disabled`);
    } else {
      logger.error(`Redis unavailable: ${result.reason}`);
      process.exit(1);
    }
  });

  // The embedding model takes a while to load; the API is useful before then.
  ensureRagService().catch((error) => {
    logger.error(`RAG service unavailable: ${error.message}`);
    logger.error('Chat and uploads will fail until it starts. Check PYTHON_BIN in backend/.env.');
  });

  // A crash or restart can leave a document mid-pipeline forever.
  documentModel
    .failStaleProcessing()
    .then((count) => count && logger.warn(`marked ${count} interrupted document(s) as failed`))
    .catch(() => {});

  sessionModel
    .purgeExpiredSessions()
    .then((count) => count && logger.info(`purged ${count} expired session(s)`))
    .catch(() => {});
});

// Hourly cleanup of expired sessions.
const cleanupTimer = setInterval(
  () => sessionModel.purgeExpiredSessions().catch(() => {}),
  60 * 60 * 1000,
);
cleanupTimer.unref();

let shuttingDown = false;

const shutdown = async (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} received - shutting down`);

  clearInterval(cleanupTimer);
  stopRagService();
  server.close();

  await Promise.allSettled([closeDatabase(), closeRedis()]);
  process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('unhandledRejection', (reason) => logger.error('unhandled rejection:', reason));
process.on('uncaughtException', (error) => {
  logger.error('uncaught exception:', error);
  shutdown('uncaughtException');
});

export default server;
