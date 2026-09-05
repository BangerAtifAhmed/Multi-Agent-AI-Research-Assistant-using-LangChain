import { useCallback, useEffect, useRef, useState } from 'react';


const BOTTOM_THRESHOLD_PX = 90;

/**
 * Keeps the newest content visible while streaming, but yields control the
 * moment the user scrolls up - scrolling back down re-arms it.
 */
export function useAutoScroll(dependencies = []) {
  const containerRef = useRef(null);
  const [pinnedToBottom, setPinnedToBottom] = useState(true);

  const isNearBottom = useCallback(() => {
    const element = containerRef.current;
    if (!element) return true;
    return (
      element.scrollHeight - element.scrollTop - element.clientHeight <= BOTTOM_THRESHOLD_PX
    );
  }, []);

  const handleScroll = useCallback(() => {
    setPinnedToBottom(isNearBottom());
  }, [isNearBottom]);

  const scrollToBottom = useCallback((behavior = 'smooth') => {
    const element = containerRef.current;
    if (!element) return;
    element.scrollTo({ top: element.scrollHeight, behavior });
    setPinnedToBottom(true);
  }, []);

  useEffect(() => {
    if (!pinnedToBottom) return;
    const element = containerRef.current;
    if (!element) return;
    // 'auto' during streaming: smooth scrolling per token feels laggy.
    element.scrollTop = element.scrollHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, dependencies);

  return { containerRef, pinnedToBottom, handleScroll, scrollToBottom };
}

export default useAutoScroll;
