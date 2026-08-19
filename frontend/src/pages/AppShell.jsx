import { useCallback, useEffect, useRef, useState } from 'react';

import Sidebar from '../components/Sidebar.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import useConversations from '../hooks/useConversations.js';
import conversationApi from '../services/conversationApi.js';
import documentApi from '../services/documentApi.js';
import ChatView from './ChatView.jsx';
import LibraryPage from './LibraryPage.jsx';
import ProfilePage from './ProfilePage.jsx';

const HEALTH_POLL_MS = 15_000;

/**
 * The authenticated application: sidebar plus one of the three views.
 *
 * ChatView stays mounted while Library or Profile is open, so navigating away
 * mid-answer does not abort the stream.
 */
export default function AppShell() {
  const { user, logout } = useAuth();

  const [view, setView] = useState('chat');
  const [activeId, setActiveId] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [error, setError] = useState(null);

  const [documents, setDocuments] = useState([]);
  const [documentsLoading, setDocumentsLoading] = useState(true);
  const [health, setHealth] = useState(null);

  const activeIdRef = useRef(null);
  activeIdRef.current = activeId;

  const { conversations, loading, upsert, remove, removeLocal } = useConversations({
    onError: setError,
  });

  const loadDocuments = useCallback(async () => {
    try {
      setDocuments(await documentApi.listDocuments());
    } catch (loadError) {
      setError(loadError.message);
    } finally {
      setDocumentsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDocuments();
  }, [loadDocuments]);

  useEffect(() => {
    let cancelled = false;
    let timer;

    const poll = async () => {
      try {
        const result = await documentApi.getHealth();
        if (!cancelled) setHealth(result);
      } catch {
        if (!cancelled) setHealth({ status: 'unhealthy' });
      }
      // Poll quickly until the RAG engine is warm, then back off.
      const delay = health?.rag?.state === 'ready' ? HEALTH_POLL_MS : 5000;
      if (!cancelled) timer = setTimeout(poll, delay);
    };

    poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [health?.rag?.state === 'ready']);

  const selectConversation = useCallback((id) => {
    setActiveId(id);
    setView('chat');
    setSidebarOpen(false);
    setError(null);
  }, []);

  const startNewChat = useCallback(() => {
    setView('chat');
    setSidebarOpen(false);
    setError(null);
    // A draft chat: the conversation row is created with the first message, so
    // clicking "New Chat" repeatedly never leaves empty rows behind.
    setActiveId(null);
  }, []);

  const deleteConversation = useCallback(
    async (id) => {
      try {
        await remove(id);
        if (activeIdRef.current === id) setActiveId(null);
      } catch {
        /* surfaced by useConversations */
      }
    },
    [remove],
  );

  const pinConversation = useCallback(
    async (id, pinned) => {
      try {
        upsert(await conversationApi.setPinned(id, pinned));
      } catch (pinError) {
        setError(pinError.message);
      }
    },
    [upsert],
  );

  const renameConversation = useCallback(
    async (id, title) => {
      try {
        upsert(await conversationApi.renameConversation(id, title));
      } catch (renameError) {
        setError(renameError.message);
      }
    },
    [upsert],
  );

  const navigate = useCallback((next) => {
    setView(next);
    setSidebarOpen(false);
    setError(null);
  }, []);

  return (
    <div className="layout">
      {sidebarOpen && (
        <div className="scrim" onClick={() => setSidebarOpen(false)} aria-hidden="true" />
      )}

      <Sidebar
        conversations={conversations}
        activeId={activeId}
        loading={loading}
        view={view}
        onSelect={selectConversation}
        onDelete={deleteConversation}
        onPin={pinConversation}
        onRename={renameConversation}
        onNewChat={startNewChat}
        onNavigate={navigate}
        onLogout={logout}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        user={user}
        health={health}
      />

      <div className="view" hidden={view !== 'chat'}>
        <ChatView
          activeId={activeId}
          setActiveId={setActiveId}
          documents={documents}
          onDocumentsChanged={loadDocuments}
          conversationsUpsert={upsert}
          conversationsRemoveLocal={removeLocal}
          onOpenSidebar={() => setSidebarOpen(true)}
          onOpenLibrary={() => navigate('library')}
          externalError={error}
          onDismissExternalError={() => setError(null)}
          health={health}
        />
      </div>

      {view === 'library' && (
        <LibraryPage
          documents={documents}
          loading={documentsLoading}
          error={error}
          onRefresh={loadDocuments}
          onOpenSidebar={() => setSidebarOpen(true)}
        />
      )}

      {view === 'profile' && <ProfilePage onOpenSidebar={() => setSidebarOpen(true)} />}
    </div>
  );
}
