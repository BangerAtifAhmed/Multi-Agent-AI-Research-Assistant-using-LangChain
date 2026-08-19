import { memo, useCallback, useEffect, useRef, useState } from 'react';
import ProcessingProgress from './ProcessingProgress.jsx';

const MAX_LENGTH = 8000;
const ACCEPT = '.pdf,.doc,.docx,.ppt,.pptx,.txt,.md';

/**
 * ChatGPT-style composer: multi-line, Enter to send, Shift+Enter for a newline,
 * a paperclip that uploads through the existing document pipeline, and a Stop
 * button while the answer is streaming.
 */
function ChatInput({
  onSend,
  onStop,
  onAttach,
  onRemoveAttachment,
  attachment,
  webSearch = false,
  onWebSearchChange,
  webSearchAvailable = true,
  isStreaming,
  disabled,
  placeholder = 'Ask anything…',
}) {
  const [value, setValue] = useState('');
  const textareaRef = useRef(null);
  const fileRef = useRef(null);

  const autoResize = useCallback(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 200)}px`;
  }, []);

  useEffect(autoResize, [value, autoResize]);

  useEffect(() => {
    if (!isStreaming) textareaRef.current?.focus();
  }, [isStreaming]);

  const submit = useCallback(() => {
    const text = value.trim();
    if (!text || isStreaming || disabled) return;
    setValue('');
    onSend(text);
  }, [disabled, isStreaming, onSend, value]);

  const handleKeyDown = (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  const handleFile = (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) onAttach?.(file);
  };

  const busy = attachment?.status === 'uploading' || attachment?.status === 'processing';

  return (
    <div className="composer">
      {isStreaming && (
        <div className="composer__stop-row">
          <button type="button" className="btn btn--stop" onClick={onStop}>
            <span className="btn__square" aria-hidden="true" />
            Stop
          </button>
        </div>
      )}

      <form
        className="composer__box"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {attachment && (
          <div className={`attachment attachment--${attachment.status}`}>
            <span className="attachment__icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="15" height="15">
                <path
                  d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinejoin="round"
                />
                <path d="M14 3v5h5" fill="none" stroke="currentColor" strokeWidth="1.7" />
              </svg>
            </span>

            <span className="attachment__name" title={attachment.name}>
              {attachment.name}
            </span>

            <span className="attachment__state">
              {attachment.status === 'failed' ? (
                attachment.error || 'Upload failed'
              ) : (
                <ProcessingProgress
                  compact
                  // While uploading there is no server document yet, so the
                  // status is supplied directly and the percentage is the
                  // browser's own count of bytes sent.
                  document={attachment.document ?? { status: attachment.status }}
                  uploadPercent={attachment.uploadPercent}
                  backgrounded={attachment.status === 'backgrounded'}
                />
              )}
            </span>

            {/* Removes the pending attachment only. The document stays in the
                Library and can be deleted from there. */}
            <button
              type="button"
              className="attachment__remove"
              onClick={onRemoveAttachment}
              aria-label={`Remove ${attachment.name} from this message`}
              title="Remove from this message (stays in your Library)"
            >
              ✕
            </button>
          </div>
        )}

        <div className="composer__row">
          <button
            type="button"
            className="composer__attach"
            onClick={() => fileRef.current?.click()}
            disabled={disabled || busy}
            aria-label="Attach a document"
            title="Attach a document (PDF, DOC, DOCX, PPT, PPTX, TXT, MD)"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <path
                d="M21.44 11.05l-8.49 8.49a5.5 5.5 0 1 1-7.78-7.78l8.49-8.49a3.67 3.67 0 1 1 5.19 5.19l-8.5 8.49a1.83 1.83 0 1 1-2.59-2.59l7.84-7.83"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>

          <input ref={fileRef} type="file" accept={ACCEPT} onChange={handleFile} hidden />

          {/* Forces this message onto the web-search route. The backend still
              decides and enforces the route; this only expresses a preference,
              and is ignored when no search provider is configured. */}
          <button
            type="button"
            className={`composer__web${webSearch ? ' composer__web--on' : ''}`}
            onClick={() => onWebSearchChange?.(!webSearch)}
            disabled={disabled || !webSearchAvailable}
            aria-pressed={webSearch}
            aria-label="Search the web for this message"
            title={
              webSearchAvailable
                ? 'Search the web for this message (otherwise chosen automatically)'
                : 'Web search is not configured on this server'
            }
          >
            <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
              <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.8" />
              <path
                d="M3 12h18M12 3c2.5 2.7 2.5 15.3 0 18M12 3c-2.5 2.7-2.5 15.3 0 18"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
            </svg>
            <span className="composer__web-label">Web</span>
          </button>

          <textarea
            ref={textareaRef}
            className="composer__input"
            value={value}
            rows={1}
            maxLength={MAX_LENGTH}
            disabled={disabled}
            placeholder={placeholder}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={handleKeyDown}
          />

          <button
            type="submit"
            className="btn btn--send"
            disabled={!value.trim() || isStreaming || disabled}
            aria-label="Send message"
            title="Send (Enter)"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <path
                d="M12 20V5M12 5l-6 6M12 5l6 6"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
      </form>

      <p className="composer__hint">
        Enter to send · Shift+Enter for a new line · answers are grounded in the sources shown
      </p>
    </div>
  );
}

export default memo(ChatInput);
