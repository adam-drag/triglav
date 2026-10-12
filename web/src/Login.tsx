import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { ApiError, get, post, UNAUTHORIZED_EVENT } from './api.ts';

/** Shows the login form until the server accepts the session cookie, then the dashboard. A 401 anywhere brings the form back. */
export function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<'checking' | 'out' | 'in'>('checking');
  useEffect(() => {
    get('/api/session').then(
      () => setState('in'),
      (e: Error) => setState(e instanceof ApiError && e.status === 401 ? 'out' : 'in'),
    );
    const out = () => setState('out');
    window.addEventListener(UNAUTHORIZED_EVENT, out);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, out);
  }, []);
  if (state === 'checking') return null;
  if (state === 'out') return <LoginPage onDone={() => setState('in')} />;
  return <>{children}</>;
}

function LoginPage({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post('/api/login', { password });
      setPassword('');
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="login" data-testid="login">
      <form onSubmit={submit}>
        <h1>
          <img src="/android-chrome-192x192.png" width="32" height="32" alt="" /> Triglav
        </h1>
        <p>Enter the dashboard password. You set it with <code>node scripts/set-password.ts</code>.</p>
        <label htmlFor="password">Password</label>
        <input id="password" type="password" autoComplete="current-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
        {error && (
          <p className="error" role="alert" data-testid="login-error">
            {error}
          </p>
        )}
        <button className="primary" type="submit" disabled={busy || !password} data-testid="login-submit">
          {busy ? 'Checking...' : 'Log in'}
        </button>
      </form>
    </main>
  );
}

/** Ends the session and shows the login form. */
export async function logout() {
  await post('/api/logout', {}).catch(() => {});
  window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
}
