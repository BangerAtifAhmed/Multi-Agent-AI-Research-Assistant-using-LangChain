import { createHash } from 'node:crypto';

import config from '../config/index.js';
import { withRedis } from '../config/redis.js';

/**
 * Redis caching for expensive, repeatable work.
 *
 * Isolation rule: anything derived from a user's private documents is cached
 * under a key that contains that user's id. Only genuinely public results (web
 * search, which depends on nothing user-owned) use a shared key. This is what
 * keeps User A's retrieval results from ever being served to User B.
 */

const hash = (value) => createHash('sha256').update(value).digest('hex').slice(0, 32);

export const cacheKeys = {
  /** Query embeddings depend only on the text and the model - safe to share. */
  embedding: (text) => `cache:embed:${hash(text)}`,

  /** Private: scoped to the owner and the exact document set searched. */
  retrieval: (userId, query, documentIds, allowWeakMatches = true) =>
    `cache:retrieval:${userId}:${hash(
      `${query}::${(documentIds ?? []).join(',')}::weak=${allowWeakMatches ? 1 : 0}`,
    )}`,

  /** Public: web search results are not derived from any user's data. */
  webResearch: (query) => `cache:web:${hash(query.toLowerCase().trim())}`,

  /** Private: the user's own document list. */
  documents: (userId) => `cache:documents:${userId}`,
};

export async function getCached(key) {
  const raw = await withRedis((redis) => redis.get(key));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function setCached(key, value, ttlSeconds) {
  await withRedis((redis) => redis.set(key, JSON.stringify(value), ttlSeconds));
}

export async function invalidate(...keys) {
  if (!keys.length) return;
  await withRedis((redis) => redis.del(...keys));
}

/** Drops every cached artefact derived from a user's documents. */
export async function invalidateUserDocumentCaches(userId) {
  await withRedis(async (redis) => {
    await redis.del(cacheKeys.documents(userId));

    // Retrieval keys are per-query, so scan the user's namespace. SCAN (not
    // KEYS) keeps this safe on a shared Redis.
    const keys = await redis.scanKeys(`cache:retrieval:${userId}:*`);
    if (keys.length) await redis.del(...keys);
  });
}

export default {
  cacheKeys,
  getCached,
  setCached,
  invalidate,
  invalidateUserDocumentCaches,
};
