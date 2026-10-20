import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { hashPassword, PublicLoginLimiter } from '../src/client-auth.ts';
import { type DashboardConfig, readListenerConfig } from '../src/config.ts';
import { query, queryOne } from '../src/db.ts';
import { sha256 } from '../src/lib.ts';
import { buildServer, HSTS } from '../src/server.ts';
import { createTestCtx, loginCookie, TEST_DB_URL, TEST_ENROLLMENT_KEY, TEST_RUNNER_KEY, testServerKeys } from './helpers.ts';

const DASHBOARD: DashboardConfig = { origin: 'https://triglav.example.com', host: 'triglav.example.com', port: 7410 };
/** Long enough for the public listener (16 characters or more). */
const LONG_PASSWORD = 'a long public dashboard password';

describe('listener config', () => {
  const errorsOf = (env: Record<string, string>) => {
    const r = readListenerConfig(env);
    return r.ok ? '' : r.errors.join('\n');
  };

  it('is off by default and keeps the default install as it is', () => {
    expect(readListenerConfig({})).toEqual({ ok: true, dashboard: null });
    expect(readListenerConfig({ ORCH_PUBLIC_URL: 'http://localhost:7400', ORCH_PORT: '7400' })).toEqual({ ok: true, dashboard: null });
  });

  it('reads an https origin, with or without a trailing slash, and the port (default 7410)', () => {
    expect(readListenerConfig({ ORCH_DASHBOARD_URL: 'https://Triglav.Example.com' })).toEqual({ ok: true, dashboard: DASHBOARD });
    expect(readListenerConfig({ ORCH_DASHBOARD_URL: 'https://triglav.example.com/', ORCH_DASHBOARD_PORT: '8443' })).toEqual({ ok: true, dashboard: { ...DASHBOARD, port: 8443 } });
    expect(readListenerConfig({ ORCH_DASHBOARD_URL: 'https://triglav.example.com:8443' })).toEqual({ ok: true, dashboard: { origin: 'https://triglav.example.com:8443', host: 'triglav.example.com:8443', port: 7410 } });
  });

  it('refuses an invalid, non-https or non-origin dashboard URL, and an invalid port, with a message', () => {
    expect(errorsOf({ ORCH_DASHBOARD_URL: 'not a url' })).toMatch(/ORCH_DASHBOARD_URL is not a valid URL/);
    expect(errorsOf({ ORCH_DASHBOARD_URL: 'http://triglav.example.com' })).toMatch(/must start with https/);
    for (const bad of ['https://triglav.example.com/app', 'https://triglav.example.com/?x=1', 'https://triglav.example.com?', 'https://triglav.example.com/#top', 'https://triglav.example.com#', 'https://user:pw@triglav.example.com', 'https://user@triglav.example.com']) {
      expect(errorsOf({ ORCH_DASHBOARD_URL: bad }), bad).toMatch(/no path, query, fragment or user info/);
    }
    for (const bad of ['0', '65536', 'abc', '74.1', '-1', '123456']) expect(errorsOf({ ORCH_DASHBOARD_URL: 'https://triglav.example.com', ORCH_DASHBOARD_PORT: bad }), bad).toMatch(/ORCH_DASHBOARD_PORT must be a port number/);
    expect(errorsOf({ ORCH_DASHBOARD_URL: 'https://triglav.example.com', ORCH_DASHBOARD_PORT: '7400' })).toMatch(/must differ from ORCH_PORT/);
    // The default port collides too.
    expect(errorsOf({ ORCH_DASHBOARD_URL: 'https://triglav.example.com', ORCH_PORT: '7410' })).toMatch(/must differ from ORCH_PORT \(7410\)/);
    expect(readListenerConfig({ ORCH_PORT: '7410' })).toMatchObject({ ok: true });
  });

  it('refuses a non-loopback ORCH_PUBLIC_URL and names ORCH_DASHBOARD_URL; loopback hosts still pass', () => {
    for (const ok of ['http://localhost:7400', 'http://127.0.0.1:7400', 'http://[::1]:7400']) expect(readListenerConfig({ ORCH_PUBLIC_URL: ok }), ok).toMatchObject({ ok: true });
    for (const bad of ['https://triglav.example.com', 'http://10.0.0.5:7400', 'nonsense']) {
      const text = errorsOf({ ORCH_PUBLIC_URL: bad });
      expect(text, bad).toMatch(/ORCH_PUBLIC_URL must be a loopback URL/);
      expect(text, bad).toContain('ORCH_DASHBOARD_URL');
    }
  });

  it('keeps the real server from starting on a bad listener setting, before it touches the database', async () => {
    const env = { PATH: process.env.PATH!, DATABASE_URL: 'mysql://nobody:x@127.0.0.1:1/none', ORCH_ENROLLMENT_KEY: 'e'.repeat(32), ORCH_RUNNER_KEY: 'r'.repeat(32), ORCH_CLIENT_PASSWORD_HASH: await hashPassword('correct horse battery') };
    const run = (extra: Record<string, string>) => spawnSync('node', ['src/main.ts'], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 20_000 });
    const publicUrl = run({ ORCH_PUBLIC_URL: 'https://triglav.example.com' });
    expect(publicUrl.status).toBe(1);
    expect(publicUrl.stderr).toMatch(/ORCH_PUBLIC_URL must be a loopback URL.*ORCH_DASHBOARD_URL/);
    const dashboardUrl = run({ ORCH_DASHBOARD_URL: 'http://triglav.example.com' });
    expect(dashboardUrl.status).toBe(1);
    expect(dashboardUrl.stderr).toMatch(/ORCH_DASHBOARD_URL must start with https/);
  });
});

