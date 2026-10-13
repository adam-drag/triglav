import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { AddressInfo } from 'node:net';
import { hashPassword, LoginLimiter, MAX_PASSWORD_LENGTH, parsePasswordHash, passwordLengthProblem, verifyPassword } from '../src/client-auth.ts';
import { readSecurityConfig } from '../src/config.ts';
import { queryOne } from '../src/db.ts';
import { sha256 } from '../src/lib.ts';
import { buildServer, CONTENT_SECURITY_POLICY } from '../src/server.ts';
import { asClient, createTestCtx, loginCookie, TEST_DB_URL, TEST_ENROLLMENT_KEY, TEST_PASSWORD, TEST_RUNNER_KEY, testPasswordHash, testServerKeys } from './helpers.ts';

describe('password hash', () => {
  it('is a salted scrypt hash that verifies only the right password and never contains it', async () => {
    const a = await hashPassword('correct horse battery');
    const b = await hashPassword('correct horse battery');
    expect(a).toMatch(/^scrypt:32768:8:1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/);
    expect(a).not.toContain('correct');
    expect(a).not.toEqual(b);
    expect(await verifyPassword(a, 'correct horse battery')).toBe(true);
    expect(await verifyPassword(a, 'correct horse batterz')).toBe(false);
    expect(await verifyPassword(a, '')).toBe(false);
  });

  it('refuses a malformed or abusive stored value instead of matching it', async () => {
    expect(parsePasswordHash('plain-text-password')).toBeNull();
    expect(parsePasswordHash('scrypt:32768:8:1:short:short')).toBeNull();
    const ok = await hashPassword('correct horse battery');
    expect(parsePasswordHash(ok)).not.toBeNull();
    expect(parsePasswordHash(ok.replace('scrypt:32768', 'scrypt:2147483648'))).toBeNull();
    expect(parsePasswordHash(ok.replace('scrypt:32768', 'scrypt:30000'))).toBeNull();
    expect(await verifyPassword('plain-text-password', 'plain-text-password')).toBe(false);
  });

  it('refuses parameters that each pass their own bound but need more memory than the container has', async () => {
    const ok = await hashPassword('correct horse battery');
    // N = 2^20 with r = 16 needs 2 GiB; the compose limit for the server is 1 GiB.
    expect(parsePasswordHash(ok.replace('scrypt:32768:8', 'scrypt:1048576:16'))).toBeNull();
    expect(parsePasswordHash(ok.replace('scrypt:32768:8', 'scrypt:1048576:8'))).toBeNull();
    expect(parsePasswordHash(ok.replace('scrypt:32768:8', 'scrypt:65536:8'))).not.toBeNull();
  });
});

describe('login rate limit', () => {
  it('lets 5 failed attempts in, then asks to wait, and a correct password does not count', () => {
    const limiter = new LoginLimiter(5, 600_000);
    const t0 = new Date('2026-10-12T10:00:00Z');
    for (let i = 0; i < 5; i++) expect(limiter.take(t0).waitSec).toBe(0);
    expect(limiter.take(t0).waitSec).toBe(600);
    expect(limiter.take(new Date(t0.getTime() + 300_000)).waitSec).toBe(300);
    expect(limiter.take(new Date(t0.getTime() + 601_000)).waitSec).toBe(0);

    const fresh = new LoginLimiter(2, 600_000);
    for (let i = 0; i < 10; i++) fresh.take(t0).refund();
    expect(fresh.take(t0).waitSec).toBe(0);
    expect(fresh.take(t0).waitSec).toBe(0);
    expect(fresh.take(t0).waitSec).toBeGreaterThan(0);
  });
});

