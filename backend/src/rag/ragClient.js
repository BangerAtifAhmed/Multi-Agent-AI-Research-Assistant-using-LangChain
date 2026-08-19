import config from '../config/index.js';
import ApiError from '../utils/ApiError.js';
import logger from '../utils/logger.js';
import { ensureRagService } from './ragProcess.js';

/**
 * HTTP client for the private RAG service (embeddings, extraction, web research
 * and LLM streaming). The browser never reaches this service.
 */

const serviceHeaders = () => ({
  'Content-Type': 'application/json',
  ...(config.rag.token ? { 'X-Service-Token': config.rag.token } : {}),
});

const unavailable = (error) => {
  logger.error('RAG service unavailable:', error.message || error);
  return ApiError.serviceUnavailable(
    'The retrieval service is unavailable. Please try again in a moment.',
    'RAG_UNAVAILABLE',
  );
};

async function requestJson(path, { method = 'POST', body, timeoutMs = 120_000 } = {}) {
  await ensureRagService();

  let response;
  try {
    response = await fetch(`${config.rag.url}${path}`, {
      method,
      headers: serviceHeaders(),
      body: method === 'GET' || !body ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw unavailable(error);
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    logger.error(`RAG service ${path} -> ${response.status}: ${detail.slice(0, 400)}`);

    if (response.status === 404) throw ApiError.notFound('The file could not be read.');
    if (response.status === 415) {
      throw ApiError.unsupportedMediaType('That file type is not supported.');
    }
    throw ApiError.internal('The document pipeline failed.', 'RAG_ERROR');
  }

  return response.json();
}

/** Embeds one query string. Returns {embedding, model}. */
export async function embedQuery(text) {
  const { embeddings, dimension, model } = await requestJson('/embed', {
    body: { texts: [text], kind: 'query' },
  });

  if (dimension !== config.retrieval.embeddingDimension) {
    throw ApiError.internal(
      `Embedding dimension mismatch: model returned ${dimension}, database expects ${config.retrieval.embeddingDimension}.`,
      'EMBEDDING_DIMENSION_MISMATCH',
    );
  }

  return { embedding: embeddings[0], model };
}

/** Embeds many passages, in batches. Returns {embeddings, model}. */
export async function embedPassages(texts) {
  const batchSize = config.retrieval.embedBatchSize;
  const vectors = [];
  let model = null;

  for (let start = 0; start < texts.length; start += batchSize) {
    const batch = texts.slice(start, start + batchSize);
    const batchResult = await requestJson('/embed', {
      body: { texts: batch, kind: 'passage' },
      timeoutMs: 300_000,
    });
    const { embeddings, dimension } = batchResult;

    // Every batch must come from the same model, or the document would end up
    // with chunks in two different embedding spaces.
    if (model && batchResult.model !== model) {
      throw ApiError.internal(
        'The embedding model changed while indexing this document.',
        'EMBEDDING_MODEL_CHANGED',
      );
    }
    model = batchResult.model;

    if (dimension !== config.retrieval.embeddingDimension) {
      throw ApiError.internal(
        `Embedding dimension mismatch: model returned ${dimension}, database expects ${config.retrieval.embeddingDimension}.`,
        'EMBEDDING_DIMENSION_MISMATCH',
      );
    }
    vectors.push(...embeddings);
  }

  return { embeddings: vectors, model };
}

/**
 * Streams extraction events: {type:'status'|'result'|'error'}.
 *
 * Status events arrive while the work happens (including per-page OCR
 * progress), so the caller can persist a live processing stage.
 */
export async function* extractChunksStream(filePath, name, batchSize) {
  await ensureRagService();

  let response;
  try {
    response = await fetch(`${config.rag.url}/documents/extract`, {
      method: 'POST',
      headers: serviceHeaders(),
      body: JSON.stringify({ path: filePath, name, batchSize }),
      // OCR on a long scanned PDF is slow; give it room.
      signal: AbortSignal.timeout(1_800_000),
    });
  } catch (error) {
    throw unavailable(error);
  }

  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => '');
    logger.error(`extraction failed (${response.status}): ${detail.slice(0, 400)}`);
    throw ApiError.internal('The document pipeline failed.', 'RAG_ERROR');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let newlineIndex;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (!line) continue;
        try {
          yield JSON.parse(line);
        } catch {
          logger.warn(`skipping malformed extraction event: ${line.slice(0, 160)}`);
        }
      }
    }

    const tail = buffer.trim();
    if (tail) {
      try {
        yield JSON.parse(tail);
      } catch {
        /* truncated trailing frame */
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

/** Which formats this deployment can actually process. */
export async function ragCapabilities() {
  try {
    return await requestJson('/capabilities', { method: 'GET', timeoutMs: 10_000 });
  } catch {
    return null;
  }
}

/** Cheap one-word classification for the automatic query router. */
export async function classifyRoute(prompt) {
  const { answer } = await requestJson('/classify', {
    body: { prompt, maxTokens: 5 },
    timeoutMs: 15_000,
  });
  return answer;
}

export async function condenseQuestion(question, history) {
  try {
    const { query } = await requestJson('/condense', {
      body: { question, history },
      timeoutMs: 30_000,
    });
    return query || question;
  } catch {
    // Query rewriting is an optimisation; never fail the turn over it.
    return question;
  }
}

export async function webResearch(query, maxResults = 5) {
  try {
    return await requestJson('/web/research', { body: { query, maxResults }, timeoutMs: 60_000 });
  } catch (error) {
    logger.warn(`web research failed: ${error.message}`);
    return { sources: [], scraped: null, available: false };
  }
}

export async function health() {
  await ensureRagService();
  const response = await fetch(`${config.rag.url}/health`, { signal: AbortSignal.timeout(3000) });
  return response.json();
}

/**
 * Streams generated tokens. `signal` aborts the upstream request, which makes
 * the Python side cancel generation instead of finishing the answer unseen.
 */
export async function* streamGeneration(payload, signal) {
  await ensureRagService();

  let response;
  try {
    response = await fetch(`${config.rag.url}/generate/stream`, {
      method: 'POST',
      headers: serviceHeaders(),
      body: JSON.stringify(payload),
      signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') return;
    throw unavailable(error);
  }

  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => '');
    logger.error(`RAG stream failed (${response.status}): ${detail.slice(0, 400)}`);
    throw ApiError.internal('The assistant could not start generating.', 'RAG_STREAM_FAILED');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let newlineIndex;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (!line) continue;
        try {
          yield JSON.parse(line);
        } catch {
          logger.warn(`skipping malformed RAG event: ${line.slice(0, 200)}`);
        }
      }
    }

    const tail = buffer.trim();
    if (tail) {
      try {
        yield JSON.parse(tail);
      } catch {
        /* ignore a truncated trailing frame */
      }
    }
  } catch (error) {
    if (error?.name === 'AbortError') return;
    throw error;
  } finally {
    reader.cancel().catch(() => {});
  }
}

export default {
  embedQuery,
  embedPassages,
  extractChunksStream,
  ragCapabilities,
  classifyRoute,
  condenseQuestion,
  webResearch,
  streamGeneration,
  health,
};
