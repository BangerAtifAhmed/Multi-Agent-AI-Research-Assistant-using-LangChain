import { useCallback, useEffect, useRef, useState } from 'react';

import { sendMessageStream } from '../services/chatApi.js';

/**
 * Owns one in-flight assistant response.
 *
 * Tokens arrive from the network one at a time; React state is updated on an
 * animation frame instead of once per token, so a fast stream cannot flood the
 * renderer. The text itself is never delayed or faked - it is painted as soon
 * as the next frame runs.
 */
export function useChatStream({ onMeta, onComplete } = {}) {
  const [stream, setStream] = useState({
    active: false,
    messageId: null,
    content: '',
    critique: '',
    sources: [],
    status: null,
    error: null,
  });

  const contentRef = useRef('');
  const critiqueRef = useRef('');
  const frameRef = useRef(null);
  const abortRef = useRef(null);
  const mountedRef = useRef(true);

  useEffect(
    () => () => {
      mountedRef.current = false;
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
      abortRef.current?.abort();
    },
    [],
  );

  const flushNow = useCallback(() => {
    if (frameRef.current) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    if (!mountedRef.current) return;
    setStream((prev) => ({ ...prev, content: contentRef.current, critique: critiqueRef.current }));
  }, []);

  const scheduleFlush = useCallback(() => {
    if (frameRef.current != null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      if (!mountedRef.current) return;
      setStream((prev) => ({
        ...prev,
        content: contentRef.current,
        critique: critiqueRef.current,
      }));
    });
  }, []);

  const reset = useCallback(() => {
    contentRef.current = '';
    critiqueRef.current = '';
    setStream({
      active: false,
      messageId: null,
      content: '',
      critique: '',
      sources: [],
      status: null,
      error: null,
    });
  }, []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const start = useCallback(
    async (payload) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      contentRef.current = '';
      critiqueRef.current = '';
      setStream({
        active: true,
        messageId: null,
        content: '',
        critique: '',
        sources: [],
        status: { stage: 'starting', label: 'Thinking' },
        error: null,
      });

      let finishReason = 'stop';
      let savedMessage = null;
      let finalConversation = null;
      let removedConversationId = null;
      let sources = [];
      let streamError = null;
      let aborted = false;

      try {
        for await (const { event, data } of sendMessageStream(payload, controller.signal)) {
          switch (event) {
            case 'meta':
              setStream((prev) => ({ ...prev, messageId: data.assistantMessageId }));
              onMeta?.(data);
              break;

            case 'status':
              setStream((prev) => ({ ...prev, status: data }));
              break;

            case 'sources':
              sources = data.sources ?? [];
              setStream((prev) => ({ ...prev, sources }));
              break;

            case 'token':
              contentRef.current += data.text;
              scheduleFlush();
              break;

            case 'critique':
              critiqueRef.current += data.text;
              scheduleFlush();
              break;

            case 'error':
              streamError = data.message || 'The assistant could not answer.';
              break;

            case 'done':
              finishReason = data.finishReason || 'stop';
              savedMessage = data.message ?? null;
              if (data.removed) removedConversationId = data.conversationId ?? null;
              else if (data.conversation) finalConversation = data.conversation;
              break;

            default:
              break;
          }
        }
      } catch (error) {
        if (error?.name === 'AbortError' || controller.signal.aborted) {
          aborted = true;
          finishReason = 'aborted';
        } else {
          streamError = error?.message || 'The connection to the server was lost.';
          finishReason = 'error';
        }
      }

      if (controller.signal.aborted) {
        aborted = true;
        if (finishReason !== 'error') finishReason = 'aborted';
      }

      flushNow();

      const content = contentRef.current;

      if (!content.trim() && !streamError && !aborted) {
        streamError = 'The assistant returned an empty response.';
        finishReason = 'error';
      }

      if (mountedRef.current) {
        setStream((prev) => ({ ...prev, active: false, error: streamError }));
      }

      abortRef.current = null;

      onComplete?.({
        content,
        critique: critiqueRef.current,
        sources,
        finishReason,
        savedMessage,
        error: streamError,
        conversation: finalConversation,
        removedConversationId,
        aborted,
      });

      return { content, finishReason, error: streamError };
    },
    [flushNow, onComplete, onMeta, scheduleFlush],
  );

  return { stream, start, stop, reset, isStreaming: stream.active };
}

export default useChatStream;
