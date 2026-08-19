import { memo } from 'react';

/** Shown between sending a message and the first streamed token. */
function LoadingIndicator({ label = 'Thinking' }) {
  return (
    <div className="loading" role="status" aria-live="polite">
      <span className="loading__dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span className="loading__label">{label}</span>
    </div>
  );
}

export default memo(LoadingIndicator);
