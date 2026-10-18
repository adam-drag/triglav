import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authenticate, registerAgent, type Agent } from '../src/agents.ts';
import { clientInbox, fileDissent, openObjections, postMessage, recordDecision } from '../src/board.ts';
import { query } from '../src/db.ts';
import { readEvents } from '../src/events.ts';
import { generalThreadId, registerJob, updateJob } from '../src/jobs.ts';
import { createPersona } from '../src/research.ts';
import { createTestCtx, issue, TEST_DB_URL } from './helpers.ts';

// How agents disagree on the board: open objections, dissent to the Client, and objectors hearing the outcome.
describe.skipIf(!TEST_DB_URL)('discussion', () => {
  let env: Awaited<ReturnType<typeof createTestCtx>>;
  let n = 0;

  beforeAll(async () => {
    env = await createTestCtx();
  });
  afterAll(async () => {
    await env?.close();
  });

  async function register(role: 'staff' | 'researcher') {
    const reg = await registerAgent(env.ctx, { role, nickname: `${role}-${++n}`, runtime: 'test' });
    return authenticate(env.ctx, reg.session_token);
  }

  async function jobFor(staff: Agent) {
    const parent = issue(`DIS-${++n}`, 'Discussion job');
    env.linear.add(parent as any);
    const job = await registerJob(env.ctx, staff, { linearIssue: parent.identifier, repoPath: '/repo', baseBranch: 'main' });
    await updateJob(env.ctx, staff, { jobId: job.job_id, status: 'planning' });
    return { jobId: job.job_id, threadId: await generalThreadId(env.ctx.pool, job.job_id) };
  }

  const objectAs = (agent: Agent, threadId: string, body = 'Use the existing parser.') =>
    postMessage(env.ctx, { kind: 'agent', agent }, { threadId, type: 'reply', stance: 'challenge', reason: 'parser.ts:12 already handles this.', body });

  it('keeps an objection open until Staff or the Client answers it or a decision lists it', async () => {
    const staff = await register('staff');
    const r = await register('researcher');
    const { jobId, threadId } = await jobFor(staff);
    const open = async () => (await openObjections(env.ctx.pool, jobId)).map((o) => o.id);

    const first = await objectAs(r, threadId);
    const second = await objectAs(r, threadId, 'And drop the cache.');
    // Staff's own objections are its authority, not something it owes an answer to.
    await postMessage(env.ctx, { kind: 'agent', agent: staff }, { threadId, type: 'reply', stance: 'disagree', reason: 'r', body: 'No.' });
    expect(await open()).toEqual([first.message_id, second.message_id]);

    // A plain later Staff message that neither replies to nor mentions the objector does not answer it.
    await postMessage(env.ctx, { kind: 'agent', agent: staff }, { threadId, type: 'reply', body: 'Working on it.' });
    expect(await open()).toEqual([first.message_id, second.message_id]);

    await postMessage(env.ctx, { kind: 'agent', agent: staff }, { threadId, type: 'reply', body: 'Accepted, will reuse it.', inReplyTo: first.message_id });
    expect(await open()).toEqual([second.message_id]);

    await recordDecision(env.ctx, { kind: 'agent', agent: staff }, { threadId, body: 'Keep the cache.', rationale: 'Cold starts.', consideredMessageIds: [second.message_id] });
    expect(await open()).toEqual([]);
  });

  it('tells the objectors about the decision and routes it to an objecting researcher persona only', async () => {
    const staff = await register('staff');
    const { jobId, threadId } = await jobFor(staff);
    const objecting = await createPersona(env.ctx, { nickname: `obj-${++n}`, focus: 'f', repo_path: '/repo', model: 'm', effort: 'medium' });
    const quiet = await createPersona(env.ctx, { nickname: `quiet-${++n}`, focus: 'f', repo_path: '/repo', model: 'm', effort: 'medium' });
    const [persona] = await query(env.ctx.pool, `SELECT * FROM agents WHERE id = (SELECT agent_id FROM researcher_personas WHERE id = ?)`, [objecting.id]);
    const objection = await objectAs(persona as unknown as Agent, threadId);
    const d = await recordDecision(env.ctx, { kind: 'agent', agent: staff }, { threadId, body: 'Write a new parser.', rationale: 'The old one is slow.', consideredMessageIds: [objection.message_id] });

    const ev = await readEvents(env.ctx.pool, String(persona!.id), { cursor: 0, scope: 'owned', types: ['decision.recorded'] });
    expect(ev.events.some((e) => e.payload.decision_id === d.decision_id)).toBe(true);
    const items = await query(env.ctx.pool, `SELECT persona_id, kind FROM research_inbox WHERE job_id = ? AND kind = 'decision'`, [jobId]);
    expect(items.map((i) => i.persona_id)).toEqual([objecting.id]);
    expect(items.some((i) => i.persona_id === quiet.id)).toBe(false);
  });

  it('lets any agent but the deciding Staff file one dissent per decision, into the Client inbox', async () => {
    const staff = await register('staff');
    const r = await register('researcher');
    const { threadId } = await jobFor(staff);
    const objection = await objectAs(r, threadId);
    const d = await recordDecision(env.ctx, { kind: 'agent', agent: staff }, { threadId, body: 'Write a new parser.', rationale: 'Speed.', consideredMessageIds: [objection.message_id] });
    const reason = 'The new parser drops UTF-16 input that parser.ts:30 handles; customers upload such files. Reuse the old parser.';

    await expect(fileDissent(env.ctx, staff, { decisionId: d.decision_id, reason })).rejects.toThrow(/You made this decision/);
    await expect(fileDissent(env.ctx, r, { decisionId: d.decision_id, reason: 'too short' })).rejects.toThrow(/50 to 1200/);

    const res = await fileDissent(env.ctx, r, { decisionId: d.decision_id, reason });
    await expect(fileDissent(env.ctx, r, { decisionId: d.decision_id, reason })).rejects.toThrow(/already filed/);

    const inbox = await clientInbox(env.ctx);
    const item = inbox.find((m) => m.id === res.message_id);
    expect(item?.type).toBe('dissent');
    expect(item?.body).toBe(reason);
    const ev = await readEvents(env.ctx.pool, staff.id, { cursor: 0, scope: 'owned', types: ['decision.dissent'] });
    expect(ev.events.some((e) => e.payload.decision_id === d.decision_id)).toBe(true);

    // A superseded decision and a Client decision take no dissent.
    const newer = await recordDecision(env.ctx, { kind: 'agent', agent: staff }, { threadId, body: 'Reuse the old parser.', rationale: 'UTF-16.', consideredMessageIds: [], supersedesDecisionId: d.decision_id });
    const r2 = await register('researcher');
    await expect(fileDissent(env.ctx, r2, { decisionId: d.decision_id, reason })).rejects.toThrow(/superseded/);
    const client = await recordDecision(env.ctx, { kind: 'client' }, { threadId, body: 'Reuse it.', rationale: 'Mine.', consideredMessageIds: [], supersedesDecisionId: newer.decision_id });
    await expect(fileDissent(env.ctx, r2, { decisionId: client.decision_id, reason })).rejects.toThrow(/Client made this decision/);
  });
});
