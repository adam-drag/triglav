import { useEffect, useState } from 'react';

export type Json = any;

export class ApiError extends Error {
  status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.status = status;
  }
}

/** Fired when the server answers 401 to a call that is not the login itself: the session ended, so the login form comes back. */
export const UNAUTHORIZED_EVENT = 'triglav:unauthorized';

function failure(path: string, res: Response, body: { message?: string }): ApiError {
  if (res.status === 401 && path !== '/api/login' && path !== '/api/session') window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
  return new ApiError(body.message ?? `HTTP ${res.status}`, res.status);
}

/** fetch, with a network failure (Triglav restarting or down) turned into a message the Client can act on. */
async function call(path: string, init: RequestInit | undefined, write: boolean): Promise<Response> {
  try {
    return await fetch(path, init);
  } catch {
    throw new ApiError(write ? 'Triglav did not answer (probably restarting), so this may not have been saved. Check the value and try again.' : 'Triglav is not answering (probably restarting). Retrying on the next refresh.');
  }
}

export async function get<T = Json>(path: string): Promise<T> {
  const res = await call(path, undefined, false);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw failure(path, res, body);
  return body as T;
}

export async function post<T = Json>(path: string, data: unknown, method = 'POST'): Promise<T> {
  const res = await call(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) }, true);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw failure(path, res, body);
  return body as T;
}

/** Increments whenever the server reports a change, so views refetch. Also reports whether the stream is connected. */
export function useLiveVersion(): { version: number; connected: boolean } {
  const [version, setVersion] = useState(0);
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    const source = new EventSource('/api/stream');
    let pending: number | undefined;
    source.onopen = () => {
      setConnected(true);
      setVersion((v) => v + 1);
    };
    source.onerror = () => setConnected(false);
    source.onmessage = () => {
      if (pending !== undefined) return;
      pending = window.setTimeout(() => {
        pending = undefined;
        setVersion((v) => v + 1);
      }, 250);
    };
    return () => source.close();
  }, []);
  return { version, connected };
}

export function useData<T = Json>(path: string | null, version: number): { data: T | null; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!path) return;
    let alive = true;
    get<T>(path)
      .then((d) => alive && (setData(d), setError(null)))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [path, version, nonce]);
  return { data, error, reload: () => setNonce((n) => n + 1) };
}

export function fmt(ts: string | null | undefined): string {
  if (!ts) return '';
  return new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
