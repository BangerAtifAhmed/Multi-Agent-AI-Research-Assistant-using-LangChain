import { randomUUID } from 'node:crypto';

import config from '../config/index.js';
import conversationModel from '../models/conversationModel.js';
import documentModel from '../models/documentModel.js';
import messageModel from '../models/messageModel.js';
import { buildHistoryWindow } from '../rag/contextWindow.js';
import ragClient from '../rag/ragClient.js';
import queryRouter from './queryRouter.js';
import ApiError from '../utils/ApiError.js';
import logger from '../utils/logger.js';
import retrievalService from './retrievalService.js';
import { generateTitle } from './titleService.js';

const DEFAULT_TITLE = 'New chat';
/**
 * Runs one chat turn for one authenticated user.
 *
 *   persist question -> history window -> query rewrite -> embed
 *   -> pgvector search (this user's chunks only) -> optional web research
 *   -> stream from the LLM -> persist the answer and its citations
 *
 * `userId` always comes from the session. It is never read from the request
 * body, so a client cannot ask questions as somebody else.
 */
export async function runChatTurn({
  userId,
  conversationId,
  message,
  mode,
  documentId,
  critique = false,
  webSearch = false,
  signal,
  emit,
}) {
  if (!userId) throw ApiError.unauthorized();

  const text = typeof message === 'string' ? message.trim() : '';
  if (!text) throw ApiError.badRequest('Message must not be empty', 'EMPTY_MESSAGE');
  if (text.length > config.limits.maxMessageLength) {
    throw ApiError.payloadTooLarge(
      `Message is too long (max ${config.limits.maxMessageLength} characters).`,
      'MESSAGE_TOO_LONG',
    );
  }
  // --- conversation (scoped to the user) -----------------------------------
  let conversation = null;
  if (conversationId) {
    conversation = await conversationModel.getConversation(userId, conversationId);
    if (!conversation) {
      throw ApiError.notFound('Conversation not found', 'CONVERSATION_NOT_FOUND');
    }
  }

  const isNewConversation = !conversation;

  // A document id from the client is only honoured if the user owns it. This is
  // the document attached to this message, or the conversation's pinned one.
  let resolvedDocumentId = documentId ?? conversation?.documentId ?? null;
  if (resolvedDocumentId) {
    const owned = await documentModel.getDocument(userId, resolvedDocumentId);
    if (!owned) {
      throw ApiError.notFound('Document not found', 'DOCUMENT_NOT_FOUND');
    }
    if (owned.status !== 'ready') {
      throw ApiError.badRequest(
        `"${owned.name}" is still processing. Try again once it is ready.`,
        'DOCUMENT_NOT_READY',
      );
    }
  }

  // --- automatic routing ---------------------------------------------------
  // The client never chooses the retrieval strategy. Any `mode` it sends is
  // ignored; the backend decides and enforces the route.
  const readyDocuments = await documentModel.countReadyDocuments(userId);
  const ragHealth = await ragClient.health().catch(() => null);

  const routing = await queryRouter.routeQuery({
    message: text,
    hasDocuments: readyDocuments > 0,
    hasAttachment: Boolean(documentId),
    webSearchEnabled: ragHealth?.webSearch !== false,
    // Honoured only if a provider is actually configured.
    forceWeb: webSearch === true,
  });

  const resolvedMode = queryRouter.routeToPipelineMode(routing.route);
  logger.debug(
    `router: "${text.slice(0, 60)}" -> ${routing.route} (${routing.confidence}) ${routing.reason}`,
  );

  if (!conversation) {
    conversation = await conversationModel.createConversation({
      userId,
      title: generateTitle(text),
      mode: 'auto',
      documentId: resolvedDocumentId,
    });
  }

  const previousMessages = await messageModel.listMessages(userId, conversation.id);

  const patch = {};
  if (!isNewConversation && previousMessages.length === 0 && conversation.title === DEFAULT_TITLE) {
    patch.title = generateTitle(text);
  }
  if (conversation.mode !== 'auto') patch.mode = 'auto';
  if (conversation.documentId !== resolvedDocumentId) patch.documentId = resolvedDocumentId;
  if (Object.keys(patch).length) {
    conversation = await conversationModel.updateConversation(userId, conversation.id, patch);
  }

  // --- persist the user turn -----------------------------------------------
  const userMessage = await messageModel.createMessage({
    conversationId: conversation.id,
    role: 'user',
    content: text,
    metadata: { mode: resolvedMode },
  });

  const assistantMessageId = randomUUID();
  const history = buildHistoryWindow(previousMessages);

  emit('meta', {
    conversation,
    userMessage,
    assistantMessageId,
    mode: resolvedMode,
    documentId: resolvedDocumentId,
    historyMessages: history.length,
  });

  let content = '';
  let critiqueText = '';
  let sources = [];
  let rewrittenQuery = null;
  let finishReason = 'stop';
  let errorPayload = null;

  try {
    // --- query processing --------------------------------------------------
    let searchQuery = text;
    if (history.length) {
      emit('status', { stage: 'rewriting', label: 'Understanding the follow-up' });
      searchQuery = await ragClient.condenseQuestion(text, history);
      if (searchQuery !== text) {
        rewrittenQuery = searchQuery;
        emit('status', { stage: 'rewritten', label: 'Refined search', query: searchQuery });
      }
    }
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    // --- retrieval ---------------------------------------------------------
    let documentSources = [];
    let webSources = [];
    let documentContext = '';
    let webContext = '';

    if (resolvedMode === 'document' || resolvedMode === 'hybrid') {
      emit('status', { stage: 'retrieving', label: 'Searching your library' });
      const result = await retrievalService.retrieveForUser({
        userId,
        query: searchQuery,
        documentIds: resolvedDocumentId ? [resolvedDocumentId] : null,
        // In hybrid the question is not necessarily about the documents at all,
        // so only genuinely relevant chunks may take a citation slot. In
        // document mode the user did ask about their files, so the nearest
        // matches are still worth showing.
        allowWeakMatches: resolvedMode === 'document',
      });
      documentSources = result.sources;
      documentContext = retrievalService.buildContext(documentSources, 1);
    }

    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    if (resolvedMode === 'web' || resolvedMode === 'hybrid') {
      emit('status', { stage: 'searching', label: 'Searching the web' });
      const research = await retrievalService.researchWeb(searchQuery);
      webSources = research.sources ?? [];
      webContext = retrievalService.buildContext(webSources, documentSources.length + 1);
      if (research.scraped) {
        webContext += `\n\nFull text of the most relevant page:\n${research.scraped.slice(0, 8000)}`;
      }
      logger.debug(
        `web search: "${searchQuery.slice(0, 80)}" -> ${webSources.length} result(s)` +
          `${research.cached ? ' (cached)' : ''}`,
      );
    }

    // The question needs a live figure and the search produced nothing - a
    // provider outage, or a query nothing matched. Answering from memory here is
    // how a confident, invented number reaches the user, so the model is told
    // plainly that it has no current data rather than being left to fill the gap.
    if (routing.requiresFreshData && !webSources.length) {
      logger.warn(
        `no web results for a query that needs current data: "${searchQuery.slice(0, 80)}"`,
      );
      webContext +=
        '\n\nNo current web results could be retrieved for this question. Tell the user ' +
        'that live information is unavailable right now and that any figure you might ' +
        'recall could be out of date. Do not state a specific current figure.';
    }

    sources = [...documentSources, ...webSources].map((source, index) => ({
      ...source,
      index: index + 1,
    }));

    emit('sources', { sources });
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    emit('status', {
      stage: 'generating',
      label:
        resolvedMode === 'llm' || sources.length
          ? 'Generating answer'
          : 'No matches found - answering without sources',
    });

    // --- generation --------------------------------------------------------
    const stream = ragClient.streamGeneration(
      {
        query: text,
        mode: resolvedMode,
        documentContext,
        webContext,
        history,
        critique: Boolean(critique),
      },
      signal,
    );

    for await (const event of stream) {
      if (signal?.aborted) break;

      switch (event.type) {
        case 'status':
          emit('status', { stage: event.stage, label: event.label });
          break;
        case 'token':
          content += event.text;
          emit('token', { text: event.text });
          break;
        case 'critique_token':
          critiqueText += event.text;
          emit('critique', { text: event.text });
          break;
        case 'error':
          errorPayload = {
            message: event.message || 'The assistant could not answer.',
            code: event.code || 'RAG_ERROR',
          };
          finishReason = 'error';
          break;
        case 'done':
          finishReason = event.finishReason || 'stop';
          break;
        default:
          logger.debug(`unhandled RAG event: ${event.type}`);
      }
    }
  } catch (error) {
    if (error?.name === 'AbortError' || signal?.aborted) {
      finishReason = 'aborted';
    } else {
      logger.error('chat turn failed:', error);
      finishReason = 'error';
      errorPayload = {
        message:
          error instanceof ApiError
            ? error.message
            : 'The assistant could not complete this response.',
        code: error?.code || 'STREAM_FAILED',
      };
    }
  }

  if (signal?.aborted && finishReason !== 'error') finishReason = 'aborted';

  if (!content.trim() && !errorPayload && finishReason === 'stop') {
    finishReason = 'error';
    errorPayload = {
      message: 'The assistant returned an empty response. Please try again.',
      code: 'EMPTY_RESPONSE',
    };
  }

  // --- persist the assistant turn ------------------------------------------
  let assistantMessage = null;
  if (content.trim()) {
    assistantMessage = await messageModel.createMessage({
      conversationId: conversation.id,
      role: 'assistant',
      content,
      metadata: {
        mode: resolvedMode,
        // Which route the router chose. The UI derives its "Used your
        // documents / Searched the web" hint from the sources actually
        // returned, so this is kept for diagnostics only and the reason
        // string is deliberately not persisted or exposed.
        route: routing.route,
        finishReason,
        ...(rewrittenQuery ? { rewrittenQuery } : {}),
        ...(critiqueText.trim() ? { critique: critiqueText } : {}),
      },
      sources,
    });
  }

  // Roll back a brand-new conversation whose first turn produced nothing.
  if (!assistantMessage && errorPayload && isNewConversation && previousMessages.length === 0) {
    await conversationModel.deleteConversation(userId, conversation.id);
    return {
      conversation: null,
      conversationId: conversation.id,
      userMessage,
      assistantMessage: null,
      assistantMessageId,
      finishReason,
      error: errorPayload,
      sources,
    };
  }

  await conversationModel.touchConversation(userId, conversation.id);

  return {
    conversation: await conversationModel.getConversation(userId, conversation.id),
    conversationId: conversation.id,
    userMessage,
    assistantMessage,
    assistantMessageId,
    finishReason,
    error: errorPayload,
    sources,
  };
}

export default { runChatTurn };
