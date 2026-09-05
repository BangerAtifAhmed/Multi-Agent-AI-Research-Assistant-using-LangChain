import config from '../config/index.js';
import { withRedis, isRedisReady } from '../config/redis.js';
import ApiError from '../utils/ApiError.js';
import logger from '../utils/logger.js';

/**
 * Per-user daily chat quota, enforced in the backend before any LLM/RAG work.
 *
 * One Redis counter per user per calendar day:
 *
 *     chat_limit:{userId}:{YYYY-MM-DD}      (INCR, EXPIRE at midnight)
 *
 * The user comes from the authenticated session, never from the client and
 * never from the IP address, so signing out or changing network does not reset
 * anything.
 *
 * Reserve, then release
 * ---------------------
 * The counter is incremented *before* the turn runs, because INCR is the atomic
 * operation that makes a burst of simultaneous requests safe: the 11th
 * concurrent request gets 11 back from Redis and is rejected, whatever order
 * the requests interleave in. Checking first and incrementing later would let
 * eleven requests all read 9 and all proceed.
 *
 * That reservation is released again if the turn never actually starts
 * processing - an empty message, a conversation or document the user does not
 * own, a client that disconnects before generation begins. The controller
 * commits the reservation (via `onAccepted`) at the moment the pipeline begins,
 * and anything that ends the response without committing refunds it. So:
 *
 *   * a rejected request costs nothing
 *   * a request that ran and then failed costs one chat - it consumed the work
 *   * a Mistral call that fails over to Hugging Face costs one chat, because
 *     the counter is incremented once per HTTP request and the failover happens
 *     entirely inside that single turn
 *
 * A request that is already over the limit is NOT refunded: the counter is
 * allowed to drift above `max` for the rest of the day, exactly as the
 * fixed-window limiter in rateLimit.js does, so no refund can ever race a
 * concurrent request back under the limit.
 */

/** Emitted when the day's allowance is gone. */
export const DAILY_LIMIT_MESSAGE = 'Daily chat limit reached. You can send more chats tomorrow.';
export const DAILY_LIMIT_CODE = 'DAILY_CHAT_LIMIT_REACHED';

const SECONDS_PER_DAY = 86_400;

/** `chat_limit:{userId}:{YYYY-MM-DD}` (redis.js adds the deployment prefix). */
export const chatLimitKey = (userId, date) => `chat_limit:${userId}:${date}`;

function validateTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone });
    return timeZone;
  } catch {
    logger.warn(`CHAT_DAILY_LIMIT_TIMEZONE "${timeZone}" is not a valid IANA zone; using UTC`);
    return 'UTC';
  }
}

/**
 * The calendar day `now` falls in, and when the next one starts.
 *
 * All of it comes from the same formatted instant, so the TTL always expires
 * the key exactly when its date stops being today - which is what makes the
 * reset automatic rather than something a job has to clean up. Computing it
 * through Intl rather than by arithmetic keeps it correct across DST changes.
 *
 * @returns {{ date: string, ttlSeconds: number, secondsUntilReset: number, resetAt: string }}
 */
export function dayWindow(now = new Date(), timeZone = 'UTC') {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: validateTimeZone(timeZone),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(now);

  const part = (type) => parts.find((entry) => entry.type === type)?.value ?? '0';

  const date = `${part('year')}-${part('month')}-${part('day')}`;
  // hour12:false reports midnight as "24" in some ICU builds.
  const secondsIntoDay =
    (Number(part('hour')) % 24) * 3600 + Number(part('minute')) * 60 + Number(part('second'));

  // The true boundary, used for `resetAt` so the client is told when the
  // allowance actually returns rather than when the key happens to expire.
  const secondsUntilReset = SECONDS_PER_DAY - secondsIntoDay;

  return {
    date,
    secondsUntilReset,
    // Intl counts in whole seconds, so `now`'s milliseconds are dropped rather
    // than carried into the boundary: the day starts at .000, not at .603.
    resetAt: new Date(
      now.getTime() - now.getMilliseconds() + secondsUntilReset * 1000,
    ).toISOString(),
    // Never below a minute: a key created in the last seconds of the day must
    // still outlive the request that created it.
    ttlSeconds: Math.max(secondsUntilReset, 60),
  };
}

/** The production counter. Returns null when Redis is unavailable. */
export const redisCounter = {
  async increment(key, ttlSeconds) {
    return withRedis(async (redis) => redis.incrWithTtl(key, ttlSeconds), null);
  },
  /** Reads the counter without spending a chat. `{count}`, or null if Redis is down. */
  async peek(key) {
    return withRedis(async (redis) => {
      const value = await redis.get(key);
      // A key that does not exist yet is a user who has not chatted today,
      // which is a count of zero - not an unavailable counter.
      return { count: Number(value) || 0 };
    }, null);
  },
  async release(key) {
    return withRedis(async (redis) => {
      const value = await redis.decr(key);
      // The day may have rolled over between reserving and releasing, in which
      // case DECR just recreated the key at -1 with no expiry. Dropping it at
      // or below zero keeps that from granting a free chat tomorrow.
      if (value <= 0) await redis.del(key);
      return value;
    }, null);
  },
};

/**
 * The user's allowance as the client is allowed to see it.
 *
 * The single place these four numbers are derived, so the headers, the 429
 * body, the SSE frame and the read-only endpoint can never disagree about how
 * many chats someone has left.
 *
 * @returns {{used: number, limit: number, remaining: number, resetAt: string,
 *            resetSeconds: number, date: string}}
 */
