import { ApiRequestError, request, streamRequest } from './apiClient.js';
import { readQuota } from '../lib/chatQuota.js';

/**
 * The server writes a ": ping" comment every 15 seconds for as long as a turn
 * is running, so total silence for three heartbeats means the connection is
 * dead - not that the answer is slow. Without a deadline here a half-open
 * socket leaves the reader waiting forever and the composer stuck generating.
 */
export const STREAM_STALL_MS = 45_000;

/** Headers arrive as soon as the stream opens, so this only catches a wedge. */
export const STREAM_OPEN_MS = 30_000;

const STALLED_MESSAGE =
  'The server stopped responding. The answer was interrupted - please try again.';
const NO_RESPONSE_MESSAGE =
  'The server did not start responding. It may be busy - please try again.';

/**
 * Parses a Server-Sent Events body into {event, data} objects, yielding each
 * one as soon as its frame arrives. No buffering of the full response.
 *
 * Throws `STREAM_STALLED` if nothing at all arrives for `stallMs` - heartbeat
 * comments included - so a stream that will never end still ends.
 */
export async function* parseSse(response, signal, { stallMs = STREAM_STALL_MS } = {}) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let stalled = false;

  const onAbort = () => reader.cancel().catch(() => {});
  signal?.addEventListener('abort', onAbort, { once: true });

  // Cancelling the reader resolves the pending read() as `done`, which unwinds
  // the loop below through the same path a finished stream takes.
  let stallTimer = null;
  const watchForStall = () => {
    if (!stallMs) return;
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      stalled = true;
      reader.cancel().catch(() => {});
    }, stallMs);
  };

  try {
    watchForStall();

    while (true) {
      const { done, value } = await reader.read();
      if (stalled) throw new ApiRequestError(STALLED_MESSAGE, { code: 'STREAM_STALLED' });
      if (done) break;

      // Any bytes at all prove the server is still there, heartbeats included.
      watchForStall();
      buffer += decoder.decode(value, { stream: true });

      // Frames are separated by a blank line.
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);

        let event = 'message';
        const dataLines = [];

        for (const line of frame.split('\n')) {
          if (line.startsWith(':')) continue; // heartbeat comment
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
        }

        if (!dataLines.length) continue;

        try {
          yield { event, data: JSON.parse(dataLines.join('\n')) };
        } catch {
          /* ignore an unparsable frame rather than killing the stream */
        }
      }
    }
  } finally {
    clearTimeout(stallTimer);
    signal?.removeEventListener('abort', onAbort);
    reader.cancel().catch(() => {});
  }
}

/**
 * Sends a message and yields streaming events from the backend.
 *
 * Every exit is bounded: the request must produce headers within
 * `STREAM_OPEN_MS` and a frame within `STREAM_STALL_MS` of the last one, so the
 * caller always gets either events, a completed stream, or an error to show.
 *
 * @param {object} payload {conversationId, message, documentId, critique, webSearch}
 * @param {AbortSignal} signal aborting stops generation server-side too
 */
export async function* sendMessageStream(payload, signal, options = {}) {
  const { stallMs = STREAM_STALL_MS, openMs = STREAM_OPEN_MS } = options;

  // One controller for the whole request, so Stop and the open deadline both
  // end the same fetch.
  const request = new AbortController();
  const forwardAbort = () => request.abort();
  if (signal?.aborted) request.abort();
  else signal?.addEventListener('abort', forwardAbort, { once: true });

  let timedOut = false;
  const openTimer = openMs
    ? setTimeout(() => {
        timedOut = true;
        request.abort();
      }, openMs)
    : null;

  try {
    let response;
    try {
      response = await streamRequest('/chat', { body: payload, signal: request.signal });
    } catch (error) {
      if (timedOut) throw new ApiRequestError(NO_RESPONSE_MESSAGE, { code: 'STREAM_TIMEOUT' });
      throw error;
    } finally {
      // Headers are in; from here the stall watchdog owns the deadline. Leaving
      // this armed would abort a perfectly healthy long answer.
      clearTimeout(openTimer);
    }

    yield* parseSse(response, request.signal, { stallMs });
  } finally {
    clearTimeout(openTimer);
    signal?.removeEventListener('abort', forwardAbort);
  }
}

/**
 * Today's chat allowance, read without spending one.
 *
 * Used once, when the composer mounts; every later value arrives on the stream
 * itself. Returns null when the server has no count to give (Redis down), which
 * the UI shows as no indicator rather than as a guess.
 */
export async function getChatLimit() {
  const { quota } = await request('/chat/limit');
  return readQuota(quota);
}

export default { sendMessageStream, parseSse, getChatLimit };
