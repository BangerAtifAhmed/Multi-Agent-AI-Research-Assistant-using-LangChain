import { memo } from 'react';

import useAutoScroll from '../hooks/useAutoScroll.js';
import ChatInput from './ChatInput.jsx';
import EmptyState from './EmptyState.jsx';
import ErrorBanner from './ErrorBanner.jsx';
import MessageList from './MessageList.jsx';

/**
 * The chat pane. There is no mode selector: routing between the model, the
 * user's documents and the web is decided by the backend per message.
 */
function ChatWindow({
  messages,
  streaming,
  isStreaming,
  attachment,
  onAttach,
  webSearch,
  onWebSearchChange,
  webSearchAvailable,
  onRemoveAttachment,
  onOpenLibrary,
  critique,
  onCritiqueChange,
  error,
  onDismissError,
  onSend,
  onStop,
  onOpenSidebar,
  disabled,
  loadingMessages,
  quota,
}) {
  const { containerRef, pinnedToBottom, handleScroll, scrollToBottom } = useAutoScroll([
    messages.length,
    streaming?.content,
    streaming?.active,
  ]);

  const showEmpty = !loadingMessages && !messages.length && !streaming?.active;
  const heading =
    messages.find((message) => message.role === 'user')?.content?.slice(0, 60) || 'New chat';

  return (
    <main className="chat">
      <header className="chat__header">
        <button
          type="button"
          className="chat__menu"
          onClick={onOpenSidebar}
          aria-label="Open menu"
        >
          ☰
        </button>

        <h1 className="chat__title" title={heading}>
          {heading}
        </h1>

        <div className="chat__controls">
          <label className="toggle" title="Run the critic agent on each answer">
            <input
              type="checkbox"
              checked={critique}
              onChange={(event) => onCritiqueChange(event.target.checked)}
              disabled={isStreaming}
            />
            <span>Critic</span>
          </label>
        </div>
      </header>

      <div className="chat__scroll" ref={containerRef} onScroll={handleScroll}>
        <div className="chat__inner">
          {showEmpty ? (
            <EmptyState onPick={(suggestion) => onSend(suggestion)} onOpenLibrary={onOpenLibrary} />
          ) : (
            <MessageList messages={messages} streaming={streaming} />
          )}
        </div>
      </div>

      {!pinnedToBottom && (
        <button
          type="button"
          className="scroll-down"
          onClick={() => scrollToBottom()}
          aria-label="Scroll to latest"
        >
          ↓
        </button>
      )}

      <div className="chat__footer">
        <ErrorBanner message={error} onDismiss={onDismissError} />
        <ChatInput
          onSend={onSend}
          onStop={onStop}
          onAttach={onAttach}
          webSearch={webSearch}
          onWebSearchChange={onWebSearchChange}
          webSearchAvailable={webSearchAvailable}
          onRemoveAttachment={onRemoveAttachment}
          attachment={attachment}
          isStreaming={isStreaming}
          disabled={disabled}
          quota={quota}
          placeholder="Ask anything…"
        />
      </div>
    </main>
  );
}

export default memo(ChatWindow);
