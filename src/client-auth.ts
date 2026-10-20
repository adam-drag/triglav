/**
 * Login of the Client (the human) for the dashboard API.
 *
 * The password is set once with scripts/set-password.ts, which writes only a scrypt hash to .env. A login makes a
 * random session id; the browser keeps it in an HttpOnly cookie and the database keeps only its SHA-256, so neither
 * the password nor a session id is stored in plain text. This raises the bar for agents (they must steal a secret
 * instead of calling an open endpoint), but they run as the same OS user, so it is not a hard boundary.
 */
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { Ctx } from './context.ts';
import { exec, query, queryOne } from './db.ts';
import { addSeconds, sha256 } from './lib.ts';

export const SESSION_COOKIE = 'triglav_session';
export const SESSION_SECONDS = 30 * 24 * 3600;
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 1000;

/**
 * A session belongs to the listener it was made on. The public dashboard listener (behind an HTTPS reverse proxy) makes
 * `public` sessions with a shorter life and a `__Host-` cookie; the local listener makes `local` ones. Each listener
 * accepts only its own, so a cookie taken from localhost does not work through the proxy, and the other way round.
 */
export type SessionScope = 'local' | 'public';
export const PUBLIC_SESSION_COOKIE = '__Host-triglav_session';
export const PUBLIC_SESSION_SECONDS = 7 * 24 * 3600;
/** The public listener refuses a shorter password before it hashes anything: it is reachable from the internet. */
export const MIN_PUBLIC_PASSWORD_LENGTH = 16;
const COOKIE_OF: Record<SessionScope, string> = { local: SESSION_COOKIE, public: PUBLIC_SESSION_COOKIE };
const SECONDS_OF: Record<SessionScope, number> = { local: SESSION_SECONDS, public: PUBLIC_SESSION_SECONDS };

/** The length that counts: what `hashPassword` hashes (NFKC-normalized), in characters, not UTF-16 units. */
export const passwordLength = (password: string) => [...password.normalize('NFKC')].length;

