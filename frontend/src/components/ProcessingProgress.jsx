import { describeProgress } from '../lib/uploadProgress.js';

/**
 * Live progress for a document being ingested.
 *
 * Everything shown comes from counters the server measured. When no ratio is
 * available - which is normal while extraction and embedding overlap - the bar
 * is indeterminate rather than showing an invented percentage.
 *
 * @param {object} props
 * @param {object} props.document      document as returned by the API
 * @param {number} [props.uploadPercent]  bytes-sent percentage, while uploading
 * @param {boolean} [props.backgrounded]  the UI stopped waiting; work continues
 * @param {boolean} [props.compact]    single line, for the composer chip
 */
export default function ProcessingProgress({
  document,
  uploadPercent,
  backgrounded = false,
  compact = false,
}) {
  const { label, detail, percent, tone, done } = describeProgress(document, {
    uploadPercent,
    backgrounded,
  });

  const determinate = typeof percent === 'number';
  const text = detail ? `${label}: ${detail}` : label;

  return (
    <div
      className={`progress progress--${tone}${compact ? ' progress--compact' : ''}`}
      // One live region for the whole widget, so a screen reader announces
      // "Embedding: batch 8 of 32" rather than each fragment separately.
      role="status"
      aria-live="polite"
    >
      <span className="progress__label">
        {tone === 'done' && <span aria-hidden="true">✓ </span>}
        {text}
      </span>

      {!done && (
        <span
          className={`progress__track${determinate ? '' : ' progress__track--indeterminate'}`}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          // Omitting aria-valuenow is what marks a progressbar indeterminate.
          {...(determinate ? { 'aria-valuenow': percent } : {})}
          aria-label={text}
        >
          <span
            className="progress__fill"
            style={determinate ? { width: `${percent}%` } : undefined}
          />
        </span>
      )}
    </div>
  );
}
