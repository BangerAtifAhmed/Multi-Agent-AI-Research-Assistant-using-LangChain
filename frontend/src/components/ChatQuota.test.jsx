/**
 * Render-level checks for the daily-allowance indicator.
 *
 * Run through `npm test`, which transpiles the JSX first. These cover what the
 * pure quota tests cannot: that a known allowance renders the server's figures
 * and an unknown one renders nothing at all - no placeholder, no zero, nothing
 * a user could mistake for a real count.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';

import ChatQuota from './ChatQuota.jsx';

const render = (quota) => renderToStaticMarkup(<ChatQuota quota={quota} />);

const quota = (over = {}) => ({
  used: 7,
  limit: 10,
  remaining: 3,
  resetAt: '2026-09-06T00:00:00.000Z',
  ...over,
});

describe('ChatQuota', () => {
  it('shows the count out of the allowance', () => {
    const html = render(quota());
    assert.match(html, /Chats today: 7\/10/);
  });

  it('says when the day is spent, and marks it', () => {
    const html = render(quota({ used: 10, remaining: 0 }));
    assert.match(html, /No chats left today/);
    assert.match(html, /quota--spent/);
  });

  it('does not mark an allowance that still has chats in it', () => {
    assert.doesNotMatch(render(quota()), /quota--spent/);
  });

  it('tells the user when the allowance returns', () => {
    assert.match(render(quota()), /Resets/);
  });

  it('renders nothing at all without a quota', () => {
    // Redis down, or the read on mount failed: better an absent indicator than
    // a number the backend would not agree with.
    assert.equal(render(null), '');
    assert.equal(render(undefined), '');
  });

  it('renders nothing for a payload it cannot trust', () => {
    assert.equal(render({ used: 7 }), '');
  });

  it('announces changes politely, so it cannot interrupt an answer', () => {
    assert.match(render(quota()), /aria-live="polite"/);
  });
});
