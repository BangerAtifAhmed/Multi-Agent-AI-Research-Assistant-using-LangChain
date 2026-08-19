import chatService from '../services/chatService.js';
import ApiError from '../utils/ApiError.js';
import logger from '../utils/logger.js';
import { closeStream, openStream, sendEvent } from '../utils/sse.js';

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

  openStream(res);

  const emit = (event, data) => {
    if (clientGone) return false;
    return sendEvent(res, event, data);
  };

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
    });

    if (result.error) {
      emit('error', { message: result.error.message, code: result.error.code });
    }

    emit('done', {
      finishReason: result.finishReason,
      conversation: result.conversation,
      conversationId: result.conversationId,
      removed: result.conversation === null,
      message: result.assistantMessage,
      assistantMessageId: result.assistantMessageId,
    });
  } catch (error) {
    const safe =
      error instanceof ApiError
        ? { message: error.message, code: error.code }
        : { message: 'The assistant could not complete this response.', code: 'CHAT_FAILED' };

    if (!(error instanceof ApiError)) logger.error('chat failed:', error);

    emit('error', safe);
    emit('done', { finishReason: 'error' });
  } finally {
    closeStream(res);
  }
}

export default { chat };
