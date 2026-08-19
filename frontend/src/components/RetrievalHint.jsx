import { memo } from 'react';

/**
 * A subtle note about where the answer's context came from.
 *
 * Derived from the sources that were actually used, not from the router's
 * decision, so it can never claim a retrieval that did not happen. Plain
 * language only - no routes, confidences or other internals.
 */
function RetrievalHint({ sources }) {
  if (!sources?.length) return null;

  const usedDocuments = sources.some((source) => source.type === 'document');
  const usedWeb = sources.some((source) => source.type === 'web');

  const label =
    usedDocuments && usedWeb
      ? 'Used your documents + web'
      : usedDocuments
        ? 'Used your documents'
        : usedWeb
          ? 'Searched the web'
          : null;

  if (!label) return null;

  return (
    <span className="retrieval-hint">
      <span className="retrieval-hint__dot" aria-hidden="true" />
      {label}
    </span>
  );
}

export default memo(RetrievalHint);