describe('startup credentials', () => {
  const good = { ORCH_ENROLLMENT_KEY: 'e'.repeat(32), ORCH_RUNNER_KEY: 'r'.repeat(32), ORCH_CLIENT_PASSWORD_HASH: '' };
  it('refuses a missing, short or equal runner key and a missing or bad password hash, and says how to fix each', async () => {
    const hash = await hashPassword('correct horse battery');
    const env = { ...good, ORCH_CLIENT_PASSWORD_HASH: hash };
    expect(readSecurityConfig(env)).toMatchObject({ ok: true });

    const missing = readSecurityConfig({ ...env, ORCH_RUNNER_KEY: undefined });
    expect(missing).toMatchObject({ ok: false });
    expect((missing as any).errors.join('\n')).toMatch(/ORCH_RUNNER_KEY is missing.*openssl rand -hex 24/);
    const short = readSecurityConfig({ ...env, ORCH_RUNNER_KEY: 'r'.repeat(23) });
    expect((short as any).errors.join('\n')).toMatch(/ORCH_RUNNER_KEY must be at least 24 characters/);
    expect(readSecurityConfig({ ...env, ORCH_RUNNER_KEY: 'r'.repeat(24) })).toMatchObject({ ok: true });
    const same = readSecurityConfig({ ...env, ORCH_RUNNER_KEY: env.ORCH_ENROLLMENT_KEY });
    expect((same as any).errors.join('\n')).toMatch(/must differ from ORCH_ENROLLMENT_KEY/);
    expect((readSecurityConfig({ ...env, ORCH_CLIENT_PASSWORD_HASH: undefined }) as any).errors.join('\n')).toMatch(/node scripts\/set-password\.ts/);
    expect(readSecurityConfig({ ...env, ORCH_CLIENT_PASSWORD_HASH: 'hunter2' })).toMatchObject({ ok: false });
  });

  it('keeps the real server from starting, with a message, before it touches the database', () => {
    const run = (env: Record<string, string>) => spawnSync('node', ['src/main.ts'], { env: { PATH: process.env.PATH!, ...env }, encoding: 'utf8', timeout: 20_000 });
    const noRunnerKey = run({ DATABASE_URL: 'mysql://nobody:x@127.0.0.1:1/none', ORCH_ENROLLMENT_KEY: 'e'.repeat(32) });
    expect(noRunnerKey.status).toBe(1);
    expect(noRunnerKey.stderr).toMatch(/ORCH_RUNNER_KEY is missing/);
    const equal = run({ DATABASE_URL: 'mysql://nobody:x@127.0.0.1:1/none', ORCH_ENROLLMENT_KEY: 'e'.repeat(32), ORCH_RUNNER_KEY: 'e'.repeat(32) });
    expect(equal.status).toBe(1);
    expect(equal.stderr).toMatch(/must differ from ORCH_ENROLLMENT_KEY/);
  });
});

