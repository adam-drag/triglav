import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authenticate, registerAgent, type Agent } from '../src/agents.ts';
import { postMessage } from '../src/board.ts';
import { exec, query, queryOne } from '../src/db.ts';
import { readEvents, STAFF_WAKE_TYPES } from '../src/events.ts';
import { cancelJobRequest, checkBranch, checkRepoPath, checkRequest, checkUrl, createJobRequest, dismissJobRequest, listJobRequests, failUnregisteredStarts, MAX_QUEUED_REQUESTS, readJobRequest, retryJobRequest } from '../src/job-requests.ts';
import { getJob, refreshFromLinear, registerJob, updateJob } from '../src/jobs.ts';
import { approveRefinement, clientRefine } from '../src/refine.ts';
import { expireStaleLaunches, finishLaunch, nextLaunch, recentLaunches } from '../src/telemetry.ts';
import { buildServer } from '../src/server.ts';
import { asClient, createTestCtx, issue, loginCookie, TEST_DB_URL, testServerKeys } from './helpers.ts';

describe('request validation', () => {
  it('accepts http and https URLs only, without credentials, spaces or control characters', () => {
    expect(checkUrl(' https://acme.atlassian.net/browse/ENG-1 ')).toBe('https://acme.atlassian.net/browse/ENG-1');
    expect(checkUrl('http://localhost:3000/issues/4')).toBe('http://localhost:3000/issues/4');
    for (const bad of ['', 'ftp://x.test/a', 'javascript:alert(1)', 'file:///etc/passwd', 'https://user:pw@x.test/a', 'https://x.test/a b', 'not a url', 'https://x.test/\u0007', `https://x.test/${'a'.repeat(2000)}`]) {
      expect(() => checkUrl(bad), bad).toThrow();
    }
  });

  it('accepts absolute paths with plain characters only', () => {
    expect(checkRepoPath('/home/user/workspace/triglav/')).toBe('/home/user/workspace/triglav');
    expect(checkRepoPath('~/workspace/repo/', '/home/user')).toBe('/home/user/workspace/repo');
    expect(checkRepoPath('~', '/home/user/')).toBe('/home/user');
    expect(() => checkRepoPath('~/repo', undefined)).toThrow(/ORCH_HOST_HOME/);
    expect(() => checkRepoPath('~bob/repo', '/home/user')).toThrow(/absolute/);
    expect(() => checkRepoPath('~/../etc', '/home/user')).toThrow(/\.\./);
    for (const bad of ['', 'relative/path', '/a/../b', '/a;rm -rf /', '/a$(id)', '/a`id`', '/a\nb', '/a|b', `/${'a'.repeat(500)}`]) {
      expect(() => checkRepoPath(bad), bad).toThrow();
    }
  });

  it('accepts git-safe branch names only', () => {
    for (const ok of ['main', 'release/1.2', 'trg-1-1-job-sources', 'feature/a_b.c']) expect(checkBranch(ok)).toBe(ok);
    for (const bad of ['', '-rf', '--upload-pack=x', 'a..b', 'a b', 'a//b', '/a', 'a/', 'a.', 'a.lock', 'a/.hidden', 'a@{1}', 'a~1', 'a^', 'a:b', 'a\\b', 'x'.repeat(201)]) {
      expect(() => checkBranch(bad), bad).toThrow();
    }
  });

  it('checks the fields of each mode and defaults the branch', () => {
    expect(checkRequest({ mode: 'link', url: 'https://github.com/o/r/issues/3', repoPath: '/r' })).toMatchObject({ mode: 'link', baseBranch: 'main', prompt: null });
    expect(checkRequest({ mode: 'prompt', prompt: '  Add a PDF export\n\nwith tests ', repoPath: '/r', baseBranch: 'dev' })).toMatchObject({ mode: 'prompt', prompt: 'Add a PDF export\n\nwith tests', url: null, baseBranch: 'dev' });
    expect(() => checkRequest({ mode: 'other', repoPath: '/r' })).toThrow(/Mode/);
    expect(() => checkRequest({ mode: 'link', url: 'https://x.test/1', prompt: 'both', repoPath: '/r' })).toThrow(/not prompt text/);
    expect(() => checkRequest({ mode: 'prompt', prompt: 'both', url: 'https://x.test/1', repoPath: '/r' })).toThrow(/not a URL/);
    expect(() => checkRequest({ mode: 'prompt', prompt: '   ', repoPath: '/r' })).toThrow(/Write the prompt/);
    expect(() => checkRequest({ mode: 'prompt', prompt: 'x'.repeat(10_001), repoPath: '/r' })).toThrow(/longer/);
    expect(() => checkRequest({ mode: 'prompt', prompt: 'a\u0000b', repoPath: '/r' })).toThrow(/control/);
    expect(() => checkRequest({ mode: 'prompt', prompt: 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789', repoPath: '/r' })).toThrow(/credential/);
  });
});

// Runs against a real MySQL: set ORCH_TEST_DATABASE_URL (see README). Skipped otherwise.
describe.skipIf(!TEST_DB_URL)('job sources', () => {
  let env: Awaited<ReturnType<typeof createTestCtx>>;
  let app: ReturnType<typeof buildServer>;
  let client: ReturnType<typeof asClient>;
  let n = 0;
  beforeAll(async () => {
    env = await createTestCtx();
    app = buildServer(env.ctx, { ...(await testServerKeys()), webDir: '/nonexistent' });
    client = asClient(app, await loginCookie(app));
  });
  afterAll(async () => {
    await app?.close();
    await env?.close();
  });

  async function staff(): Promise<Agent> {
    const reg = await registerAgent(env.ctx, { role: 'staff', nickname: `staff-${++n}`, runtime: 'claude-code' });
    return authenticate(env.ctx, reg.session_token);
  }
  async function drain() {
    for (let i = 0; i < 20; i++) {
      const l: any = await nextLaunch(env.ctx);
      if (!l) break;
      await finishLaunch(env.ctx, l.id, 'ok: started');
    }
  }
  async function request(input: Parameters<typeof createJobRequest>[1]) {
    await drain();
    return createJobRequest(env.ctx, input);
  }
  const wakes = async (agent: Agent, cursor: number) => (await readEvents(env.ctx.pool, agent.id, { cursor, scope: 'owned' })).events.filter((e) => STAFF_WAKE_TYPES.includes(e.type));
  const lastEventId = async () => Number((await queryOne(env.ctx.pool, `SELECT COALESCE(MAX(id), 0) AS id FROM events`))?.id);

  describe('job requests and the staff_start launch', () => {
    it('queues a staff_start launch that carries only the request id, not the Client text', async () => {
      const url = 'https://acme.atlassian.net/browse/ENG-77?secretish=value';
      const { id, already_queued } = await request({ mode: 'link', url, repoPath: '/home/user/workspace/repo', baseBranch: 'main' });
      expect(already_queued).toBe(false);
      expect(id).toMatch(/^req_[0-9a-f]{16}$/);
      const launch: any = await nextLaunch(env.ctx);
      expect(launch).toEqual({ id: expect.stringMatching(/^lch_/), kind: 'staff_start', request_id: id, runtime: 'claude-code', cwd: '/home/user/workspace/repo', model: 'claude-opus-5-5', effort: 'high', session_id: null });
      expect(JSON.stringify(launch)).not.toContain('atlassian');
      const row = await queryOne(env.ctx.pool, `SELECT agent_id, kind, run_id, ticket, session_id FROM launches WHERE id = ?`, [launch.id]);
      expect(row).toMatchObject({ agent_id: null, kind: 'staff_start', run_id: id, ticket: null, session_id: null });
      // It shows in the recent launches, without an agent.
      expect((await recentLaunches(env.ctx)).find((l: any) => l.id === launch.id)).toMatchObject({ kind: 'staff_start', nickname: null });
      await finishLaunch(env.ctx, launch.id, 'ok: started');
      expect(await queryOne(env.ctx.pool, `SELECT status, error FROM job_requests WHERE id = ?`, [id])).toMatchObject({ status: 'started', error: null });
    });

    it('uses the Staff model and effort from role_models', async () => {
      await exec(env.ctx.pool, `UPDATE role_models SET model = 'claude-sonnet-5-5', effort = 'xhigh' WHERE role = 'staff'`);
      await request({ mode: 'prompt', prompt: 'Model check', repoPath: '/r1' });
      const launch: any = await nextLaunch(env.ctx);
      expect(launch).toMatchObject({ kind: 'staff_start', model: 'claude-sonnet-5-5', effort: 'xhigh' });
      await finishLaunch(env.ctx, launch.id, 'ok: started');
      await exec(env.ctx.pool, `UPDATE role_models SET model = 'claude-opus-5-5', effort = 'high' WHERE role = 'staff'`);
    });

    it('refuses a Staff model the runner would refuse, and a runtime the runner cannot start', async () => {
      await drain();
      await exec(env.ctx.pool, `UPDATE role_models SET model = 'bad model; rm -rf /' WHERE role = 'staff'`);
      await expect(createJobRequest(env.ctx, { mode: 'prompt', prompt: 'x', repoPath: '/r2' })).rejects.toThrow(/Models page/);
      await exec(env.ctx.pool, `UPDATE role_models SET model = 'claude-opus-5-5', runtime = 'gemini' WHERE role = 'staff'`);
      await expect(createJobRequest(env.ctx, { mode: 'prompt', prompt: 'x', repoPath: '/r2' })).rejects.toThrow(/claude-code and codex/);
      await exec(env.ctx.pool, `UPDATE role_models SET runtime = 'claude-code' WHERE role = 'staff'`);
    });

    it('starts Staff on Codex when the Staff role is set to it, with a Codex effort', async () => {
      await drain();
      await exec(env.ctx.pool, `UPDATE role_models SET runtime = 'codex', model = 'gpt-6.1-sol', effort = 'ultra' WHERE role = 'staff'`);
      const { id } = await createJobRequest(env.ctx, { mode: 'prompt', prompt: 'On Codex', repoPath: '/r4' });
      const launch: any = await nextLaunch(env.ctx);
      expect(launch).toMatchObject({ kind: 'staff_start', request_id: id, runtime: 'codex', model: 'gpt-6.1-sol', effort: 'ultra' });
      await finishLaunch(env.ctx, launch.id, 'ok: started');
      await exec(env.ctx.pool, `UPDATE role_models SET runtime = 'claude-code', model = 'claude-opus-5-5', effort = 'high' WHERE role = 'staff'`);
    });

    it('retries a failed request with the same fields and dismisses the failed one; only a failed request is retried', async () => {
      await drain();
      const { id } = await createJobRequest(env.ctx, { mode: 'prompt', prompt: 'Try again', repoPath: '/r5', baseBranch: 'dev' });
      await expect(retryJobRequest(env.ctx, id)).rejects.toThrow(/did not fail/);
      await expect(dismissJobRequest(env.ctx, id)).rejects.toThrow(/not tried/);
      const first: any = await nextLaunch(env.ctx);
      await finishLaunch(env.ctx, first.id, 'failed: Claude Code does not trust /r5 yet.\nCommand failed');
      expect((await listJobRequests(env.ctx)).find((r: any) => r.id === id)).toMatchObject({ status: 'failed', dismissed_at: null });

      const again = await retryJobRequest(env.ctx, id);
      expect(again.id).not.toBe(id);
      const rows = await listJobRequests(env.ctx);
      expect(rows.find((r: any) => r.id === id)?.dismissed_at).toBeTruthy();
      expect(rows.find((r: any) => r.id === again.id)).toMatchObject({ prompt: 'Try again', repo_path: '/r5', base_branch: 'dev', status: 'queued', dismissed_at: null });

      // A request that started is never retried (a Staff may be running), only dismissed once the Client has looked.
      const second: any = await nextLaunch(env.ctx);
      await finishLaunch(env.ctx, second.id, 'ok: started');
      await expect(retryJobRequest(env.ctx, again.id)).rejects.toThrow(/did not fail/);
      await dismissJobRequest(env.ctx, again.id);
      expect((await listJobRequests(env.ctx)).find((r: any) => r.id === again.id)?.dismissed_at).toBeTruthy();
      await expect(retryJobRequest(env.ctx, 'req_0000000000000000')).rejects.toThrow(/not found/);
    });

    it('cancels a request the runner has not taken, so it never starts; refuses one the runner took', async () => {
      await drain();
      const { id } = await createJobRequest(env.ctx, { mode: 'prompt', prompt: 'Wrong repository', repoPath: '/wrong', baseBranch: 'main' });
      await cancelJobRequest(env.ctx, id);
      expect((await listJobRequests(env.ctx)).find((r: any) => r.id === id)).toMatchObject({ status: 'cancelled', result: 'cancelled by the Client' });
      expect((await listJobRequests(env.ctx)).find((r: any) => r.id === id)?.dismissed_at).toBeTruthy();
      expect(await nextLaunch(env.ctx)).toBeNull();
      await expect(cancelJobRequest(env.ctx, id)).rejects.toThrow(/no longer waiting/);

      const taken = await createJobRequest(env.ctx, { mode: 'prompt', prompt: 'Taken', repoPath: '/r6', baseBranch: 'main' });
      const launch: any = await nextLaunch(env.ctx);
      expect(launch.request_id).toBe(taken.id);
      await expect(cancelJobRequest(env.ctx, taken.id)).rejects.toThrow(/already taken/);
      await finishLaunch(env.ctx, launch.id, 'ok: started');
      await expect(cancelJobRequest(env.ctx, 'req_0000000000000000')).rejects.toThrow(/not found/);
    });

    it('returns the first request for a repeated identical click and caps the waiting requests', async () => {
      await drain();
      const first = await createJobRequest(env.ctx, { mode: 'prompt', prompt: 'Same thing', repoPath: '/r3' });
      const again = await createJobRequest(env.ctx, { mode: 'prompt', prompt: 'Same thing', repoPath: '/r3' });
      expect(again).toMatchObject({ id: first.id, already_queued: true });
      for (let i = 1; i < MAX_QUEUED_REQUESTS; i++) await createJobRequest(env.ctx, { mode: 'prompt', prompt: `Different ${i}`, repoPath: '/r3' });
      await expect(createJobRequest(env.ctx, { mode: 'prompt', prompt: 'One too many', repoPath: '/r3' })).rejects.toThrow(/waiting for the runner/);
      await drain();
    });

    it('does not return a request the Client dismissed, so the same text can be submitted again at once', async () => {
      await drain();
      const first = await createJobRequest(env.ctx, { mode: 'prompt', prompt: 'Dismissed then again', repoPath: '/r7' });
      await finishLaunch(env.ctx, ((await nextLaunch(env.ctx)) as any).id, 'ok: started');
      // A started request that never registered a job still counts as the same request until the Client dismisses it.
      expect(await createJobRequest(env.ctx, { mode: 'prompt', prompt: 'Dismissed then again', repoPath: '/r7' })).toMatchObject({ id: first.id, already_queued: true });
      await dismissJobRequest(env.ctx, first.id);
      const again = await createJobRequest(env.ctx, { mode: 'prompt', prompt: 'Dismissed then again', repoPath: '/r7' });
      expect(again.already_queued).toBe(false);
      expect(again.id).not.toBe(first.id);
      await drain();
    });

    it('marks the request failed when the runner reports a failure, when the launch expires, and when the runner never reports', async () => {
      await drain();
      const a = await createJobRequest(env.ctx, { mode: 'prompt', prompt: 'Fails', repoPath: '/r4' });
      const la: any = await nextLaunch(env.ctx);
      await finishLaunch(env.ctx, la.id, 'failed: cwd /nope is outside /home/user');
      expect(await queryOne(env.ctx.pool, `SELECT status, error FROM job_requests WHERE id = ?`, [a.id])).toMatchObject({ status: 'failed', error: expect.stringContaining('outside') });

      const b = await createJobRequest(env.ctx, { mode: 'prompt', prompt: 'Expires', repoPath: '/r4' });
      env.clock.advance(11 * 60);
      await expireStaleLaunches(env.ctx);
      expect(await queryOne(env.ctx.pool, `SELECT status, error FROM job_requests WHERE id = ?`, [b.id])).toMatchObject({ status: 'failed', error: expect.stringContaining('expired') });
      expect(await nextLaunch(env.ctx)).toBeNull();

      const c = await createJobRequest(env.ctx, { mode: 'prompt', prompt: 'Lost', repoPath: '/r4' });
      await nextLaunch(env.ctx);
      env.clock.advance(6 * 60);
      await expireStaleLaunches(env.ctx);
      expect(await queryOne(env.ctx.pool, `SELECT status FROM job_requests WHERE id = ?`, [c.id])).toMatchObject({ status: 'failed' });
    });

    it('fails a started request that never registered and retries it once', async () => {
      await drain();
      await exec(env.ctx.pool, `UPDATE job_requests SET status = 'registered' WHERE status = 'started'`);
      const a = await createJobRequest(env.ctx, { mode: 'prompt', prompt: 'Idle session', repoPath: '/r5' });
      const la: any = await nextLaunch(env.ctx);
      await finishLaunch(env.ctx, la.id, 'ok: backgrounded');
      env.clock.advance(2 * 60);
      await failUnregisteredStarts(env.ctx);
      expect(await queryOne(env.ctx.pool, `SELECT status FROM job_requests WHERE id = ?`, [a.id])).toMatchObject({ status: 'started' });
      env.clock.advance(2 * 60);
      await failUnregisteredStarts(env.ctx);
      expect(await queryOne(env.ctx.pool, `SELECT status, error FROM job_requests WHERE id = ?`, [a.id])).toMatchObject({ status: 'failed', error: expect.stringContaining('did not read its job request') });
      const again: any = await nextLaunch(env.ctx);
      expect(again).toMatchObject({ kind: 'staff_start' });
      expect(again.request_id).not.toBe(a.id);
      await finishLaunch(env.ctx, again.id, 'ok: backgrounded');
      env.clock.advance(4 * 60);
      await failUnregisteredStarts(env.ctx);
      expect(await queryOne(env.ctx.pool, `SELECT status FROM job_requests WHERE id = ?`, [again.request_id])).toMatchObject({ status: 'failed' });
      expect(await nextLaunch(env.ctx)).toBeNull();
    });

    it('leaves a started request alone once a Staff has read it, however long register_job takes', async () => {
      await drain();
      await exec(env.ctx.pool, `UPDATE job_requests SET status = 'registered' WHERE status = 'started'`);
      const a = await createJobRequest(env.ctx, { mode: 'prompt', prompt: 'Slow to register', repoPath: '/r5b' });
      const la: any = await nextLaunch(env.ctx);
      await finishLaunch(env.ctx, la.id, 'ok: backgrounded');
      await readJobRequest(env.ctx, await staff(), a.id);
      env.clock.advance(30 * 60);
      await failUnregisteredStarts(env.ctx);
      expect(await queryOne(env.ctx.pool, `SELECT status, error FROM job_requests WHERE id = ?`, [a.id])).toMatchObject({ status: 'started', error: null });
      expect(await nextLaunch(env.ctx)).toBeNull();
    });

    it('refuses to frame the dashboard and does not run a launch kind it does not know as a resume', async () => {
      await drain();
      const res = await app.inject({ method: 'GET', url: '/api/health' });
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      const s = await staff();
      await exec(env.ctx.pool, `INSERT INTO launches (id, agent_id, kind, cwd, runtime, requested_at) VALUES ('lch_unknownkind', ?, 'mystery', '/r', 'claude-code', NOW(3))`, [s.id]);
      expect(await nextLaunch(env.ctx)).toBeNull();
      expect(await queryOne(env.ctx.pool, `SELECT result FROM launches WHERE id = 'lch_unknownkind'`)).toMatchObject({ result: expect.stringContaining('unknown launch kind') });
    });

    it('validates over HTTP and answers a bad field with 400 and a readable message', async () => {
      await drain();
      const bad = await client.inject({ method: 'POST', url: '/api/job-requests', payload: { mode: 'link', url: 'ftp://x.test/1', repo_path: '/r' } });
      expect(bad.statusCode).toBe(400);
      expect(bad.json().message).toMatch(/http and https/);
      const badPath = await client.inject({ method: 'POST', url: '/api/job-requests', payload: { mode: 'prompt', prompt: 'x', repo_path: 'rel', base_branch: 'main' } });
      expect(badPath.statusCode).toBe(400);
      expect(badPath.json().message).toMatch(/absolute/);
      const badBranch = await client.inject({ method: 'POST', url: '/api/job-requests', payload: { mode: 'prompt', prompt: 'x', repo_path: '/r', base_branch: '--upload-pack=x' } });
      expect(badBranch.statusCode).toBe(400);
      const cross = await client.inject({ method: 'POST', url: '/api/job-requests', headers: { origin: 'https://evil.example' }, payload: { mode: 'prompt', prompt: 'x', repo_path: '/r' } });
      expect(cross.statusCode).toBe(403);
      // Same host name but another port is another origin (a local page on a different port).
      const host = 'localhost:7400';
      const otherPort = await client.inject({ method: 'POST', url: '/api/job-requests', headers: { host, origin: 'http://localhost:3000' }, payload: { mode: 'prompt', prompt: 'x', repo_path: '/r' } });
      expect(otherPort.statusCode).toBe(403);
      const sameOrigin = await client.inject({ method: 'POST', url: '/api/job-requests', headers: { host, origin: `http://${host}` }, payload: { mode: 'prompt', prompt: 'Same origin', repo_path: '/home/user/so' } });
      expect(sameOrigin.statusCode).toBe(200);
      await drain();
      const form = await client.inject({ method: 'POST', url: '/api/job-requests', headers: { 'content-type': 'text/plain' }, payload: '{"mode":"prompt"}' });
      expect(form.statusCode).toBeGreaterThanOrEqual(400);
      const ok = await client.inject({ method: 'POST', url: '/api/job-requests', payload: { mode: 'prompt', prompt: 'Over HTTP', repo_path: '/home/user/x', base_branch: 'main' } });
      expect(ok.statusCode).toBe(200);
      const list = await client.inject({ method: 'GET', url: '/api/job-requests' });
      expect(list.json().find((r: any) => r.id === ok.json().id)).toMatchObject({ mode: 'prompt', status: 'queued' });
      await drain();
    });
  });

  describe('register_job with a request', () => {
    it('link mode, non-Linear URL: needs the snapshot, keeps its own URL, is never refreshed from Linear', async () => {
      const s = await staff();
      const url = 'https://acme.atlassian.net/browse/ENG-9';
      const r = await request({ mode: 'link', url, repoPath: '/repo-j', baseBranch: 'develop' });
      const read = await readJobRequest(env.ctx, s, r.id);
      expect(read).toMatchObject({ mode: 'link', source_url: url, repo_path: '/repo-j', base_branch: 'develop' });
      await expect(registerJob(env.ctx, s, { requestId: r.id })).rejects.toThrow(/not in Linear/);
      const snapshot = { id: '10234', identifier: 'ENG-9', title: 'Jira ticket', description: 'From Jira', url: 'javascript:alert(1)', state: 'To Do', updatedAt: null, children: [] };
      await expect(registerJob(env.ctx, s, { requestId: r.id, repoPath: '/other', snapshot })).rejects.toThrow(/differs from the request/);
      const job = await registerJob(env.ctx, s, { requestId: r.id, snapshot });
      expect(job).toMatchObject({ snapshot_source: 'agent', job_source: 'link', status: 'queued' });
      const row = await queryOne(env.ctx.pool, `SELECT source, status, repo_path, base_branch, linear_url, linear_issue_id FROM jobs WHERE id = ?`, [job.job_id]);
      expect(row).toMatchObject({ source: 'link', status: 'queued', repo_path: '/repo-j', base_branch: 'develop', linear_url: url });
      expect(String(row!.linear_issue_id)).toMatch(/^link:[0-9a-f]{40}$/);
      expect(await queryOne(env.ctx.pool, `SELECT status, job_id FROM job_requests WHERE id = ?`, [r.id])).toMatchObject({ status: 'registered', job_id: job.job_id });
      await expect(registerJob(env.ctx, s, { requestId: r.id, snapshot })).rejects.toThrow(/already registered/);

      // The Linear refresh skips it: even a Linear fake that knows the id changes nothing.
      env.linear.add({ ...snapshot, id: row!.linear_issue_id as string, identifier: 'X-1', title: 'Changed in Linear', children: [] } as any);
      await exec(env.ctx.pool, `UPDATE jobs SET linear_fetched_at = '2020-01-01' WHERE id = ?`, [job.job_id]);
      await refreshFromLinear(env.ctx);
      expect(await queryOne(env.ctx.pool, `SELECT title, linear_fetched_at FROM jobs WHERE id = ?`, [job.job_id])).toMatchObject({ title: 'Jira ticket' });
    });

    it('two different GitHub issues with the same tracker id do not clash', async () => {
      const s = await staff();
      const snap = (url: string) => ({ id: '1', identifier: 'GH-1', title: `Issue at ${url}`, url, state: 'open', updatedAt: null, children: [] });
      const a = await request({ mode: 'link', url: 'https://github.com/o/a/issues/1', repoPath: '/repo-gh' });
      const b = await request({ mode: 'link', url: 'https://github.com/o/b/issues/1', repoPath: '/repo-gh' });
      await registerJob(env.ctx, s, { requestId: a.id, snapshot: snap('https://github.com/o/a/issues/1') });
      await registerJob(env.ctx, s, { requestId: b.id, snapshot: snap('https://github.com/o/b/issues/1') });
    });

    it('link mode, Linear URL: fetches by the identifier in the URL and stays a Linear job that refreshes', async () => {
      const s = await staff();
      const k = ++n;
      const tree = issue(`LIN-${k}`, 'A Linear ticket', { children: [] });
      env.linear.add(tree as any);
      const r = await request({ mode: 'link', url: `https://linear.app/team/issue/LIN-${k}/a-linear-ticket`, repoPath: '/repo-l' });
      const job = await registerJob(env.ctx, s, { requestId: r.id });
      expect(job).toMatchObject({ snapshot_source: 'linear', job_source: 'linear' });
      expect(await queryOne(env.ctx.pool, `SELECT source, linear_issue_id FROM jobs WHERE id = ?`, [job.job_id])).toMatchObject({ source: 'linear', linear_issue_id: tree.id });
      env.linear.add({ ...tree, title: 'Renamed', updatedAt: '2026-10-08T00:00:00.000Z' } as any);
      await exec(env.ctx.pool, `UPDATE jobs SET linear_fetched_at = '2020-01-01' WHERE id = ?`, [job.job_id]);
      await refreshFromLinear(env.ctx);
      expect(await queryOne(env.ctx.pool, `SELECT title FROM jobs WHERE id = ?`, [job.job_id])).toMatchObject({ title: 'Renamed' });
    });

    it('the first Staff to read a request claims it; others and non-Staff are refused', async () => {
      const a = await staff();
      const b = await staff();
      const r = await request({ mode: 'prompt', prompt: 'Claim me', repoPath: '/repo-c' });
      await readJobRequest(env.ctx, a, r.id);
      await expect(readJobRequest(env.ctx, b, r.id)).rejects.toThrow(/already taken/);
      await expect(registerJob(env.ctx, b, { requestId: r.id, title: 'x' })).rejects.toThrow(/taken by another/);
      const senior = { ...a, role: 'senior' } as Agent;
      await expect(readJobRequest(env.ctx, senior, r.id)).rejects.toThrow(/Only a Staff/);
      await expect(readJobRequest(env.ctx, a, 'req_nothex')).rejects.toThrow(/job request id/);
      await expect(readJobRequest(env.ctx, a, 'req_0000000000000000')).rejects.toThrow(/not found/);
      expect(await registerJob(env.ctx, a, { requestId: r.id, title: 'Claimed' })).toMatchObject({ job_source: 'prompt' });
    });
  });

  describe('prompt mode and refinement', () => {
    async function promptJob(prompt = 'Add a PDF export for reports') {
      const s = await staff();
      const r = await request({ mode: 'prompt', prompt, repoPath: '/repo-p' });
      expect(await readJobRequest(env.ctx, s, r.id)).toMatchObject({ mode: 'prompt', prompt });
      await expect(registerJob(env.ctx, s, { requestId: r.id })).rejects.toThrow(/title/);
      const job = await registerJob(env.ctx, s, { requestId: r.id, title: 'PDF export' });
      return { s, job: job.job_id, request: r.id };
    }

    it('creates the job in refining with a synthetic identifier and the prompt as its description', async () => {
      const { job, request: rid } = await promptJob();
      expect((await queryOne(env.ctx.pool, `SELECT status FROM job_requests WHERE id = ?`, [rid]))?.status).toBe('registered');
      const got = await getJob(env.ctx.pool, job);
      expect(got.job).toMatchObject({ status: 'refining', source: 'prompt', title: 'PDF export', repo_path: '/repo-p', linear_url: '' });
      expect(got.job.linear_identifier).toMatch(/^PRM-[0-9A-F]{6}$/);
      expect(got.job.linear_snapshot.description).toBe('Add a PDF export for reports');
      expect(got.job.next_action).toMatch(/Client answers Staff and approves/);
      expect(got.threads).toHaveLength(1);
    });

    it('Staff cannot leave refining; the Client reply wakes Staff; only the Client approves, and that wakes Staff', async () => {
      const { s, job } = await promptJob();
      const cursor = await lastEventId();
      await expect(updateJob(env.ctx, s, { jobId: job, status: 'planning' })).rejects.toThrow(/Only the Client's approval/);
      await expect(updateJob(env.ctx, s, { jobId: job, status: 'ready' })).rejects.toThrow(/Only the Client's approval/);

      await updateJob(env.ctx, s, { jobId: job, plan: 'Goal: export reports to PDF.\nNon-goals: other formats.', acceptanceCriteria: '1. Export works.\n2. Tests.' });
      const thread = (await getJob(env.ctx.pool, job)).threads[0]!.id as string;
      await postMessage(env.ctx, { kind: 'agent', agent: s }, { threadId: thread, type: 'discussion', body: '1. Which paper size?' });
      const feed = await query(env.ctx.pool, `SELECT type FROM events WHERE job_id = ? AND id > ? ORDER BY id`, [job, cursor]);
      expect(feed.map((e) => e.type)).toEqual(expect.arrayContaining(['refinement.proposal_updated', 'refinement.staff_posted']));
      // The Staff's own writes wake nobody.
      expect(await wakes(s, cursor)).toEqual([]);

      const reply = await clientRefine(env.ctx, job, { message: 'A4.', acceptanceCriteria: '1. Export works.\n2. Tests.\n3. A4 pages.' });
      expect(reply.edited).toEqual(['acceptance_criteria']);
      const woken = await wakes(s, cursor);
      expect(woken.map((e) => e.type)).toEqual(['refinement.client_reply']);
      expect(woken[0]!.payload.excerpt).toContain('A4.');
      expect((await getJob(env.ctx.pool, job)).job.acceptance_criteria).toContain('A4 pages');
      const messages = await query(env.ctx.pool, `SELECT author, body FROM messages WHERE thread_id = ? ORDER BY id`, [thread]);
      expect(messages.map((m) => m.author)).toEqual([s.id, 'client']);

      const mark = await lastEventId();
      expect(await approveRefinement(env.ctx, job)).toEqual({ job_id: job, status: 'planning' });
      const after = await wakes(s, mark);
      expect(after.map((e) => e.type)).toEqual(expect.arrayContaining(['refinement.approved']));
      expect((await getJob(env.ctx.pool, job)).job.status).toBe('planning');
      // Now Staff plans as usual.
      expect(await updateJob(env.ctx, s, { jobId: job, status: 'ready' })).toMatchObject({ status: 'ready' });
      await expect(approveRefinement(env.ctx, job)).rejects.toThrow(/not refining/);
      await expect(clientRefine(env.ctx, job, { message: 'late' })).rejects.toThrow(/not refining/);
    });

    it('wakes Staff for a Client message posted in the ordinary thread box on a refining job, not after approval', async () => {
      const { s, job } = await promptJob();
      const thread = (await getJob(env.ctx.pool, job)).threads[0]!.id as string;
      const cursor = await lastEventId();
      await postMessage(env.ctx, { kind: 'client' }, { threadId: thread, type: 'discussion', body: 'Also support Excel.' });
      expect((await wakes(s, cursor)).map((e) => e.type)).toEqual(['refinement.client_reply']);
      await clientRefine(env.ctx, job, { acceptanceCriteria: 'Done.' });
      await approveRefinement(env.ctx, job);
      const mark = await lastEventId();
      await postMessage(env.ctx, { kind: 'client' }, { threadId: thread, type: 'discussion', body: 'One more thing.' });
      expect(await wakes(s, mark)).toEqual([]);
    });

    it('approves with a last answer and edits in one step: Staff wakes once, for the approval, and the note is on the thread', async () => {
      const { s, job } = await promptJob();
      const thread = (await getJob(env.ctx.pool, job)).threads[0]!.id as string;
      const cursor = await lastEventId();
      // Criteria written with the approval count, so an empty proposal can still be approved this way.
      await approveRefinement(env.ctx, job, { message: 'Use A4.', acceptanceCriteria: '1. Export works on A4.' });
      const woken = await wakes(s, cursor);
      expect(woken.map((e) => e.type)).toEqual(['refinement.approved']);
      expect(woken[0]!.payload).toMatchObject({ edited: ['acceptance_criteria'] });
      expect(woken[0]!.payload.note).toContain('Use A4.');
      const got = await getJob(env.ctx.pool, job);
      expect(got.job).toMatchObject({ status: 'planning', acceptance_criteria: '1. Export works on A4.' });
      const messages = await query(env.ctx.pool, `SELECT author, body FROM messages WHERE thread_id = ? ORDER BY id`, [thread]);
      expect(messages.at(-1)).toMatchObject({ author: 'client', body: expect.stringContaining('Use A4.') });
    });

    it('does not approve without criteria, and refuses empty or secret input', async () => {
      const { job } = await promptJob();
      await expect(approveRefinement(env.ctx, job)).rejects.toThrow(/acceptance criteria/);
      await expect(clientRefine(env.ctx, job, {})).rejects.toThrow(/Write an answer/);
      await expect(clientRefine(env.ctx, job, { message: 'key ghp_abcdefghijklmnopqrstuvwxyz0123456789' })).rejects.toThrow(/credential/);
      // The Client can write the criteria itself and then approve.
      await clientRefine(env.ctx, job, { acceptanceCriteria: 'Done when the export works.' });
      await approveRefinement(env.ctx, job);
    });

    it('serves the refine and approve endpoints', async () => {
      const { job } = await promptJob();
      expect((await client.inject({ method: 'POST', url: `/api/jobs/${job}/approve`, payload: {} })).statusCode).toBe(409);
      const r = await client.inject({ method: 'POST', url: `/api/jobs/${job}/refine`, payload: { message: 'Hello', acceptance_criteria: 'It works.' } });
      expect(r.statusCode).toBe(200);
      expect((await client.inject({ method: 'POST', url: `/api/jobs/${job}/approve`, payload: {} })).json()).toEqual({ job_id: job, status: 'planning' });
      expect((await client.inject({ method: 'POST', url: `/api/jobs/${job}/refine`, payload: { message: 'again' } })).statusCode).toBe(409);
    });

    it('lists the refinement events that wake Staff', () => {
      expect(STAFF_WAKE_TYPES).toEqual(expect.arrayContaining(['refinement.client_reply', 'refinement.approved']));
    });
  });

  it('keeps registering a Linear ticket the old way (linear_issue / ticket)', async () => {
    const s = await staff();
    const a = issue(`OLD-${++n}`, 'Old way', { children: [] });
    const b = issue(`NEW-${++n}`, 'New name', { children: [] });
    env.linear.add(a as any);
    env.linear.add(b as any);
    expect(await registerJob(env.ctx, s, { linearIssue: a.identifier, repoPath: '/r', baseBranch: 'main' })).toMatchObject({ job_source: 'linear', status: 'queued' });
    expect(await registerJob(env.ctx, s, { ticket: b.identifier, repoPath: '/r' })).toMatchObject({ job_source: 'linear', status: 'queued' });
    await expect(registerJob(env.ctx, s, { repoPath: '/r' })).rejects.toThrow(/ticket/);
  });
});
