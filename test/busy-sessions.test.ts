import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listAgents, ownerIsLive, presenceOf, registerAgent } from '../src/agents.ts';
import { recordBusySessions } from '../src/busy-sessions.ts';
import { POLICY } from '../src/context.ts';
import { exec, queryOne, withTx } from '../src/db.ts';
import type { AddressInfo } from 'node:net';
import { latestEventId } from '../src/events.ts';
import { tick } from '../src/scheduler.ts';
import { buildServer } from '../src/server.ts';
import { resumeList } from '../src/telemetry.ts';
import { busyOf, busyReport, busyReporter } from '../scripts/forks.ts';
import { asClient, createTestCtx, FakeClock, loginCookie, TEST_DB_URL, TEST_ENROLLMENT_KEY, TEST_RUNNER_KEY, testServerKeys } from './helpers.ts';

const at = (iso: string) => new Date(iso);

describe('presenceOf with busy_at', () => {
  const clock = new FakeClock('2026-10-29T12:00:00.000Z');
  const ctx = { clock } as any;
  const old = at('2026-10-29T11:00:00.000Z');
  const base = { last_seen_at: old, waiting_until: null, ended_at: null, transcript_at: old };

  it('is working while busy_at is under busySessionSec, with no call and no transcript line', () => {
    expect(presenceOf(ctx, { ...base, busy_at: null })).toBe('offline');
    expect(presenceOf(ctx, { ...base, busy_at: at('2026-10-29T11:59:00.000Z') })).toBe('working');
    expect(presenceOf(ctx, { ...base, busy_at: new Date(clock.now().getTime() - (POLICY.busySessionSec - 1) * 1000) })).toBe('working');
    expect(presenceOf(ctx, { ...base, busy_at: new Date(clock.now().getTime() - POLICY.busySessionSec * 1000) })).toBe('offline');
  });

  it('does not override ended or waiting', () => {
    const busy = at('2026-10-29T11:59:30.000Z');
    expect(presenceOf(ctx, { ...base, ended_at: old, busy_at: busy })).toBe('ended');
    expect(presenceOf(ctx, { ...base, waiting_until: at('2026-10-29T12:30:00.000Z'), busy_at: busy })).toBe('waiting');
  });
});

describe('busyOf (runner parsing)', () => {
  const id = (c: string) => `${c.repeat(8)}-${c.repeat(4)}-${c.repeat(4)}-${c.repeat(4)}-${c.repeat(12)}`;
  it('keeps only busy entries with a full session UUID, drops blocked, nulls unknown states, dedupes, sends nothing else', () => {
    const out = busyOf([
      { kind: 'background', id: 'aaaa1111', sessionId: id('a'), status: 'busy', state: 'working', cwd: '/secret', name: 'x', pid: 1 },
      { kind: 'background', sessionId: id('a'), status: 'busy', state: 'working', pid: 1 },
      { kind: 'background', sessionId: id('b'), status: 'idle', state: 'blocked', pid: 2 },
      { kind: 'background', sessionId: id('c'), status: 'busy', state: 'blocked', pid: 3 },
      { kind: 'background', sessionId: id('d'), status: 'busy', state: 'something new', pid: 4 },
      { kind: 'background', sessionId: 'aaaa1111', status: 'busy', state: 'working', pid: 5 },
      { kind: 'background', sessionId: id('e'), status: null, state: 'blocked', pid: 6 },
      { kind: 'background', sessionId: id('f'), status: 'busy', state: 'working' },
      null,
      'junk',
    ]);
    expect(out).toEqual([
      { sessionId: id('a'), status: 'busy', state: 'working' },
      { sessionId: id('d'), status: 'busy', state: null },
    ]);
    expect(busyOf({ not: 'an array' })).toEqual([]);
  });

  it('caps the report at 200 entries', () => {
    const many = Array.from({ length: 250 }, (_, i) => ({ sessionId: `${i.toString(16).padStart(8, '0')}-0000-0000-0000-000000000000`, status: 'busy', state: 'working', pid: i + 1 }));
    expect(busyOf(many)).toHaveLength(200);
  });
});

