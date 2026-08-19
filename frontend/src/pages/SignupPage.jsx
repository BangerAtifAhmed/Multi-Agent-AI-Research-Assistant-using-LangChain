import { useState } from 'react';

import AuthLayout from '../components/auth/AuthLayout.jsx';
import GoogleButton from '../components/auth/GoogleButton.jsx';
import { useAuth } from '../context/AuthContext.jsx';

const MIN_PASSWORD_LENGTH = 8;

export default function SignupPage({ onNavigate }) {
  const { signup, googleEnabled } = useAuth();
  const [form, setForm] = useState({ name: '', email: '', password: '', confirmPassword: '' });
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const passwordsMatch =
    !form.confirmPassword || form.password === form.confirmPassword;

  const submit = async (event) => {
    event.preventDefault();
    setError(null);

    if (form.password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (form.password !== form.confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setSubmitting(true);
    try {
      await signup(form);
    } catch (signupError) {
      setError(signupError.message);
    } finally {
      setSubmitting(false);
    }
  };

  const update = (field) => (event) => setForm((prev) => ({ ...prev, [field]: event.target.value }));

  return (
    <AuthLayout
      title="Create your account"
      subtitle="Upload documents and ask questions about them."
      error={error}
    >
      <form className="auth__form" onSubmit={submit}>
        <label className="field">
          <span className="field__label">Name</span>
          <input
            className="field__input"
            type="text"
            autoComplete="name"
            required
            minLength={2}
            value={form.name}
            onChange={update('name')}
            placeholder="Ada Lovelace"
          />
        </label>

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
            autoComplete="new-password"
            required
            minLength={MIN_PASSWORD_LENGTH}
            value={form.password}
            onChange={update('password')}
            placeholder="At least 8 characters"
          />
        </label>

        <label className="field">
          <span className="field__label">Confirm password</span>
          <input
            className={`field__input ${passwordsMatch ? '' : 'field__input--error'}`}
            type="password"
            autoComplete="new-password"
            required
            value={form.confirmPassword}
            onChange={update('confirmPassword')}
            placeholder="Repeat your password"
          />
          {!passwordsMatch && <span className="field__hint">Passwords do not match.</span>}
        </label>

        <button className="btn btn--primary btn--block" type="submit" disabled={submitting}>
          {submitting ? 'Creating account…' : 'Create account'}
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
        Already have an account?{' '}
        <button type="button" className="link" onClick={() => onNavigate('login')}>
          Sign in
        </button>
      </p>
    </AuthLayout>
  );
}
