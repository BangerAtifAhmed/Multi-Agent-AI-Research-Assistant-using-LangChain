import { memo, useState } from 'react';

import { formatTime } from '../utils/date.js';
import LoadingIndicator from './LoadingIndicator.jsx';
import MarkdownRenderer from './MarkdownRenderer.jsx';
import RetrievalHint from './RetrievalHint.jsx';
import SourceList from './SourceList.jsx';

function CritiqueBlock({ critique }) {
  const [open, setOpen] = useState(false);
  if (!critique?.trim()) return null;

  return (
    <div className="critique">
      <button type="button" className="critique__toggle" onClick={() => setOpen((v) => !v)}>
        <span className={`sources__caret ${open ? 'is-open' : ''}`} aria-hidden="true">
          ▸
        </span>
        Critic review
      </button>
      {open && <MarkdownRenderer content={critique} />}
    </div>
  );
}

/**
 * One chat bubble. Memoised so streaming a new answer does not re-render the
 * messages already on screen.
 */
function Message({ message, streaming = false, status = null }) {
  const isUser = message.role === 'user';
  const showLoader = streaming && !message.content;

  return (
    <article className={`message message--${message.role}`}>
      <div className="message__avatar" aria-hidden="true">
        {isUser ? 'You' : 'AI'}
      </div>

      <div className="message__body">
        {isUser ? (
          <p className="message__text">{message.content}</p>
        ) : showLoader ? (
          <LoadingIndicator label={status?.label || 'Thinking'} />
        ) : (
          <>
            <MarkdownRenderer content={message.content} streaming={streaming} />
            {streaming && <span className="cursor" aria-hidden="true" />}
          </>
        )}

        {!isUser && <SourceList sources={message.sources} />}
        {!isUser && !streaming && <CritiqueBlock critique={message.metadata?.critique} />}

        <div className="message__meta">
          {message.createdAt && <span>{formatTime(message.createdAt)}</span>}
          {!isUser && <RetrievalHint sources={message.sources} />}
          {message.metadata?.finishReason === 'aborted' && (
            <span className="message__badge">stopped</span>
          )}
        </div>
      </div>
    </article>
  );
}

export default memo(Message);
