/**
 * A second opinion on Staff's plan before the first Senior starts. Staff posts the plan as a timed question; the
 * researchers form their own approach, check the plan's premises in the code and challenge it. The spawn ticket gate
 * (`assertPlanReviewed`) refuses a Senior until the review closed, or was skipped with a recorded reason, and until
 * Staff has answered every objection on it.
 */
import type { Agent } from './agents.ts';
import { openObjections, openQuestion, systemMessage } from './board.ts';
import { POLICY, tx, type Ctx } from './context.ts';
import { exec, query, queryOne, type Conn, type Row } from './db.ts';
import { assertNoSecrets, conflict, invalid } from './lib.ts';
import { CLOSED, lockJob, requireStaffOf } from './jobs.ts';
import { researchUnavailable } from './research.ts';

export interface PlanInput {
  jobId: string;
  problem: string;
  change: string;
  reasons: string;
  alternatives: string;
  premises: string;
  risks: string;
  windowSec?: number;
}

const FIELD_MAX = 3000;

/** The review covers the whole job tree, so it lives on the top-level job. */
async function rootOf(conn: Conn, jobId: string): Promise<Row> {
  const job = await lockJob(conn, jobId);
  return job.parent_job_id ? lockJob(conn, job.parent_job_id as string) : job;
}

function checkRoot(agent: Agent, root: Row) {
  requireStaffOf(agent, root);
  if (CLOSED.includes(root.status)) throw conflict(`Job ${root.id} is ${root.status}.`);
  if (root.status === 'refining') throw conflict(`Job ${root.id} is still refining. Plan it after the Client approves.`);
}

async function existing(conn: Conn, rootId: string) {
  return queryOne(conn, `SELECT * FROM plan_reviews WHERE job_id = ? FOR UPDATE`, [rootId]);
}

function already(row: Row) {
  if (row.state === 'skipped') return conflict(`The plan review of job ${row.job_id} was skipped: ${row.skip_reason}`);
  return conflict(`Job ${row.job_id} already has a plan review (thread ${row.thread_id}, ${row.state}). Use await_question or get_thread on it.`);
}

/**
 * Opens the review, or records a skip when no researcher can answer (the result says so). The row and its question are
 * written in one transaction, so a restart can never leave a review without its thread.
 */
export async function requestPlanReview(ctx: Ctx, agent: Agent, input: PlanInput) {
  const fields = { problem: input.problem, change: input.change, reasons: input.reasons, alternatives: input.alternatives, premises: input.premises, risks: input.risks };
  for (const [name, value] of Object.entries(fields)) {
    if (!value?.trim()) throw invalid(`${name} is required.`);
    if (value.length > FIELD_MAX) throw invalid(`${name} is longer than ${FIELD_MAX} characters. Keep the plan high level.`);
  }
  assertNoSecrets(...Object.values(fields));
  return tx(ctx, async (conn) => {
    const root = await rootOf(conn, input.jobId);
    checkRoot(agent, root);
    const row = await existing(conn, root.id as string);
    if (row) throw already(row);
    const unavailable = await researchUnavailable(ctx, conn);
    const now = ctx.clock.now();
    if (unavailable) {
      await exec(conn, `INSERT INTO plan_reviews (job_id, state, skip_reason, created_by, created_at, closed_at) VALUES (?, 'skipped', ?, ?, ?, ?)`, [root.id, unavailable, agent.id, now, now]);
      await systemMessage(conn, ctx, root.id as string, agent.id, 'progress', `Plan review skipped: ${unavailable}`);
      return { skipped: true, reason: unavailable, next: 'Start the Seniors.' };
    }
    const q = await openQuestion(conn, ctx, { kind: 'agent', agent }, {
      jobId: root.id as string,
      title: `Plan review: ${root.title as string}`.slice(0, 500),
      question: [
        `PLAN REVIEW. Before reading the plan, decide how you would solve the problem. Then check the premises in the code and challenge what is wrong, risky or weaker than your approach.`,
        ``,
        `Problem: ${input.problem}`,
        `Change: ${input.change}`,
        `Why: ${input.reasons}`,
        `Alternatives rejected: ${input.alternatives}`,
        `Premises to check: ${input.premises}`,
        `Risks and non-goals: ${input.risks}`,
      ].join('\n'),
      whyItMatters: 'A Senior starts on this plan when the review closes.',
      waitingWork: 'Starting the Seniors for this job.',
      windowSec: input.windowSec ?? POLICY.planReviewWindowSec,
      requiresStaffDecision: false,
    });
    await exec(conn, `INSERT INTO plan_reviews (job_id, thread_id, state, created_by, created_at) VALUES (?, ?, 'open', ?, ?)`, [root.id, q.thread_id, agent.id, now]);
    return { skipped: false, thread_id: q.thread_id, deadline_at: q.deadline_at, next: 'Call await_question with thread_id. It returns early once every researcher has answered.' };
  });
}