describe('public login limiter', () => {
  it('holds back one address after 5 failures, caps all addresses at 30, and a success does not count', () => {
    const t0 = new Date('2026-10-20T10:00:00Z');
    const limiter = new PublicLoginLimiter();
    for (let i = 0; i < 5; i++) expect(limiter.take(t0, '203.0.113.1').waitSec).toBe(0);
    expect(limiter.take(t0, '203.0.113.1').waitSec).toBe(600);
    expect(limiter.take(t0, '203.0.113.2').waitSec).toBe(0);
    for (let i = 3; i <= 7; i++) for (let j = 0; j < 5; j++) limiter.take(t0, `203.0.113.${i}`);
    // 5 + 1 + 25 = 31 tries made, 30 counted: the cap is reached for every address.
    expect(limiter.take(t0, '198.51.100.9').waitSec).toBe(600);
    expect(limiter.take(new Date(t0.getTime() + 601_000), '198.51.100.9').waitSec).toBe(0);

    const fresh = new PublicLoginLimiter(2, 3);
    for (let i = 0; i < 10; i++) fresh.take(t0, 'a').refund();
    expect(fresh.take(t0, 'a').waitSec).toBe(0);
    expect(fresh.take(t0, 'a').waitSec).toBe(0);
    expect(fresh.take(t0, 'a').waitSec).toBeGreaterThan(0);
  });

  it('forgets the oldest address past its bound, and the cap still counts', () => {
    const t0 = new Date('2026-10-20T10:00:00Z');
    const limiter = new PublicLoginLimiter(1, 100, 600_000, 2);
    limiter.take(t0, 'a');
    limiter.take(t0, 'b');
    limiter.take(t0, 'c');
    expect(limiter.take(t0, 'a').waitSec).toBe(0);
    expect(limiter.take(t0, 'c').waitSec).toBeGreaterThan(0);
  });
});

