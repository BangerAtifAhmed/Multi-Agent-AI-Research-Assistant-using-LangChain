import config from './index.js';
import logger from '../utils/logger.js';

/**
 * Redis, behind a tiny driver-agnostic interface.
 *
 * Two drivers are supported:
 *   * `rest` - Upstash's HTTPS REST API (UPSTASH_REDIS_REST_URL + _TOKEN).
 *     Works anywhere outbound 443 works, which is why it is preferred.
 *   * `tcp`  - a normal Redis connection over ioredis (REDIS_URL). Upstash
 *     requires TLS, so a redis:// URL is upgraded to rediss://.
 *
 * One shared client for the process - never a connection per request.
 *
 * Redis is a performance and abuse-control layer, not the source of truth. With
 * REDIS_OPTIONAL on (the default) an outage degrades rate limiting and caching
 * instead of taking the API down.
 */

let client = null;
let ready = false;
let lastError = null;
let driverName = 'none';

const prefixed = (key) => `${config.redis.keyPrefix}:${key}`;

/* ------------------------------------------------------------------ REST -- */

function createRestDriver({ url, token }) {
  const endpoint = url.replace(/\/+$/, '');
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const send = async (command) => {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(command),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Upstash REST ${response.status}`);
    const body = await response.json();
    if (body.error) throw new Error(body.error);
    return body.result;
  };

  const pipeline = async (commands) => {
    const response = await fetch(`${endpoint}/pipeline`, {
      method: 'POST',
      headers,
      body: JSON.stringify(commands),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Upstash REST ${response.status}`);
    const body = await response.json();
    return body.map((entry) => {
      if (entry.error) throw new Error(entry.error);
      return entry.result;
    });
  };

  return {
    name: 'rest',
    ping: () => send(['PING']),
    get: (key) => send(['GET', prefixed(key)]),
    set: (key, value, ttlSeconds) =>
      send(ttlSeconds ? ['SET', prefixed(key), value, 'EX', ttlSeconds] : ['SET', prefixed(key), value]),
    del: (...keys) => (keys.length ? send(['DEL', ...keys.map(prefixed)]) : 0),
    /** INCR + conditional EXPIRE + TTL in a single round trip. */
    incrWithTtl: async (key, ttlSeconds) => {
      const [count, , ttl] = await pipeline([
        ['INCR', prefixed(key)],
        ['EXPIRE', prefixed(key), ttlSeconds, 'NX'],
        ['TTL', prefixed(key)],
      ]);
      return { count: Number(count), ttl: Number(ttl) };
    },
    /** Atomic decrement, for releasing a counter slot that was never used. */
    decr: async (key) => Number(await send(['DECR', prefixed(key)])),
    scanKeys: async (pattern) => {
      const found = [];
      let cursor = '0';
      do {
        const [next, batch] = await send([
          'SCAN',
          cursor,
          'MATCH',
          prefixed(pattern),
          'COUNT',
          '200',
        ]);
        cursor = String(next);
        // Strip the prefix so callers pass plain keys back into del().
        for (const key of batch ?? []) {
          found.push(String(key).replace(`${config.redis.keyPrefix}:`, ''));
        }
      } while (cursor !== '0');
      return found;
    },
    close: async () => {},
  };
}

/* ------------------------------------------------------------------- TCP -- */

async function createTcpDriver(rawUrl) {
  const { default: Redis } = await import('ioredis');

  let url = rawUrl;
  if (url.startsWith('redis://')) {
    try {
      if (/upstash\.io$/i.test(new URL(url).hostname)) {
        logger.warn('REDIS_URL uses redis://; upgrading to rediss:// (Upstash requires TLS)');
        url = url.replace(/^redis:\/\//, 'rediss://');
      }
    } catch {
      /* use as given */
    }
  }

  const redis = new Redis(url, {
    keyPrefix: `${config.redis.keyPrefix}:`,
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 10_000,
    retryStrategy: (attempt) => (attempt > 10 ? null : Math.min(attempt * 500, 5000)),
  });

  redis.on('error', (error) => {
    ready = false;
    if (lastError !== error.message) {
      lastError = error.message;
      logger.warn(`redis error: ${error.message}`);
    }
  });

  await redis.connect().catch(() => {});

  return {
    name: 'tcp',
    ping: () => redis.ping(),
    get: (key) => redis.get(key),
    set: (key, value, ttlSeconds) =>
      ttlSeconds ? redis.set(key, value, 'EX', ttlSeconds) : redis.set(key, value),
    del: (...keys) => (keys.length ? redis.del(...keys) : 0),
    incrWithTtl: async (key, ttlSeconds) => {
      const results = await redis.multi().incr(key).expire(key, ttlSeconds, 'NX').ttl(key).exec();
      const [count, , ttl] = results.map(([, value]) => value);
      return { count: Number(count), ttl: Number(ttl) };
    },
    decr: async (key) => Number(await redis.decr(key)),
    scanKeys: async (pattern) => {
      const found = [];
      let cursor = '0';
      do {
        const [next, batch] = await redis.scan(
          cursor,
          'MATCH',
          `${config.redis.keyPrefix}:${pattern}`,
          'COUNT',
          200,
        );
        cursor = next;
        for (const key of batch) found.push(key.replace(`${config.redis.keyPrefix}:`, ''));
      } while (cursor !== '0');
      return found;
    },
    close: async () => {
      try {
        await redis.quit();
      } catch {
        redis.disconnect();
      }
    },
  };
}

/* ---------------------------------------------------------------- shared -- */

let initPromise = null;

async function init() {
  if (config.redis.restUrl && config.redis.restToken) {
    client = createRestDriver({ url: config.redis.restUrl, token: config.redis.restToken });
    driverName = 'rest';
  } else if (config.redis.url) {
    client = await createTcpDriver(config.redis.url);
    driverName = 'tcp';
  } else {
    driverName = 'none';
    return null;
  }

  try {
    await client.ping();
    ready = true;
    lastError = null;
    logger.info(`redis connected (${driverName})`);
  } catch (error) {
    ready = false;
    lastError = error.message;
    logger.warn(`redis unavailable (${driverName}): ${error.message}`);
  }

  return client;
}

export function getRedis() {
  if (!initPromise) initPromise = init().catch(() => null);
  return client;
}

export const isRedisReady = () => ready;
export const redisDriver = () => driverName;

/**
 * Runs a Redis operation, returning `fallback` if Redis is unavailable.
 * Callers never have to wrap Redis in their own try/catch.
 */
export async function withRedis(handler, fallback = null) {
  if (!initPromise) initPromise = init().catch(() => null);
  await initPromise;

  if (!client || !ready) return fallback;
  try {
    return await handler(client);
  } catch (error) {
    ready = false;
    lastError = error.message;
    logger.debug(`redis operation failed: ${error.message}`);
    return fallback;
  }
}

export async function checkRedis() {
  if (!config.redis.restUrl && !config.redis.url) {
    return { connected: false, reason: 'Redis is not configured' };
  }

  if (!initPromise) initPromise = init().catch(() => null);
  await initPromise;

  if (!client) return { connected: false, reason: lastError || 'Redis is not configured' };

  const started = Date.now();
  try {
    await client.ping();
    ready = true;
    return { connected: true, latencyMs: Date.now() - started, driver: driverName };
  } catch (error) {
    ready = false;
    lastError = error.message;
    return { connected: false, reason: error.message };
  }
}

export async function closeRedis() {
  if (client) await client.close().catch(() => {});
  client = null;
  ready = false;
  initPromise = null;
}

export default { getRedis, withRedis, isRedisReady, checkRedis, closeRedis, redisDriver };
