import { useEffect, useState } from 'react';

import AuthLayout from '../components/auth/AuthLayout.jsx';
import GoogleButton from '../components/auth/GoogleButton.jsx';
import { useAuth } from '../context/AuthContext.jsx';

const OAUTH_ERRORS = {
  google_cancelled: 'Google sign-in was cancelled.',
  google_failed: 'Google sign-in failed. Please try again.',
  INVALID_OAUTH_STATE: 'That sign-in link expired. Please try again.',
  EMAIL_NOT_VERIFIED:
    'An account with that email already exists. Sign in with your password first, then link Google.',
  GOOGLE_NOT_CONFIGURED: 'Google sign-in is not configured on this server.',
};

export default function LoginPage({ onNavigate }) {
  const { login, googleEnabled } = useAuth();
  const [form, setForm] = useState({ email: '', password: '' });
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  // The OAuth callback reports failures by redirecting back with ?error=
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('error');
    if (code) {
      setError(OAUTH_ERRORS[code] ?? 'Sign-in failed. Please try again.');
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  const submit = async (event) => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(form);
    } catch (loginError) {
      setError(loginError.message);
    } finally {
      setSubmitting(false);
    }
  };

  const update = (field) => (event) => setForm((prev) => ({ ...prev, [field]: event.target.value }));

  return (
    <AuthLayout
      title="Welcome back"
      subtitle="Sign in to search your documents with AI."
      error={error}
    >
      <form className="auth__form" onSubmit={submit}>
        <label className="field">
          <span className="field__label">Email</span>
          <input
            className="field__input"
            type="email"
            autoComplete="email"
            required
            value={form.email}
            onChange={update('email')}
            placeholder="you@example.com"
          />
        </label>

        <label className="field">
          <span className="field__label">Password</span>
          <input
            className="field__input"
            type="password"
            autoComplete="current-password"
            required
            value={form.password}
            onChange={update('password')}
            placeholder="••••••••"
          />
        </label>

        <button className="btn btn--primary btn--block" type="submit" disabled={submitting}>
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>

      {googleEnabled && (
        <>
          <div className="auth__divider">
            <span>OR</span>
          </div>
          <GoogleButton label="Continue with Google" />
        </>
      )}

      <p className="auth__switch">
        Don&apos;t have an account?{' '}
        <button type="button" className="link" onClick={() => onNavigate('signup')}>
          Sign up
        </button>
      </p>
    </AuthLayout>
  );
}
