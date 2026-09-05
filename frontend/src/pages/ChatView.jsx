import { useCallback, useEffect, useRef, useState } from 'react';

import ChatWindow from '../components/ChatWindow.jsx';
import useChatStream from '../hooks/useChatStream.js';
import chatApi from '../services/chatApi.js';
import conversationApi from '../services/conversationApi.js';
import documentApi from '../services/documentApi.js';

const TERMINAL = new Set(['ready', 'failed']);
const POLL_MS = 1500;
// Processing is bounded so the chip can never spin forever; the server keeps
// working regardless, and the Library shows the outcome.
const PROCESSING_BUDGET_MS = 5 * 60 * 1000;
const MAX_POLL_ERRORS = 5;

/**
 * The chat surface. Owns the messages of the open conversation, the single
 * in-flight assistant response, and any document attached to the next message.
 *
 * There is no mode selector: the backend routes every message automatically.
 */
export default function ChatView({
  activeId,
  setActiveId,
  documents,
  onDocumentsChanged,
  conversationsUpsert,
  conversationsRemoveLocal,
  onOpenSidebar,
  onOpenLibrary,
  externalError,
  onDismissExternalError,
  health,
}) {
  const [messages, setMessages] = useState([]);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [error, setError] = useState(null);
  const [critique, setCritique] = useState(false);
  // Sticky, like a mode: once on it stays on until the user turns it off.
  const [webSearch, setWebSearch] = useState(false);

  // The document attached to the *next* message, if any.
  const [attachment, setAttachment] = useState(null);

  // The day's chat allowance, exactly as the server last reported it. Read once
  // on mount, then replaced by the `quota` frame every accepted turn sends and
  // by the figures a 429 carries. Never incremented here: the backend is the
  // only thing that counts chats, so there is nothing to drift out of step.
  const [quota, setQuota] = useState(null);

  const streamConversationRef = useRef(null);
  const activeIdRef = useRef(null);
  activeIdRef.current = activeId;

  const handleMeta = useCallback(
    (meta) => {
      streamConversationRef.current = meta.conversation.id;
      conversationsUpsert(meta.conversation);

      if (activeIdRef.current !== meta.conversation.id) {
        setActiveId(meta.conversation.id);
        activeIdRef.current = meta.conversation.id;
      }

      setMessages((prev) => [
        ...prev.filter((message) => !message.id.startsWith('temp-')),
        meta.userMessage,
      ]);
    },
    [conversationsUpsert, setActiveId],
  );

  const handleComplete = useCallback(
    ({
      content,
      critique: critiqueText,
      sources,
      finishReason,
      savedMessage,
      error: streamError,
      conversation,
      removedConversationId,
      accepted,
    }) => {
      const conversationId = streamConversationRef.current;
      streamConversationRef.current = null;

      if (streamError) setError(streamError);

      // The server never took this turn - the daily limit refused it, or the
      // request never landed - so nothing was saved. Drop the optimistic bubble
      // rather than leaving a question on screen that was never asked.
      if (!accepted) {
        setMessages((prev) => prev.filter((message) => !message.id.startsWith('temp-')));
      }

      if (removedConversationId) {
        conversationsRemoveLocal(removedConversationId);
        if (activeIdRef.current === removedConversationId) {
          setActiveId(null);
          activeIdRef.current = null;
          setMessages([]);
        }
        return;
      }

      if (conversation) conversationsUpsert(conversation);
      if (conversationId !== activeIdRef.current) return;

      if (content.trim()) {
        setMessages((prev) => [
          ...prev,
          savedMessage ?? {
            id: `local-${Date.now()}`,
            conversationId,
            role: 'assistant',
            content,
            sources,
            metadata: {
              finishReason,
              ...(critiqueText?.trim() ? { critique: critiqueText } : {}),
            },
            createdAt: new Date().toISOString(),
          },
        ]);
      }
    },
    [conversationsRemoveLocal, conversationsUpsert, setActiveId],
  );

  const { stream, start, stop, reset, isStreaming } = useChatStream({
    onMeta: handleMeta,
    // Whatever the server says the allowance now is, that is what we show.
    onQuota: setQuota,
    onComplete: handleComplete,
  });

  // The starting value. Everything after this arrives on the chat stream, so
  // this runs once and is never polled.
  useEffect(() => {
    let cancelled = false;
    chatApi
      .getChatLimit()
      .then((current) => {
        if (!cancelled) setQuota(current);
      })
      .catch(() => {
        // The indicator is not worth an error banner: it simply does not
        // appear, and the first answer fills it in.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Load the messages of whichever conversation is open.
  useEffect(() => {
    let cancelled = false;

    if (!activeId) {
      setMessages([]);
      reset();
      return () => {
        cancelled = true;
      };
    }

    if (streamConversationRef.current === activeId) return () => {};

    setLoadingMessages(true);
    setMessages([]);
    conversationApi
      .getMessages(activeId)
      .then((loaded) => {
        if (!cancelled) setMessages(loaded);
      })
      .catch((loadError) => {
        if (!cancelled) setError(loadError.message);
      })
      .finally(() => {
        if (!cancelled) setLoadingMessages(false);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  /**
   * Uploads through the EXISTING document API, then polls until the document is
   * indexed. The file lands in the user's Library like any other upload.
   */
  const attachFile = useCallback(
    async (file) => {
      setError(null);
      setAttachment({
        name: file.name,
        status: 'uploading',
        documentId: null,
        uploadPercent: 0,
        document: null,
      });

      const fail = (message) =>
        setAttachment({ name: file.name, status: 'failed', documentId: null, error: message });

      let document;
      try {
        // Phase 1: the upload itself, reporting bytes actually sent.
        document = await documentApi.uploadDocument(file, (percent) => {
          setAttachment((current) =>
            current && current.status === 'uploading'
              ? { ...current, uploadPercent: percent ?? current.uploadPercent }
              : current,
          );
        });
      } catch (uploadError) {
        fail(uploadError.message);
        return;
      }

      onDocumentsChanged?.();
      // Phase 2: the server processes in the background. Distinct from
      // "uploading" so the user can tell which stage is slow. `document` carries
      // the server's own stage and counters, which the chip renders.
      setAttachment({
        name: document.originalFilename ?? file.name,
        status: 'processing',
        documentId: null,
        document,
      });

      const deadline = Date.now() + PROCESSING_BUDGET_MS;
      let current = document;
      let consecutiveErrors = 0;

      while (!TERMINAL.has(current.status)) {
        if (Date.now() > deadline) {
          // Unchanged: stop watching, never stop the server. The chip says so
          // explicitly instead of looking like a failure.
          setAttachment({
            name: document.originalFilename ?? file.name,
            status: 'backgrounded',
            documentId: null,
            document: current,
          });
          onDocumentsChanged?.();
          return;
        }

        await new Promise((resolve) => setTimeout(resolve, POLL_MS));

        try {
          // One document rather than the whole library: this runs every 1.5s
          // for as long as processing takes.
          current = await documentApi.getDocument(document.id);
          consecutiveErrors = 0;
          // Feed the server's live counters straight to the chip.
          setAttachment((existing) =>
            existing && existing.status === 'processing'
              ? { ...existing, document: current }
              : existing,
          );
        } catch (pollError) {
          if (pollError?.status === 404) {
            fail('The document is no longer in your library.');
            return;
          }
          // A restarting server drops a few polls; only give up if it persists.
          consecutiveErrors += 1;
          if (consecutiveErrors >= MAX_POLL_ERRORS) {
            fail(`Lost contact with the server while processing. ${pollError.message}`);
            return;
          }
        }
      }

      onDocumentsChanged?.();

      if (current.status === 'ready') {
        setAttachment({
          name: current.originalFilename,
          status: 'ready',
          documentId: current.id,
          document: current,
        });
      } else {
        // Surface the server's actual reason (e.g. interrupted, unreadable).
        fail(current.errorMessage || 'Could not process this file.');
      }
    },
    [onDocumentsChanged],
  );

  /** Clears the pending attachment only - the document stays in the Library. */
  const removeAttachment = useCallback(() => setAttachment(null), []);

  const sendMessage = useCallback(
    (text) => {
      if (isStreaming) return;
      if (attachment?.status === 'uploading' || attachment?.status === 'processing') {
        setError('Wait for the attachment to finish processing.');
        return;
      }

      setError(null);

      setMessages((prev) => [
        ...prev,
        {
          id: `temp-${Date.now()}`,
          conversationId: activeIdRef.current,
          role: 'user',
          content: text,
          sources: [],
          metadata: {},
          createdAt: new Date().toISOString(),
        },
      ]);
      streamConversationRef.current = activeIdRef.current;

      start({
        conversationId: activeIdRef.current,
        message: text,
        // An attached document is prioritised for this turn. The backend still
        // verifies ownership and decides the route itself.
        documentId: attachment?.status === 'ready' ? attachment.documentId : null,
        critique,
        // A request, not a route: the server still decides and enforces it.
        webSearch,
      });

      // The attachment applies to the message just sent.
      setAttachment(null);
    },
    [attachment, critique, webSearch, isStreaming, start],
  );

  const showStreaming = streamConversationRef.current === activeId || (!activeId && stream.active);

  return (
    <ChatWindow
      activeId={activeId}
      messages={messages}
      streaming={showStreaming ? stream : { active: false }}
      isStreaming={isStreaming}
      attachment={attachment}
      onAttach={attachFile}
      onRemoveAttachment={removeAttachment}
      onOpenLibrary={onOpenLibrary}
      critique={critique}
      onCritiqueChange={setCritique}
      webSearch={webSearch}
      onWebSearchChange={setWebSearch}
      // The health check reports whether a search provider is configured, so
      // the button is disabled rather than silently doing nothing.
      webSearchAvailable={health?.rag?.webSearch !== false}
      error={error || externalError}
      onDismissError={() => {
        setError(null);
        onDismissExternalError?.();
      }}
      onSend={sendMessage}
      onStop={stop}
      onOpenSidebar={onOpenSidebar}
      disabled={health?.rag?.state === 'failed'}
      loadingMessages={loadingMessages}
      quota={quota}
    />
  );
}
