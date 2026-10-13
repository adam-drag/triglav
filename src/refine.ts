/**
 * Refinement of a job that started from a prompt. Staff proposes goal, scope, non-goals and acceptance criteria
 * (the job's plan and acceptance_criteria) and asks open questions on the General thread. The Client answers or
 * edits in the dashboard; every answer or edit wakes Staff, who revises. Only the Client's approval moves the job
 * from refining to planning, and it wakes Staff too; the Client may send a last answer with it.
 */
import { tx, type Ctx } from './context.ts';
import { exec, type Conn } from './db.ts';
import { systemMessage } from './board.ts';
import { emit } from './events.ts';
import { CLIENT, generalThreadId, lockJob, recordJobDecision, setStatus } from './jobs.ts';
import { assertNoSecrets, conflict, invalid } from './lib.ts';

export const MAX_REFINE_TEXT = 20_000;

type ClientInput = { message?: string; plan?: string; acceptanceCriteria?: string };

function checkInput(input: ClientInput) {
  const message = input.message?.trim() || undefined;
  for (const [name, text] of [['message', message], ['plan', input.plan], ['acceptance_criteria', input.acceptanceCriteria]] as const) {
    if (text !== undefined && text.length > MAX_REFINE_TEXT) throw invalid(`${name} is longer than ${MAX_REFINE_TEXT} characters.`);
  }
  assertNoSecrets(message, input.plan, input.acceptanceCriteria);
  return { ...input, message };
}

/** Saves the Client's edits and posts its answer on the General thread. Returns an empty body when there was nothing to say. */
async function applyClientInput(conn: Conn, ctx: Ctx, job: Record<string, any>, input: ClientInput) {
  const now = ctx.clock.now();
  const edited: string[] = [];
  if (input.plan !== undefined) {
    await exec(conn, `UPDATE jobs SET plan = ?, updated_at = ? WHERE id = ?`, [input.plan, now, job.id]);
    job.plan = input.plan;
    edited.push('plan');
  }
  if (input.acceptanceCriteria !== undefined) {
    await exec(conn, `UPDATE jobs SET acceptance_criteria = ?, updated_at = ? WHERE id = ?`, [input.acceptanceCriteria, now, job.id]);
    job.acceptance_criteria = input.acceptanceCriteria;
    edited.push('acceptance_criteria');
  }
  const threadId = await generalThreadId(conn, job.id);
  const label = edited.map((f) => (f === 'plan' ? 'the goal, scope and non-goals' : 'the acceptance criteria')).join(' and ');
  const body = [input.message, edited.length ? `(The Client edited ${label} on the job. Read them again with get_job.)` : null].filter(Boolean).join('\n\n');
  if (body) await systemMessage(conn, ctx, job.id, CLIENT, 'discussion', body, threadId);
  return { threadId, body, edited };
}

/** The Client answers or edits and refinement goes on: Staff wakes and revises. */
export async function clientRefine(ctx: Ctx, jobId: string, raw: ClientInput) {
  const input = checkInput(raw);
  if (input.message === undefined && input.plan === undefined && input.acceptanceCriteria === undefined) throw invalid('Write an answer or change the proposal.');
  return tx(ctx, async (conn) => {
    const job = await lockJob(conn, jobId);
    if (job.status !== 'refining') throw conflict(`Job ${job.id} is ${job.status}, not refining.`);
    const { threadId, body, edited } = await applyClientInput(conn, ctx, job, input);
    await emit(conn, ctx, {
      type: 'refinement.client_reply',
      jobId: job.id,
      threadId,
      actor: CLIENT,
      targets: [job.staff_agent_id].filter(Boolean),
      payload: { excerpt: body.slice(0, 200), edited },
    });
    return { job_id: job.id, thread_id: threadId, edited };
  });
}

/**
 * Client only. The Client may send a last answer or edits with the approval; they are saved first and Staff reads
 * them as part of planning, without another round of refinement. The criteria must exist after that: approving an
 * empty proposal would start planning without a target.
 */
export async function approveRefinement(ctx: Ctx, jobId: string, raw: ClientInput = {}) {
  const input = checkInput(raw);
  return tx(ctx, async (conn) => {
    const job = await lockJob(conn, jobId);
    if (job.status !== 'refining') throw conflict(`Job ${job.id} is ${job.status}, not refining.`);
    const criteria = input.acceptanceCriteria ?? job.acceptance_criteria;
    if (!String(criteria ?? '').trim()) throw conflict('Staff has not proposed acceptance criteria yet. Wait for the proposal, or write the criteria yourself, then approve.');
    const { threadId, body, edited } = await applyClientInput(conn, ctx, job, input);
    await recordJobDecision(conn, ctx, job.id, CLIENT, 'Approved the goal, scope and acceptance criteria. Planning can start.', null);
    await setStatus(conn, ctx, job, 'planning', CLIENT);
    await emit(conn, ctx, {
      type: 'refinement.approved',
      jobId: job.id,
      threadId,
      actor: CLIENT,
      targets: [job.staff_agent_id].filter(Boolean),
      payload: body ? { note: body.slice(0, 200), edited } : {},
    });
    return { job_id: job.id, status: 'planning' };
  });
}
