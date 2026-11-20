import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authenticate, registerAgent, type Agent } from '../src/agents.ts';
import { queryOne } from '../src/db.ts';
import { readEvents, STAFF_WAKE_TYPES } from '../src/events.ts';
import { checkRequest, createImplementRequest, createJobRequest, MAX_PROMPT, readJobRequest, staffLaunchAccess } from '../src/job-requests.ts';
import { createSpawnTicket, getJob, listJobs, registerJob, updateJob } from '../src/jobs.ts';
import { approveRefinement } from '../src/refine.ts';
import { getReport, reportFeedback, submitReport } from '../src/reports.ts';
import { approveSplit, checkSubjobs, proposeSplit, returnSplit } from '../src/splits.ts';
import { finishLaunch, nextLaunch } from '../src/telemetry.ts';
import { buildServer } from '../src/server.ts';
import { asClient, createTestCtx, loginCookie, TEST_DB_URL, testServerKeys } from './helpers.ts';

const sub = (key: string, repo: string, depends_on: string[] = []) => ({ key, title: `Change ${key}`, repo_path: repo, scope: `What ${key} changes.`, depends_on });

describe('split validation', () => {
  it('keeps the build order, fills the base branch and checks each path', () => {
    const list = checkSubjobs([sub('frontend', '/home/u/frontend'), sub('calcs', '/home/u/calculations/', ['frontend'])], 'main');
    expect(list.map((s) => [s.key, s.repo_path, s.base_branch])).toEqual([
      ['frontend', '/home/u/frontend', 'main'],
      ['calcs', '/home/u/calculations', 'main'],
    ]);
    expect(() => checkSubjobs([sub('a', '/r', ['b']), sub('b', '/r')], 'main')).toThrow(/not listed before it/);
    expect(() => checkSubjobs([sub('a', '/r', ['a'])], 'main')).toThrow(/not listed before it/);
    expect(() => checkSubjobs([sub('a', '/r'), sub('a', '/s')], 'main')).toThrow(/Two subjobs/);
    expect(() => checkSubjobs([sub('a', 'relative/path')], 'main')).toThrow(/absolute/);
    expect(() => checkSubjobs([sub('a', '/r/../etc')], 'main')).toThrow(/\.\./);
    expect(() => checkSubjobs([sub('A b', '/r')], 'main')).toThrow();
    expect(() => checkSubjobs([], 'main')).toThrow();
  });

  it('takes a prompt up to MAX_PROMPT characters', () => {
    expect(MAX_PROMPT).toBe(50_000);
    expect(checkRequest({ mode: 'prompt', prompt: 'x'.repeat(MAX_PROMPT), repoPath: '/r' }).prompt).toHaveLength(MAX_PROMPT);
    expect(() => checkRequest({ mode: 'prompt', prompt: 'x'.repeat(MAX_PROMPT + 1), repoPath: '/r' })).toThrow(/longer than/);
  });
});

