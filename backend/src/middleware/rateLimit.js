import config from '../config/index.js';
import { withRedis, isRedisReady } from '../config/redis.js';
import ApiError from '../utils/ApiError.js';
import logger from '../utils/logger.js';

/**
 * Redis-backed fixed-window rate limiting.
 *
 * INCR + EXPIRE in one round trip; the first request in a window sets the TTL.
 * Authenticated limits are keyed by user id, anonymous ones by client IP, so one
 * abusive client cannot exhaust everyone else's budget.
 *
 * If Redis is unavailable the request is allowed through (see REDIS_OPTIONAL):
 * an outage in the abuse-control layer should not take the product offline.
 */

const clientIp = (req) => {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded) return forwarded.split(',')[0].trim();
  return req.ip || req.socket?.remoteAddress || 'unknown';
};

async function consume(key, points, windowSeconds) {
  return withRedis(async (redis) => {
    const { count, ttl } = await redis.incrWithTtl(key, windowSeconds);

    return {
      allowed: count <= points,
      used: count,
      remaining: Math.max(points - count, 0),
      resetSeconds: ttl > 0 ? ttl : windowSeconds,
    };
  }, null);
}

/**
 * @param {object} options
 * @param {string} options.name        bucket name, e.g. 'login'
 * @param {'ip'|'user'|'user-or-ip'} options.by
 */
export function rateLimit({ name, by = 'user-or-ip', points, windowSeconds } = {}) {
  const limits = config.rateLimits[name] ?? {};
  const maxPoints = points ?? limits.points ?? 60;
  const window = windowSeconds ?? limits.windowSeconds ?? 60;

  return async function rateLimitMiddleware(req, res, next) {
    try {
      let scope;
      if (by === 'ip') scope = `ip:${clientIp(req)}`;
      else if (by === 'user') scope = req.user ? `user:${req.user.id}` : `ip:${clientIp(req)}`;
      else scope = req.user ? `user:${req.user.id}` : `ip:${clientIp(req)}`;

      const result = await consume(`ratelimit:${name}:${scope}`, maxPoints, window);

      if (!result) {
        // Redis unavailable - fail open, but make it visible.
        if (!isRedisReady()) res.setHeader('X-RateLimit-Bypassed', 'redis-unavailable');
        return next();
      }

      res.setHeader('X-RateLimit-Limit', maxPoints);
      res.setHeader('X-RateLimit-Remaining', result.remaining);
      res.setHeader('X-RateLimit-Reset', result.resetSeconds);

      if (!result.allowed) {
        res.setHeader('Retry-After', result.resetSeconds);
        logger.warn(`rate limit hit: ${name} ${scope}`);
        throw ApiError.tooManyRequests(
          `Too many requests. Try again in ${result.resetSeconds} second${
            result.resetSeconds === 1 ? '' : 's'
          }.`,
          'RATE_LIMITED',
        );
      }

      next();
    } catch (error) {
      next(error);
    }
  };
}

export default rateLimit;
