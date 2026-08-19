import { useEffect, useRef, useState } from 'react';

import conversationApi from '../services/conversationApi.js';

const DEBOUNCE_MS = 275;
const MIN_LENGTH = 2;

/**
 * Debounced, server-side conversation search.
 *
 * The query runs in PostgreSQL scoped to the session's user; the browser never
 * downloads every conversation to filter locally. In-flight requests are
 * aborted when the term changes, so results cannot arrive out of order.
 */
export function useConversationSearch(term) {
  const [results, setResults] = useState(null);
  const [searching, setSearching] = useState(false);
  const controllerRef = useRef(null);

  useEffect(() => {
    const clean = term.trim();

    controllerRef.current?.abort();

    if (clean.length < MIN_LENGTH) {
      setResults(null);
      setSearching(false);
      return undefined;
    }

    setSearching(true);
    const timer = setTimeout(async () => {
      const controller = new AbortController();
      controllerRef.current = controller;
      try {
        setResults(await conversationApi.searchConversations(clean, controller.signal));
      } catch (error) {
        if (error?.name !== 'AbortError') setResults([]);
      } finally {
        if (!controller.signal.aborted) setSearching(false);
      }
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [term]);

  useEffect(() => () => controllerRef.current?.abort(), []);

  return { results, searching };
}

export default useConversationSearch;
