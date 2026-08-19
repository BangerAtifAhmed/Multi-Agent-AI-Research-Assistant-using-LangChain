import { memo } from 'react';

function ErrorBanner({ message, onDismiss, onRetry }) {
  if (!message) return null;

  return (
    <div className="error-banner" role="alert">
      <span className="error-banner__icon" aria-hidden="true">
        !
      </span>
      <span className="error-banner__text">{message}</span>
      {onRetry && (
        <button type="button" className="error-banner__action" onClick={onRetry}>
          Retry
        </button>
      )}
      {onDismiss && (
        <button
          type="button"
          className="error-banner__action"
          onClick={onDismiss}
          aria-label="Dismiss"
        >
          ✕
        </button>
      )}
    </div>
  );
}

export default memo(ErrorBanner);
