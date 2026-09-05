/**
 * Reading the daily chat allowance the backend reports.
 *
 * There is deliberately no arithmetic here beyond formatting. The browser never
 * counts chats, never decrements anything after sending, and never guesses at a
 * value it has not been told: every number displayed comes from the server, via
 * `GET /api/chat/limit` on load, the `quota` frame on the chat stream, or the
 * body of a 429. A frontend counter would only ever be a second opinion, and
 * the one that disagrees with enforcement is the one the user sees.
 */

/**
 * Accepts a quota payload only if the server actually filled it in.
 *
 * Anything partial is treated as absent, because a half-known allowance renders
 * as "7/undefined" or, worse, as a plausible wrong number.
 *
 * @returns {{used: number, limit: number, remaining: number, resetAt: string|null}|null}
 */
export function readQuota(payload) {
  if (!payload) return null;

  const used = Number(payload.used);
  const limit = Number(payload.limit);
  const remaining = Number(payload.remaining);

  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return null;

  return {
    used,
    limit,
    // Only computed when the server did not say; it always does, and this keeps
    // one missing field from blanking the whole indicator.
    remaining: Number.isFinite(remaining) ? remaining : Math.max(limit - used, 0),
    resetAt: typeof payload.resetAt === 'string' ? payload.resetAt : null,
  };
}

/**
 * The quota a failed request carried, if it carried one.
 *
 * This is how the indicator learns it has run out: the daily-limit 429 puts the
 * spent allowance in the error body, so no send is needed to find out.
 */
export const quotaFromError = (error) => readQuota(error?.meta);

/**
 * The indicator's text: "Chats today: 7/10", or the plain statement when there
 * are none left. Short on purpose - it sits under the composer, not in a panel.
 *
 * Validates rather than trusting its argument, so no caller can render
 * "7/undefined" by passing a payload straight through.
 */
export function describeQuota(payload) {
  const quota = readQuota(payload);
  if (!quota) return null;
  if (quota.remaining <= 0) return 'No chats left today';
  return `Chats today: ${quota.used}/${quota.limit}`;
}

/** When the allowance comes back, in the reader's own locale. */
export function describeReset(payload) {
  const quota = readQuota(payload);
  if (!quota?.resetAt) return null;
  const resetAt = new Date(quota.resetAt);
  if (Number.isNaN(resetAt.getTime())) return null;

  const sameDay = resetAt.toDateString() === new Date().toDateString();
  const time = resetAt.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return sameDay ? `Resets at ${time}` : `Resets tomorrow at ${time}`;
}

export default { readQuota, quotaFromError, describeQuota, describeReset };
