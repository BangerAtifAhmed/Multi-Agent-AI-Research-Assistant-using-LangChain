import { memo, useState } from 'react';

import ProcessingProgress from './ProcessingProgress.jsx';
import { formatDateTime } from '../utils/date.js';

const formatSize = (bytes) => {
  if (!bytes) return '—';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

/** Every stage the ingestion pipeline can report. */
const STATUS = {
  pending: { label: 'Queued', busy: true },
  uploading: { label: 'Uploading', busy: true },
  extracting: { label: 'Extracting text', busy: true },
  ocr: { label: 'Running OCR', busy: true, hint: 'Scanned pages detected' },
  chunking: { label: 'Chunking', busy: true },
  embedding: { label: 'Generating embeddings', busy: true },
  processing: { label: 'Processing', busy: true },
  ready: { label: 'Ready', busy: false },
  failed: { label: 'Failed', busy: false },
};

function DocumentCard({ document, onDelete }) {
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const status = STATUS[document.status] ?? { label: document.status, busy: false };
  const info = document.extractionInfo ?? {};

  const remove = async () => {
    setDeleting(true);
    try {
      await onDelete(document.id);
    } finally {
      setDeleting(false);
      setConfirming(false);
    }
  };

  return (
    <article className="doc-card">
      <div className="doc-card__icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="20" height="20">
          <path
            d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinejoin="round"
          />
          <path d="M14 3v5h5" fill="none" stroke="currentColor" strokeWidth="1.7" />
        </svg>
      </div>

      <div className="doc-card__body">
        <h3 className="doc-card__title" title={document.originalFilename}>
          {document.originalFilename}
        </h3>
        <p className="doc-card__meta">
          {formatSize(document.fileSize)} · Uploaded {formatDateTime(document.createdAt)}
        </p>

        <div className="doc-card__tags">
          <span className={`badge badge--${document.status}`}>
            {status.busy && <span className="badge__spinner" aria-hidden="true" />}
            {status.label}
          </span>

          {document.status === 'ready' && (
            <span className="badge">{document.chunkCount} chunks</span>
          )}
          {document.status === 'ready' && info.pageCount != null && (
            <span className="badge">{info.pageCount} pages</span>
          )}
          {document.status === 'ready' && info.slideCount != null && (
            <span className="badge">{info.slideCount} slides</span>
          )}
          {document.status === 'ready' && info.usedOcr && (
            <span className="badge badge--ocr" title={`${info.ocrPages} page(s) read with OCR`}>
              OCR
            </span>
          )}
          {status.busy && status.hint && <span className="doc-card__hint">{status.hint}</span>}
        </div>

        {/* Live counters while the pipeline is still working on this document.
            The Library already polls, so this costs no extra requests. */}
        {status.busy && (
          <div className="doc-card__progress">
            <ProcessingProgress document={document} />
          </div>
        )}

        {document.status === 'failed' && document.errorMessage && (
          <p className="doc-card__error">{document.errorMessage}</p>
        )}
      </div>

      {confirming ? (
        <div className="doc-card__confirm">
          <button
            type="button"
            className="btn btn--danger btn--sm"
            onClick={remove}
            disabled={deleting}
          >
            {deleting ? 'Deleting…' : 'Delete'}
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => setConfirming(false)}
            disabled={deleting}
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => setConfirming(true)}
          aria-label={`Delete ${document.originalFilename}`}
        >
          Delete
        </button>
      )}
    </article>
  );
}

export default memo(DocumentCard);