describe.skipIf(!TEST_DB_URL)('who may call what', () => {
  let env: Awaited<ReturnType<typeof createTestCtx>>;
  let app: ReturnType<typeof buildServer>;
  let base = '';
  let cookie = '';
  let client: ReturnType<typeof asClient>;
  const json = { 'content-type': 'application/json' };
  const runner = { authorization: `Bearer ${TEST_RUNNER_KEY}`, ...json };

  beforeAll(async () => {
    env = await createTestCtx(null);
    app = buildServer(env.ctx, { ...(await testServerKeys()), webDir: '/nonexistent' });
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://localhost:${(app.server.address() as AddressInfo).port}`;
    cookie = await loginCookie(app);
    client = asClient(app, cookie);
  });
  afterAll(async () => {
    await app?.close();
    await env?.close();
  });

  it('answers 401 to every Client endpoint without a session, also when no Origin header is sent', async () => {
    const client_routes: [string, string][] = [
      ['GET', '/api/jobs'], ['GET', '/api/jobs/job_x'], ['GET', '/api/threads/thr_x'], ['GET', '/api/agents'], ['GET', '/api/agents/agt_x'], ['GET', '/api/role-models'],
      ['GET', '/api/runtimes'], ['GET', '/api/usage'], ['GET', '/api/artifacts'], ['GET', '/api/feed'], ['GET', '/api/map'], ['GET', '/api/queue'], ['GET', '/api/resume'],
      ['GET', '/api/chats'], ['GET', '/api/chats/cht_x'], ['GET', '/api/chats/cht_x/stream'], ['GET', '/api/job-requests'], ['GET', '/api/research'], ['GET', '/api/board'],
      ['GET', '/api/events'], ['GET', '/api/stream'], ['GET', '/api/session'],
      ['POST', '/api/chats'], ['POST', '/api/chats/cht_x/messages'], ['POST', '/api/chats/cht_x/stop'], ['POST', '/api/chats/cht_x/actions/act_x'],
      ['POST', '/api/job-requests'], ['POST', '/api/job-requests/req_x/retry'], ['POST', '/api/job-requests/req_x/dismiss'], ['POST', '/api/job-requests/req_x/cancel'],
      ['POST', '/api/research/personas'], ['PUT', '/api/research/personas/per_x'], ['PUT', '/api/role-models/senior'], ['PUT', '/api/review-mode'],
      ['POST', '/api/jobs/job_x/control'], ['POST', '/api/jobs/job_x/refine'], ['POST', '/api/jobs/job_x/approve'], ['POST', '/api/jobs/job_x/reopen'], ['POST', '/api/jobs/job_x/staff'],
      ['POST', '/api/agents/agt_x/poke'], ['POST', '/api/agents/agt_x/resume'], ['POST', '/api/messages'], ['POST', '/api/questions'], ['POST', '/api/decisions'], ['POST', '/api/blockers/blk_x/resolve'],
    ];
    for (const [method, path] of client_routes) {
      const res = await fetch(`${base}${path}`, { method, headers: json, body: method === 'GET' ? undefined : '{}' });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
    // The route is matched on its pattern, so an encoded path cannot slip past the check.
    expect((await fetch(`${base}/%61pi/jobs`)).status).not.toBe(200);
    // The runner key and the enrollment key are not a Client session.
    for (const key of [TEST_RUNNER_KEY, TEST_ENROLLMENT_KEY]) expect((await fetch(`${base}/api/jobs`, { headers: { authorization: `Bearer ${key}` } })).status).toBe(401);
    // A made-up cookie is no session.
    expect((await fetch(`${base}/api/jobs`, { headers: { cookie: 'triglav_session=nope' } })).status).toBe(401);
  });

  it('lets a Client with a session read and write, and a write is a real effect (job approve, chat confirm, blocker resolve reach their handlers)', async () => {
    expect((await client.inject({ method: 'GET', url: '/api/jobs' })).statusCode).toBe(200);
    expect((await client.inject({ method: 'GET', url: '/api/session' })).statusCode).toBe(200);
    // With a session the handlers run: these ids do not exist, so the answer is the handler's own 404, not 401.
    expect((await client.inject({ method: 'POST', url: '/api/jobs/job_x/approve', payload: {} })).statusCode).toBe(404);
    expect((await client.inject({ method: 'POST', url: '/api/blockers/blk_x/resolve', payload: { resolution: 'ok' } })).statusCode).toBe(404);
    expect((await client.inject({ method: 'POST', url: '/api/chats/cht_x/actions/act_x', payload: { decision: 'confirm' } })).statusCode).toBe(404);
    // A session does not open the runner API.
    expect((await client.inject({ method: 'POST', url: '/api/runner/next', payload: {} })).statusCode).toBe(401);
  });

  it('keeps health, the stop hook, the status line usage and the guide open', async () => {
    expect((await fetch(`${base}/api/health`)).status).toBe(200);
    expect((await fetch(`${base}/guide.md`)).status).toBe(200);
    expect((await fetch(`${base}/api/hooks/stop`, { method: 'POST', headers: json, body: JSON.stringify({ session_token: 'orch_tok_unknown' }) })).status).not.toBe(401);
    expect((await fetch(`${base}/api/usage/claude`, { method: 'POST', headers: json, body: JSON.stringify({ five_hour: { used_percentage: 12 } }) })).status).toBe(200);
  });

  it('opens /api/runner/* for the runner key only, and /mcp for the enrollment key only', async () => {
    expect((await fetch(`${base}/api/runner/next`, { method: 'POST', headers: runner, body: '{}' })).status).toBe(200);
    expect((await fetch(`${base}/api/runner/next`, { method: 'POST', headers: { authorization: `Bearer ${TEST_ENROLLMENT_KEY}`, ...json }, body: '{}' })).status).toBe(401);
    expect((await fetch(`${base}/api/runner/runtimes`, { method: 'POST', headers: { authorization: `Bearer ${TEST_ENROLLMENT_KEY}`, ...json }, body: JSON.stringify({ 'claude-code': null, codex: null }) })).status).toBe(401);
    expect((await fetch(`${base}/api/runner/chat/hello`, { method: 'POST', headers: { authorization: `Bearer ${TEST_ENROLLMENT_KEY}`, ...json }, body: '{}' })).status).toBe(401);
    expect((await fetch(`${base}/api/runner/lch_x/done`, { method: 'POST', headers: { authorization: `Bearer ${TEST_ENROLLMENT_KEY}`, ...json }, body: '{"result":"x"}' })).status).toBe(401);
    expect((await fetch(`${base}/api/runner/next`, { method: 'POST', headers: json, body: '{}' })).status).toBe(401);

    const connect = async (key: string) => {
      const c = new Client({ name: 'test', version: '0' });
      await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${key}` } } }));
      return c;
    };
    await expect(connect(TEST_RUNNER_KEY)).rejects.toThrow();
    const ok = await connect(TEST_ENROLLMENT_KEY);
    expect((await ok.listTools()).tools.length).toBeGreaterThan(0);
    await ok.close();
  });

  it('stores only a hash of the session id, ends the session on logout, and sets a hardened cookie', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/login', payload: { password: TEST_PASSWORD } });
    const setCookie = String(res.headers['set-cookie']);
    expect(setCookie).toMatch(/^triglav_session=[A-Za-z0-9_-]{40,}; Path=\/; Max-Age=2592000; HttpOnly; SameSite=Strict$/);
    const id = setCookie.split(';')[0]!.split('=')[1]!;
    expect(await queryOne(env.ctx.pool, `SELECT id_hash FROM client_sessions WHERE id_hash = ?`, [id])).toBeUndefined();
    expect(await queryOne(env.ctx.pool, `SELECT id_hash FROM client_sessions WHERE id_hash = ?`, [sha256(`${await testPasswordHash()}:${id}`)])).toBeDefined();
    const mine = asClient(app, `triglav_session=${id}`);
    expect((await mine.inject({ method: 'GET', url: '/api/jobs' })).statusCode).toBe(200);
    const out = await mine.inject({ method: 'POST', url: '/api/logout', payload: {} });
    expect(out.statusCode).toBe(200);
    expect(String(out.headers['set-cookie'])).toContain('Max-Age=0');
    expect(await queryOne(env.ctx.pool, `SELECT id_hash FROM client_sessions WHERE id_hash = ?`, [sha256(`${await testPasswordHash()}:${id}`)])).toBeUndefined();
    expect((await mine.inject({ method: 'GET', url: '/api/jobs' })).statusCode).toBe(401);
  });

  it('ends every session when the password hash changes', async () => {
    const cookie = await loginCookie(app);
    expect((await asClient(app, cookie).inject({ method: 'GET', url: '/api/jobs' })).statusCode).toBe(200);
    const rotated = buildServer(env.ctx, { ...(await testServerKeys()), passwordHash: await hashPassword('another password, rotated'), webDir: '/nonexistent' });
    expect((await asClient(rotated, cookie).inject({ method: 'GET', url: '/api/jobs' })).statusCode).toBe(401);
    expect((await asClient(app, cookie).inject({ method: 'GET', url: '/api/jobs' })).statusCode).toBe(200);
    await rotated.close();
  });

  it('expires a session after 30 days', async () => {
    const id = (await loginCookie(app)).split('=')[1]!;
    const mine = asClient(app, `triglav_session=${id}`);
    env.clock.advance(29 * 24 * 3600);
    expect((await mine.inject({ method: 'GET', url: '/api/jobs' })).statusCode).toBe(200);
    env.clock.advance(2 * 24 * 3600);
    expect((await mine.inject({ method: 'GET', url: '/api/jobs' })).statusCode).toBe(401);
  });

  it('accepts at login every password that set-password accepts, up to the shared maximum, and nothing above it', async () => {
    const longest = 'p'.repeat(MAX_PASSWORD_LENGTH);
    const own = buildServer(env.ctx, { ...(await testServerKeys()), passwordHash: await hashPassword(longest), webDir: '/nonexistent' });
    const attempt = (password: string) => own.inject({ method: 'POST', url: '/api/login', payload: { password } });
    expect((await attempt(longest)).statusCode).toBe(200);
    expect((await attempt(longest + 'p')).statusCode).toBe(400);
    // Counted as set-password counts it: normalized, in characters. 1000 characters that take 2000 UTF-16 units still log in.
    const astral = '\u{1F600}'.repeat(MAX_PASSWORD_LENGTH);
    expect(passwordLengthProblem(astral)).toBeNull();
    const second = buildServer(env.ctx, { ...(await testServerKeys()), passwordHash: await hashPassword(astral), webDir: '/nonexistent' });
    expect((await second.inject({ method: 'POST', url: '/api/login', payload: { password: astral } })).statusCode).toBe(200);
    expect((await second.inject({ method: 'POST', url: '/api/login', payload: { password: astral + 'p' } })).statusCode).toBe(400);
    expect(passwordLengthProblem(longest)).toBeNull();
    expect(passwordLengthProblem(longest + 'p')).toMatch(/at most 1000 characters/);
    await own.close();
    await second.close();
  });

  it('rejects a wrong password, then rate limits, and carries a strict Content-Security-Policy', async () => {
    const own = buildServer(env.ctx, { ...(await testServerKeys()), webDir: '/nonexistent' });
    const attempt = (password: string) => own.inject({ method: 'POST', url: '/api/login', payload: { password } });
    for (let i = 0; i < 5; i++) expect((await attempt('wrong password')).statusCode).toBe(401);
    const blocked = await attempt(TEST_PASSWORD);
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    env.clock.advance(11 * 60);
    expect((await attempt(TEST_PASSWORD)).statusCode).toBe(200);
    await own.close();

    const health = await app.inject({ method: 'GET', url: '/api/health' });
    expect(health.headers['content-security-policy']).toBe(CONTENT_SECURITY_POLICY);
    expect(CONTENT_SECURITY_POLICY).toMatch(/^default-src 'self'; /);
    expect(CONTENT_SECURITY_POLICY).not.toMatch(/unsafe-/);
  });

  it('ends an open event stream and chat stream when the session is logged out or expires', async () => {
    const own = buildServer(env.ctx, { ...(await testServerKeys()), webDir: '/nonexistent', streamCheckMs: 50 });
    await own.listen({ port: 0, host: '127.0.0.1' });
    const url = `http://localhost:${(own.server.address() as AddressInfo).port}`;
    try {
      const first = (await loginCookie(own)).split('=')[1]!;
      const second = (await loginCookie(own)).split('=')[1]!;
      const headers = (id: string) => ({ cookie: `triglav_session=${id}`, 'content-type': 'application/json' });
      const chat = (await (await fetch(`${url}/api/chats`, { method: 'POST', headers: headers(first), body: JSON.stringify({ text: 'hello' }) })).json()) as { id: string };
      // Resolves when the server ends the stream; rejects if the stream is still open after 3 s.
      const ends = async (path: string, id: string) => {
        const res = await fetch(`${url}${path}`, { headers: headers(id), signal: AbortSignal.timeout(3000) });
        expect(res.status).toBe(200);
        const reader = res.body!.getReader();
        while (!(await reader.read()).done);
      };
      const logoutEnds = ends('/api/stream', first);
      const chatEnds = ends(`/api/chats/${chat.id}/stream`, first);
      await new Promise((r) => setTimeout(r, 150));
      expect((await fetch(`${url}/api/logout`, { method: 'POST', headers: headers(first), body: '{}' })).status).toBe(200);
      await Promise.all([logoutEnds, chatEnds]);

      const expiryEnds = ends('/api/stream', second);
      await new Promise((r) => setTimeout(r, 150));
      env.clock.advance(31 * 24 * 3600);
      await expiryEnds;
    } finally {
      await own.close();
    }
  });

  it('ends an open stream when the session check itself fails, instead of leaving it open', async () => {
    const own = buildServer(env.ctx, { ...(await testServerKeys()), webDir: '/nonexistent', streamCheckMs: 50 });
    await own.listen({ port: 0, host: '127.0.0.1' });
    const url = `http://localhost:${(own.server.address() as AddressInfo).port}`;
    const real = env.ctx.pool.query.bind(env.ctx.pool);
    try {
      const id = (await loginCookie(own)).split('=')[1]!;
      const res = await fetch(`${url}/api/stream`, { headers: { cookie: `triglav_session=${id}` }, signal: AbortSignal.timeout(3000) });
      expect(res.status).toBe(200);
      // From now on the session lookup fails, as it does when the database is down.
      (env.ctx.pool as any).query = (sql: unknown, ...rest: unknown[]) => (String(sql).includes('client_sessions') ? Promise.reject(new Error('database is down')) : (real as any)(sql, ...rest));
      const reader = res.body!.getReader();
      while (!(await reader.read()).done);
    } finally {
      (env.ctx.pool as any).query = real;
      await own.close();
    }
  });
});
