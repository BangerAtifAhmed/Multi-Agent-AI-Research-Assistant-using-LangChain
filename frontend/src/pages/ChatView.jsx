import { useCallback, useEffect, useRef, useState } from 'react';

import ChatWindow from '../components/ChatWindow.jsx';
import useChatStream from '../hooks/useChatStream.js';
import conversationApi from '../services/conversationApi.js';
import documentApi from '../services/documentApi.js';

const TERMINAL = new Set(['ready', 'failed']);
const POLL_MS = 1200;

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

  // The document attached to the *next* message, if any.
  const [attachment, setAttachment] = useState(null);

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
    }) => {
      const conversationId = streamConversationRef.current;
      streamConversationRef.current = null;

      if (streamError) setError(streamError);

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
    onComplete: handleComplete,
  });

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
      setAttachment({ name: file.name, status: 'uploading', documentId: null });

      try {
        const document = await documentApi.uploadDocument(file);
        onDocumentsChanged?.();

        let current = document;
        for (let attempt = 0; attempt < 300 && !TERMINAL.has(current.status); attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, POLL_MS));
          const list = await documentApi.listDocuments();
          current = list.find((item) => item.id === document.id) ?? current;
        }
        onDocumentsChanged?.();

        if (current.status === 'ready') {
          setAttachment({ name: current.originalFilename, status: 'ready', documentId: current.id });
        } else {
          setAttachment({
            name: current.originalFilename ?? file.name,
            status: 'failed',
            documentId: null,
            error: current.errorMessage || 'Could not process this file',
          });
        }
      } catch (uploadError) {
        setAttachment({ name: file.name, status: 'failed', documentId: null, error: uploadError.message });
      }
    },
    [onDocumentsChanged],
  );

  /** Clears the pending attachment only - the document stays in the Library. */
  const removeAttachment = useCallback(() => setAttachment(null), []);

  const sendMessage = useCallback(
    (text) => {
      if (isStreaming) return;
      if (attachment?.status === 'uploading') {
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
      });

      // The attachment applies to the message just sent.
      setAttachment(null);
    },
    [attachment, critique, isStreaming, start],
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
    />
  );
}
