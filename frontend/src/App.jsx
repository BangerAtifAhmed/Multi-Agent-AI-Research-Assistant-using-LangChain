import { useState } from 'react';

import { AuthProvider, useAuth } from './context/AuthContext.jsx';
import AppShell from './pages/AppShell.jsx';
import LoginPage from './pages/LoginPage.jsx';
import SignupPage from './pages/SignupPage.jsx';

/**
 * Route guard. Everything behind the session lives in AppShell; unauthenticated
 * visitors only ever get the login/signup screens.
 */
function Routes() {
  const { user, loading } = useAuth();
  const [authView, setAuthView] = useState(() =>
    typeof window !== 'undefined' && window.location.pathname === '/signup' ? 'signup' : 'login',
  );

  if (loading) {
    return (
      <div className="boot">
        <span className="boot__spinner" aria-hidden="true" />
        <p className="boot__text">Loading…</p>
      </div>
    );
  }

  if (!user) {
    return authView === 'signup' ? (
      <SignupPage onNavigate={setAuthView} />
    ) : (
      <LoginPage onNavigate={setAuthView} />
    );
  }

  return <AppShell />;
}

export default function App() {
  return (
    <AuthProvider>
      <Routes />
    </AuthProvider>
  );
}
