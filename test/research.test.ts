import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { authenticate, listAgents, registerAgent, type Agent } from '../src/agents.ts';
import { raiseBlocker } from '../src/blockers.ts';
import { askQuestion } from '../src/board.ts';
import { exec, query, queryOne } from '../src/db.ts';
import { registerJob, updateJob } from '../src/jobs.ts';
import { closeRun, createPersona, dispatchResearch, endRun, getItem, markItem, recordCodexBudget, startRun } from '../src/research.ts';
import { nextLaunch } from '../src/telemetry.ts';
import { createTestCtx, issue, TEST_DB_URL } from './helpers.ts';

// Runs against a real MySQL: set ORCH_TEST_DATABASE_URL (see README). Skipped otherwise.
describe.skipIf(!TEST_DB_URL)('research runs', () => {
  let env: Awaited<ReturnType<typeof createTestCtx>>;
  let n = 0;
  beforeAll(async () => {
    env = await createTestCtx();
  });
  afterAll(async () => {
    await env?.close();
  });
  // Each test watches only its own persona.
  beforeEach(async () => {
    await exec(env.ctx.pool, `UPDATE researcher_personas SET enabled = 0`);
  });

  async function staffWithJob(): Promise<{ staff: Agent; jobId: string }> {
    const reg = await registerAgent(env.ctx, { role: 'staff', nickname: `staff-${++n}`, runtime: 'test' });
    const staff = await authenticate(env.ctx, reg.session_token);
    const parent = issue(`RES-${++n}`, 'Research target', { children: [] });
    env.linear.add(parent as any);
    const job = await registerJob(env.ctx, staff, { linearIssue: parent.identifier, repoPath: '/repo', baseBranch: 'main' });
    await updateJob(env.ctx, staff, { jobId: job.job_id, status: 'planning' });
    return { staff, jobId: job.job_id };
  }

  /** Takes the next launch the way the runner does and returns its run ticket from the prompt. */
  async function takeRun() {
    const launch: any = await nextLaunch(env.ctx);
    expect(launch?.kind).toBe('research_run');
    return String(/run_ticket "([^"]+)"/.exec(launch.prompt)?.[1]);
  }

  it('routes a question to a persona, runs it once, and closes the item with a note', async () => {
    const { staff, jobId } = await staffWithJob();
    const persona = await createPersona(env.ctx, { nickname: `sol-${++n}`, focus: 'testing', repo_path: '/repo', model: 'gpt-6.1-sol', effort: 'medium' });
    await askQuestion(env.ctx, { kind: 'agent', agent: staff }, { jobId, title: 'Queue or inline?', summary: 's', question: 'q?', whyItMatters: 'w', waitingWork: 'x', windowSec: 60 });
    expect((await listAgents(env.ctx, { includeInactive: false })).find((a) => a.id === persona.agent_id)?.presence).toBe('waiting');
    const inbox = await query(env.ctx.pool, `SELECT * FROM research_inbox WHERE persona_id = ?`, [persona.id]);
    expect(inbox.map((i) => [i.kind, i.status])).toEqual([['question', 'new']]);

    // Due within 90 seconds, so it does not wait for the batch delay.
    await dispatchResearch(env.ctx);
    await dispatchResearch(env.ctx);
    expect(await query(env.ctx.pool, `SELECT * FROM research_runs WHERE persona_id = ?`, [persona.id])).toHaveLength(1);

    const presence = async () => (await listAgents(env.ctx, { includeInactive: false })).find((a) => a.id === persona.agent_id)?.presence;
    expect(presence).toBeDefined();
    const queued = await presence();
    const started = await startRun(env.ctx, await takeRun());
    expect(started.items).toHaveLength(1);
    const me = await authenticate(env.ctx, started.session_token);
    const detail: any = await getItem(env.ctx, me.id, String(started.items[0]!.id));
    expect(detail.messages.length).toBeGreaterThan(0);
    await markItem(env.ctx, me.id, String(started.items[0]!.id), 'skipped', 'Nothing to add to the Staff option.');
    await endRun(env.ctx, me.id, 'one item');
    // A persona shows at once: starting while its run is queued, waiting between runs, never ended.
    expect(queued).toBe('starting');
    expect(await presence()).toBe('waiting');

    const item = await queryOne(env.ctx.pool, `SELECT status, note FROM research_inbox WHERE persona_id = ?`, [persona.id]);
    expect(item).toMatchObject({ status: 'skipped', note: 'Nothing to add to the Staff option.' });
    const run = await queryOne(env.ctx.pool, `SELECT status FROM research_runs WHERE persona_id = ?`, [persona.id]);
    expect(run?.status).toBe('ended');
    await expect(authenticate(env.ctx, started.session_token)).rejects.toThrow();
  });

  it('returns unmarked items to the inbox when a run dies, then expires them', async () => {
    const { staff, jobId } = await staffWithJob();
    const persona = await createPersona(env.ctx, { nickname: `sol-${++n}`, focus: 'decisions', repo_path: '/repo', model: 'gpt-6.1-sol', effort: 'medium' });
    await raiseBlocker(env.ctx, staff, { jobId, kind: 'client_decision', context: 'c', requestedDecision: 'Ship it?', recommendation: 'Yes', unblockCondition: 'Client answers' });
    const open = () => queryOne(env.ctx.pool, `SELECT * FROM research_inbox WHERE persona_id = ?`, [persona.id]);
    expect((await open())?.kind).toBe('client_decision');

    // Not due soon: it waits for the batch delay.
    await dispatchResearch(env.ctx);
    expect((await open())?.status).toBe('new');
    env.clock.advance(20);
    for (let attempt = 1; attempt <= 2; attempt++) {
      await dispatchResearch(env.ctx);
      const run = await queryOne(env.ctx.pool, `SELECT id FROM research_runs WHERE persona_id = ? AND status = 'queued'`, [persona.id]);
      await takeRun();
      await closeRun(env.ctx, String(run!.id), 'failed', 'exit 1');
    }
    expect((await open())?.status).toBe('expired');
  });

  it('holds back above the budget limit until the window resets', async () => {
    const { staff, jobId } = await staffWithJob();
    const persona = await createPersona(env.ctx, { nickname: `sol-${++n}`, focus: 'budget', repo_path: '/repo', model: 'gpt-6.1-sol', effort: 'medium' });
    const now = env.clock.now();
    await recordCodexBudget(env.ctx.pool, { used: 95, windowMin: 300, resetsAt: new Date(now.getTime() + 3600_000), weekly: 50, weeklyResetsAt: null, at: now });
    await askQuestion(env.ctx, { kind: 'agent', agent: staff }, { jobId, title: 'Budget?', summary: 's', question: 'q?', whyItMatters: 'w', waitingWork: 'x', windowSec: 60 });
    await dispatchResearch(env.ctx);
    expect(await query(env.ctx.pool, `SELECT * FROM research_runs WHERE persona_id = ?`, [persona.id])).toHaveLength(0);
    env.clock.advance(3601);
    await dispatchResearch(env.ctx);
    expect(await query(env.ctx.pool, `SELECT * FROM research_runs WHERE persona_id = ?`, [persona.id])).toHaveLength(1);
  });
});
