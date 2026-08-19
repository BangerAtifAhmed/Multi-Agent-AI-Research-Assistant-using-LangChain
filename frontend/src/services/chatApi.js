import { streamRequest } from './apiClient.js';

/**
 * Parses a Server-Sent Events body into {event, data} objects, yielding each
 * one as soon as its frame arrives. No buffering of the full response.
 */
async function* parseSse(response, signal) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const onAbort = () => reader.cancel().catch(() => {});
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

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
    signal?.removeEventListener('abort', onAbort);
    reader.cancel().catch(() => {});
  }
}

/**
 * Sends a message and yields streaming events from the backend.
 *
 * @param {object} payload {conversationId, message, mode, documentId, critique}
 * @param {AbortSignal} signal aborting stops generation server-side too
 */
export async function* sendMessageStream(payload, signal) {
  const response = await streamRequest('/chat', { body: payload, signal });
  yield* parseSse(response, signal);
}

export default { sendMessageStream };
