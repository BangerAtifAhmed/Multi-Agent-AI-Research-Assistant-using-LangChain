/**
 * Daily chat quota tests.
 *
 *   npm test        (node --test)
 *
 * The rule these exist to protect: ten chats per user per calendar day, decided
 * by the backend, counted once per user request - never once per provider
 * attempt, and never at all for a request that was rejected before any work
 * started.
 *
 * The counter is injected rather than mocked, so these run with no Redis and no
 * network while exercising the real middleware.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';

import {
  DAILY_LIMIT_CODE,
  DAILY_LIMIT_MESSAGE,
  chatLimitKey,
  createDailyChatLimiter,
  dayWindow,
  peekChatQuota,
} from './chatDailyLimit.js';

/* ------------------------------------------------------------------ fakes -- */

/**
 * An in-memory stand-in for the Redis counter with the same semantics that
 * matter: INCR returns the value *after* incrementing, and a key with an
 * elapsed TTL is gone.
 */
class FakeCounter {
  constructor({ clock } = {}) {
    this.entries = new Map();
    this.clock = clock ?? { now: () => 0 };
    this.increments = 0;
    this.releases = 0;
    this.failing = false;
  }

  #live(key) {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= this.clock.now()) {
      this.entries.delete(key);
      return null;
    }
    return entry;
  }

  async increment(key, ttlSeconds) {
    this.increments += 1;
    if (this.failing) return null; // how withRedis reports an outage
    const entry = this.#live(key);
    if (entry) {
      entry.count += 1;
      return { count: entry.count, ttl: Math.ceil((entry.expiresAt - this.clock.now()) / 1000) };
    }
    // First increment of the day sets the expiry (EXPIRE ... NX).
    this.entries.set(key, { count: 1, expiresAt: this.clock.now() + ttlSeconds * 1000 });
    return { count: 1, ttl: ttlSeconds };
  }

  /** GET, for reporting the allowance without spending one. */
  async peek(key) {
    this.peeks += 1;
    if (this.failing) return null;
    return { count: this.#live(key)?.count ?? 0 };
  }

  async release(key) {
    this.releases += 1;
    if (this.failing) return null;
    const entry = this.#live(key);
    if (!entry) return 0;
    entry.count -= 1;
    if (entry.count <= 0) this.entries.delete(key);
    return entry.count;
  }

  countFor(key) {
    return this.#live(key)?.count ?? 0;
  }
}

class FakeResponse extends EventEmitter {
  constructor() {
    super();
    this.headers = {};
  }

  setHeader(name, value) {
    this.headers[name] = value;
  }

