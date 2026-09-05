import { memo } from 'react';

import { describeQuota, describeReset, readQuota } from '../lib/chatQuota.js';

/**
 * The day's chat allowance, shown under the composer.
 *
 * Every figure here came from the server - the read on mount, the `quota` frame
 * on the stream, or the body of a 429. Nothing is counted or decremented in the
 * browser, so this can never drift out of step with what the backend enforces.
 *
 * Renders nothing at all when there is no quota to show (the counter is
 * unavailable), which is the honest alternative to a made-up number.
 */
function ChatQuota({ quota }) {
  const value = readQuota(quota);
  const label = describeQuota(value);
  if (!label) return null;

  const exhausted = value.remaining <= 0;
  const reset = describeReset(value);

  return (
    <p
      className={`quota${exhausted ? ' quota--spent' : ''}`}
      // Polite: it updates mid-answer, and must not interrupt a screen reader
      // that is reading the answer itself.
      aria-live="polite"
    >
      <span className="quota__count">{label}</span>
      {reset && <span className="quota__reset">{reset}</span>}
    </p>
  );
}

export default memo(ChatQuota);
