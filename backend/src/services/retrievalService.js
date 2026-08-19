import config from '../config/index.js';
import chunkModel from '../models/chunkModel.js';
import ragClient from '../rag/ragClient.js';
import cacheService, { cacheKeys } from './cacheService.js';

/**
 * Retrieval: embed the query, then search pgvector *within the caller's own
 * documents*.
 *
 * `userId` is required and is passed straight into the SQL WHERE clause. There
 * is no code path here that can search across users.
 */

/** Query embeddings are model-deterministic, so caching them is safe to share. */
async function embedQueryCached(text) {
  const key = cacheKeys.embedding(text);
  const cached = await cacheService.getCached(key);
  if (cached?.embedding?.length === config.retrieval.embeddingDimension) {
    return { ...cached, cached: true };
  }

  const result = await ragClient.embedQuery(text);
  await cacheService.setCached(key, result, config.cache.embeddingTtlSeconds);
  return { ...result, cached: false };
}

export async function retrieveForUser({
  userId,
  query,
  documentIds = null,
  k,
  allowWeakMatches = true,
}) {
  if (!userId) throw new Error('retrieveForUser requires a userId');

  const scope = Array.isArray(documentIds) && documentIds.length ? [...documentIds].sort() : null;

  // Cache key contains the user id: one user's retrieval results can never be
  // served to another.
  // The flag changes the result set, so it has to be part of the cache key.
  const key = cacheKeys.retrieval(userId, query, scope, allowWeakMatches);
  const cached = await cacheService.getCached(key);
  if (cached) return { sources: cached, cached: true };

  const { embedding, model } = await embedQueryCached(query);

  const sources = await chunkModel.searchChunks({
    userId,
    embedding,
    // Only chunks written by the SAME model are comparable to this query.
    embeddingModel: model,
    documentIds: scope,
    limit: k ?? config.retrieval.k,
    fetchLimit: config.retrieval.fetchK,
    allowWeakMatches,
  });

  await cacheService.setCached(key, sources, config.cache.retrievalTtlSeconds);
  return { sources, cached: false };
}

/** Live web research (no user data involved, so the cache key is public). */
export async function researchWeb(query) {
  const key = cacheKeys.webResearch(query);
  const cached = await cacheService.getCached(key);
  if (cached) return { ...cached, cached: true };

  const result = await ragClient.webResearch(query);
  if (result.sources?.length) {
    await cacheService.setCached(key, result, config.cache.webResearchTtlSeconds);
  }
  return { ...result, cached: false };
}

/** Numbered context blocks, so the model's [1]/[2] citations line up. */
export function buildContext(sources, startIndex = 1) {
  const blocks = [];
  let total = 0;

  for (const [offset, source] of sources.entries()) {
    const index = startIndex + offset;
    let header;
    let body;

    if (source.type === 'web') {
      header = `[${index}] ${source.title} - ${source.url}`;
      body = source.snippet ?? '';
    } else {
      const page = source.page ? `, page ${source.page}` : '';
      header = `[${index}] ${source.documentName ?? source.title}${page}`;
      body = source.content ?? source.snippet ?? '';
    }

    const block = `${header}\n${body}`;
    if (total + block.length > 12_000) break;
    blocks.push(block);
    total += block.length;
  }

  return blocks.join('\n\n');
}

export default { retrieveForUser, researchWeb, buildContext };