/** Staff judged the job small enough to skip the review. The reason goes on the job board for the Client. */
export async function skipPlanReview(ctx: Ctx, agent: Agent, input: { jobId: string; reason: string }) {
  const reason = input.reason?.trim() ?? '';
  if (reason.length < 40 || reason.length > 1000) throw invalid('reason must be 40 to 1000 characters: why this job is small enough to skip the review.');
  assertNoSecrets(reason);
  return tx(ctx, async (conn) => {
    const root = await rootOf(conn, input.jobId);
    checkRoot(agent, root);
    const row = await existing(conn, root.id as string);
    if (row) throw already(row);
    const now = ctx.clock.now();
    const text = `Staff judged the job small: ${reason}`;
    await exec(conn, `INSERT INTO plan_reviews (job_id, state, skip_reason, created_by, created_at, closed_at) VALUES (?, 'skipped', ?, ?, ?, ?)`, [root.id, text, agent.id, now, now]);
    await systemMessage(conn, ctx, root.id as string, agent.id, 'progress', `Plan review skipped. ${text}`);
    return { skipped: true, job_id: root.id };
  });
}

/**
 * Spawn ticket gate for a Senior. Jobs whose tree already had a Senior are past planning and pass. With no review and
 * no researcher able to answer, the skip is recorded here, so Staff is not stopped for a review nobody can give.
 */
export async function assertPlanReviewed(ctx: Ctx, conn: Conn, agent: Agent, job: Row) {
  const rootId = (job.parent_job_id as string | null) ?? (job.id as string);
  const started = await queryOne(conn, `SELECT 1 AS s FROM assignments a JOIN jobs j ON j.id = a.job_id WHERE a.kind = 'implement' AND (j.id = ? OR j.parent_job_id = ?) LIMIT 1`, [rootId, rootId]);
  if (started) return;
  const row = await queryOne(conn, `SELECT * FROM plan_reviews WHERE job_id = ? FOR UPDATE`, [rootId]);
  if (!row) {
    const unavailable = await researchUnavailable(ctx, conn);
    if (!unavailable) throw conflict(`Job ${rootId} has no plan review. Call request_plan_review first, or skip_plan_review for a small job.`);
    const now = ctx.clock.now();
    await exec(conn, `INSERT INTO plan_reviews (job_id, state, skip_reason, created_by, created_at, closed_at) VALUES (?, 'skipped', ?, ?, ?, ?)`, [rootId, unavailable, agent.id, now, now]);
    await systemMessage(conn, ctx, rootId, agent.id, 'progress', `Plan review skipped: ${unavailable}`);
    return;
  }
  if (row.state === 'skipped') return;
  if (row.state === 'open') throw conflict(`The plan review of job ${rootId} is still open (thread ${row.thread_id}). Call await_question on it.`);
  const open = (await openObjections(conn, rootId)).filter((o) => o.thread_id === row.thread_id);
  if (open.length) {
    throw conflict(
      `Answer every objection on the plan review first (reply with in_reply_to, or raise a client_decision blocker for a major one): messages ${open.map((o) => o.id).join(', ')}.`,
    );
  }
}

/** A plan review closes early once every researcher it reached has handled or skipped its item. */
export async function planReviewSettled(conn: Conn, threadId: string): Promise<boolean> {
  const rows = await query(conn, `SELECT status FROM research_inbox WHERE thread_id = ? AND kind = 'question'`, [threadId]);
  return rows.length > 0 && rows.every((r) => !['new', 'claimed'].includes(r.status as string));
}

/** Marks the review closed when its question closes. Returns whether the thread was a plan review. */
export async function closePlanReview(conn: Conn, ctx: Ctx, threadId: string): Promise<boolean> {
  const row = await queryOne(conn, `SELECT job_id FROM plan_reviews WHERE thread_id = ? FOR UPDATE`, [threadId]);
  if (!row) return false;
  await exec(conn, `UPDATE plan_reviews SET state = 'closed', closed_at = ? WHERE thread_id = ? AND state = 'open'`, [ctx.clock.now(), threadId]);
  return true;
}

export async function planReviewOf(conn: Conn, jobId: string) {
  const job = await queryOne(conn, `SELECT id, parent_job_id FROM jobs WHERE id = ?`, [jobId]);
  if (!job) return null;
  return queryOne(conn, `SELECT job_id, thread_id, state, skip_reason, created_at, closed_at FROM plan_reviews WHERE job_id = ?`, [job.parent_job_id ?? job.id]);
}