  /** What Node emits once a response has been sent or the socket dropped. */
  async end() {
    this.emit('close');
    await tick();
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const request = (userId) => ({ user: { id: userId } });

/**
 * Runs the middleware once and reports what happened.
 *
 * `process` models what the route does after the limiter: 'accept' is a turn
 * that starts (the controller's onAccepted fires), 'reject' is a request that
 * never starts processing, 'abandon' is a client that disappears first.
 */
async function send(limiter, userId, { process = 'accept' } = {}) {
  const req = request(userId);
  const res = new FakeResponse();

  let failure = null;
  await new Promise((resolve) => {
    limiter(req, res, (error) => {
      failure = error ?? null;
      resolve();
    });
  });

  if (!failure && process === 'accept') req.chatQuota?.commit();
  await res.end();

  return {
    allowed: !failure,
    status: failure?.status ?? 200,
    code: failure?.code,
    message: failure?.message,
    // What errorHandler serialises into the 429 body.
    meta: failure?.meta,
    headers: res.headers,
    quota: req.chatQuota,
  };
}

/** A limiter over a fresh counter, with a clock the test controls. */
function harness({ max = 10, timeZone = 'UTC', failOpen = true, startMs = Date.UTC(2026, 8, 5, 9) } = {}) {
  const clock = { current: startMs, now: () => clock.current };
  const counter = new FakeCounter({ clock });
  const limiter = createDailyChatLimiter({
    counter,
    max,
    timeZone,
    failOpen,
    now: () => new Date(clock.now()),
  });
  return { limiter, counter, clock };
}

/* ----------------------------------------------------------------- tests -- */

describe('the day window', () => {
  it('builds the documented key shape', () => {
    assert.equal(chatLimitKey('user-42', '2026-09-05'), 'chat_limit:user-42:2026-09-05');
  });

  it('expires the counter exactly at midnight', () => {
    const { ttlSeconds, date } = dayWindow(new Date(Date.UTC(2026, 8, 5, 23, 59, 0)), 'UTC');
    assert.equal(date, '2026-09-05');
    assert.equal(ttlSeconds, 60);
  });

  it('reports the reset as the start of the next calendar day', () => {
    const window = dayWindow(new Date(Date.UTC(2026, 8, 5, 9, 30, 0)), 'UTC');
    assert.equal(window.resetAt, '2026-09-06T00:00:00.000Z');
    assert.equal(window.secondsUntilReset, 52_200);
  });

  it('lands on the exact day boundary from a clock with milliseconds', () => {
    // A real clock is never on a whole second; resetAt must still be .000.
    const window = dayWindow(new Date(Date.UTC(2026, 8, 5, 9, 30, 0, 603)), 'UTC');
    assert.equal(window.resetAt, '2026-09-06T00:00:00.000Z');
  });

  it('reports the reset in the configured zone, not UTC', () => {
    // Local midnight in Asia/Kolkata is 18:30 UTC the previous day.
    const window = dayWindow(new Date(Date.UTC(2026, 8, 5, 9, 0, 0)), 'Asia/Kolkata');
    assert.equal(window.date, '2026-09-05');
    assert.equal(window.resetAt, '2026-09-05T18:30:00.000Z');
  });

  it('gives a full day to a counter created at midnight', () => {
    const { ttlSeconds } = dayWindow(new Date(Date.UTC(2026, 8, 5, 0, 0, 0)), 'UTC');
    assert.equal(ttlSeconds, 86_400);
  });

  it('never returns a TTL too short to outlive the request that set it', () => {
    const { ttlSeconds } = dayWindow(new Date(Date.UTC(2026, 8, 5, 23, 59, 59)), 'UTC');
    assert.ok(ttlSeconds >= 60, `got ${ttlSeconds}`);
  });

  it('follows the configured zone, not the server clock', () => {
    // 20:00 UTC is already the next day in Asia/Kolkata (+05:30).
    const instant = new Date(Date.UTC(2026, 8, 5, 20, 0, 0));
    assert.equal(dayWindow(instant, 'UTC').date, '2026-09-05');
    assert.equal(dayWindow(instant, 'Asia/Kolkata').date, '2026-09-06');
  });

  it('falls back to UTC for an invalid zone instead of throwing', () => {
    assert.equal(dayWindow(new Date(Date.UTC(2026, 8, 5, 9)), 'Not/AZone').date, '2026-09-05');
  });
});

describe('the 0 / 1 / 10 / 11 progression', () => {
  it('a user with 0 chats used is accepted', async () => {
    const { limiter, counter } = harness();
    assert.equal(counter.countFor('chat_limit:user-a:2026-09-05'), 0, 'starts at zero');

    const first = await send(limiter, 'user-a');

    assert.equal(first.allowed, true);
    assert.equal(first.quota.used, 1);
    assert.equal(first.quota.remaining, 9);
  });

  it('a user with 1 chat used is accepted and charged a second', async () => {
    const { limiter, counter } = harness();
    await send(limiter, 'user-a');
    assert.equal(counter.countFor('chat_limit:user-a:2026-09-05'), 1);

    const second = await send(limiter, 'user-a');

    assert.equal(second.allowed, true);
    assert.equal(second.quota.used, 2);
    assert.equal(second.quota.remaining, 8);
    assert.equal(counter.countFor('chat_limit:user-a:2026-09-05'), 2);
  });

  it('the 10th is accepted and the 11th is not', async () => {
    const { limiter } = harness();
    const results = [];
    for (let i = 0; i < 11; i += 1) results.push(await send(limiter, 'user-a'));

    assert.deepEqual(
      results.map((result) => result.status),
      [200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 429],
    );
  });
});

describe('a user with chats left', () => {
  it('accepts the first request of the day', async () => {
    const { limiter, counter } = harness();
    const result = await send(limiter, 'user-a');

    assert.equal(result.allowed, true);
    assert.equal(counter.countFor('chat_limit:user-a:2026-09-05'), 1);
  });

  it('reports the full allowance picture in the response headers', async () => {
    const { limiter } = harness();
    const result = await send(limiter, 'user-a');

    assert.equal(result.headers['X-Chat-Limit-Limit'], 10);
    assert.equal(result.headers['X-Chat-Limit-Used'], 1);
    assert.equal(result.headers['X-Chat-Limit-Remaining'], 9);
    assert.ok(result.headers['X-Chat-Limit-Reset'] > 0);
    assert.equal(result.headers['X-Chat-Limit-Reset-At'], '2026-09-06T00:00:00.000Z');
  });

  it('counts down to zero across ten chats', async () => {
    const { limiter } = harness();
    const remaining = [];
    for (let i = 0; i < 10; i += 1) {
      remaining.push((await send(limiter, 'user-a')).headers['X-Chat-Limit-Remaining']);
    }
    assert.deepEqual(remaining, [9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
  });
});

describe('the tenth and eleventh chats', () => {
  it('accepts the tenth', async () => {
    const { limiter } = harness();
    let last;
    for (let i = 0; i < 10; i += 1) last = await send(limiter, 'user-a');

    assert.equal(last.allowed, true, 'the 10th chat must be allowed');
    assert.equal(last.headers['X-Chat-Limit-Remaining'], 0);
  });

  it('rejects the eleventh with 429 and the documented message', async () => {
    const { limiter } = harness();
    for (let i = 0; i < 10; i += 1) await send(limiter, 'user-a');

    const eleventh = await send(limiter, 'user-a');

    assert.equal(eleventh.allowed, false);
    assert.equal(eleventh.status, 429);
    assert.equal(eleventh.message, DAILY_LIMIT_MESSAGE);
    assert.equal(eleventh.message, 'Daily chat limit reached. You can send more chats tomorrow.');
    assert.equal(eleventh.code, DAILY_LIMIT_CODE);
  });

  it('tells the client when to come back', async () => {
    const { limiter } = harness();
    for (let i = 0; i < 11; i += 1) await send(limiter, 'user-a');
    const blocked = await send(limiter, 'user-a');

    assert.ok(blocked.headers['Retry-After'] > 0);
    assert.equal(blocked.headers['X-Chat-Limit-Remaining'], 0);
  });

  it('returns the quota figures in the 429 body', async () => {
    const { limiter } = harness({ startMs: Date.UTC(2026, 8, 5, 9) });
    for (let i = 0; i < 10; i += 1) await send(limiter, 'user-a');

    const blocked = await send(limiter, 'user-a');

    assert.deepEqual(blocked.meta, {
      used: 10,
      limit: 10,
      remaining: 0,
      resetAt: '2026-09-06T00:00:00.000Z',
      retryAfterSeconds: 54_000, // 15:00 left of 2026-09-05
    });
  });

  it('reports 10 used, not the drifted counter, however many are refused', async () => {
    const { limiter, counter } = harness();
    for (let i = 0; i < 30; i += 1) await send(limiter, 'user-a');

    const blocked = await send(limiter, 'user-a');

    assert.ok(counter.countFor('chat_limit:user-a:2026-09-05') > 10, 'the counter drifts');
    assert.equal(blocked.meta.used, 10, 'a refused attempt is not a spent chat');
    assert.equal(blocked.headers['X-Chat-Limit-Used'], 10);
  });

  it('keeps rejecting every later request that day', async () => {
    const { limiter } = harness();
    for (let i = 0; i < 10; i += 1) await send(limiter, 'user-a');

    for (let i = 0; i < 5; i += 1) {
      assert.equal((await send(limiter, 'user-a')).status, 429);
    }
  });

  it('never hands a rejected request a quota it could commit', async () => {
    const { limiter } = harness();
    for (let i = 0; i < 10; i += 1) await send(limiter, 'user-a');

    assert.equal((await send(limiter, 'user-a')).quota, undefined);
  });
});

describe('users are counted independently', () => {
  it('does not let one user consume another user\'s allowance', async () => {
    const { limiter, counter } = harness();
    for (let i = 0; i < 10; i += 1) await send(limiter, 'user-a');

    const other = await send(limiter, 'user-b');

    assert.equal(other.allowed, true);
    assert.equal(other.headers['X-Chat-Limit-Remaining'], 9);
    assert.equal(counter.countFor('chat_limit:user-a:2026-09-05'), 10);
    assert.equal(counter.countFor('chat_limit:user-b:2026-09-05'), 1);
  });

  it('keys the counter by user id, never by address', async () => {
    const { limiter } = harness();
    const req = { user: { id: 'user-a' }, ip: '203.0.113.9' };
    const res = new FakeResponse();
    await new Promise((resolve) => limiter(req, res, resolve));

    assert.equal(req.chatQuota.key, 'chat_limit:user-a:2026-09-05');
    assert.ok(!req.chatQuota.key.includes('203.0.113.9'));
  });

  it('rejects an unauthenticated request rather than counting it globally', async () => {
    const { limiter, counter } = harness();
    const res = new FakeResponse();
    const failure = await new Promise((resolve) => limiter({}, res, resolve));

    assert.equal(failure.status, 401);
    assert.equal(counter.increments, 0);
  });
});

describe('the counter resets on the next calendar day', () => {
  it('gives a blocked user a fresh allowance after midnight', async () => {
    const { limiter, clock } = harness({ startMs: Date.UTC(2026, 8, 5, 23, 0) });
    for (let i = 0; i < 10; i += 1) await send(limiter, 'user-a');
    assert.equal((await send(limiter, 'user-a')).status, 429);

    clock.current = Date.UTC(2026, 8, 6, 0, 30); // 30 minutes into the next day

    const tomorrow = await send(limiter, 'user-a');
    assert.equal(tomorrow.allowed, true);
    assert.equal(tomorrow.headers['X-Chat-Limit-Remaining'], 9);
  });

  it('writes the new day to a different key and lets the old one expire', async () => {
    const { limiter, counter, clock } = harness({ startMs: Date.UTC(2026, 8, 5, 23, 0) });
    await send(limiter, 'user-a');
    assert.equal(counter.countFor('chat_limit:user-a:2026-09-05'), 1);

    clock.current = Date.UTC(2026, 8, 6, 0, 30);
    await send(limiter, 'user-a');

    assert.equal(counter.countFor('chat_limit:user-a:2026-09-06'), 1);
    assert.equal(counter.countFor('chat_limit:user-a:2026-09-05'), 0, 'yesterday must expire');
  });
});

describe('only requests that start processing are counted', () => {
  it('refunds a request rejected before the pipeline ran', async () => {
    const { limiter, counter } = harness();
    // e.g. an empty message, or a document the user does not own.
    await send(limiter, 'user-a', { process: 'reject' });

    assert.equal(counter.countFor('chat_limit:user-a:2026-09-05'), 0);
  });

  it('refunds a client that disconnects before generation begins', async () => {
    const { limiter, counter } = harness();
    await send(limiter, 'user-a', { process: 'abandon' });

    assert.equal(counter.countFor('chat_limit:user-a:2026-09-05'), 0);
  });

  it('does not let rejected requests eat into the ten', async () => {
    const { limiter } = harness();
    for (let i = 0; i < 25; i += 1) await send(limiter, 'user-a', { process: 'reject' });

    for (let i = 0; i < 10; i += 1) {
      assert.equal((await send(limiter, 'user-a')).allowed, true, `chat ${i + 1} must be allowed`);
    }
    assert.equal((await send(limiter, 'user-a')).status, 429);
  });

  it('keeps the charge once the pipeline has started', async () => {
    const { limiter, counter } = harness();
    await send(limiter, 'user-a', { process: 'accept' });

    assert.equal(counter.countFor('chat_limit:user-a:2026-09-05'), 1);
  });

  it('refunds at most once, however often the response closes', async () => {
    const { limiter, counter } = harness();
    const req = request('user-a');
    const res = new FakeResponse();
    await new Promise((resolve) => limiter(req, res, resolve));

    await res.end();
    await res.end();
    await res.end();

    assert.equal(counter.releases, 1);
    assert.equal(counter.countFor('chat_limit:user-a:2026-09-05'), 0);
  });

  it('cannot be refunded after the turn committed it', async () => {
    const { limiter, counter } = harness();
    const req = request('user-a');
    const res = new FakeResponse();
    await new Promise((resolve) => limiter(req, res, resolve));

    req.chatQuota.commit();
    assert.equal(await req.chatQuota.release(), false);
    await res.end();

    assert.equal(counter.releases, 0);
    assert.equal(counter.countFor('chat_limit:user-a:2026-09-05'), 1);
  });
});

describe('one user request is one chat, whatever the pipeline does', () => {
  /**
   * The turn is charged once at the start, so what happens afterwards - which
   * route ran, which provider answered, whether it failed - cannot change the
   * count. These drive that through the real commit contract.
   */
  const turn = async (limiter, userId, run) => {
    const req = request(userId);
    const res = new FakeResponse();
    await new Promise((resolve) => limiter(req, res, resolve));
    if (req.chatQuota) await run(req.chatQuota);
    await res.end();
    return req.chatQuota;
  };

  it('charges a Mistral failure that fell back to Hugging Face exactly once', async () => {
    const { limiter, counter } = harness();

    await turn(limiter, 'user-a', async (quota) => {
      quota.commit(); // the pipeline started
      // Inside the RAG service: Mistral returns 429, Llama 3.1 answers instead.
      // That is one turn, and it must not touch the counter a second time.
    });

    assert.equal(counter.countFor('chat_limit:user-a:2026-09-05'), 1);
    assert.equal(counter.increments, 1, 'the failover must not increment again');
  });

  it('leaves nine chats after a failover turn', async () => {
    const { limiter } = harness();
    let last;
    await turn(limiter, 'user-a', (quota) => quota.commit());
    last = await turn(limiter, 'user-a', (quota) => quota.commit());

    assert.equal(last.remaining, 8, 'two turns, two chats - not four');
  });

  it('charges a turn whose LLM failed once, not twice', async () => {
    const { limiter, counter } = harness();

    await turn(limiter, 'user-a', (quota) => {
      quota.commit();
      // Both providers failed; the controller reports an error frame. The chat
      // is spent because the work was done, but only once.
    });

    assert.equal(counter.countFor('chat_limit:user-a:2026-09-05'), 1);
    assert.equal(counter.increments, 1);
    assert.equal(counter.releases, 0);
  });

  it('applies the same allowance to every retrieval route', async () => {
    const { limiter, counter } = harness();
    // document RAG, web search, hybrid and a plain LLM answer are all one chat.
    for (const _route of ['document', 'web', 'hybrid', 'llm']) {
      await turn(limiter, 'user-a', (quota) => quota.commit());
    }

    assert.equal(counter.countFor('chat_limit:user-a:2026-09-05'), 4);
  });
});

describe('concurrent requests cannot bypass the limit', () => {
  it('admits exactly ten of twenty simultaneous requests', async () => {
    const { limiter } = harness();

    const results = await Promise.all(
      Array.from({ length: 20 }, () => send(limiter, 'user-a')),
    );

    const allowed = results.filter((result) => result.allowed).length;
    const rejected = results.filter((result) => result.status === 429).length;

    assert.equal(allowed, 10, `expected 10 accepted, got ${allowed}`);
    assert.equal(rejected, 10);
  });

  it('never lets the accepted count exceed the limit under a burst', async () => {
    const { limiter, counter } = harness();
    await Promise.all(Array.from({ length: 50 }, () => send(limiter, 'user-a')));

    const accepted = Math.min(counter.countFor('chat_limit:user-a:2026-09-05'), 10);
    assert.ok(accepted <= 10, `${accepted} chats were accepted`);
  });

  it('keeps concurrent users independent', async () => {
    const { limiter, counter } = harness();

    await Promise.all([
      ...Array.from({ length: 12 }, () => send(limiter, 'user-a')),
      ...Array.from({ length: 3 }, () => send(limiter, 'user-b')),
    ]);

    assert.equal(counter.countFor('chat_limit:user-b:2026-09-05'), 3);
    assert.equal((await send(limiter, 'user-b')).allowed, true);
  });
});

describe('when Redis is unavailable', () => {
  it('keeps chat working by default', async () => {
    const { limiter, counter } = harness();
    counter.failing = true;

    const result = await send(limiter, 'user-a');

    assert.equal(result.allowed, true);
    assert.equal(result.headers['X-Chat-Limit-Bypassed'], 'redis-unavailable');
  });

  it('refuses chats instead when configured to fail closed', async () => {
    const { limiter, counter } = harness({ failOpen: false });
    counter.failing = true;

    const result = await send(limiter, 'user-a');

    assert.equal(result.allowed, false);
    assert.equal(result.status, 503);
    assert.equal(result.code, 'CHAT_LIMIT_UNAVAILABLE');
  });
});

describe('the limit is configurable', () => {
  it('honours a different daily maximum', async () => {
    const { limiter } = harness({ max: 3 });
    for (let i = 0; i < 3; i += 1) {
      assert.equal((await send(limiter, 'user-a')).allowed, true);
    }
    assert.equal((await send(limiter, 'user-a')).status, 429);
  });
});

describe('reporting the allowance to the UI', () => {
  /** peekChatQuota over the same counter the limiter is spending. */
  const peek = ({ counter, clock, max = 10, timeZone = 'UTC' }, userId) =>
    peekChatQuota(userId, { counter, max, timeZone, now: () => new Date(clock.now()) });

  it('reports a full allowance before anything is sent', async () => {
    const context = harness();

    const quota = await peek(context, 'user-a');

    assert.equal(quota.used, 0);
    assert.equal(quota.limit, 10);
    assert.equal(quota.remaining, 10);
    assert.match(quota.resetAt, /^\d{4}-\d{2}-\d{2}T/);
  });

  it('never spends a chat just by being read', async () => {
    const context = harness();

    for (let i = 0; i < 5; i += 1) await peek(context, 'user-a');

    assert.equal(context.counter.increments, 0);
    assert.equal(context.counter.countFor(chatLimitKey('user-a', '2026-09-05')), 0);
    assert.equal((await peek(context, 'user-a')).remaining, 10);
  });

  it('agrees with the figures the last accepted turn reported', async () => {
    const context = harness();
    let last;
    for (let i = 0; i < 7; i += 1) last = await send(context.limiter, 'user-a');

    const quota = await peek(context, 'user-a');

    assert.equal(quota.used, 7);
    assert.equal(quota.remaining, 3);
    // The indicator must read the same whether it was just told over the stream
    // or is coming back from a reload.
    assert.equal(quota.used, last.quota.used);
    assert.equal(quota.limit, last.quota.limit);
    assert.equal(quota.remaining, last.quota.remaining);
    assert.equal(quota.resetAt, last.quota.resetAt);
  });

  it('reports nothing at all when the counter is unavailable', async () => {
    const context = harness();
    context.counter.failing = true;

    // Not zero, and not the limit: an invented number would disagree with what
    // the backend goes on to enforce.
    assert.equal(await peek(context, 'user-a'), null);
  });

  it('reports a spent allowance as 10/10 with none remaining', async () => {
    const context = harness();
    for (let i = 0; i < 10; i += 1) await send(context.limiter, 'user-a');

    const quota = await peek(context, 'user-a');

    assert.equal(quota.used, 10);
    assert.equal(quota.remaining, 0);
  });

  it('does not report the rejected attempts as chats', async () => {
    const context = harness();
    for (let i = 0; i < 13; i += 1) await send(context.limiter, 'user-a');

    const quota = await peek(context, 'user-a');

    // The counter drifted to 13; the user still only spent ten.
    assert.equal(quota.used, 10);
    assert.equal(quota.remaining, 0);
  });

  it('reports a full allowance again on the next day', async () => {
    const context = harness();
    for (let i = 0; i < 10; i += 1) await send(context.limiter, 'user-a');

    context.clock.current += 24 * 60 * 60 * 1000;

    assert.equal((await peek(context, 'user-a')).remaining, 10);
  });
});
