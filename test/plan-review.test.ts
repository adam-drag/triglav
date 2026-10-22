import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { authenticate, registerAgent, type Agent } from '../src/agents.ts';
import { dueQuestions, postMessage, reconcileQuestion } from '../src/board.ts';
import { exec, query, queryOne } from '../src/db.ts';
import { createSpawnTicket, registerJob, updateJob } from '../src/jobs.ts';
import { recordHostRuntimes } from '../src/models.ts';
import { requestPlanReview, skipPlanReview } from '../src/plan-review.ts';
import { createPersona, recordCodexBudget } from '../src/research.ts';
import { createTestCtx, issue, TEST_DB_URL } from './helpers.ts';

const PLAN = {
  problem: 'Uploads over 10 MB fail with a timeout.',
  change: 'Stream the upload to storage instead of buffering it.',
  reasons: 'Buffering holds the whole file in memory.',
  alternatives: 'Raise the timeout: hides the problem.',
  premises: 'The handler buffers the body (upload.ts).',
  risks: 'Partial uploads on a dropped connection. Not changing the size limit.',
};

// Runs against a real MySQL: set ORCH_TEST_DATABASE_URL (see README). Skipped otherwise.
describe.skipIf(!TEST_DB_URL)('plan review before the first Senior', () => {
  let env: Awaited<ReturnType<typeof createTestCtx>>;
  let n = 0;
  let researcher: Agent;
  let personaId = '';

  beforeAll(async () => {
    env = await createTestCtx();
    const p = await createPersona(env.ctx, { nickname: 'reviewer-r', focus: 'f', repo_path: '/repo', model: 'm', effort: 'medium', runtime: 'codex' });
    personaId = p.id;
    researcher = (await queryOne(env.ctx.pool, `SELECT * FROM agents WHERE id = ?`, [p.agent_id])) as unknown as Agent;
  });
  afterAll(async () => {
    await env?.close();
  });
  beforeEach(async () => {
    await exec(env.ctx.pool, `UPDATE researcher_personas SET enabled = 1`);
    await exec(env.ctx.pool, `DELETE FROM codex_budget`);
    await recordHostRuntimes(env.ctx, { codex: { version: '1', models: [] } });
  });

  async function readyJob(children = 0) {
    const reg = await registerAgent(env.ctx, { role: 'staff', nickname: `staff-${++n}`, runtime: 'test' });
    const staff = await authenticate(env.ctx, reg.session_token);
    const kids = Array.from({ length: children }, (_, i) => issue(`PLR-${n}0${i}`, `Sub ${i}`));
    const parent = issue(`PLR-${n}`, 'Plan review job', kids.length ? { children: kids } : {});
    env.linear.add(parent as any);
    const job = await registerJob(env.ctx, staff, { linearIssue: parent.identifier, repoPath: '/repo', baseBranch: 'main' });
    const ids = [job.job_id as string, ...((job.subjob_ids as string[]) ?? [])];
    for (const id of ids) {
      await updateJob(env.ctx, staff, { jobId: id, status: 'planning' });
      await updateJob(env.ctx, staff, { jobId: id, acceptanceCriteria: 'Works' });
      if (id !== job.job_id || !children) await updateJob(env.ctx, staff, { jobId: id, status: 'ready' });
    }
    return { staff, root: job.job_id as string, leaf: ids[ids.length - 1]! };
  }

  const spawn = (staff: Agent, jobId: string) => createSpawnTicket(env.ctx, staff, { jobId, role: 'senior', brief: 'Build it' });
  const reviewRow = (jobId: string) => queryOne(env.ctx.pool, `SELECT * FROM plan_reviews WHERE job_id = ?`, [jobId]);

  it('refuses the first Senior until the plan was reviewed or skipped', async () => {
    const { staff, root } = await readyJob();
    await expect(spawn(staff, root)).rejects.toThrow(/request_plan_review/);
  });

  it('closes early once every researcher answered, and holds the Senior until Staff answers the objection', async () => {
    const { staff, root } = await readyJob();
    const r = await requestPlanReview(env.ctx, staff, { jobId: root, ...PLAN });
    expect(r.skipped).toBe(false);
    const threadId = (r as { thread_id: string }).thread_id;
    await expect(spawn(staff, root)).rejects.toThrow(/still open/);

    const item = await queryOne(env.ctx.pool, `SELECT id, title FROM research_inbox WHERE persona_id = ? AND thread_id = ?`, [personaId, threadId]);
    expect(item!.title).toContain('Plan review:');
    const objection = await postMessage(env.ctx, { kind: 'agent', agent: researcher }, { threadId, type: 'reply', stance: 'challenge', reason: 'upload.ts streams already.', body: 'The premise is wrong.' });
    expect(await reconcileQuestion(env.ctx, threadId)).toBe(false);
    await exec(env.ctx.pool, `UPDATE research_inbox SET status = 'handled', done_at = ? WHERE id = ?`, [env.ctx.clock.now(), item!.id]);
    expect(await dueQuestions(env.ctx.pool, env.ctx.clock.now())).toContain(threadId);
    expect(await reconcileQuestion(env.ctx, threadId)).toBe(true);
    expect((await reviewRow(root))!.state).toBe('closed');
    expect((await queryOne(env.ctx.pool, `SELECT state FROM questions WHERE thread_id = ?`, [threadId]))!.state).toBe('collected');
    const ev = await queryOne(env.ctx.pool, `SELECT payload FROM events WHERE type = 'question.deadline_reached' AND thread_id = ?`, [threadId]);
    expect(ev!.payload).toMatchObject({ plan_review: true, objections: 1 });

    await expect(spawn(staff, root)).rejects.toThrow(new RegExp(`messages ${objection.message_id}`));
    await postMessage(env.ctx, { kind: 'agent', agent: staff }, { threadId, type: 'reply', stance: 'inform', body: 'Checked: it buffers at upload.ts:40. Keeping the plan.', inReplyTo: objection.message_id });
    await expect(spawn(staff, root)).resolves.toMatchObject({ spawn_ticket: expect.any(String) });
  });

  it('closes on silence at the deadline instead of extending the window', async () => {
    const { staff, root } = await readyJob();
    const r = (await requestPlanReview(env.ctx, staff, { jobId: root, ...PLAN, windowSec: 60 })) as { thread_id: string };
    env.clock.advance(61);
    expect(await reconcileQuestion(env.ctx, r.thread_id)).toBe(true);
    expect((await reviewRow(root))!.state).toBe('closed');
    await expect(spawn(staff, root)).resolves.toBeTruthy();
  });

  it('skips at once with the reason when no researcher can answer', async () => {
    for (const [setup, reason] of [
      [() => exec(env.ctx.pool, `UPDATE researcher_personas SET enabled = 0`), /No researcher is enabled/],
      [() => exec(env.ctx.pool, `DELETE FROM host_runtimes`), /host runner/],
      [() => recordCodexBudget(env.ctx.pool, { used: 95, windowMin: 300, resetsAt: null, weekly: null, weeklyResetsAt: null, at: env.ctx.clock.now() }), /Codex window/],
    ] as const) {
      const { staff, root } = await readyJob();
      await setup();
      const r = await requestPlanReview(env.ctx, staff, { jobId: root, ...PLAN });
      expect(r).toMatchObject({ skipped: true, reason: expect.stringMatching(reason) });
      expect((await reviewRow(root))!.state).toBe('skipped');
      await expect(spawn(staff, root)).resolves.toBeTruthy();
      await exec(env.ctx.pool, `UPDATE researcher_personas SET enabled = 1`);
      await exec(env.ctx.pool, `DELETE FROM codex_budget`);
      await recordHostRuntimes(env.ctx, { codex: { version: '1', models: [] } });
    }
  });

  it('records the skip at the spawn ticket when Staff never asked and nobody could answer', async () => {
    const { staff, root } = await readyJob();
    await exec(env.ctx.pool, `UPDATE researcher_personas SET enabled = 0`);
    await expect(spawn(staff, root)).resolves.toBeTruthy();
    expect((await reviewRow(root))!.skip_reason).toMatch(/No researcher/);
    const msgs = await query(env.ctx.pool, `SELECT body FROM messages WHERE job_id = ? AND body LIKE 'Plan review skipped%'`, [root]);
    expect(msgs).toHaveLength(1);
  });

  it('lets Staff skip a small job with a reason the Client sees, once', async () => {
    const { staff, root } = await readyJob();
    await expect(skipPlanReview(env.ctx, staff, { jobId: root, reason: 'small' })).rejects.toThrow(/40 to 1000/);
    await skipPlanReview(env.ctx, staff, { jobId: root, reason: 'One-line copy fix in the footer, no logic, contract or data change.' });
    expect(await query(env.ctx.pool, `SELECT 1 FROM messages WHERE job_id = ? AND body LIKE 'Plan review skipped. Staff judged the job small%'`, [root])).toHaveLength(1);
    await expect(requestPlanReview(env.ctx, staff, { jobId: root, ...PLAN })).rejects.toThrow(/skipped/);
    await expect(spawn(staff, root)).resolves.toBeTruthy();
  });

  it('reviews once on the parent for every subjob, and passes jobs that already had a Senior', async () => {
    const { staff, root, leaf } = await readyJob(2);
    await expect(spawn(staff, leaf)).rejects.toThrow(new RegExp(`Job ${root} has no plan review`));
    const r = (await requestPlanReview(env.ctx, staff, { jobId: leaf, ...PLAN, windowSec: 60 })) as { thread_id: string };
    expect((await reviewRow(root))!.thread_id).toBe(r.thread_id);
    env.clock.advance(61);
    await reconcileQuestion(env.ctx, r.thread_id);
    await expect(spawn(staff, leaf)).resolves.toBeTruthy();

    const other = await readyJob();
    await exec(env.ctx.pool, `INSERT INTO assignments (id, job_id, kind, status, created_at) VALUES (?, ?, 'implement', 'closed', ?)`, [`asg_pr${n}`, other.root, env.ctx.clock.now()]);
    await expect(spawn(other.staff, other.root)).resolves.toBeTruthy();
  });

  it('refuses a plan with a missing or oversized section', async () => {
    const { staff, root } = await readyJob();
    await expect(requestPlanReview(env.ctx, staff, { jobId: root, ...PLAN, premises: ' ' })).rejects.toThrow(/premises is required/);
    await expect(requestPlanReview(env.ctx, staff, { jobId: root, ...PLAN, change: 'x'.repeat(3001) })).rejects.toThrow(/high level/);
    expect(await reviewRow(root)).toBeUndefined();
  });
});
