import { memo } from 'react';

const SUGGESTIONS = [
  'What is retrieval-augmented generation?',
  'Summarise the key points of my document',
  'What are the latest developments in AI?',
  'Compare my document with current research',
];

/**
 * The opening screen. It no longer asks the user to choose a mode - the
 * suggestions simply hint at the range of things the router handles.
 */
function EmptyState({ onPick, onOpenLibrary }) {
  return (
    <div className="empty">
      <div className="empty__mark" aria-hidden="true">
        <svg viewBox="0 0 32 32" width="40" height="40">
          <circle cx="14" cy="14" r="8" fill="none" stroke="currentColor" strokeWidth="2.4" />
          <line
            x1="20"
            y1="20"
            x2="27"
            y2="27"
            stroke="currentColor"
            strokeWidth="2.8"
            strokeLinecap="round"
          />
        </svg>
      </div>

      <h1 className="empty__title">Ask anything</h1>
      <p className="empty__subtitle">
        Answers come from the model, your documents, or the web — whichever fits the question.
        Attach a file with 📎 to ask about it directly.
      </p>

      <div className="empty__suggestions">
        {SUGGESTIONS.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            className="empty__suggestion"
            onClick={() => onPick(suggestion)}
          >
            {suggestion}
          </button>
        ))}
      </div>

      <button type="button" className="empty__library-link" onClick={onOpenLibrary}>
        Manage your document library
      </button>
    </div>
  );
}

export default memo(EmptyState);
