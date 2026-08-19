import { useCallback, useEffect, useState } from 'react';

import conversationApi from '../services/conversationApi.js';

/**
 * Sidebar state: the conversation list plus create/select/delete.
 *
 * The list is kept in local state and patched in place, so streaming a reply
 * never triggers a refetch of every conversation.
 */
export function useConversations({ onError } = {}) {
  const [conversations, setConversations] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      setConversations(await conversationApi.listConversations());
    } catch (error) {
      onError?.(error.message);
    } finally {
      setLoading(false);
    }
  }, [onError]);

  useEffect(() => {
    load();
  }, [load]);

  /** Insert or update one conversation without refetching the list. */
  const upsert = useCallback((conversation) => {
    if (!conversation) return;
    setConversations((prev) => {
      const rest = prev.filter((item) => item.id !== conversation.id);
      return [conversation, ...rest].sort(
        (a, b) => new Date(b.updatedAt) - new Date(a.updatedAt),
      );
    });
  }, []);

  /** Drops a conversation from the list only - the server already removed it. */
  const removeLocal = useCallback((id) => {
    setConversations((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const remove = useCallback(
    async (id) => {
      const snapshot = conversations;
      setConversations((prev) => prev.filter((item) => item.id !== id));
      try {
        await conversationApi.deleteConversation(id);
      } catch (error) {
        setConversations(snapshot);
        onError?.(error.message);
        throw error;
      }
    },
    [conversations, onError],
  );

  const rename = useCallback(
    async (id, title) => {
      try {
        upsert(await conversationApi.renameConversation(id, title));
      } catch (error) {
        onError?.(error.message);
      }
    },
    [onError, upsert],
  );

  return { conversations, loading, reload: load, upsert, remove, removeLocal, rename };
}

export default useConversations;