/** Why a new password is refused, or null. scripts/set-password.ts and the login both use MAX_PASSWORD_LENGTH, so a password that can be set can be used. */
export function passwordLengthProblem(password: string): string | null {
  const n = passwordLength(password);
  if (n < MIN_PASSWORD_LENGTH) return `The password must have at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (n > MAX_PASSWORD_LENGTH) return `The password can have at most ${MAX_PASSWORD_LENGTH} characters.`;
  return null;
}

const N = 2 ** 15;
const R = 8;
const P = 1;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
// scrypt needs about 128 * N * r bytes; the Node default limit is 32 MiB, which is exactly N = 2^15, r = 8.
const MAX_SCRYPT_BYTES = 64 * 1024 * 1024;
const maxmem = (n: number, r: number) => 128 * n * r * 2 + 1024 * 1024;

const derive = (password: string, salt: Buffer, n: number, r: number, p: number, length: number) =>
  new Promise<Buffer>((resolve, reject) => scrypt(password.normalize('NFKC'), salt, length, { N: n, r, p, maxmem: maxmem(n, r) }, (err, key) => (err ? reject(err) : resolve(key))));

/** `scrypt:N:r:p:salt:hash`, with salt and hash in base64url. No `$`, so Docker Compose and shells leave it alone. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const key = await derive(password, salt, N, R, P, KEY_LENGTH);
  return ['scrypt', N, R, P, salt.toString('base64url'), key.toString('base64url')].join(':');
}

type Parsed = { n: number; r: number; p: number; salt: Buffer; hash: Buffer };

export function parsePasswordHash(stored: string): Parsed | null {
  const m = /^scrypt:(\d+):(\d+):(\d+):([A-Za-z0-9_-]{16,}):([A-Za-z0-9_-]{32,})$/.exec(stored);
  if (!m) return null;
  const [n, r, p] = [Number(m[1]), Number(m[2]), Number(m[3])];
  // N must be a power of two. The bounds keep a bad value in .env from using the memory of the container: scrypt needs
  // 128 * N * r bytes, and the cap is 64 MiB (the default needs 32 MiB), well below the 1 GiB compose limit.
  if (n < 2 ** 14 || n > 2 ** 20 || (n & (n - 1)) !== 0 || r < 1 || r > 16 || p < 1 || p > 4 || 128 * n * r > MAX_SCRYPT_BYTES) return null;
  return { n, r, p, salt: Buffer.from(m[4]!, 'base64url'), hash: Buffer.from(m[5]!, 'base64url') };
}

/** Compares in constant time. A malformed stored hash never matches. */
export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  const parsed = parsePasswordHash(stored);
  if (!parsed) return false;
  const key = await derive(password, parsed.salt, parsed.n, parsed.r, parsed.p, parsed.hash.length);
  return key.length === parsed.hash.length && timingSafeEqual(key, parsed.hash);
}

/**
 * Failed logins are counted for the whole server, not per address: the dashboard reaches the container through Docker's
 * network, so every caller has the same source address. An attempt is counted when it starts, so a burst of parallel
 * requests cannot get past the limit while the first ones are still being checked.
 */
export class LoginLimiter {
  private attempts: { t: number }[] = [];
  private readonly max: number;
  private readonly windowMs: number;
  constructor(max = 5, windowMs = 10 * 60_000) {
    this.max = max;
    this.windowMs = windowMs;
  }

  /** `waitSec` is how long to wait before the next attempt, or 0 when this one may go ahead (and is counted). A correct password calls `refund`. */
  take(now: Date): { waitSec: number; refund: () => void } {
    const t = now.getTime();
    this.attempts = this.attempts.filter((a) => t - a.t < this.windowMs);
    if (this.attempts.length >= this.max) return { waitSec: Math.max(1, Math.ceil((this.attempts[0]!.t + this.windowMs - t) / 1000)), refund: () => {} };
    const mine = { t };
    this.attempts.push(mine);
    return { waitSec: 0, refund: () => void (this.attempts = this.attempts.filter((a) => a !== mine)) };
  }
}

/**
 * The limit of the public listener: failed logins counted per client address (the rightmost X-Forwarded-For entry the
 * proxy added) and, as a cap, for the whole listener. One address that guesses is held back without locking out the
 * Client elsewhere; many addresses together hit the cap, which still never touches the local listener's login.
 */
export class PublicLoginLimiter {
  private readonly perClient = new Map<string, number[]>();
  private all: number[] = [];
  private readonly maxPerClient: number;
  private readonly maxAll: number;
  private readonly windowMs: number;
  private readonly maxClients: number;
  constructor(maxPerClient = 5, maxAll = 30, windowMs = 10 * 60_000, maxClients = 10_000) {
    this.maxPerClient = maxPerClient;
    this.maxAll = maxAll;
    this.windowMs = windowMs;
    this.maxClients = maxClients;
  }

  /** As `LoginLimiter.take`, for one client address. An attempt counts for the client and for the cap; `refund` takes it back from both. */
  take(now: Date, client: string): { waitSec: number; refund: () => void } {
    const t = now.getTime();
    const live = (list: number[]) => list.filter((a) => t - a < this.windowMs);
    const wait = (list: number[]) => Math.max(1, Math.ceil((list[0]! + this.windowMs - t) / 1000));
    this.all = live(this.all);
    for (const [key, list] of this.perClient) {
      const kept = live(list);
      if (kept.length) this.perClient.set(key, kept);
      else this.perClient.delete(key);
    }
    const mine = this.perClient.get(client) ?? [];
    if (mine.length >= this.maxPerClient) return { waitSec: wait(mine), refund: () => {} };
    if (this.all.length >= this.maxAll) return { waitSec: wait(this.all), refund: () => {} };
    // Bounded: past the limit the oldest address is forgotten. The cap above still counts every attempt.
    if (!this.perClient.has(client) && this.perClient.size >= this.maxClients) this.perClient.delete(this.perClient.keys().next().value!);
    mine.push(t);
    this.perClient.set(client, mine);
    this.all.push(t);
    return {
      waitSec: 0,
      refund: () => {
        const list = this.perClient.get(client);
        const i = list?.indexOf(t) ?? -1;
        if (list && i >= 0) list.splice(i, 1);
        const j = this.all.indexOf(t);
        if (j >= 0) this.all.splice(j, 1);
      },
    };
  }
}

export function cookieValue(header: string | undefined, name: string): string | null {
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim() || null;
  }
  return null;
}

export const sessionCookie = (id: string, maxAge: number) => `${SESSION_COOKIE}=${id}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Strict`;
/** `__Host-`: the browser keeps it only with Secure, Path=/ and no Domain, so no other host or plain-http page can set or read it. */
export const publicSessionCookie = (id: string, maxAge: number) => `${PUBLIC_SESSION_COOKIE}=${id}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;
export const cookieFor = (scope: SessionScope, id: string, maxAge: number) => (scope === 'public' ? publicSessionCookie(id, maxAge) : sessionCookie(id, maxAge));
export const sessionSeconds = (scope: SessionScope) => SECONDS_OF[scope];

/** The stored key binds a session to the password hash it was created under, so a new password ends every old session. */
const sessionKey = (passwordHash: string, id: string) => sha256(`${passwordHash}:${id}`);

export async function createSession(ctx: Ctx, passwordHash: string, scope: SessionScope = 'local'): Promise<string> {
  const id = randomBytes(32).toString('base64url');
  const now = ctx.clock.now();
  await exec(ctx.pool, `DELETE FROM client_sessions WHERE expires_at < ?`, [now]);
  await exec(ctx.pool, `INSERT INTO client_sessions (id_hash, created_at, expires_at, scope) VALUES (?, ?, ?, ?)`, [sessionKey(passwordHash, id), now, addSeconds(now, SECONDS_OF[scope]), scope]);
  return id;
}

export async function sessionValid(ctx: Ctx, passwordHash: string, cookieHeader: string | undefined, scope: SessionScope = 'local'): Promise<boolean> {
  const id = cookieValue(cookieHeader, COOKIE_OF[scope]);
  if (!id || id.length > 100) return false;
  return !!(await queryOne(ctx.pool, `SELECT id_hash FROM client_sessions WHERE id_hash = ? AND expires_at > ? AND scope = ?`, [sessionKey(passwordHash, id), ctx.clock.now(), scope]));
}

export async function destroySession(ctx: Ctx, passwordHash: string, cookieHeader: string | undefined, scope: SessionScope = 'local'): Promise<void> {
  const id = cookieValue(cookieHeader, COOKIE_OF[scope]);
  if (id && id.length <= 100) await exec(ctx.pool, `DELETE FROM client_sessions WHERE id_hash = ? AND scope = ?`, [sessionKey(passwordHash, id), scope]);
}

const LOGIN_RECORD_DAYS = 90;
export const MAX_LOGIN_RECORDS = 50;

/** A successful login on the public listener, so the Client can spot one that was not theirs (Security page). Local logins are not recorded. */
export async function recordPublicLogin(ctx: Ctx, address: string): Promise<void> {
  const now = ctx.clock.now();
  await exec(ctx.pool, `DELETE FROM client_logins WHERE at < ?`, [addSeconds(now, -LOGIN_RECORD_DAYS * 24 * 3600)]);
  await exec(ctx.pool, `INSERT INTO client_logins (at, address) VALUES (?, ?)`, [now, address.slice(0, 64)]);
}

/** The recent public logins, newest first. */
export async function recentPublicLogins(ctx: Ctx): Promise<{ at: Date; address: string }[]> {
  const rows = await query(ctx.pool, `SELECT at, address FROM client_logins ORDER BY at DESC, id DESC LIMIT ${MAX_LOGIN_RECORDS}`);
  return rows.map((r) => ({ at: r.at as Date, address: String(r.address) }));
}
