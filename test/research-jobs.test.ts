import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authenticate, registerAgent, type Agent } from '../src/agents.ts';
import { exec, queryOne } from '../src/db.ts';
import { readEvents, STAFF_WAKE_TYPES } from '../src/events.ts';
import { checkKind, checkRequest, createJobRequest, readJobRequest, staffLaunchAccess, startStaffForJob } from '../src/job-requests.ts';
import { createSpawnTicket, getJob, registerJob, updateJob } from '../src/jobs.ts';
import { requestPlanReview } from '../src/plan-review.ts';
import { approveRefinement } from '../src/refine.ts';
import { getReport, recordArtifact, reportFeedback, requestPublish, submitReport } from '../src/reports.ts';
import { finishLaunch, nextLaunch } from '../src/telemetry.ts';
import { buildServer } from '../src/server.ts';
import { DOCUMENT_RESUME_PROMPT } from '../src/claude-args.ts';
import { loadGuide } from '../src/mcp.ts';
import { asClient, createTestCtx, loginCookie, TEST_DB_URL, testServerKeys } from './helpers.ts';

describe('research request validation', () => {
  it('defaults to an implement job with no options', () => {
    expect(checkKind({ mode: 'link' })).toEqual({ kind: 'implement', options: null });
    expect(checkRequest({ mode: 'prompt', prompt: 'x', repoPath: '/r' })).toMatchObject({ kind: 'implement', options: null });
  });

  it('takes a research job from a prompt only, with checked sources and depth', () => {
    expect(checkKind({ mode: 'prompt', kind: 'research' })).toEqual({ kind: 'research', options: { sources: 'code', depth: 'light' } });
    expect(checkKind({ mode: 'prompt', kind: 'research', options: { sources: 'code_web', depth: 'deep' } })).toEqual({ kind: 'research', options: { sources: 'code_web', depth: 'deep' } });
    expect(() => checkKind({ mode: 'link', kind: 'research' })).toThrow(/starts from a prompt/);
    expect(() => checkKind({ mode: 'prompt', kind: 'plan' })).toThrow(/Kind/);
    expect(() => checkKind({ mode: 'prompt', kind: 'research', options: { sources: 'everything' } })).toThrow(/Sources/);
    expect(() => checkKind({ mode: 'prompt', kind: 'research', options: { depth: 'max' } })).toThrow(/Depth/);
    expect(() => checkKind({ mode: 'prompt', kind: 'implement', options: { depth: 'deep' } })).toThrow(/Only a research job/);
  });

  it('gives a research Staff its own guide: no Senior or delivery card', () => {
    const guide = loadGuide('http://localhost:7400', 'staff_document');
    expect(guide).toContain('## Staff of a research job');
    expect(guide).toContain('## Waiting for work');
    expect(guide).not.toContain('## Staff Software Engineer');
    expect(guide).not.toMatch(/gh pr|Copilot/);
  });
});

