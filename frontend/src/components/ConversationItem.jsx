import { memo, useEffect, useRef, useState } from 'react';

/**
 * One row in the sidebar, with a three-dot menu: Rename, Pin/Unpin, Delete.
 */
function ConversationItem({ conversation, active, onSelect, onDelete, onPin, onRename }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(conversation.title);
  const wrapperRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    if (!menuOpen && !confirming) return undefined;
    const close = (event) => {
      if (!wrapperRef.current?.contains(event.target)) {
        setMenuOpen(false);
        setConfirming(false);
      }
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menuOpen, confirming]);

  useEffect(() => {
    if (renaming) inputRef.current?.select();
  }, [renaming]);

  const commitRename = () => {
    const title = draft.trim();
    setRenaming(false);
    if (title && title !== conversation.title) onRename(conversation.id, title);
    else setDraft(conversation.title);
  };

  if (renaming) {
    return (
      <div className="conversation is-renaming">
        <input
          ref={inputRef}
          className="conversation__rename"
          value={draft}
          maxLength={60}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commitRename}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commitRename();
            if (event.key === 'Escape') {
              setDraft(conversation.title);
              setRenaming(false);
            }
          }}
        />
      </div>
    );
  }

  return (
    <div className={`conversation ${active ? 'is-active' : ''}`} ref={wrapperRef}>
      <button
        type="button"
        className="conversation__main"
        onClick={() => onSelect(conversation.id)}
        title={conversation.title}
      >
        {conversation.pinned && (
          <span className="conversation__pin" aria-label="Pinned">
            📌
          </span>
        )}
        <span className="conversation__title">{conversation.title}</span>
        {conversation.snippet && (
          <span className="conversation__snippet">{conversation.snippet}</span>
        )}
      </button>

      <button
        type="button"
        className="conversation__action"
        onClick={() => setMenuOpen((open) => !open)}
        aria-label={`Options for ${conversation.title}`}
        aria-expanded={menuOpen}
      >
        <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
          <circle cx="12" cy="5" r="1.6" fill="currentColor" />
          <circle cx="12" cy="12" r="1.6" fill="currentColor" />
          <circle cx="12" cy="19" r="1.6" fill="currentColor" />
        </svg>
      </button>

      {menuOpen && (
        <div className="menu" role="menu">
          {confirming ? (
            <>
              <p className="menu__confirm">Delete this chat?</p>
              <button
                type="button"
                className="menu__item menu__item--danger"
                onClick={() => {
                  setMenuOpen(false);
                  setConfirming(false);
                  onDelete(conversation.id);
                }}
              >
                Yes, delete
              </button>
              <button type="button" className="menu__item" onClick={() => setConfirming(false)}>
                Cancel
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="menu__item"
                onClick={() => {
                  setMenuOpen(false);
                  setDraft(conversation.title);
                  setRenaming(true);
                }}
              >
                Rename
              </button>
              <button
                type="button"
                className="menu__item"
                onClick={() => {
                  setMenuOpen(false);
                  onPin(conversation.id, !conversation.pinned);
                }}
              >
                {conversation.pinned ? 'Unpin' : 'Pin'}
              </button>
              <button
                type="button"
                className="menu__item menu__item--danger"
                onClick={() => setConfirming(true)}
              >
                Delete
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default memo(ConversationItem);
