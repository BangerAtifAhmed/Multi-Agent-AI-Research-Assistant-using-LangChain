import { memo } from 'react';

/**
 * One retrieved citation. Only fields the RAG pipeline actually returned are
 * shown - nothing here is inferred or invented.
 */
function SourceCard({ source }) {
  const isWeb = source.type === 'web';
  const hostname = (() => {
    if (!source.url) return null;
    try {
      return new URL(source.url).hostname.replace(/^www\./, '');
    } catch {
      return null;
    }
  })();

  const body = (
    <>
      <div className="source-card__head">
        <span className="source-card__index">{source.index}</span>
        <span className="source-card__title" title={source.title || ''}>
          {source.title || source.documentName || 'Source'}
        </span>
      </div>

      <div className="source-card__meta">
        {isWeb ? (
          hostname && <span className="source-card__chip">{hostname}</span>
        ) : (
          <>
            <span className="source-card__chip">{source.documentName}</span>
            {/* Per-format locator: only whatever the extractor actually recorded. */}
            {source.page != null && <span className="source-card__chip">p. {source.page}</span>}
            {source.slide != null && (
              <span className="source-card__chip">slide {source.slide}</span>
            )}
            {source.paragraph != null && source.page == null && source.slide == null && (
              <span className="source-card__chip">¶ {source.paragraph}</span>
            )}
            {source.line != null && source.page == null && source.slide == null && (
              <span className="source-card__chip">line {source.line}</span>
            )}
            {source.section && (
              <span className="source-card__chip" title={source.section}>
                {source.section}
              </span>
            )}
          </>
        )}
        {typeof source.score === 'number' && (
          <span className="source-card__chip source-card__chip--score" title="Relevance score">
            {source.score.toFixed(2)}
          </span>
        )}
      </div>

      {source.snippet && <p className="source-card__snippet">{source.snippet}</p>}
    </>
  );

  return isWeb && source.url ? (
    <a className="source-card" href={source.url} target="_blank" rel="noopener noreferrer">
      {body}
    </a>
  ) : (
    <div className="source-card">{body}</div>
  );
}

export default memo(SourceCard);