function describeQuota({ used, max, window, resetSeconds }) {
  return {
    // Clamped: the counter is allowed to drift past `max` on rejected
    // attempts, but a rejected attempt is not a chat the user spent.
    used: Math.min(used, max),
    limit: max,
    remaining: Math.max(max - used, 0),
    resetAt: window.resetAt,
    resetSeconds: resetSeconds ?? window.secondsUntilReset,
    date: window.date,
  };
}

/**
 * Today's allowance for one user, without spending a chat.
 *
 * Read-only on purpose: this is what the UI asks for when it loads, and asking
 * how many chats you have left must never be one of them. Returns null when
 * Redis is unavailable, so the caller can say nothing rather than invent a
 * number the enforcement side would not agree with.
 *
 * @returns {Promise<object|null>}
 */
export async function peekChatQuota(
  userId,
  {
    counter = redisCounter,
    max = config.chatDailyLimit.max,
    timeZone = config.chatDailyLimit.timeZone,
    now = () => new Date(),
  } = {},
) {
  if (!userId) throw ApiError.unauthorized();

  const window = dayWindow(now(), timeZone);
  const current = await counter.peek(chatLimitKey(userId, window.date));
  if (!current) return null;

  return describeQuota({ used: Number(current.count) || 0, max, window });
}

/**
 * @param {object} [options]
 * @param {object} [options.counter]  storage for the daily count (injectable for tests)
 * @param {number} [options.max]      chats allowed per user per day
 * @param {string} [options.timeZone] IANA zone that defines the calendar day
 * @param {boolean} [options.failOpen] allow chats through when Redis is down
 * @param {() => Date} [options.now]  clock, injectable for tests
 */
export function createDailyChatLimiter({
  counter = redisCounter,
  max = config.chatDailyLimit.max,
  timeZone = config.chatDailyLimit.timeZone,
  failOpen = config.chatDailyLimit.failOpen,
  now = () => new Date(),
} = {}) {
  return async function dailyChatLimitMiddleware(req, res, next) {
    try {
      // requireAuth runs first; this is a guard, not the auth check.
      const userId = req.user?.id;
      if (!userId) throw ApiError.unauthorized();

      const window = dayWindow(now(), timeZone);
      const { date, ttlSeconds } = window;
      const key = chatLimitKey(userId, date);

      const reserved = await counter.increment(key, ttlSeconds);

      if (!reserved) {
        if (!failOpen) {
          logger.error('daily chat limit cannot be enforced: Redis is unavailable');
          throw ApiError.serviceUnavailable(
            'Chat is temporarily unavailable. Please try again shortly.',
            'CHAT_LIMIT_UNAVAILABLE',
          );
        }
        if (!isRedisReady()) res.setHeader('X-Chat-Limit-Bypassed', 'redis-unavailable');
        logger.warn('daily chat limit bypassed: Redis is unavailable');
        return next();
      }

      const used = Number(reserved.count);
      // Redis owns the countdown, so its TTL is the authoritative answer to
      // "when does this counter disappear"; the computed window is the fallback
      // for a driver that cannot report one.
      const resetSeconds = reserved.ttl > 0 ? Number(reserved.ttl) : ttlSeconds;

      /** What the client is told about its allowance, in headers and on a 429. */
      const status = describeQuota({ used, max, window, resetSeconds });

      res.setHeader('X-Chat-Limit-Limit', status.limit);
      res.setHeader('X-Chat-Limit-Used', status.used);
      res.setHeader('X-Chat-Limit-Remaining', status.remaining);
      res.setHeader('X-Chat-Limit-Reset', status.resetSeconds);
      res.setHeader('X-Chat-Limit-Reset-At', status.resetAt);

      if (used > max) {
        res.setHeader('Retry-After', resetSeconds);
        logger.warn(`daily chat limit reached: user ${userId} used ${used}/${max} on ${date}`);
        // `used` is reported as the limit rather than the drifted counter: the
        // user spent 10 chats, and the extra rejected attempts are not chats.
        throw ApiError.tooManyRequests(DAILY_LIMIT_MESSAGE, DAILY_LIMIT_CODE).withMeta({
          used: max,
          limit: max,
          remaining: 0,
          resetAt: status.resetAt,
          retryAfterSeconds: resetSeconds,
        });
      }

      // The reservation, and the means to give it back. `commit()` is called by
      // the controller when the pipeline actually starts; anything that ends
      // the response without committing refunds the chat.
      let settled = false;
      const quota = {
        ...status,
        key,
        committed: false,
        /** This request has started processing: the chat is spent. */
        commit() {
          if (settled) return;
          settled = true;
          this.committed = true;
        },
        /** Give the reservation back unless it has been committed. */
        async release() {
          if (settled) return false;
          settled = true;
          try {
            await counter.release(key);
            logger.debug(`daily chat quota released for user ${userId} (${key})`);
            return true;
          } catch (error) {
            // Losing a refund costs the user one chat; failing the response
            // over it would cost them the answer as well.
            logger.warn(`could not release daily chat quota (${key}): ${error.message}`);
            return false;
          }
        },
      };

      req.chatQuota = quota;
      // The single refund path: whatever ends this response - a validation
      // error, a client that walked away, a thrown exception - gives the chat
      // back unless the turn committed it first.
      res.on('close', () => {
        quota.pendingRelease = quota.release();
      });

      next();
    } catch (error) {
      next(error);
    }
  };
}

/** The configured middleware used by the chat route. */
export const dailyChatLimit = (options) => createDailyChatLimiter(options);

export default dailyChatLimit;
