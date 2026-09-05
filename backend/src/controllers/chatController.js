import config from '../config/index.js';
import { peekChatQuota } from '../middleware/chatDailyLimit.js';
import chatService from '../services/chatService.js';
import ApiError from '../utils/ApiError.js';
import logger from '../utils/logger.js';
import { closeStream, openStream, sendEvent } from '../utils/sse.js';

/** Only the four figures the UI displays; never the Redis key or the raw count. */
const publicQuota = (quota) =>
  quota && {
    used: quota.used,
    limit: quota.limit,
    remaining: quota.remaining,
    resetAt: quota.resetAt,
  };

/**
 * GET /api/chat/limit  (authenticated)
 *
 * Today's chat allowance, read without spending one. This is how the composer
 * knows what to show before the user has sent anything; every later update
 * comes from the `quota` frame on the stream itself, so the browser never
 * counts anything on its own.
 *
 * `quota: null` means the counter is unavailable (Redis down, chats served
 * uncounted). Saying nothing is the honest answer there - a number the
 * enforcement side would not agree with is worse than no number.
 */
export async function chatLimit(req, res) {
  const quota = await peekChatQuota(req.user.id);
  res.json({ quota: publicQuota(quota) ?? null });
}

/**
 * POST /api/chat  (authenticated)
 *
 * Responds with a Server-Sent Events stream:
 *
 *   meta     -> conversation + message ids (sent before generation starts)
 *   status   -> pipeline stage (rewriting, retrieving, searching, generating)
 *   sources  -> citations, sent before the first token
 *   token    -> a chunk of the answer, forwarded the instant the LLM emits it
 *   critique -> a chunk of the optional critic review
 *   done     -> finish reason and the saved message
 *   error    -> user-safe error message
 *
 * `done` is always the last frame, and the response is always ended: the
 * browser keeps the composer in its generating state until the stream closes,
 * so a turn that never terminates here is a turn the user can never retry. The
 * deadline below is the backstop for that - it fires only when nothing
 * downstream returned at all, and every ordinary ending beats it to `finish`.
 *
 * The user comes from the session; `userId` in the body is ignored entirely.
 */
export async function chat(req, res) {
  const { conversationId, message, mode, documentId, critique, webSearch } = req.body ?? {};

  // Validate before opening the stream so failures are ordinary HTTP errors
  // (and so the rate limiter's 429 is a normal response, not an SSE frame).
  const text = typeof message === 'string' ? message.trim() : '';
  if (!text) throw ApiError.badRequest('Message must not be empty', 'EMPTY_MESSAGE');

  if (webSearch !== undefined && typeof webSearch !== 'boolean') {
    throw ApiError.badRequest('webSearch must be a boolean', 'INVALID_WEB_SEARCH');
  }
  // Neither rejection above spends one of the day's chats: the daily limiter
  // reserved a slot before this handler ran, and refunds it when the response
  // ends without the turn having committed it.

  const controller = new AbortController();
  let clientGone = false;

  // "Stop generating": the browser aborts the fetch, Express sees the socket
  // close, and the abort propagates to the RAG service and the LLM.
  //
  // This listens on `res`, not `req`: the request stream emits 'close' as soon
  // as its body has been consumed, which would abort every stream immediately.
  res.on('close', () => {
    if (!res.writableEnded) {
      clientGone = true;
      controller.abort();
    }
  });

  const stopHeartbeat = openStream(res);

  const emit = (event, data) => {
    if (clientGone) return false;
    return sendEvent(res, event, data);
  };

  // The single terminating path: the first caller wins, every later one is a
  // no-op. Success, a reported failure, a thrown error and the deadline all
  // come through here, so the stream is closed exactly once whichever wins.
  let finished = false;
  const finish = ({ error, done }) => {
    if (finished) return;
    finished = true;
    clearTimeout(deadline);
    if (error) emit('error', error);
    emit('done', done);
    stopHeartbeat();
    closeStream(res);
  };

  const deadline = setTimeout(() => {
    logger.error(
      `chat turn exceeded ${config.limits.chatTurnTimeoutMs}ms without finishing; closing the stream`,
    );
    // Stop the work as well as the waiting, so an abandoned turn does not keep
    // burning an LLM call after the browser has been told it failed.
    controller.abort();
    finish({
      error: {
        message: 'The assistant took too long to respond. Please try again.',
        code: 'CHAT_TIMEOUT',
      },
      done: { finishReason: 'error' },
    });
  }, config.limits.chatTurnTimeoutMs);
  deadline.unref?.();

  try {
    const result = await chatService.runChatTurn({
      userId: req.user.id,
      conversationId,
      message: text,
      mode,
      documentId,
      critique,
      // A request to search the web, not a route: the server still decides.
      webSearch: webSearch === true,
      signal: controller.signal,
      emit,
      // The pipeline has started, so this turn spends one daily chat whatever
      // happens next - a provider failover, a mid-stream error, an abort.
      onAccepted: () => {
        req.chatQuota?.commit();
        // The counter was incremented before this handler ran, so these figures
        // already include the chat now starting. Sent here rather than at the
        // end because this is the moment it was actually spent: a turn that
        // fails later still cost one, and the number the user sees must say so.
        const quota = publicQuota(req.chatQuota);
        if (quota) emit('quota', quota);
      },
    });

    finish({
      error: result.error ? { message: result.error.message, code: result.error.code } : null,
      done: {
        finishReason: result.finishReason,
        conversation: result.conversation,
        conversationId: result.conversationId,
        removed: result.conversation === null,
        message: result.assistantMessage,
        assistantMessageId: result.assistantMessageId,
      },
    });
  } catch (error) {
    const safe =
      error instanceof ApiError
        ? { message: error.message, code: error.code }
        : { message: 'The assistant could not complete this response.', code: 'CHAT_FAILED' };

    if (!(error instanceof ApiError)) logger.error('chat failed:', error);

    finish({ error: safe, done: { finishReason: 'error' } });
  } finally {
    clearTimeout(deadline);
    stopHeartbeat();
    closeStream(res);
  }
}

export default { chat, chatLimit };