describe('busyReport (runner call)', () => {
  const sid = '22061f6f-2378-4a90-a582-a7ae97af4284';
  it('runs a fixed argv without --cwd, scrubbed env, timeout with SIGKILL and an output cap; sends only the parsed fields', async () => {
    const calls: { cmd: string; args: string[]; opts: any }[] = [];
    process.env.ORCH_RUNNER_KEY_TEST_PROBE = 'x';
    const out = await busyReport('/home/u', (cmd, args, opts, cb) => {
      calls.push({ cmd, args, opts });
      cb(null, JSON.stringify([{ kind: 'background', sessionId: sid, status: 'busy', state: 'working', pid: 9, cwd: '/home/u/secret', name: 'n' }]));
    });
    delete process.env.ORCH_RUNNER_KEY_TEST_PROBE;
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe('claude');
    expect(calls[0]!.args).toEqual(['agents', '--json']);
    expect(calls[0]!.opts).toMatchObject({ cwd: '/home/u', timeout: 30_000, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024 });
    expect(Object.keys(calls[0]!.opts.env).some((k) => k.startsWith('ORCH_'))).toBe(false);
    expect(out).toEqual({ sessions: [{ sessionId: sid, status: 'busy', state: 'working' }] });
  });

  it('fails with a fixed message, never the output or stderr', async () => {
    const secret = 'stderr-with-secret-token';
    await expect(busyReport('/h', (_c, _a, _o, cb) => cb(Object.assign(new Error(`Command failed\n${secret}`), { code: 1 }), secret))).rejects.toThrow(/^claude agents --json failed \(1\)$/);
    await expect(busyReport('/h', (_c, _a, _o, cb) => cb(null, `not json ${secret}`))).rejects.toThrow(/^claude agents --json printed no JSON$/);
  });
});

describe('busyReporter (runner tick)', () => {
  it('skips a tick while the previous one runs, posts only { sessions }, and runs again after a failure', async () => {
    let release!: (v: { sessions: unknown[] }) => void;
    const posted: unknown[] = [];
    const logs: string[] = [];
    let fail = false;
    const report = () => (fail ? Promise.reject(new Error('claude agents --json failed (1)\nsecret')) : new Promise<{ sessions: unknown[] }>((r) => (release = r)));
    const tickOnce = busyReporter(report as any, async (b) => void posted.push(b), (l) => logs.push(l));
    const first = tickOnce();
    expect(await tickOnce()).toBe('skipped');
    release({ sessions: [{ sessionId: 'x' }], extra: 'dropped' } as any);
    expect(await first).toBe('sent');
    expect(posted).toEqual([{ sessions: [{ sessionId: 'x' }] }]);
    fail = true;
    expect(await tickOnce()).toBe('failed');
    expect(logs).toEqual(['report busy sessions: claude agents --json failed (1)']);
    fail = false;
    const again = tickOnce();
    release({ sessions: [] });
    expect(await again).toBe('sent');
  });
});