// Runs against a real MySQL: set ORCH_TEST_DATABASE_URL (see README). Skipped otherwise.
describe.skipIf(!TEST_DB_URL)('implementation jobs from a research report', () => {
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
    const reg = await registerAgent(env.ctx, { role: 'staff', nickname: `istaff-${++n}`, runtime: 'claude-code' });
    return authenticate(env.ctx, reg.session_token);
  }
  async function drain() {
    for (let i = 0; i < 20; i++) {
      const l: any = await nextLaunch(env.ctx);
      if (!l) break;
      await finishLaunch(env.ctx, l.id, 'ok: started');
    }
  }
  const wakes = async (agent: Agent, cursor: number) => (await readEvents(env.ctx.pool, agent.id, { cursor, scope: 'owned' })).events.filter((e) => STAFF_WAKE_TYPES.includes(e.type)).map((e) => e.type);
  const lastEventId = async () => Number((await queryOne(env.ctx.pool, `SELECT COALESCE(MAX(id), 0) AS id FROM events`))?.id);

  /** A research job with two report versions, waiting for the Client. */
  async function researched() {
    await drain();
    const r = await createJobRequest(env.ctx, { mode: 'prompt', kind: 'research', prompt: `Plan the delete cascade ${++n}`, repoPath: '/home/user/workspace' });
    await drain();
    const s = await staff();
    await readJobRequest(env.ctx, s, r.id);
    const job = await registerJob(env.ctx, s, { requestId: r.id, title: 'Delete cascade' });
    await updateJob(env.ctx, s, { jobId: job.job_id, acceptanceCriteria: '1. What should change?' });
    await approveRefinement(env.ctx, job.job_id);
    await submitReport(env.ctx, s, { jobId: job.job_id, summary: 'First.', body: 'Version one.' });
    await reportFeedback(env.ctx, job.job_id, 'More.');
    await submitReport(env.ctx, s, { jobId: job.job_id, summary: 'Second.', body: '## Plan\n1. frontend\n2. calculations' });
    return { researchStaff: s, researchJobId: job.job_id };
  }

  /** The implementation job registered by a new Staff. */
  async function started(note?: string) {
    const { researchStaff, researchJobId } = await researched();
    const req = await createImplementRequest(env.ctx, researchJobId, { note });
    const launch: any = await nextLaunch(env.ctx);
    await finishLaunch(env.ctx, launch.id, 'ok: started');
    const s = await staff();
    const read: any = await readJobRequest(env.ctx, s, req.id);
    const job = await registerJob(env.ctx, s, { requestId: req.id, title: 'Delete cascade, implementation' });
    return { researchStaff, researchJobId, request: req, launch, read, staff: s, jobId: job.job_id, registered: job };
  }

  it('starts a full-access Staff from the newest report version, with the note, and only from a report the Client is reading', async () => {
    const { researchJobId } = await researched();
    await drain();
    const req = await createImplementRequest(env.ctx, researchJobId, { note: 'Start with the frontend.' });
    const row = await queryOne(env.ctx.pool, `SELECT kind, mode, prompt, repo_path, from_job_id, from_report_version FROM job_requests WHERE id = ?`, [req.id]);
    expect(row).toMatchObject({ kind: 'implement', mode: 'prompt', repo_path: '/home/user/workspace', from_job_id: researchJobId, from_report_version: 2 });
    expect(row?.prompt).toContain("The Client's note:\nStart with the frontend.");
    expect(await staffLaunchAccess(env.ctx.pool, { requestId: req.id })).toMatchObject({ access: 'full' });
    // The same click again returns the request that waits; a different one is refused while it waits.
    expect(await createImplementRequest(env.ctx, researchJobId, { note: 'Start with the frontend.' })).toMatchObject({ id: req.id, already_queued: true });
    await expect(createImplementRequest(env.ctx, researchJobId, { version: 1 })).rejects.toThrow(/already starting/);
    await expect(createImplementRequest(env.ctx, researchJobId, { version: 9 })).rejects.toThrow(/Version 9/);
    // The research job stays open until the new Staff registers the job.
    expect((await getJob(env.ctx.pool, researchJobId)).job.status).toBe('report_ready');
  });

  it('refuses a job that is not a research job, or one whose report is not ready', async () => {
    const s = await started();
    await expect(createImplementRequest(env.ctx, s.jobId, {})).rejects.toThrow(/Only a research job/);
    // The research job is done once the implementation job is registered.
    await expect(createImplementRequest(env.ctx, s.researchJobId, {})).rejects.toThrow(/is done/);
  });

  it('registers in planning, closes the research job and lets only the new Staff read the report', async () => {
    const s = await started();
    expect(s.read).toMatchObject({ from_report: { job_id: s.researchJobId, version: 2 } });
    expect(s.read.next).toMatch(/propose_subjobs/);
    expect(s.registered.status).toBe('planning');
    const { job } = await getJob(env.ctx.pool, s.jobId);
    expect(job).toMatchObject({ status: 'planning', kind: 'implement', from_job_id: s.researchJobId, from_report_version: 2 });
    const research = (await getJob(env.ctx.pool, s.researchJobId)).job;
    expect(research.status).toBe('done');
    // The Client chose this, so it does not show again as newly finished.
    expect(research.client_done_seen_at).not.toBeNull();
    expect((await getReport(env.ctx, s.staff, s.researchJobId, 2)).body).toContain('## Plan');
    expect((await getReport(env.ctx, s.researchStaff, s.researchJobId)).version).toBe(2);
    await expect(getReport(env.ctx, await staff(), s.researchJobId)).rejects.toThrow(/owning Staff/);
  });

  it('starts no Senior on the job itself: the work goes through an approved split', async () => {
    const s = await started();
    await updateJob(env.ctx, s.staff, { jobId: s.jobId, acceptanceCriteria: '1. Delete cascades.', status: 'ready' });
    await expect(createSpawnTicket(env.ctx, s.staff, { jobId: s.jobId, role: 'senior', brief: 'x' })).rejects.toThrow(/propose_subjobs/);
  });

  it('proposes a split, takes the Client note back, and creates the subjobs with their repositories and order on approval', async () => {
    const s = await started();
    await expect(proposeSplit(env.ctx, await staff(), { jobId: s.jobId, subjobs: [sub('a', '/r')] })).rejects.toThrow(/owning Staff/);
    const v1 = await proposeSplit(env.ctx, s.staff, { jobId: s.jobId, subjobs: [sub('frontend', '/home/user/frontend')] });
    expect(v1).toMatchObject({ version: 1, status: 'pending' });
    await expect(proposeSplit(env.ctx, s.staff, { jobId: s.jobId, subjobs: [sub('frontend', '/home/user/frontend')] })).rejects.toThrow(/waits for the Client/);
    expect((await listJobs(env.ctx)).find((j: any) => j.id === s.jobId)?.next_action).toBe('Client approves the split into subjobs');

    let before = await lastEventId();
    await expect(returnSplit(env.ctx, s.jobId, 1, '  ')).rejects.toThrow(/Say what to change/);
    await returnSplit(env.ctx, s.jobId, 1, 'Add calculations after the frontend.');
    expect(await wakes(s.staff, before)).toContain('split.returned');
    await expect(approveSplit(env.ctx, s.jobId, 1)).rejects.toThrow(/already returned/);

    await proposeSplit(env.ctx, s.staff, {
      jobId: s.jobId,
      subjobs: [sub('frontend', '/home/user/frontend'), { ...sub('calcs', '/home/user/calculations', ['frontend']), base_branch: 'develop' }],
    });
    before = await lastEventId();
    const approved = await approveSplit(env.ctx, s.jobId, 2);
    expect(await wakes(s.staff, before)).toContain('split.approved');
    const { job, subjobs, splits } = await getJob(env.ctx.pool, s.jobId);
    expect(splits.map((x: any) => [x.version, x.status, x.note])).toEqual([
      [2, 'approved', null],
      [1, 'returned', 'Add calculations after the frontend.'],
    ]);
    expect(job.split_pending).toBe(0);
    expect(subjobs.map((c: any) => c.id)).toEqual(approved.subjob_ids);
    const [fe, calcs] = await Promise.all(approved.subjob_ids.map(async (id: string) => (await getJob(env.ctx.pool, id))));
    expect(fe.job).toMatchObject({ parent_job_id: s.jobId, repo_path: '/home/user/frontend', base_branch: 'main', status: 'planning', staff_agent_id: s.staff.id });
    expect(calcs.job).toMatchObject({ repo_path: '/home/user/calculations', base_branch: 'develop', title: 'Change calcs' });
    expect(calcs.depends_on.map((d: any) => d.job_id)).toEqual([fe.job.id]);
    // The split is a Client decision on the job, which Seniors see in their brief.
    const decision = await queryOne(env.ctx.pool, `SELECT authority, body FROM decisions WHERE job_id = ? ORDER BY created_at DESC LIMIT 1`, [s.jobId]);
    expect(decision).toMatchObject({ authority: 'client' });
    expect(decision?.body).toContain('/home/user/calculations');
    await expect(proposeSplit(env.ctx, s.staff, { jobId: s.jobId, subjobs: [sub('x', '/r')] })).rejects.toThrow(/already has subjobs/);
    // The Senior check now moves on to the subjob's own readiness.
    await expect(createSpawnTicket(env.ctx, s.staff, { jobId: fe.job.id, role: 'senior', brief: 'x' })).rejects.toThrow(/must be ready/);
  });

  it('serves the start and the split to the Client only', async () => {
    const { researchJobId } = await researched();
    await drain();
    expect((await app.inject({ method: 'POST', url: `/api/jobs/${researchJobId}/implement`, payload: {} })).statusCode).toBe(401);
    const res = await client.inject({ method: 'POST', url: `/api/jobs/${researchJobId}/implement`, payload: { version: 2, note: 'Go.' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ already_queued: false });
    expect((await app.inject({ method: 'POST', url: `/api/jobs/${researchJobId}/split/approve`, payload: { version: 1 } })).statusCode).toBe(401);
    expect((await client.inject({ method: 'POST', url: `/api/jobs/${researchJobId}/split/return`, payload: { version: 0, note: 'x' } })).statusCode).toBe(400);
  });

  it('stores a prompt longer than TEXT holds', async () => {
    await drain();
    const prompt = '😀'.repeat(MAX_PROMPT / 2);
    const r = await createJobRequest(env.ctx, { mode: 'prompt', prompt, repoPath: '/home/user/repo' });
    expect((await queryOne(env.ctx.pool, `SELECT prompt FROM job_requests WHERE id = ?`, [r.id]))?.prompt).toBe(prompt);
  });
});
