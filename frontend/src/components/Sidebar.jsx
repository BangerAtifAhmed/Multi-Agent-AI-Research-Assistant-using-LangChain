import { memo, useMemo, useState } from 'react';

import useConversationSearch from '../hooks/useConversationSearch.js';
import groupConversations from '../utils/groupConversations.js';
import ConversationItem from './ConversationItem.jsx';

/**
 * New chat, conversation search, pinned + recent history, then Library/Profile.
 * Memoised so streaming tokens never re-render it.
 */
function Sidebar({
  conversations,
  activeId,
  loading,
  view,
  onSelect,
  onDelete,
  onPin,
  onRename,
  onNewChat,
  onNavigate,
  onLogout,
  open,
  onClose,
  user,
  health,
}) {
  const [term, setTerm] = useState('');
  const { results, searching } = useConversationSearch(term);

  const searching_ = term.trim().length >= 2;
  const list = results ?? conversations;

  const pinned = useMemo(() => list.filter((item) => item.pinned), [list]);
  const unpinned = useMemo(() => list.filter((item) => !item.pinned), [list]);
  // Search results stay in relevance order; the normal list is grouped by day.
  const groups = useMemo(
    () => (searching_ ? [{ label: 'Results', items: unpinned }] : groupConversations(unpinned)),
    [searching_, unpinned],
  );

  const itemProps = { onSelect, onDelete, onPin, onRename };

  return (
    <aside className={`sidebar ${open ? 'is-open' : ''}`}>
      <div className="sidebar__head">
        <button type="button" className="btn btn--new" onClick={onNewChat}>
          <span aria-hidden="true">+</span> New Chat
        </button>
        <button type="button" className="sidebar__close" onClick={onClose} aria-label="Close menu">
          ✕
        </button>
      </div>

      <div className="sidebar__search">
        <span className="sidebar__search-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="14" height="14">
            <circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
            <line
              x1="16"
              y1="16"
              x2="21"
              y2="21"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
          </svg>
        </span>
        <input
          className="sidebar__search-input"
          type="search"
          value={term}
          onChange={(event) => setTerm(event.target.value)}
          placeholder="Search conversations"
          aria-label="Search conversations"
        />
        {term && (
          <button
            type="button"
            className="sidebar__search-clear"
            onClick={() => setTerm('')}
            aria-label="Clear search"
          >
            ✕
          </button>
        )}
      </div>

      <div className="sidebar__list" aria-label="Conversations">
        {loading && !searching_ && <p className="sidebar__empty">Loading…</p>}
        {searching && <p className="sidebar__empty">Searching…</p>}

        {!loading && !searching && !list.length && (
          <p className="sidebar__empty">
            {searching_ ? `No conversations match “${term.trim()}”.` : 'No conversations yet.'}
          </p>
        )}

        {pinned.length > 0 && (
          <section className="sidebar__group">
            <h3 className="sidebar__group-label">Pinned</h3>
            {pinned.map((conversation) => (
              <ConversationItem
                key={conversation.id}
                conversation={conversation}
                active={view === 'chat' && conversation.id === activeId}
                {...itemProps}
              />
            ))}
          </section>
        )}

        {groups.map((group) => (
          <section key={group.label} className="sidebar__group">
            <h3 className="sidebar__group-label">
              {searching_ ? group.label : group.label === 'Today' && !pinned.length ? 'Recent' : group.label}
            </h3>
            {group.items.map((conversation) => (
              <ConversationItem
                key={conversation.id}
                conversation={conversation}
                active={view === 'chat' && conversation.id === activeId}
                {...itemProps}
              />
            ))}
          </section>
        ))}
      </div>

      <div className="sidebar__foot">
        <button
          type="button"
          className={`sidebar__link ${view === 'library' ? 'is-active' : ''}`}
          onClick={() => onNavigate('library')}
        >
          <span className="sidebar__link-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="16" height="16">
              <path
                d="M4 5.5A1.5 1.5 0 0 1 5.5 4H9l2 2h7.5A1.5 1.5 0 0 1 20 7.5v11A1.5 1.5 0 0 1 18.5 20h-13A1.5 1.5 0 0 1 4 18.5v-13Z"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          Library
        </button>

        <div className="sidebar__health">
          <span
            className={`status-dot status-dot--${
              health?.status === 'ok' ? 'ready' : health?.status === 'degraded' ? 'starting' : 'failed'
            }`}
            aria-hidden="true"
          />
          <span className="sidebar__status-text">
            {health?.rag?.state === 'ready'
              ? 'RAG engine ready'
              : health?.rag?.state === 'starting'
                ? 'Starting RAG engine…'
                : health?.status === 'degraded'
                  ? 'Running (cache offline)'
                  : health
                    ? 'RAG engine unavailable'
                    : 'Connecting…'}
          </span>
        </div>

        <button
          type="button"
          className={`sidebar__user ${view === 'profile' ? 'is-active' : ''}`}
          onClick={() => onNavigate('profile')}
        >
          {user?.avatarUrl ? (
            <img className="sidebar__avatar" src={user.avatarUrl} alt="" />
          ) : (
            <span className="sidebar__avatar sidebar__avatar--initials" aria-hidden="true">
              {(user?.name ?? '?').slice(0, 1).toUpperCase()}
            </span>
          )}
          <span className="sidebar__user-name">{user?.name}</span>
        </button>

        <button type="button" className="sidebar__link sidebar__link--muted" onClick={onLogout}>
          <span className="sidebar__link-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="16" height="16">
              <path
                d="M15 17l5-5-5-5M20 12H9M12 20H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h6"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          Log out
        </button>
      </div>
    </aside>
  );
}

export default memo(Sidebar);