describe.skipIf(!TEST_DB_URL)('public dashboard listener', () => {
  let env: Awaited<ReturnType<typeof createTestCtx>>;
  let local: FastifyInstance;
  let pub: FastifyInstance;
  let webDir = '';
  let longHash = '';
  const INDEX = '<!doctype html><title>dashboard index</title>';
  const host = { host: DASHBOARD.host };
  const write = { ...host, origin: DASHBOARD.origin };

  /** Builds a server with the long password, so the public listener's 16-character minimum is met. */
  const build = async (extra: Partial<Parameters<typeof buildServer>[1]> = {}) => buildServer(env.ctx, { ...(await testServerKeys()), passwordHash: longHash, webDir, ...extra });
  const publicLogin = async (app: FastifyInstance, headers: Record<string, string> = {}) => app.inject({ method: 'POST', url: '/api/login', headers: { ...write, ...headers }, payload: { password: LONG_PASSWORD } });
  const cookieOf = (res: { headers: Record<string, unknown> }) => String(res.headers['set-cookie']).split(';')[0]!;
  const inject = (app: FastifyInstance, o: InjectOptions & { headers?: Record<string, string> }) => app.inject(o);

  beforeAll(async () => {
    env = await createTestCtx(null);
    // One hash for every server here, so a session is refused only for its scope, never for a different hash.
    longHash = await hashPassword(LONG_PASSWORD);
    webDir = mkdtempSync(join(tmpdir(), 'triglav-web-'));
    writeFileSync(join(webDir, 'index.html'), INDEX);
    local = await build();
    pub = await build({ dashboard: DASHBOARD });
  });
  afterAll(async () => {
    await local?.close();
    await pub?.close();
    await env?.close();
    if (webDir) rmSync(webDir, { recursive: true, force: true });
  });

  it('keeps the local cookie as it was: no Secure flag, 30 days, and no HSTS on local responses', async () => {
    const res = await local.inject({ method: 'POST', url: '/api/login', payload: { password: LONG_PASSWORD } });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['set-cookie'])).toMatch(/^triglav_session=[A-Za-z0-9_-]{40,}; Path=\/; Max-Age=2592000; HttpOnly; SameSite=Strict$/);
    expect(String(res.headers['set-cookie'])).not.toMatch(/Secure/);
    expect(res.headers['strict-transport-security']).toBeUndefined();
    expect((await local.inject({ method: 'GET', url: '/api/health' })).headers['strict-transport-security']).toBeUndefined();
    // Local logins are not recorded.
    expect(await query(env.ctx.pool, `SELECT * FROM client_logins`)).toEqual([]);
    const row = await queryOne(env.ctx.pool, `SELECT scope FROM client_sessions ORDER BY created_at DESC LIMIT 1`);
    expect(row?.scope).toBe('local');
  });

  it('accepts only the dashboard host; any other Host, localhost included, gets 403', async () => {
    expect((await inject(pub, { method: 'GET', url: '/api/health', headers: host })).statusCode).toBe(200);
    expect((await inject(pub, { method: 'GET', url: '/api/health', headers: { host: 'TRIGLAV.example.com' } })).statusCode).toBe(200);
    for (const other of ['localhost', 'localhost:7410', '127.0.0.1', '[::1]', 'evil.example.com', 'triglav.example.com:7410', 'triglav.example.com.evil.com', '']) {
      expect((await inject(pub, { method: 'GET', url: '/api/health', headers: { host: other } })).statusCode, other).toBe(403);
    }
  });

  it('needs the exact dashboard origin on every write', async () => {
    const post = (origin?: string) => inject(pub, { method: 'POST', url: '/api/logout', headers: origin === undefined ? host : { ...host, origin }, payload: {} });
    expect((await post(DASHBOARD.origin)).statusCode).toBe(200);
    for (const bad of [undefined, 'null', 'http://triglav.example.com', 'https://triglav.example.com:8443', 'https://evil.example.com', 'https://triglav.example.com.evil.com', 'http://localhost:7410', 'https://triglav.example.com/']) {
      expect((await post(bad)).statusCode, String(bad)).toBe(403);
    }
  });

  it('leaves the local listener as it was: the dashboard host is refused there, local origins still work', async () => {
    expect((await inject(local, { method: 'GET', url: '/api/health', headers: host })).statusCode).toBe(403);
    expect((await inject(local, { method: 'POST', url: '/api/logout', headers: { host: 'localhost:7400', origin: DASHBOARD.origin }, payload: {} })).statusCode).toBe(403);
    expect((await inject(local, { method: 'POST', url: '/api/logout', headers: { host: 'localhost:7400', origin: 'http://localhost:7400' }, payload: {} })).statusCode).toBe(200);
    expect((await inject(local, { method: 'POST', url: '/api/logout', headers: { host: 'localhost:7400' }, payload: {} })).statusCode).toBe(200);
    expect((await inject(local, { method: 'GET', url: '/guide.md', headers: { host: 'localhost:7400' } })).statusCode).toBe(200);
  });

  it('serves only the dashboard: agent, runner, hook, usage and guide routes are 404 (not index.html), whatever credential is sent', async () => {
    const cookie = cookieOf(await publicLogin(pub));
    const localCookie = await loginCookie(local, LONG_PASSWORD);
    const credentials: Record<string, string>[] = [{}, { authorization: `Bearer ${TEST_ENROLLMENT_KEY}` }, { authorization: `Bearer ${TEST_RUNNER_KEY}` }, { cookie }, { cookie: localCookie }];
    const routes: [string, string][] = [
      ['POST', '/mcp'], ['GET', '/mcp'], ['DELETE', '/mcp'], ['POST', '/operator/mcp'], ['GET', '/operator/mcp'],
      ['POST', '/api/runner/next'], ['POST', '/api/runner/runtimes'], ['POST', '/api/runner/chat/hello'], ['POST', '/api/runner/lch_x/done'], ['GET', '/api/runner/next'],
      ['POST', '/api/hooks/stop'], ['POST', '/api/usage/claude'], ['GET', '/guide.md'], ['POST', '/nothing/here'],
    ];
    for (const [method, url] of routes) {
      for (const extra of credentials) {
        const res = await inject(pub, { method: method as 'GET', url, headers: { ...write, ...extra, 'content-type': 'application/json' }, payload: method === 'GET' ? undefined : '{}' });
        expect(res.statusCode, `${method} ${url} ${Object.keys(extra)}`).toBe(404);
        expect(res.body, `${method} ${url}`).not.toContain('dashboard index');
        expect(res.headers['content-type'], `${method} ${url}`).toMatch(/application\/json/);
      }
      // With Host: localhost the host check refuses it first.
      const res = await inject(pub, { method: method as 'GET', url, headers: { host: 'localhost', origin: 'http://localhost', authorization: `Bearer ${TEST_ENROLLMENT_KEY}`, 'content-type': 'application/json' }, payload: method === 'GET' ? undefined : '{}' });
      expect(res.statusCode, `${method} ${url} localhost`).toBe(403);
    }
    // What the dashboard needs still works.
    expect((await inject(pub, { method: 'GET', url: '/', headers: host })).body).toBe(INDEX);
    expect((await inject(pub, { method: 'GET', url: '/jobs/x', headers: host })).body).toBe(INDEX);
    expect((await inject(pub, { method: 'GET', url: '/api/health', headers: host })).statusCode).toBe(200);
    expect((await inject(pub, { method: 'GET', url: '/api/jobs', headers: { ...host, cookie } })).statusCode).toBe(200);
    expect((await inject(pub, { method: 'POST', url: '/api/jobs/job_x/approve', headers: { ...write, cookie }, payload: {} })).statusCode).toBe(404);
    expect((await inject(pub, { method: 'GET', url: '/api/jobs', headers: host })).statusCode).toBe(401);
    expect((await inject(pub, { method: 'GET', url: '/api/unknown', headers: { ...host, cookie } })).statusCode).toBe(404);
  });

  it('keeps the scopes apart: a local session does not work on the public listener, nor a public one locally', async () => {
    const localId = (await loginCookie(local, LONG_PASSWORD)).split('=')[1]!;
    const publicId = cookieOf(await publicLogin(pub)).split('=')[1]!;
    expect((await inject(pub, { method: 'GET', url: '/api/session', headers: { ...host, cookie: `__Host-triglav_session=${publicId}` } })).statusCode).toBe(200);
    expect((await inject(pub, { method: 'GET', url: '/api/session', headers: { ...host, cookie: `__Host-triglav_session=${localId}` } })).statusCode).toBe(401);
    expect((await inject(pub, { method: 'GET', url: '/api/session', headers: { ...host, cookie: `triglav_session=${localId}` } })).statusCode).toBe(401);
    expect((await inject(local, { method: 'GET', url: '/api/session', headers: { cookie: `triglav_session=${publicId}` } })).statusCode).toBe(401);
    expect((await inject(local, { method: 'GET', url: '/api/session', headers: { cookie: `__Host-triglav_session=${publicId}` } })).statusCode).toBe(401);
    expect((await inject(local, { method: 'GET', url: '/api/session', headers: { cookie: `triglav_session=${localId}` } })).statusCode).toBe(200);
    // Logging out on one listener does not end a session of the other scope.
    await inject(pub, { method: 'POST', url: '/api/logout', headers: { ...write, cookie: `__Host-triglav_session=${localId}` }, payload: {} });
    expect((await inject(local, { method: 'GET', url: '/api/session', headers: { cookie: `triglav_session=${localId}` } })).statusCode).toBe(200);
  });

  it('sets a __Host- cookie, refuses the session after 7 days, and logout revokes it with the same attributes', async () => {
    const res = await publicLogin(pub);
    expect(res.statusCode).toBe(200);
    const setCookie = String(res.headers['set-cookie']);
    expect(setCookie).toMatch(/^__Host-triglav_session=[A-Za-z0-9_-]{40,}; Path=\/; Max-Age=604800; HttpOnly; Secure; SameSite=Strict$/);
    expect(setCookie).not.toMatch(/Domain/i);
    expect(res.headers['strict-transport-security']).toBe(HSTS);
    const cookie = cookieOf(res);
    expect(await queryOne(env.ctx.pool, `SELECT scope, TIMESTAMPDIFF(SECOND, created_at, expires_at) AS life FROM client_sessions WHERE id_hash = ?`, [sha256(`${longHash}:${cookie.split('=')[1]}`)])).toMatchObject({ scope: 'public', life: 604800 });

    const later = cookieOf(await publicLogin(pub));
    env.clock.advance(6 * 24 * 3600);
    expect((await inject(pub, { method: 'GET', url: '/api/jobs', headers: { ...host, cookie } })).statusCode).toBe(200);
    env.clock.advance(2 * 24 * 3600);
    // The browser would have dropped the cookie; a replayed one is refused by the database.
    expect((await inject(pub, { method: 'GET', url: '/api/jobs', headers: { ...host, cookie } })).statusCode).toBe(401);
    expect((await inject(pub, { method: 'GET', url: '/api/jobs', headers: { ...host, cookie: later } })).statusCode).toBe(401);

    const fresh = cookieOf(await publicLogin(pub));
    const out = await inject(pub, { method: 'POST', url: '/api/logout', headers: { ...write, cookie: fresh }, payload: {} });
    expect(out.statusCode).toBe(200);
    expect(String(out.headers['set-cookie'])).toBe('__Host-triglav_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict');
    expect((await inject(pub, { method: 'GET', url: '/api/jobs', headers: { ...host, cookie: fresh } })).statusCode).toBe(401);
  });

  it('refuses a password under 16 characters without counting it, and limits per client and in total', async () => {
    const shortHash = await hashPassword('short password');
    const short = buildServer(env.ctx, { ...(await testServerKeys()), passwordHash: shortHash, webDir, dashboard: DASHBOARD });
    try {
      for (let i = 0; i < 8; i++) {
        const res = await inject(short, { method: 'POST', url: '/api/login', headers: write, payload: { password: 'short password' } });
        expect(res.statusCode).toBe(400);
        expect(JSON.parse(res.body).message).toMatch(/at least 16 characters/);
      }
    } finally {
      await short.close();
    }

    const own = await build({ dashboard: DASHBOARD });
    const localOwn = await build();
    try {
      const attempt = (password: string, xff?: string) => inject(own, { method: 'POST', url: '/api/login', headers: xff ? { ...write, 'x-forwarded-for': xff } : write, payload: { password } });
      // The rightmost entry is the address: entries further left are what the client sent.
      for (let i = 0; i < 5; i++) expect((await attempt('wrong password, sixteen+', `10.9.9.${i}, 203.0.113.7`)).statusCode).toBe(401);
      const held = await attempt(LONG_PASSWORD, '1.2.3.4, 203.0.113.7');
      expect(held.statusCode).toBe(429);
      expect(Number(held.headers['retry-after'])).toBeGreaterThan(0);
      expect((await attempt(LONG_PASSWORD, '203.0.113.7, 203.0.113.8')).statusCode).toBe(200);
      // A short password is refused before the limiter, so it does not count either.
      expect((await attempt('short', '203.0.113.9')).statusCode).toBe(400);

      for (let a = 10; a < 35; a++) await attempt('wrong password, sixteen+', `203.0.113.${a}`);
      // 5 + 25 = 30 failures across addresses: every public login waits, but the local listener's login still works.
      expect((await attempt(LONG_PASSWORD, '198.51.100.1')).statusCode).toBe(429);
      expect((await attempt(LONG_PASSWORD)).statusCode).toBe(429);
      expect((await localOwn.inject({ method: 'POST', url: '/api/login', payload: { password: LONG_PASSWORD } })).statusCode).toBe(200);
    } finally {
      await own.close();
      await localOwn.close();
    }
  });

  it('records each successful public login with its time and address, newest first, behind the Client session', async () => {
    await env.ctx.pool.query(`DELETE FROM client_logins`);
    const own = await build({ dashboard: DASHBOARD });
    try {
      expect((await publicLogin(own, { 'x-forwarded-for': 'spoofed, 203.0.113.20' })).statusCode).toBe(200);
      env.clock.advance(60);
      // Not an IP: the socket address is used instead.
      expect((await publicLogin(own, { 'x-forwarded-for': '203.0.113.21, not-an-ip' })).statusCode).toBe(200);
      env.clock.advance(60);
      const cookie = cookieOf(await publicLogin(own, { 'x-forwarded-for': '2001:db8::1' }));
      expect((await inject(own, { method: 'POST', url: '/api/login', headers: { ...write, 'x-forwarded-for': '203.0.113.22' }, payload: { password: 'wrong password, sixteen+' } })).statusCode).toBe(401);

      const res = await inject(own, { method: 'GET', url: '/api/security/logins', headers: { ...host, cookie } });
      expect(res.statusCode).toBe(200);
      const logins = JSON.parse(res.body).logins as { at: string; address: string }[];
      expect(logins.map((l) => l.address)).toEqual(['2001:db8::1', '127.0.0.1', '203.0.113.20']);
      expect(Date.parse(logins[0]!.at)).toBeGreaterThan(Date.parse(logins[1]!.at));

      // The same route on the local listener needs a local session; the keys are no session.
      const localCookie = await loginCookie(local, LONG_PASSWORD);
      expect((await local.inject({ method: 'GET', url: '/api/security/logins', headers: { cookie: localCookie } })).statusCode).toBe(200);
      for (const app of [local, own]) {
        const h = app === own ? host : {};
        expect((await inject(app, { method: 'GET', url: '/api/security/logins', headers: h })).statusCode).toBe(401);
        for (const key of [TEST_ENROLLMENT_KEY, TEST_RUNNER_KEY]) expect((await inject(app, { method: 'GET', url: '/api/security/logins', headers: { ...h, authorization: `Bearer ${key}` } })).statusCode).toBe(401);
      }
      // Older than 90 days: no longer listed, even before another login deletes the rows.
      env.clock.advance(91 * 24 * 3600);
      const freshCookie = await loginCookie(local, LONG_PASSWORD);
      expect(JSON.parse((await local.inject({ method: 'GET', url: '/api/security/logins', headers: { cookie: freshCookie } })).body)).toEqual({ logins: [] });
      expect((await query(env.ctx.pool, `SELECT address FROM client_logins`)).length).toBe(3);
      // They go when a new one is written.
      await publicLogin(own, { 'x-forwarded-for': '203.0.113.30' });
      expect((await query(env.ctx.pool, `SELECT address FROM client_logins`)).map((r) => r.address)).toEqual(['203.0.113.30']);
    } finally {
      await own.close();
    }
  });

  it('gives the Models page the agents\' loopback address, also through the public listener', async () => {
    const cookie = cookieOf(await publicLogin(pub));
    const res = await inject(pub, { method: 'GET', url: '/api/role-models', headers: { ...host, cookie } });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).base_url).toBe('http://localhost:7400');
    // A trailing slash in ORCH_PUBLIC_URL is dropped, so the page does not build //guide.md.
    const slashed = buildServer({ ...env.ctx, baseUrl: 'http://localhost:7400/' }, { ...(await testServerKeys()), passwordHash: longHash, webDir });
    try {
      const view = await slashed.inject({ method: 'GET', url: '/api/role-models', headers: { cookie: await loginCookie(slashed, LONG_PASSWORD) } });
      expect(JSON.parse(view.body).base_url).toBe('http://localhost:7400');
    } finally {
      await slashed.close();
    }
  });

  it('sends HSTS on public responses, also on an event stream, and ends that stream on logout', async () => {
    expect((await inject(pub, { method: 'GET', url: '/api/health', headers: host })).headers['strict-transport-security']).toBe(HSTS);
    expect((await inject(pub, { method: 'GET', url: '/mcp', headers: host })).headers['strict-transport-security']).toBe(HSTS);
    expect((await inject(pub, { method: 'GET', url: '/', headers: host })).headers['strict-transport-security']).toBe(HSTS);

    const own = await build({ dashboard: DASHBOARD, streamCheckMs: 50 });
    await own.listen({ port: 0, host: '127.0.0.1' });
    const port = (own.server.address() as AddressInfo).port;
    try {
      const cookie = cookieOf(await publicLogin(own));
      // fetch() does not let a test set Host, so the stream is read with node:http.
      const ended = new Promise<{ status: number; hsts: unknown }>((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port, path: '/api/stream', headers: { host: DASHBOARD.host, cookie } }, (res) => {
          res.resume();
          res.on('end', () => resolve({ status: res.statusCode!, hsts: res.headers['strict-transport-security'] }));
        });
        req.setTimeout(3000, () => req.destroy(new Error('stream still open after 3 s')));
        req.on('error', reject);
        req.end();
      });
      await new Promise((r) => setTimeout(r, 150));
      expect((await own.inject({ method: 'POST', url: '/api/logout', headers: { ...write, cookie }, payload: {} })).statusCode).toBe(200);
      expect(await ended).toEqual({ status: 200, hsts: HSTS });
    } finally {
      await own.close();
    }
  });
});
