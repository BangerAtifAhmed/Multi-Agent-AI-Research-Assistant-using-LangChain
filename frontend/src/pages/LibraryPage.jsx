import { useCallback, useEffect, useRef, useState } from 'react';

import DocumentCard from '../components/DocumentCard.jsx';
import ErrorBanner from '../components/ErrorBanner.jsx';
import documentApi from '../services/documentApi.js';

const TERMINAL_STATUSES = new Set(['ready', 'failed']);
const POLL_MS = 1500;

/**
 * The signed-in user's document library. The API only ever returns documents
 * owned by the session's user, so there is no client-side filtering here.
 *
 * Processing happens in the background, so while any document is mid-pipeline
 * the list is polled and each card shows its current stage.
 */
export default function LibraryPage({ onOpenSidebar, documents, loading, error, onRefresh }) {
  const [uploading, setUploading] = useState(false);
  const [localError, setLocalError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [formats, setFormats] = useState(null);
  const inputRef = useRef(null);

  useEffect(() => {
    documentApi.getFormats().then(setFormats).catch(() => setFormats(null));
  }, []);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(timer);
  }, [notice]);

  // Poll only while something is actually processing.
  const busy = documents.some((document) => !TERMINAL_STATUSES.has(document.status));
  useEffect(() => {
    if (!busy) return undefined;
    const timer = setInterval(onRefresh, POLL_MS);
    return () => clearInterval(timer);
  }, [busy, onRefresh]);

  const accept = (formats?.accepted ?? ['.pdf', '.doc', '.docx', '.ppt', '.pptx', '.txt', '.md'])
    .join(',');

  const supportedLabel = (formats?.accepted ?? ['.pdf', '.doc', '.docx', '.ppt', '.pptx', '.txt', '.md'])
    .map((extension) => extension.slice(1).toUpperCase())
    .join(', ');

  // Formats the server accepts but cannot currently process (missing tooling).
  const unavailable =
    formats?.supported && formats?.accepted
      ? formats.accepted.filter((extension) => !formats.supported.includes(extension))
      : [];

  const handleFile = useCallback(
    async (event) => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file) return;

      setLocalError(null);
      setUploading(true);
      try {
        const document = await documentApi.uploadDocument(file);
        setNotice(
          document.status === 'ready'
            ? `“${document.originalFilename}” is already indexed.`
            : `“${document.originalFilename}” uploaded — processing now.`,
        );
        await onRefresh();
      } catch (uploadError) {
        setLocalError(uploadError.message);
      } finally {
        setUploading(false);
      }
    },
    [onRefresh],
  );

  const handleDelete = useCallback(
    async (id) => {
      setLocalError(null);
      try {
        await documentApi.deleteDocument(id);
        setNotice('Document deleted.');
        await onRefresh();
      } catch (deleteError) {
        setLocalError(deleteError.message);
      }
    },
    [onRefresh],
  );

  const totalBytes = documents.reduce((sum, item) => sum + (item.fileSize || 0), 0);
  const maxMb = formats?.maxSizeBytes ? Math.round(formats.maxSizeBytes / (1024 * 1024)) : 25;

  return (
    <main className="chat">
      <header className="chat__header">
        <button type="button" className="chat__menu" onClick={onOpenSidebar} aria-label="Open menu">
          ☰
        </button>
        <h1 className="chat__title">Library</h1>

        <div className="chat__controls">
          <button
            type="button"
            className="btn btn--primary btn--sm"
            onClick={() => inputRef.current?.click()}
            disabled={uploading}
          >
            {uploading ? 'Uploading…' : '+ Upload Document'}
          </button>
          <input ref={inputRef} type="file" accept={accept} onChange={handleFile} hidden />
        </div>
      </header>

      <div className="chat__scroll">
        <div className="library">
          {(localError || error) && (
            <ErrorBanner message={localError || error} onDismiss={() => setLocalError(null)} />
          )}
          {notice && <div className="notice">{notice}</div>}

          {unavailable.length > 0 && (
            <div className="notice notice--busy">
              {unavailable.map((extension) => extension.slice(1).toUpperCase()).join(' and ')} upload
              is accepted but cannot be processed on this server yet
              {formats?.libreOffice === false ? ' (LibreOffice is not installed)' : ''}.
              {formats?.ocr === false && ' Scanned PDFs also need Tesseract OCR installed.'}
            </div>
          )}

          <div className="library__head">
            <div>
              <h2 className="library__heading">My Documents</h2>
              <p className="library__formats">
                Supported: {supportedLabel} · up to {maxMb} MB
              </p>
            </div>
            {documents.length > 0 && (
              <span className="library__meta">
                {documents.length} document{documents.length === 1 ? '' : 's'} ·{' '}
                {(totalBytes / (1024 * 1024)).toFixed(1)} MB
              </span>
            )}
          </div>

          {loading && <p className="library__empty">Loading your library…</p>}

          {!loading && !documents.length && (
            <div className="library__blank">
              <p className="library__blank-title">No documents yet</p>
              <p className="library__blank-text">
                Upload a {supportedLabel} file. It is extracted, chunked, embedded and stored
                privately in your library — only you can search it.
              </p>
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => inputRef.current?.click()}
              >
                + Upload Document
              </button>
            </div>
          )}

          <div className="library__grid">
            {documents.map((document) => (
              <DocumentCard key={document.id} document={document} onDelete={handleDelete} />
            ))}
          </div>
        </div>
      </div>
    </main>
  );
}
