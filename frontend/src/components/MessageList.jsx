import { memo } from 'react';

import Message from './Message.jsx';

/**
 * Committed messages plus, optionally, the message currently streaming.
 *
 * The streaming bubble is a separate element so only it re-renders as tokens
 * arrive; every finished message above it stays memoised and untouched.
 */
function MessageList({ messages, streaming }) {
  return (
    <div className="messages">
      {messages.map((message) => (
        <Message key={message.id} message={message} />
      ))}

      {streaming?.active && (
        <Message
          key={streaming.messageId || 'streaming'}
          message={{
            id: streaming.messageId || 'streaming',
            role: 'assistant',
            content: streaming.content,
            sources: streaming.sources,
            metadata: {},
          }}
          streaming
          status={streaming.status}
        />
      )}
    </div>
  );
}

export default memo(MessageList);
