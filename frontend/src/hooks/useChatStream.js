import { useCallback, useEffect, useRef, useState } from 'react';

import createChatStreamRunner, { IDLE_STREAM } from '../lib/chatStreamRunner.js';
import { sendMessageStream } from '../services/chatApi.js';

/**
 * Owns one in-flight assistant response.
 *
 * The lifecycle itself lives in chatStreamRunner, which guarantees that every
 * ending - completion, an error frame, a dead connection, Stop - clears
 * `active` exactly once. This hook only paints what the runner publishes.
 *
 * Tokens arrive from the network one at a time; React state is updated on an
 * animation frame instead of once per token, so a fast stream cannot flood the
 * renderer. The text itself is never delayed or faked - it is painted as soon
 * as the next frame runs.
 */
export function useChatStream({ onMeta, onQuota, onComplete } = {}) {
  const [stream, setStream] = useState(() => ({ ...IDLE_STREAM }));

  const frameRef = useRef(null);
  const pendingRef = useRef(null);
  const mountedRef = useRef(true);

  // Read through refs so the runner - and therefore start/stop/reset - stays
  // stable for the life of the component while still calling today's handlers.
  const metaRef = useRef(onMeta);
  const quotaRef = useRef(onQuota);
  const completeRef = useRef(onComplete);
  metaRef.current = onMeta;
  quotaRef.current = onQuota;
  completeRef.current = onComplete;

  const cancelFrame = useCallback(() => {
    if (frameRef.current != null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
  }, []);

  const applyState = useCallback(
    (patch) => {
      if (!mountedRef.current) return;
      // A terminal patch carries the final text, so a queued frame is stale.
      if (patch.active === false) cancelFrame();
      setStream((previous) => ({ ...previous, ...patch }));
    },
    [cancelFrame],
  );

  const applyTokens = useCallback((text) => {
    if (!mountedRef.current) return;
    pendingRef.current = text;
    if (frameRef.current != null) return;

    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      if (!mountedRef.current) return;
      const next = pendingRef.current;
      if (!next) return;
      // Once the turn has ended its final text is already painted; a frame that
      // lands afterwards must not reinstate a partial answer.
      setStream((previous) => (previous.active ? { ...previous, ...next } : previous));
    });
  }, []);

  const runnerRef = useRef(null);
  if (runnerRef.current === null) {
    runnerRef.current = createChatStreamRunner({
      send: sendMessageStream,
      onState: applyState,
      onTokens: applyTokens,
      onMeta: (data) => metaRef.current?.(data),
      onQuota: (quota) => quotaRef.current?.(quota),
      onComplete: (summary) => completeRef.current?.(summary),
    });
  }

  useEffect(() => {
    // Set on every mount, not just the first: React remounts components (in
    // StrictMode, and when an Offscreen subtree is restored) without rebuilding
    // refs, and a flag left false here would silently drop the update that
    // clears `active` - leaving the Stop button on with no way to send again.
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
      cancelFrame();
      runnerRef.current?.stop();
    };
  }, [cancelFrame]);

  const start = useCallback((payload) => runnerRef.current.start(payload), []);
  const stop = useCallback(() => runnerRef.current.stop(), []);
  const reset = useCallback(() => runnerRef.current.reset(), []);

  return { stream, start, stop, reset, isStreaming: stream.active };
}

export default useChatStream;
