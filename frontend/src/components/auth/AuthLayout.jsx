import ErrorBanner from '../ErrorBanner.jsx';

export default function AuthLayout({ title, subtitle, error, children }) {
  return (
    <div className="auth">
      <div className="auth__card">
        <div className="auth__brand">
          <span className="auth__logo" aria-hidden="true">
            <svg viewBox="0 0 32 32" width="26" height="26">
              <circle cx="14" cy="14" r="8" fill="none" stroke="currentColor" strokeWidth="2.6" />
              <line
                x1="20"
                y1="20"
                x2="27"
                y2="27"
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="round"
              />
            </svg>
          </span>
          <span className="auth__brand-name">RAG Search</span>
        </div>

        <h1 className="auth__title">{title}</h1>
        {subtitle && <p className="auth__subtitle">{subtitle}</p>}

        {error && <ErrorBanner message={error} />}

        {children}
      </div>
    </div>
  );
}
