import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { authenticate, listAgents, registerAgent, type Agent } from '../src/agents.ts';
import { raiseBlocker } from '../src/blockers.ts';
import { askQuestion, postMessage, VIEW_REQUEST_BODY } from '../src/board.ts';
import { exec, parseJson, query, queryOne } from '../src/db.ts';
import { registerJob, updateJob } from '../src/jobs.ts';
import { closeRun, createPersona, dispatchResearch, endRun, getItem, markItem, recordCodexBudget, startRun } from '../src/research.ts';
import { buildServer } from '../src/server.ts';
import { nextLaunch } from '../src/telemetry.ts';
import { asClient, createTestCtx, issue, loginCookie, TEST_DB_URL, TEST_RUNNER_KEY, testServerKeys } from './helpers.ts';

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

  it('does not route a routine Client decision to a researcher', async () => {
    const { staff, jobId } = await staffWithJob();
    const persona = await createPersona(env.ctx, { nickname: `sol-${++n}`, focus: 'decisions', repo_path: '/repo', model: 'gpt-6.1-sol', effort: 'medium' });
    await raiseBlocker(env.ctx, staff, { jobId, kind: 'client_decision', requestedDecision: 'Mark the PR ready so CI runs?', unblockCondition: 'Client says Done', routine: true });
    expect(await queryOne(env.ctx.pool, `SELECT id FROM research_inbox WHERE persona_id = ?`, [persona.id])).toBeUndefined();
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

  it('closes a run whose launch failed to start, so its items go back to the inbox at once', async () => {
    const { staff, jobId } = await staffWithJob();
    const persona = await createPersona(env.ctx, { nickname: `sol-${++n}`, focus: 'launch', repo_path: '/repo', model: 'gpt-6.1-sol', effort: 'medium' });
    await askQuestion(env.ctx, { kind: 'agent', agent: staff }, { jobId, title: 'Queue or inline?', summary: 's', question: 'q?', whyItMatters: 'w', waitingWork: 'x', windowSec: 60 });
    await dispatchResearch(env.ctx);
    const launch: any = await nextLaunch(env.ctx);
    expect(launch?.kind).toBe('research_run');
    const inbox = () => queryOne(env.ctx.pool, `SELECT status FROM research_inbox WHERE persona_id = ?`, [persona.id]);
    expect((await inbox())?.status).toBe('claimed');
    // The runner reports a start that failed through /done: no process exists, so no /exited will come.
    const app = buildServer(env.ctx, { ...(await testServerKeys()), webDir: '/nonexistent' });
    const res = await app.inject({ method: 'POST', url: `/api/runner/${launch.id}/done`, headers: { authorization: `Bearer ${TEST_RUNNER_KEY}`, 'content-type': 'application/json' }, payload: JSON.stringify({ result: 'failed: could not list the MCP servers of Codex' }) });
    expect(res.statusCode).toBe(200);
    await app.close();
    expect((await queryOne(env.ctx.pool, `SELECT status FROM research_runs WHERE id = ?`, [launch.run_id]))?.status).toBe('failed');
    expect((await inbox())?.status).toBe('new');
  });

  it('turns a Client mention into a view request that runs above the 70% budget and names the message to answer', async () => {
    const { staff, jobId } = await staffWithJob();
    const persona = await createPersona(env.ctx, { nickname: `sol-${++n}`, focus: 'views', repo_path: '/repo', model: 'gpt-6.1-sol', effort: 'medium' });
    // An agent's mention first: a plain mention item, which the Client's request then upgrades.
    await postMessage(env.ctx, { kind: 'agent', agent: staff }, { jobId, type: 'discussion', body: 'Option A or B?', mentions: [persona.agent_id] });
    const now = env.clock.now();
    await recordCodexBudget(env.ctx.pool, { used: 75, windowMin: 300, resetsAt: new Date(now.getTime() + 3600_000), weekly: 50, weeklyResetsAt: null, at: now });
    const asked = await postMessage(env.ctx, { kind: 'client' }, { jobId, type: 'reply', body: VIEW_REQUEST_BODY, mentions: [persona.agent_id, staff.id] });
    const items = await query(env.ctx.pool, `SELECT kind, status FROM research_inbox WHERE persona_id = ?`, [persona.id]);
    expect(items.map((i) => [i.kind, i.status])).toEqual([['view_request', 'new']]);

    // Staff gets the same request as a mention it is woken by.
    const staffEvent = await queryOne(env.ctx.pool, `SELECT payload FROM events WHERE type = 'mention' AND actor = 'client' AND JSON_CONTAINS(payload, JSON_QUOTE(?), '$.targets')`, [staff.id]);
    expect(parseJson<Record<string, unknown>>(staffEvent!.payload).view_requested).toBe(true);

    env.clock.advance(20);
    await dispatchResearch(env.ctx);
    const started = await startRun(env.ctx, await takeRun());
    const me = await authenticate(env.ctx, started.session_token);
    const detail: any = await getItem(env.ctx, me.id, String(started.items[0]!.id));
    expect(detail.client_message_id).toBe(asked.message_id);
    expect(detail.messages.at(-1)).toMatchObject({ id: asked.message_id, author: 'client', body: VIEW_REQUEST_BODY });
    await markItem(env.ctx, me.id, String(started.items[0]!.id), 'handled', 'Answered the Client.');
    await endRun(env.ctx, me.id, 'one view');
  });

  it('refuses a Client mention of an agent that cannot answer on the job', async () => {
    const { jobId } = await staffWithJob();
    const persona = await createPersona(env.ctx, { nickname: `sol-${++n}`, focus: 'off', repo_path: '/repo', model: 'gpt-6.1-sol', effort: 'medium' });
    await exec(env.ctx.pool, `UPDATE researcher_personas SET enabled = 0 WHERE id = ?`, [persona.id]);
    const other = await staffWithJob();
    await expect(postMessage(env.ctx, { kind: 'client' }, { jobId, type: 'reply', body: 'View?', mentions: [persona.agent_id] })).rejects.toThrow(/Cannot ask/);
    await expect(postMessage(env.ctx, { kind: 'client' }, { jobId, type: 'reply', body: 'View?', mentions: [other.staff.id] })).rejects.toThrow(/Cannot ask/);
    // Tagging only the Client is not a request for a view and stays allowed.
    await postMessage(env.ctx, { kind: 'client' }, { jobId, type: 'reply', body: 'Noted.', mentions: ['client'] });
  });

  it('makes a Client request that arrives during a run a new item, instead of closing it with the claimed one', async () => {
    const { jobId } = await staffWithJob();
    const persona = await createPersona(env.ctx, { nickname: `sol-${++n}`, focus: 'twice', repo_path: '/repo', model: 'gpt-6.1-sol', effort: 'medium' });
    await postMessage(env.ctx, { kind: 'client' }, { jobId, type: 'reply', body: 'First ask.', mentions: [persona.agent_id] });
    env.clock.advance(20);
    await dispatchResearch(env.ctx);
    const started = await startRun(env.ctx, await takeRun());
    const me = await authenticate(env.ctx, started.session_token);
    const second = await postMessage(env.ctx, { kind: 'client' }, { jobId, type: 'reply', body: 'Second ask.', mentions: [persona.agent_id] });
    await markItem(env.ctx, me.id, String(started.items[0]!.id), 'handled', 'Answered the first ask.');
    await endRun(env.ctx, me.id, 'first');
    const open = await query(env.ctx.pool, `SELECT kind, status, event_id FROM research_inbox WHERE persona_id = ? AND status = 'new'`, [persona.id]);
    expect(open.map((i) => i.kind)).toEqual(['view_request']);
    const event = await queryOne(env.ctx.pool, `SELECT payload FROM events WHERE id = ?`, [open[0]!.event_id]);
    expect(parseJson<Record<string, unknown>>(event!.payload).message_id).toBe(second.message_id);
  });

  it('names the Client message to answer even when an agent mention or a question merged into the item', async () => {
    const { staff, jobId } = await staffWithJob();
    const persona = await createPersona(env.ctx, { nickname: `sol-${++n}`, focus: 'merge', repo_path: '/repo', model: 'gpt-6.1-sol', effort: 'medium' });
    // On a general thread: the Client asks, then Staff mentions the researcher before the run starts.
    const asked = await postMessage(env.ctx, { kind: 'client' }, { jobId, type: 'reply', body: 'Your view?', mentions: [persona.agent_id] });
    await postMessage(env.ctx, { kind: 'agent', agent: staff }, { jobId, type: 'reply', body: 'Also look at the cache.', mentions: [persona.agent_id] });
    // On a timed question's thread: the item stays a question with its title, and still names the Client's message.
    const q = await askQuestion(env.ctx, { kind: 'agent', agent: staff }, { jobId, title: 'Cache or not?', summary: 's', question: 'q?', whyItMatters: 'w', waitingWork: 'x', windowSec: 60 });
    const onQuestion = await postMessage(env.ctx, { kind: 'client' }, { threadId: q.thread_id, type: 'reply', body: 'Challenge this.', mentions: [persona.agent_id] });
    env.clock.advance(20);
    await dispatchResearch(env.ctx);
    const started = await startRun(env.ctx, await takeRun());
    const me = await authenticate(env.ctx, started.session_token);
    const byThread = new Map<string, any>();
    for (const it of started.items) byThread.set(String(it.thread_id), { it, detail: await getItem(env.ctx, me.id, String(it.id)) });
    const general = byThread.get(asked.thread_id)!;
    expect(general.it.kind).toBe('view_request');
    expect(general.detail.client_message_id).toBe(asked.message_id);
    const question = byThread.get(q.thread_id)!;
    expect(question.it.kind).toBe('question');
    expect(question.it.title).toContain('question: Cache or not?');
    expect(question.detail.client_message_id).toBe(onQuestion.message_id);
    for (const it of started.items) await markItem(env.ctx, me.id, String(it.id), 'handled', 'Answered.');
    await endRun(env.ctx, me.id, 'two');
  });

  it('serves the view candidates and fills an empty request through the Client API, and refuses an agent that cannot answer', async () => {
    const { staff, jobId } = await staffWithJob();
    const other = await staffWithJob();
    const persona = await createPersona(env.ctx, { nickname: `sol-${++n}`, focus: 'api', repo_path: '/repo', model: 'gpt-6.1-sol', effort: 'medium' });
    const posted = await postMessage(env.ctx, { kind: 'agent', agent: staff }, { jobId, type: 'discussion', body: 'Plan.' });
    const app = buildServer(env.ctx, { ...(await testServerKeys()), webDir: '/nonexistent' });
    try {
      const client = asClient(app, await loginCookie(app));
      const thread = (await client.inject({ method: 'GET', url: `/api/threads/${posted.thread_id}` })).json();
      expect(thread.view_candidates.map((c: any) => c.id).sort()).toEqual([staff.id, persona.agent_id].sort());
      const ok = await client.inject({ method: 'POST', url: '/api/messages', payload: { thread_id: posted.thread_id, type: 'reply', body: '', mentions: [persona.agent_id] } });
      expect(ok.statusCode).toBe(200);
      const row = await queryOne(env.ctx.pool, `SELECT body FROM messages WHERE id = ?`, [ok.json().message_id]);
      expect(row?.body).toBe(VIEW_REQUEST_BODY);
      const refused = await client.inject({ method: 'POST', url: '/api/messages', payload: { thread_id: posted.thread_id, type: 'reply', body: 'View?', mentions: [other.staff.id] } });
      expect(refused.statusCode).toBe(400);
      const empty = await client.inject({ method: 'POST', url: '/api/messages', payload: { thread_id: posted.thread_id, type: 'reply', body: '' } });
      expect(empty.statusCode).toBe(400);
    } finally {
      await app.close();
    }
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