// Runs against a real MySQL: set ORCH_TEST_DATABASE_URL (see README). Skipped otherwise.
describe.skipIf(!TEST_DB_URL)('research jobs', () => {
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
    const reg = await registerAgent(env.ctx, { role: 'staff', nickname: `rstaff-${++n}`, runtime: 'claude-code' });
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

  /** A research request, its Staff registered, and the questions approved: the job is drafting. */
  async function drafting(options: { sources?: 'code' | 'code_web'; depth?: 'light' | 'deep' } = {}) {
    await drain();
    const r = await createJobRequest(env.ctx, { mode: 'prompt', kind: 'research', options, prompt: 'Why is the editor slow on big pages?', repoPath: '/home/user/repo' });
    const launch: any = await nextLaunch(env.ctx);
    await finishLaunch(env.ctx, launch.id, 'ok: started');
    const s = await staff();
    await readJobRequest(env.ctx, s, r.id);
    const job = await registerJob(env.ctx, s, { requestId: r.id, title: 'Editor slowness' });
    await updateJob(env.ctx, s, { jobId: job.job_id, plan: 'Scope: the editor render path.', acceptanceCriteria: '1. Where does the time go?\n2. What would fix it?' });
    await approveRefinement(env.ctx, job.job_id);
    return { request: r, launch, staff: s, jobId: job.job_id };
  }

  it('starts a research job with a read-only Staff whose reports folder is named after the request', async () => {
    await drain();
    const { id } = await createJobRequest(env.ctx, { mode: 'prompt', kind: 'research', options: { sources: 'code_web', depth: 'deep' }, prompt: 'Compare two caches', repoPath: '/home/user/repo' });
    const launch: any = await nextLaunch(env.ctx);
    expect(launch).toMatchObject({ kind: 'staff_start', request_id: id, access: 'document', web: true, report_key: id });
    await finishLaunch(env.ctx, launch.id, 'ok: started');
    expect(await queryOne(env.ctx.pool, `SELECT kind, options FROM job_requests WHERE id = ?`, [id])).toMatchObject({ kind: 'research', options: { sources: 'code_web', depth: 'deep' } });
  });

  it('refuses a research job while Staff runs on Codex: only Claude Code can be held read-only', async () => {
    await drain();
    await exec(env.ctx.pool, `UPDATE role_models SET runtime = 'codex', model = 'gpt-6.1-sol', effort = 'high' WHERE role = 'staff'`);
    try {
      await expect(createJobRequest(env.ctx, { mode: 'prompt', kind: 'research', prompt: 'x', repoPath: '/r' })).rejects.toThrow(/needs a Staff on claude-code/);
    } finally {
      await exec(env.ctx.pool, `UPDATE role_models SET runtime = 'claude-code', model = 'claude-opus-5-5', effort = 'high' WHERE role = 'staff'`);
    }
  });

  it('refines the research questions, then drafts instead of planning', async () => {
    const { staff: s, jobId } = await drafting();
    const { job } = await getJob(env.ctx.pool, jobId);
    expect(job).toMatchObject({ kind: 'research', status: 'drafting', options: { sources: 'code', depth: 'light' }, next_action: 'Staff researches and writes the report' });
    expect(job.report_key).toMatch(/^req_[0-9a-f]{16}$/);
    // Staff cannot move a research job through the planning states.
    await expect(updateJob(env.ctx, s, { jobId, status: 'ready' })).rejects.toThrow();
  });

  it('never starts a Senior or a reviewer, and has no plan review', async () => {
    const { staff: s, jobId } = await drafting();
    await expect(createSpawnTicket(env.ctx, s, { jobId, role: 'senior', brief: 'x' })).rejects.toThrow(/research job/);
    await expect(createSpawnTicket(env.ctx, s, { jobId, role: 'reviewer', brief: 'x' })).rejects.toThrow(/research job/);
    const plan = { jobId, problem: 'p', change: 'c', reasons: 'r', alternatives: 'a', premises: 'pr', risks: 'ri' };
    await expect(requestPlanReview(env.ctx, s, plan)).rejects.toThrow(/research job/);
  });

  it('versions the report, sends it back on feedback and wakes Staff, and publishes only what the Client asked for', async () => {
    const { staff: s, jobId } = await drafting();
    const other = await staff();
    await expect(submitReport(env.ctx, other, { jobId, summary: 's', body: 'b' })).rejects.toThrow(/owning Staff/);
    await expect(submitReport(env.ctx, s, { jobId, summary: '', body: 'b' })).rejects.toThrow(/summary/);
    await expect(submitReport(env.ctx, s, { jobId, summary: 'key ghp_abcdefghijklmnopqrstuvwxyz0123456789', body: 'b' })).rejects.toThrow(/credential/);
    const v1 = await submitReport(env.ctx, s, { jobId, summary: 'The time goes into layout.', body: '## 1. Where does the time go?\nLayout, see src/a.ts:10.' });
    expect(v1).toMatchObject({ version: 1, status: 'report_ready' });
    // One version at a time: the Client reads it first.
    await expect(submitReport(env.ctx, s, { jobId, summary: 's', body: 'b' })).rejects.toThrow(/report_ready/);

    const before = await lastEventId();
    await reportFeedback(env.ctx, jobId, 'Measure it on a page with 500 blocks.');
    expect((await getJob(env.ctx.pool, jobId)).job.status).toBe('drafting');
    expect(await wakes(s, before)).toContain('report.feedback');
    await expect(reportFeedback(env.ctx, jobId, 'again')).rejects.toThrow(/drafting/);
    const v2 = await submitReport(env.ctx, s, { jobId, summary: 'Layout, 1.2 s on 500 blocks.', body: 'Measured.' });
    expect(v2.version).toBe(2);
    expect((await getReport(env.ctx, s, jobId)).version).toBe(2);
    expect((await getReport(env.ctx, s, jobId, 1)).summary).toBe('The time goes into layout.');

    await expect(recordArtifact(env.ctx, s, { jobId, version: 2, url: 'https://claude.ai/artifact/abcdefgh12' })).rejects.toThrow(/has not asked to publish/);
    const beforePublish = await lastEventId();
    expect(await requestPublish(env.ctx, jobId, 2)).toMatchObject({ already_requested: false });
    expect(await requestPublish(env.ctx, jobId, 2)).toMatchObject({ already_requested: true });
    expect(await wakes(s, beforePublish)).toContain('report.publish_requested');
    for (const bad of ['https://evil.test/artifact/abcdefgh12', 'http://claude.ai/artifact/abcdefgh12', 'https://claude.ai/artifact/abc', 'javascript:alert(1)']) {
      await expect(recordArtifact(env.ctx, s, { jobId, version: 2, url: bad }), bad).rejects.toThrow(/artifact link/);
    }
    await recordArtifact(env.ctx, s, { jobId, version: 2, url: 'https://claude.ai/artifact/Beom6br61Sbpey7AxVktG3' });
    await expect(requestPublish(env.ctx, jobId, 2)).rejects.toThrow(/already published/);
    const { reports } = await getJob(env.ctx.pool, jobId);
    expect(reports.map((r: any) => r.version)).toEqual([2, 1]);
    expect(reports[0]).toMatchObject({ artifact_url: 'https://claude.ai/artifact/Beom6br61Sbpey7AxVktG3' });
    expect(reports[0].body).toBeUndefined();
  });

  it('serves the report to the Client over the dashboard routes', async () => {
    const { staff: s, jobId } = await drafting();
    await submitReport(env.ctx, s, { jobId, summary: 'Short answer.', body: 'Long answer.' });
    const list = await client.inject({ method: 'GET', url: `/api/jobs/${jobId}/reports` });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject([{ version: 1, summary: 'Short answer.', body: 'Long answer.' }]);
    const post = (url: string, payload: Record<string, unknown>) => client.inject({ method: 'POST', url, payload });
    expect((await post(`/api/jobs/${jobId}/report-publish`, { version: 0 })).statusCode).toBe(400);
    expect((await post(`/api/jobs/${jobId}/report-feedback`, { message: 'More on point 2.' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/jobs/${jobId}/reports` })).statusCode).toBe(401);
  });

  it('resumes and takes over a research job with the same read-only access, and the prompt that loads its guide', async () => {
    const { request, staff: s, jobId } = await drafting({ sources: 'code_web' });
    expect(await staffLaunchAccess(env.ctx.pool, { agentId: s.id })).toEqual({ access: 'document', web: true, report_key: request.id });
    await drain();
    await exec(
      env.ctx.pool,
      `INSERT INTO launches (id, agent_id, kind, run_id, ticket, session_id, cwd, runtime, model, effort, requested_at) VALUES ('lch_00000000000000aa', ?, 'resume', NULL, NULL, '1b85d8aa-ea20-41ef-baa6-1de0d08eb630', '/home/user/repo', 'claude-code', NULL, NULL, ?)`,
      [s.id, env.ctx.clock.now()],
    );
    const resume: any = await nextLaunch(env.ctx);
    expect(resume).toMatchObject({ kind: 'resume', role: 'staff', access: 'document', web: true, report_key: request.id, prompt: DOCUMENT_RESUME_PROMPT });
    await finishLaunch(env.ctx, resume.id, 'ok: started');
    // A new Staff for the job keeps the job's folder, not its own request's.
    await exec(env.ctx.pool, `INSERT INTO blockers (id, job_id, kind, responsible, requested_decision, unblock_condition, raised_by, created_at) VALUES ('blk_research_owner', ?, 'unavailable_owner', 'client', 'd', 'u', 'scheduler', ?)`, [jobId, env.ctx.clock.now()]);
    const takeover = await startStaffForJob(env.ctx, jobId);
    const start: any = await nextLaunch(env.ctx);
    expect(start).toMatchObject({ request_id: takeover.id, access: 'document', report_key: request.id });
    await finishLaunch(env.ctx, start.id, 'ok: started');
  });

  it('keeps one Staff on one kind of job', async () => {
    const { staff: s } = await drafting();
    await drain();
    const other = await createJobRequest(env.ctx, { mode: 'prompt', prompt: 'Change some code', repoPath: '/home/user/repo' });
    await drain();
    await expect(readJobRequest(env.ctx, s, other.id)).rejects.toThrow(/already works on a research job/);
  });

  it('leaves a Staff no request started with full access, as before', async () => {
    const s = await staff();
    expect(await staffLaunchAccess(env.ctx.pool, { agentId: s.id })).toEqual({ access: 'full', web: false, report_key: null });
  });
});
