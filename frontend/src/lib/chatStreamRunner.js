/**
 * The lifecycle of one in-flight assistant response, with no React in it.
 *
 * This module exists to enforce a single rule: *every* way a turn can end -
 * the stream finishing, an `error` frame from the server, a transport failure,
 * a stalled connection, Stop, or a second prompt superseding the first - runs
 * the same terminating path exactly once. `active: false` is published from a
 * `finally`, so there is no ordering of events, and no listener throwing, that
 * can leave the composer stuck showing "Stop".
 *
 * It is deliberately framework-free: the state machine that decides whether the
 * UI is generating is the part worth testing, and testing it should not need a
 * DOM. `useChatStream` is a thin adapter that renders whatever this publishes.
 */

import { quotaFromError, readQuota } from './chatQuota.js';

/** The state of a chat surface with nothing in flight. */
export const IDLE_STREAM = Object.freeze({
  active: false,
  messageId: null,
  content: '',
  critique: '',
  sources: [],
  status: null,
  error: null,
});

const EMPTY_RESPONSE = 'The assistant returned an empty response.';
const LOST_CONNECTION = 'The connection to the server was lost.';

/**
 * @param {object} options
 * @param {(payload: object, signal: AbortSignal) => AsyncIterable} options.send
 *   Yields `{event, data}` frames. Rejecting or throwing is a normal outcome.
 * @param {(patch: object) => void} [options.onState] merged into the visible state
 * @param {(text: {content: string, critique: string}) => void} [options.onTokens]
 *   Called per token so the adapter can throttle painting. The terminal state
 *   patch carries the final text, so dropping any of these is safe.
 * @param {(data: object) => void} [options.onMeta]
 * @param {(quota: object) => void} [options.onQuota] the server's daily-chat
 *   figures, from the stream or from a 429. Never computed here.
 * @param {(summary: object) => void} [options.onComplete] at most once per start
 */
export function createChatStreamRunner({
  send,
  onState,
  onTokens,
  onMeta,
  onQuota,
  onComplete,
} = {}) {
  let controller = null;
  // Only the newest turn may write state or report itself. A turn that was
  // superseded, or whose surface was reset, must not clear the flag its
  // replacement just set or overwrite the answer now on screen.
  let currentRun = 0;

  const stop = () => controller?.abort();

  const reset = () => {
    currentRun += 1;
    onState?.({ ...IDLE_STREAM });
  };

  async function start(payload) {
    // One turn at a time; a new one always supersedes whatever is in flight.
    controller?.abort();
    const signalOwner = new AbortController();
    controller = signalOwner;

    const run = ++currentRun;
    const isCurrent = () => run === currentRun;

    onState?.({
      ...IDLE_STREAM,
      active: true,
      status: { stage: 'starting', label: 'Thinking' },
    });

    // The whole result of this turn, built up as frames arrive. Local to the
    // call, so a superseded turn cannot leak its text into its replacement's.
    const summary = {
      content: '',
      critique: '',
      sources: [],
      finishReason: 'stop',
      savedMessage: null,
      error: null,
      conversation: null,
      removedConversationId: null,
      aborted: false,
      accepted: false,
      quota: null,
    };

    try {
      for await (const { event, data } of send(payload, signalOwner.signal)) {
        if (!isCurrent()) break;

        switch (event) {
          case 'meta':
            // The turn was accepted and the question persisted. Anything that
            // ends the turn before this frame - a refusal, a dead connection -
            // left no trace on the server for the view to keep.
            summary.accepted = true;
            onState?.({ messageId: data.assistantMessageId });
            onMeta?.(data);
            break;

          case 'status':
            onState?.({ status: data });
            break;

          case 'quota': {
            // Sent when the backend accepted the turn, so it already counts
            // this chat. Reported as it arrives rather than at the end: the
            // chat is spent from this moment, however the turn goes.
            const quota = readQuota(data);
            if (quota) {
              summary.quota = quota;
              onQuota?.(quota);
            }
            break;
          }

          case 'sources':
            summary.sources = data.sources ?? [];
            onState?.({ sources: summary.sources });
            break;

          case 'token':
            summary.content += data.text;
            onTokens?.({ content: summary.content, critique: summary.critique });
            break;

          case 'critique':
            summary.critique += data.text;
            onTokens?.({ content: summary.content, critique: summary.critique });
            break;

          case 'error':
            summary.error = data.message || 'The assistant could not answer.';
            break;

          case 'done':
            summary.finishReason = data.finishReason || 'stop';
            summary.savedMessage = data.message ?? null;
            if (data.removed) summary.removedConversationId = data.conversationId ?? null;
            else if (data.conversation) summary.conversation = data.conversation;
            break;

          default:
            break;
        }
      }
    } catch (failure) {
      if (failure?.name === 'AbortError' || signalOwner.signal.aborted) {
        summary.aborted = true;
        summary.finishReason = 'aborted';
      } else {
        summary.error = failure?.message || LOST_CONNECTION;
        summary.finishReason = 'error';
        summary.errorCode = failure?.code;
        summary.status = failure?.status;
        // A refusal carries the allowance that caused it - a 429 from the daily
        // limit is how the indicator learns it has run out. Still the server's
        // numbers: the request was rejected, so nothing was spent here.
        const quota = quotaFromError(failure);
        if (quota) {
          summary.quota = quota;
          onQuota?.(quota);
        }
      }
    } finally {
      // The single terminating path. It runs for a completed stream, an error,
      // an abort, and for a bug in any branch above, which is the whole point:
      // the composer cannot be left generating.
      if (controller === signalOwner) controller = null;
      finish(signalOwner, summary, isCurrent);
    }

    return { content: summary.content, finishReason: summary.finishReason, error: summary.error };
  }

  function finish(signalOwner, summary, isCurrent) {
    if (signalOwner.signal.aborted) {
      summary.aborted = true;
      if (summary.finishReason !== 'error') summary.finishReason = 'aborted';
    }

    // A stream that closed without a word and without saying why still has to
    // end as a failure the user can see, not as a silent success.
    if (!summary.content.trim() && !summary.error && !summary.aborted) {
      summary.error = EMPTY_RESPONSE;
      summary.finishReason = 'error';
    }

    // A superseded turn is silent: its replacement owns the surface now.
    if (!isCurrent()) return;

    onState?.({
      active: false,
      content: summary.content,
      critique: summary.critique,
      error: summary.error,
    });

    try {
      onComplete?.(summary);
    } catch (failure) {
      // A listener throwing must not undo the reset above, or the next prompt
      // would be blocked by a turn that has already ended.
      console.error('chat stream listener failed', failure);
    }
  }

  return { start, stop, reset, isActive: () => controller !== null };
}

export default createChatStreamRunner;
