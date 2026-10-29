import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listAgents, presenceOf, registerAgent } from '../src/agents.ts';
import { recordBusySessions } from '../src/busy-sessions.ts';
import { POLICY } from '../src/context.ts';
import { exec, queryOne } from '../src/db.ts';
import { latestEventId } from '../src/events.ts';
import { tick } from '../src/scheduler.ts';
import { buildServer } from '../src/server.ts';
import { resumeList } from '../src/telemetry.ts';
import { busyOf } from '../scripts/forks.ts';
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
      { kind: 'background', sessionId: id('a'), status: 'busy', state: 'working' },
      { kind: 'background', sessionId: id('b'), status: 'idle', state: 'blocked' },
      { kind: 'background', sessionId: id('c'), status: 'busy', state: 'blocked' },
      { kind: 'background', sessionId: id('d'), status: 'busy', state: 'something new' },
      { kind: 'background', sessionId: 'aaaa1111', status: 'busy', state: 'working' },
      { kind: 'background', sessionId: id('e'), status: null, state: 'blocked' },
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
    const many = Array.from({ length: 250 }, (_, i) => ({ sessionId: `${i.toString(16).padStart(8, '0')}-0000-0000-0000-000000000000`, status: 'busy', state: 'working' }));
    expect(busyOf(many)).toHaveLength(200);
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
    return { id: reg.agent_id as string, session };
  }
  const busyAt = async (agentId: string) => (await queryOne(env.ctx.pool, `SELECT busy_at FROM agent_sessions WHERE agent_id = ?`, [agentId]))!.busy_at as Date | null;
  const presence = async (agentId: string) => (await listAgents(env.ctx, { includeInactive: true })).find((a) => a.id === agentId)?.presence;
  const post = (payload: unknown, headers: Record<string, string> = runner) => app.inject({ method: 'POST', url: '/api/runner/busy-sessions', headers, payload: payload as any });

  it('sets busy_at for a busy session and shows it working with no call and no transcript line; no agent event', async () => {
    const a = await claudeAgent();
    env.clock.advance(POLICY.presenceOfflineSec + 60);
    expect(await presence(a.id)).toBe('offline');
    const before = await latestEventId(env.ctx.pool);
    const res = await post({ sessions: [{ sessionId: a.session, status: 'busy', state: 'working' }, { sessionId: a.session, status: 'busy', state: 'working' }] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, updated: 1 });
    expect(await presence(a.id)).toBe('working');
    expect(await latestEventId(env.ctx.pool)).toBe(before);
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

  it('keeps a busy session from being reaped or offered for resume, until busyReapCapSec without a call or transcript line', async () => {
    const a = await claudeAgent();
    const reaps = async () => (await queryOne(env.ctx.pool, `SELECT COUNT(*) AS n FROM launches WHERE agent_id = ? AND kind = 'reap_session'`, [a.id]))!.n;
    // Give it a job so it would appear on the Resume card when gone.
    await exec(env.ctx.pool, `INSERT INTO jobs (id, linear_issue_id, linear_identifier, linear_url, linear_snapshot, title, repo_path, base_branch, staff_agent_id, status, linear_fetched_at, created_at, updated_at) VALUES (?, ?, ?, '', '{}', 't', '/repo', 'main', ?, 'in_progress', ?, ?, ?)`, [`job_b${n}`, `li_b${n}`, `BSY-${n}`, a.id, env.clock.now(), env.clock.now(), env.clock.now()]);
    const report = () => recordBusySessions(env.ctx, { sessions: [{ sessionId: a.session, status: 'busy', state: 'working' }] });
    // The runner keeps reporting busy every 60 s for 3 hours: no reap, no resume card, no unavailable_owner blocker.
    for (let t = 0; t < 3 * 60 * 60; t += 60 * 10) {
      env.clock.advance(60 * 10);
      await report();
      await tick(env.ctx);
    }
    expect(await reaps()).toBe(0);
    expect((await resumeList(env.ctx)).some((r) => r.agent_id === a.id)).toBe(false);
    expect(await queryOne(env.ctx.pool, `SELECT id FROM blockers WHERE job_id = ? AND kind = 'unavailable_owner'`, [`job_b${n}`])).toBeUndefined();
    // Past busyReapCapSec since the last call and the last transcript line, busy no longer protects it.
    for (let t = 3 * 60 * 60; t < POLICY.busyReapCapSec + 20 * 60; t += 60 * 10) {
      env.clock.advance(60 * 10);
      await report();
      await tick(env.ctx);
    }
    expect(await reaps()).toBe(1);
    await exec(env.ctx.pool, `UPDATE jobs SET status = 'done' WHERE staff_agent_id = ?`, [a.id]);
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
});
