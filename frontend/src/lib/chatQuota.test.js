/**
 * Daily chat allowance tests.
 *
 *   npm test        (node --test, no extra tooling)
 *
 * The rule these protect: the browser displays the server's figures and does
 * nothing else with them. There is no counter here to drift, so what is checked
 * is that a partial or missing payload renders as *nothing* rather than as a
 * plausible wrong number.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { describeQuota, describeReset, quotaFromError, readQuota } from './chatQuota.js';

/** Exactly what the backend sends: on /chat/limit, the stream, and a 429. */
const payload = (over = {}) => ({
  used: 7,
  limit: 10,
  remaining: 3,
  resetAt: '2026-09-06T00:00:00.000Z',
  ...over,
});

describe('readQuota', () => {
  it('takes the server figures as given', () => {
    assert.deepEqual(readQuota(payload()), {
      used: 7,
      limit: 10,
      remaining: 3,
      resetAt: '2026-09-06T00:00:00.000Z',
    });
  });

  it('reports nothing when the server reported nothing', () => {
    assert.equal(readQuota(null), null);
    assert.equal(readQuota(undefined), null);
    assert.equal(readQuota({}), null);
  });

  it('refuses a payload it cannot render honestly', () => {
    // "7/undefined" helps nobody, and a guessed limit would be a second
    // opinion on a number only the backend gets to hold.
    assert.equal(readQuota({ used: 7 }), null);
    assert.equal(readQuota({ limit: 10 }), null);
    assert.equal(readQuota({ used: 7, limit: 0 }), null);
    assert.equal(readQuota({ used: 'lots', limit: 10 }), null);
  });

  it('fills in only a missing remaining, from the server`s own used and limit', () => {
    assert.equal(readQuota({ used: 4, limit: 10 }).remaining, 6);
    assert.equal(readQuota({ used: 14, limit: 10 }).remaining, 0);
  });

  it('keeps the server value even when it disagrees with the arithmetic', () => {
    // The backend is the authority. If it says 3 remain, 3 remain.
    assert.equal(readQuota(payload({ used: 7, limit: 10, remaining: 1 })).remaining, 1);
  });
});

describe('describeQuota', () => {
  it('reads as a count out of the allowance', () => {
    assert.equal(describeQuota(readQuota(payload())), 'Chats today: 7/10');
  });

  it('says so plainly when the day is spent', () => {
    assert.equal(
      describeQuota(readQuota(payload({ used: 10, remaining: 0 }))),
      'No chats left today',
    );
  });

  it('renders nothing without a quota', () => {
    assert.equal(describeQuota(null), null);
  });
});

describe('describeReset', () => {
  it('says when the allowance returns', () => {
    const label = describeReset(readQuota(payload({ resetAt: '2026-09-06T00:00:00.000Z' })));
    assert.match(label, /^Resets (at|tomorrow at) /);
  });

  it('says nothing when the server did not say', () => {
    assert.equal(describeReset(readQuota({ used: 1, limit: 10 })), null);
    assert.equal(describeReset(readQuota(payload({ resetAt: 'not a date' }))), null);
  });
});

describe('the daily-limit refusal', () => {
  const refusal = () =>
    Object.assign(new Error('Daily chat limit reached. You can send more chats tomorrow.'), {
      status: 429,
      code: 'DAILY_CHAT_LIMIT_REACHED',
      meta: { used: 10, limit: 10, remaining: 0, resetAt: '2026-09-06T00:00:00.000Z' },
    });

  it('carries the allowance that caused it', () => {
    assert.deepEqual(quotaFromError(refusal()), {
      used: 10,
      limit: 10,
      remaining: 0,
      resetAt: '2026-09-06T00:00:00.000Z',
    });
  });

  it('yields nothing for an error with no quota attached', () => {
    assert.equal(quotaFromError(new Error('Cannot reach the server.')), null);
  });
});
