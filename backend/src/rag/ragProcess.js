import { spawn } from 'node:child_process';

import config from '../config/index.js';
import logger from '../utils/logger.js';

/**
 * Supervises the private Python RAG service.
 *
 * The retrieval stack (local CUDA sentence-transformers embeddings + the
 * existing Chroma collections) is Python, so Express runs it as a child
 * process on loopback and is the only client that ever talks to it.
 * Set RAG_SERVICE_AUTOSTART=false to manage the process yourself.
 */

let child = null;
let readyPromise = null;
let state = 'stopped'; // stopped | starting | ready | failed
let lastError = null;

const headers = () =>
  config.rag.token ? { 'X-Service-Token': config.rag.token } : {};

async function probeHealth(timeoutMs = 2000) {
  try {
    const response = await fetch(`${config.rag.url}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: headers(),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

function pipeOutput(stream, level) {
  stream.setEncoding('utf8');
  let buffer = '';
  stream.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const text = line.trimEnd();
      // Progress bars from the model loader would spam the log.
      if (!text || text.includes('it/s]')) continue;
      logger[level](`[rag] ${text}`);
    }
  });
}

function spawnService() {
  const args = [
    '-u',
    '-m',
    'uvicorn',
    'main:app',
    '--host',
    config.rag.host,
    '--port',
    String(config.rag.port),
    '--log-level',
    'warning',
  ];

  logger.info(`starting RAG service: ${config.rag.pythonBin} ${args.join(' ')}`);

  child = spawn(config.rag.pythonBin, args, {
    cwd: config.rag.serviceDir,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
    windowsHide: true,
  });

  pipeOutput(child.stdout, 'info');
  pipeOutput(child.stderr, 'info');

  child.on('error', (error) => {
    lastError =
      error.code === 'ENOENT'
        ? `Python executable not found: "${config.rag.pythonBin}". Set PYTHON_BIN in backend/.env.`
        : error.message;
    state = 'failed';
    logger.error(`RAG service failed to start: ${lastError}`);
  });

  child.on('exit', (code, signal) => {
    child = null;
    if (state !== 'stopped') {
      state = 'failed';
      lastError = `RAG service exited (code ${code ?? 'null'}, signal ${signal ?? 'none'})`;
      logger.error(lastError);
    }
    readyPromise = null;
  });
}

async function waitForHealth() {
  const deadline = Date.now() + config.rag.startupTimeoutMs;

  while (Date.now() < deadline) {
    if (state === 'failed') throw new Error(lastError || 'RAG service failed to start');

    const health = await probeHealth();
    if (health) {
      state = 'ready';
      logger.info(
        `RAG service ready (model: ${health.model}, embeddings: ${health.embeddingModel})`,
      );
      // Preload the embedding model so the first question is not slow.
      fetch(`${config.rag.url}/warmup`, { method: 'POST', headers: headers() }).catch(
        () => {},
      );
      return health;
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  state = 'failed';
  lastError = 'RAG service did not become healthy in time';
  throw new Error(lastError);
}

/** Starts the service if needed and resolves once /health responds. */
export function ensureRagService() {
  if (readyPromise) return readyPromise;

  readyPromise = (async () => {
    const existing = await probeHealth();
    if (existing) {
      state = 'ready';
      logger.info('RAG service already running - reusing it');
      return existing;
    }

    if (!config.rag.autostart) {
      state = 'failed';
      lastError = `RAG service is not running at ${config.rag.url} and autostart is disabled.`;
      throw new Error(lastError);
    }

    state = 'starting';
    lastError = null;
    spawnService();
    return waitForHealth();
  })();

  readyPromise.catch(() => {
    // Swallow here; callers handle rejection. Allow a later retry.
    setTimeout(() => {
      if (state === 'failed') readyPromise = null;
    }, 5000);
  });

  return readyPromise;
}

export function getRagStatus() {
  return { state, error: state === 'failed' ? lastError : null, url: config.rag.url };
}

export function stopRagService() {
  state = 'stopped';
  readyPromise = null;
  if (child && !child.killed) {
    logger.info('stopping RAG service');
    child.kill();
  }
  child = null;
}

export default { ensureRagService, getRagStatus, stopRagService };