describe.skipIf(!TEST_DB_URL)('busy sessions report', () => {
  let env: Awaited<ReturnType<typeof createTestCtx>>;
  let app: ReturnType<typeof buildServer>;
  let cookie = '';
  let n = 0;
  const runner = { authorization: `Bearer ${TEST_RUNNER_KEY}` };
  const sid = () => {
    const h = (++n).toString(16).padStart(12, '0');
    return `22061f6f-2378-4a90-a582-${h}`;
  };

  beforeAll(async () => {
    env = await createTestCtx(null);
    env.clock.set('2026-10-29T12:00:00.000Z');
    app = buildServer(env.ctx, { ...(await testServerKeys()), webDir: '/nonexistent' });
    cookie = await loginCookie(app);
  });
  afterAll(async () => {
    await app?.close();
    await env?.close();
  });

  async function claudeAgent(role: 'staff' | 'senior' = 'staff', session = sid()) {
    const reg = await registerAgent(env.ctx, { role: role === 'senior' ? 'staff' : role, nickname: `a-${++n}`, runtime: 'claude-code' });
    await exec(env.ctx.pool, `UPDATE agents SET runtime = 'claude-code', role = ? WHERE id = ?`, [role, reg.agent_id]);
    await exec(env.ctx.pool, `UPDATE agent_sessions SET transcript_session = ?, transcript_cwd = '/repo' WHERE agent_id = ?`, [session, reg.agent_id]);
    return { id: reg.agent_id as string, session, at: env.clock.now().getTime() };
  }
  const busyAt = async (agentId: string) => (await queryOne(env.ctx.pool, `SELECT busy_at FROM agent_sessions WHERE agent_id = ?`, [agentId]))!.busy_at as Date | null;
  const presence = async (agentId: string) => (await listAgents(env.ctx, { includeInactive: true })).find((a) => a.id === agentId)?.presence;
  const post = (payload: unknown, headers: Record<string, string> = runner) => app.inject({ method: 'POST', url: '/api/runner/busy-sessions', headers, payload: payload as any });

  it('sets busy_at for a busy session and shows it working with no call and no transcript line; no agent event', async () => {
    const a = await claudeAgent();
    env.clock.advance(POLICY.presenceOfflineSec + 60);
    expect(await presence(a.id)).toBe('offline');
    const before = await latestEventId(env.ctx.pool);
    let presenceBumps = 0;
    let changes = 0;
    const onPresence = () => presenceBumps++;
    const onChange = () => changes++;
    env.ctx.bus.on('presence', onPresence);
    env.ctx.bus.on('change', onChange);
    const res = await post({ sessions: [{ sessionId: a.session, status: 'busy', state: 'working' }, { sessionId: a.session, status: 'busy', state: 'working' }] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, updated: 1 });
    expect(await presence(a.id)).toBe('working');
    expect(await latestEventId(env.ctx.pool)).toBe(before);
    // One dashboard bump for the change, none for a report that changes no presence, and no agent wake.
    await post({ sessions: [{ sessionId: a.session, status: 'busy', state: 'working' }] });
    env.ctx.bus.off('presence', onPresence);
    env.ctx.bus.off('change', onChange);
    expect(presenceBumps).toBe(1);
    expect(changes).toBe(0);
    env.clock.advance(POLICY.busySessionSec);
    expect(await presence(a.id)).toBe('offline');
  });

  it('never sets busy_at for an idle or blocked session, an unknown session, an ended one or a Senior; never creates rows', async () => {
    const idle = await claudeAgent();
    const blocked = await claudeAgent();
    const senior = await claudeAgent('senior');
    const ended = await claudeAgent();
    await exec(env.ctx.pool, `UPDATE agent_sessions SET ended_at = ? WHERE agent_id = ?`, [env.clock.now(), ended.id]);
    env.clock.advance(POLICY.presenceOfflineSec + 60);
    const rows = async () => (await queryOne(env.ctx.pool, `SELECT COUNT(*) AS n FROM agent_sessions`))!.n;
    const count = await rows();
    const res = await post({
      sessions: [
        { sessionId: idle.session, status: 'idle', state: 'blocked' },
        { sessionId: blocked.session, status: 'busy', state: 'blocked' },
        { sessionId: senior.session, status: 'busy', state: 'working' },
        { sessionId: ended.session, status: 'busy', state: 'working' },
        { sessionId: '99999999-9999-4999-8999-999999999999', status: 'busy', state: null },
      ],
    });
    expect(res.json()).toEqual({ ok: true, updated: 0 });
    for (const x of [idle, blocked, senior, ended]) expect(await busyAt(x.id)).toBeNull();
    expect(await rows()).toBe(count);
    expect(await presence(idle.id)).toBe('offline');
  });

  it('refuses malformed, oversized, unauthenticated and wrongly authenticated reports', async () => {
    const ok = { sessionId: '22061f6f-2378-4a90-a582-a7ae97af4284', status: 'busy', state: 'working' };
    const bad = [
      { sessions: [{ ...ok, sessionId: '22061f6f' }] },
      { sessions: [{ ...ok, sessionId: ok.sessionId.toUpperCase() }] },
      { sessions: [{ ...ok, status: 'running' }] },
      { sessions: [{ ...ok, state: 'x'.repeat(50) }] },
      { sessions: [{ ...ok, cwd: '/home' }] },
      { sessions: [ok], extra: 1 },
      { sessions: 'nope' },
      { sessions: Array.from({ length: 201 }, () => ok) },
    ];
    for (const body of bad) expect((await post(body)).statusCode).toBe(400);
    const huge = JSON.stringify({ sessions: [ok], pad: 'x'.repeat(70 * 1024) });
    expect((await app.inject({ method: 'POST', url: '/api/runner/busy-sessions', headers: { ...runner, 'content-type': 'application/json' }, payload: huge })).statusCode).toBe(413);
    expect((await post({ sessions: [ok] }, {})).statusCode).toBe(401);
    expect((await post({ sessions: [ok] }, { authorization: 'Bearer wrong-key-wrong-key-wrong-key' })).statusCode).toBe(401);
    expect((await post({ sessions: [ok] }, { authorization: `Bearer ${TEST_ENROLLMENT_KEY}` })).statusCode).toBe(401);
    expect((await asClient(app, cookie).inject({ method: 'POST', url: '/api/runner/busy-sessions', payload: { sessions: [ok] } })).statusCode).toBe(401);
    expect((await post({ sessions: [ok] })).statusCode).toBe(200);
  });

  it('never reaps a busy session; raises unavailable_owner once busy for busyLiveCapSec with no call or transcript line, and a busy report with activity clears it', async () => {
    const a = await claudeAgent();
    const job = `job_b${n}`;
    const reaps = async () => (await queryOne(env.ctx.pool, `SELECT COUNT(*) AS n FROM launches WHERE agent_id = ? AND kind = 'reap_session'`, [a.id]))!.n;
    const blocker = async () => queryOne(env.ctx.pool, `SELECT id, resolved_at FROM blockers WHERE job_id = ? AND kind = 'unavailable_owner' ORDER BY created_at DESC LIMIT 1`, [job]);
    // A job with its General thread, so the scheduler can raise and resolve blockers on it.
    await exec(env.ctx.pool, `INSERT INTO jobs (id, linear_issue_id, linear_identifier, linear_url, linear_snapshot, title, repo_path, base_branch, staff_agent_id, status, linear_fetched_at, created_at, updated_at) VALUES (?, ?, ?, '', '{}', 't', '/repo', 'main', ?, 'in_progress', ?, ?, ?)`, [job, `li_b${n}`, `BSY-${n}`, a.id, env.clock.now(), env.clock.now(), env.clock.now()]);
    await exec(env.ctx.pool, `INSERT INTO threads (id, job_id, kind, title, created_by, created_at) VALUES (?, ?, 'discussion', 'General', ?, ?)`, [`thr_b${n}`, job, a.id, env.clock.now()]);
    const report = () => recordBusySessions(env.ctx, { sessions: [{ sessionId: a.session, status: 'busy', state: 'working' }] });
    // The runner reports busy every 60 s up to just before the cap: no reap, no resume card, no blocker.
    const step = async () => {
      env.clock.advance(60);
      await report();
      await tick(env.ctx);
    };
    while (env.clock.now().getTime() < a.at + (POLICY.busyLiveCapSec - 60) * 1000) await step();
    expect(await reaps()).toBe(0);
    expect((await resumeList(env.ctx)).some((r) => r.agent_id === a.id)).toBe(false);
    expect(await blocker()).toBeUndefined();
    // Past the cap: the Client gets the blocker, and the session is still never reaped while busy.
    for (let i = 0; i < 3 * 60; i++) await step();
    expect(await blocker()).toMatchObject({ resolved_at: null });
    expect(await reaps()).toBe(0);
    // A transcript line brings it back: with a busy report, clearReturnedStaff resolves the blocker.
    await exec(env.ctx.pool, `UPDATE agent_sessions SET transcript_at = ? WHERE agent_id = ?`, [new Date(env.clock.now().getTime() - 10 * 60 * 1000), a.id]);
    await step();
    expect((await blocker())!.resolved_at).toBeTruthy();
    await exec(env.ctx.pool, `UPDATE jobs SET status = 'done' WHERE id = ?`, [job]);
  });

  it('a busy sibling on the same process vetoes reaping an old registration (NO_LIVE_SIBLING_SQL)', async () => {
    const session = sid();
    const old = await claudeAgent('staff', session);
    env.clock.advance(POLICY.reapAgentSessionSec + 60);
    const fresh = await claudeAgent('staff', session);
    await exec(env.ctx.pool, `UPDATE agent_sessions SET last_seen_at = ? WHERE agent_id = ?`, [new Date(env.clock.now().getTime() - (POLICY.reapAgentSessionSec + 60) * 1000), fresh.id]);
    await exec(env.ctx.pool, `UPDATE agent_sessions SET transcript_at = ? WHERE agent_id = ?`, [new Date(env.clock.now().getTime() - 3 * 60 * 60 * 1000), fresh.id]);
    // Only busy_at on the sibling keeps the process: recordBusySessions marks both rows (same transcript_session),
    // so set it on the sibling alone.
    await exec(env.ctx.pool, `UPDATE agent_sessions SET busy_at = ? WHERE agent_id = ?`, [env.clock.now(), fresh.id]);
    await tick(env.ctx);
    const launches = async (id: string) => (await queryOne(env.ctx.pool, `SELECT COUNT(*) AS n FROM launches WHERE agent_id = ? AND kind = 'reap_session'`, [id]))!.n;
    expect(await launches(old.id)).toBe(0);
    expect(await launches(fresh.id)).toBe(0);
    // Without the busy report both are stale and the old registration is reaped.
    await exec(env.ctx.pool, `UPDATE agent_sessions SET busy_at = NULL WHERE agent_id = ?`, [fresh.id]);
    await tick(env.ctx);
    expect((await launches(old.id)) + (await launches(fresh.id))).toBeGreaterThan(0);
  });

  it('sends one id-less presence message on /api/stream when a report changes presence, none when it does not', async () => {
    const a = await claudeAgent();
    env.clock.advance(POLICY.presenceOfflineSec + 60);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as AddressInfo).port;
    const ctl = new AbortController();
    const res = await fetch(`http://localhost:${port}/api/stream`, { headers: { cookie }, signal: ctl.signal });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    let text = '';
    // One read stays pending across calls, so a chunk that arrives after a timeout is not lost.
    let pending: ReturnType<typeof reader.read> | null = null;
    const read = async (ms: number) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        pending ??= reader.read();
        const r = await Promise.race([pending, new Promise<null>((ok) => setTimeout(() => ok(null), end - Date.now()))]);
        if (!r) break;
        pending = null;
        if (r.done) break;
        text += new TextDecoder().decode(r.value);
      }
    };
    await read(200);
    text = '';
    await recordBusySessions(env.ctx, { sessions: [{ sessionId: a.session, status: 'busy', state: 'working' }] });
    await recordBusySessions(env.ctx, { sessions: [{ sessionId: a.session, status: 'busy', state: 'working' }] });
    await read(300);
    ctl.abort();
    expect(text.match(/data: \{"type":"presence"\}/g)).toHaveLength(1);
    expect(text).not.toMatch(/^id:/m);
  });

  it('ownerIsLive treats a recent busy report as live (takeovers and clearReturnedStaff share LIVE_SESSION_SQL)', async () => {
    const a = await claudeAgent();
    env.clock.advance(POLICY.presenceOfflineSec + 60);
    const live = () => withTx(env.ctx.pool, (conn) => ownerIsLive(conn, env.ctx, a.id));
    expect(await live()).toBe(false);
    await recordBusySessions(env.ctx, { sessions: [{ sessionId: a.session, status: 'busy', state: 'working' }] });
    expect(await live()).toBe(true);
    env.clock.advance(POLICY.busySessionSec);
    expect(await live()).toBe(false);
  });
});
