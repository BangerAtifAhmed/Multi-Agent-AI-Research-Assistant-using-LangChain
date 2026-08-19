import { useEffect, useState } from 'react';

import ErrorBanner from '../components/ErrorBanner.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import authApi from '../services/authApi.js';
import { formatDateTime } from '../utils/date.js';

export default function ProfilePage({ onOpenSidebar }) {
  const { user, setUser, logout } = useAuth();
  const [profile, setProfile] = useState(null);
  const [usage, setUsage] = useState(null);
  const [name, setName] = useState(user?.name ?? '');
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    authApi
      .getProfile()
      .then((data) => {
        setProfile(data.user);
        setUsage(data.usage);
        setName(data.user.name);
      })
      .catch((loadError) => setError(loadError.message));
  }, []);

  const save = async (event) => {
    event.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const updated = await authApi.updateProfile({ name });
      setProfile(updated);
      setUser(updated);
      setNotice('Profile updated.');
    } catch (saveError) {
      setError(saveError.message);
    } finally {
      setSaving(false);
    }
  };

  const signOutEverywhere = async () => {
    try {
      await authApi.logoutEverywhere();
      await logout();
    } catch (signOutError) {
      setError(signOutError.message);
    }
  };

  return (
    <main className="chat">
      <header className="chat__header">
        <button type="button" className="chat__menu" onClick={onOpenSidebar} aria-label="Open menu">
          ☰
        </button>
        <h1 className="chat__title">Profile</h1>
      </header>

      <div className="chat__scroll">
        <div className="profile">
          {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
          {notice && <div className="notice">{notice}</div>}

          <section className="panel">
            <div className="profile__identity">
              {profile?.avatarUrl ? (
                <img className="profile__avatar" src={profile.avatarUrl} alt="" />
              ) : (
                <span className="profile__avatar profile__avatar--initials" aria-hidden="true">
                  {(profile?.name ?? user?.name ?? '?').slice(0, 1).toUpperCase()}
                </span>
              )}
              <div>
                <p className="profile__name">{profile?.name ?? user?.name}</p>
                <p className="profile__email">{profile?.email ?? user?.email}</p>
              </div>
            </div>

            <dl className="profile__facts">
              <div>
                <dt>Member since</dt>
                <dd>{profile?.createdAt ? formatDateTime(profile.createdAt) : '—'}</dd>
              </div>
              <div>
                <dt>Sign-in methods</dt>
                <dd>
                  {[profile?.hasPassword && 'Password', profile?.hasGoogle && 'Google']
                    .filter(Boolean)
                    .join(' · ') || '—'}
                </dd>
              </div>
            </dl>
          </section>

          {usage && (
            <section className="panel">
              <h2 className="panel__title">Your data</h2>
              <div className="stats">
                <div className="stat">
                  <span className="stat__value">{usage.documents}</span>
                  <span className="stat__label">Documents</span>
                </div>
                <div className="stat">
                  <span className="stat__value">{usage.chunks}</span>
                  <span className="stat__label">Indexed chunks</span>
                </div>
                <div className="stat">
                  <span className="stat__value">{usage.conversations}</span>
                  <span className="stat__label">Conversations</span>
                </div>
                <div className="stat">
                  <span className="stat__value">{usage.messages}</span>
                  <span className="stat__label">Messages</span>
                </div>
              </div>
            </section>
          )}

          <section className="panel">
            <h2 className="panel__title">Display name</h2>
            <form className="profile__form" onSubmit={save}>
              <input
                className="field__input"
                value={name}
                minLength={2}
                maxLength={80}
                onChange={(event) => setName(event.target.value)}
                required
              />
              <button className="btn btn--primary" type="submit" disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
              </button>
            </form>
          </section>

          <section className="panel">
            <h2 className="panel__title">Sessions</h2>
            <p className="panel__text">
              Signing out everywhere revokes every active session for this account, on all devices.
            </p>
            <button type="button" className="btn btn--danger" onClick={signOutEverywhere}>
              Sign out everywhere
            </button>
          </section>
        </div>
      </div>
    </main>
  );
}
