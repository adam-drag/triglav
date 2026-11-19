import { useCallback, useEffect, useState } from 'react';

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

/** Web Locks name of the tab that holds the one /api/stream connection of the origin. */
const STREAM_LOCK = 'triglav-live-stream';
/** BroadcastChannel on which that tab relays the stream to the other tabs of the origin. */
const STREAM_CHANNEL = 'triglav-live';

/** What the stream tab sends to the other tabs, and what a new tab asks for. */
type StreamRelay = { type: 'message' | 'open' | 'error' } | { type: 'state'; connected: boolean } | { type: 'ask' };

/**
 * Increments whenever the server reports a change, so views refetch. Also reports whether the stream is connected.
 * Every tab of the origin shares one /api/stream connection: the tab that holds the Web Lock opens it and relays it,
 * and when that tab closes, the lock passes to another tab. Without Web Locks or BroadcastChannel, each tab opens its own.
 */
export function useLiveVersion(): { version: number; connected: boolean } {
  const [version, setVersion] = useState(0);
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    const bump = () => setVersion((v) => v + 1);
    let pending: number | undefined;
    // Several changes within 250 ms cause one refetch.
    const schedule = () => {
      if (pending !== undefined) return;
      pending = window.setTimeout(() => {
        pending = undefined;
        bump();
      }, 250);
    };

    if (!('locks' in navigator) || typeof BroadcastChannel === 'undefined') {
      const source = new EventSource('/api/stream');
      source.onopen = () => {
        setConnected(true);
        bump();
      };
      source.onerror = () => setConnected(false);
      source.onmessage = schedule;
      return () => {
        source.close();
        window.clearTimeout(pending);
      };
    }

    const channel = new BroadcastChannel(STREAM_CHANNEL);
    const send = (m: StreamRelay) => channel.postMessage(m);
    const abort = new AbortController();
    let closed = false;
    // Set while this tab holds the lock. Resolving it gives the lock up.
    let release: (() => void) | undefined;
    let source: EventSource | null = null;
    // Whether the stream of this tab is open now. A tab that asks for the state gets this answer.
    let streamOpen = false;

    const lead = () => {
      source = new EventSource('/api/stream');
      source.onopen = () => {
        streamOpen = true;
        setConnected(true);
        // The first open of a new leader bumps the version once, as every open does: events during the handover may be missed.
        bump();
        send({ type: 'open' });
      };
      source.onerror = () => {
        streamOpen = false;
        setConnected(false);
        send({ type: 'error' });
      };
      source.onmessage = () => {
        schedule();
        send({ type: 'message' });
      };
    };

    // The tab that holds the lock leads; the others follow the relay. BroadcastChannel does not deliver to its sender,
    // so the leader applies its own messages in onmessage above.
    let leader = false;
    channel.onmessage = (ev: MessageEvent<StreamRelay>) => {
      const m = ev.data;
      if (leader) {
        if (m.type === 'ask') send({ type: 'state', connected: streamOpen });
        return;
      }
      if (m.type === 'message') schedule();
      else if (m.type === 'open') {
        setConnected(true);
        bump();
      } else if (m.type === 'error') setConnected(false);
      else if (m.type === 'state') setConnected(m.connected);
    };

    // A new tab may join while the stream is open or not yet open. The leader answers with its state, and the
    // open event that comes later still reaches it.
    send({ type: 'ask' });

    navigator.locks
      .request(STREAM_LOCK, { signal: abort.signal }, () => {
        // Returns a promise that holds the lock until the tab lets it go on unmount.
        return new Promise<void>((resolve) => {
          if (closed) return resolve();
          release = resolve;
          leader = true;
          lead();
        });
      })
      // An aborted request rejects on unmount; that is expected.
      .catch(() => {});

    return () => {
      closed = true;
      abort.abort();
      release?.();
      source?.close();
      channel.close();
      window.clearTimeout(pending);
    };
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
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, error, reload };
}

export function fmt(ts: string | null | undefined): string {
  if (!ts) return '';
  return new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
