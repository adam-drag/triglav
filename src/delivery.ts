import type { Agent } from './agents.ts';
import { openObjections, systemMessage } from './board.ts';
import { tx, type Ctx } from './context.ts';
import { exec, query, queryOne } from './db.ts';
import { emit } from './events.ts';
import { CLIENT, CLOSED, closeAssignments, lockJob, requireAttempt, requireStaffOf, setStatus } from './jobs.ts';
import { assertNoSecrets, conflict, invalid, newId } from './lib.ts';
import { reviewMode } from './models.ts';

/*
 * Delivery runs after the internal review accepts: the Senior takes the PR through the Copilot review loop
 * (when the review mode asks for it) and gets CI green on the head commit. A job is done only when Staff has checked CI itself and confirms
 * the same commit, so a passing review never stands in for a passing CI.
 */

const SHA = /^[0-9a-f]{7,40}$/;
const sameCommit = (a: string, b: string) => a.startsWith(b) || b.startsWith(a);

export interface DeliveryReport {
  assignmentId: string;
  attempt: number;
  prUrl: string;
  headSha: string;
  /** DONE: the Copilot loop ran clean. SKIPPED: it did not run, and the review mode allows that. */
  copilotStatus: 'DONE' | 'SKIPPED';
  copilotSummary: string;
  ciConclusion: 'success';
  ciSummary: string;
}

export async function reportDelivery(ctx: Ctx, agent: Agent, input: DeliveryReport) {
  const headSha = input.headSha.toLowerCase();
  if (!SHA.test(headSha)) throw invalid('head_sha must be the hex commit id of the PR head.');
  for (const text of [input.copilotSummary, input.ciSummary]) assertNoSecrets(text);
  return tx(ctx, async (conn) => {
    const a = await requireAttempt(conn, ctx, agent, input.assignmentId, input.attempt);
    if (a.kind !== 'implement') throw invalid('Only the implementing Senior reports delivery.');
    const job = await lockJob(conn, a.job_id);
    if (job.status !== 'delivering') throw conflict(`Job ${job.id} is ${job.status}. Delivery starts after the review accepts.`);
    // The Client decides whether the Copilot loop may be skipped. A Senior cannot decide it for them.
    if (input.copilotStatus === 'SKIPPED' && (await reviewMode(conn)) === 'copilot') {
      throw conflict('The Client requires the Copilot review loop. Run it, or raise a blocker if Copilot does not answer: the Client can change the review mode to CI only, and then you report SKIPPED.');
    }
    const id = newId('dlv');
    await exec(
      conn,
      `INSERT INTO deliveries (id, job_id, assignment_id, attempt_number, reported_by, pr_url, head_sha, copilot_status, copilot_summary, ci_summary, reported_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, job.id, a.id, input.attempt, agent.id, input.prUrl, headSha, input.copilotStatus, input.copilotSummary, input.ciSummary, ctx.clock.now()],
    );
    await systemMessage(
      conn,
      ctx,
      job.id,
      agent.id,
      'progress',
      `Delivery reported for ${input.prUrl} at ${headSha}.\nCopilot loop: ${input.copilotStatus === 'SKIPPED' ? 'skipped' : 'clean'}. ${input.copilotSummary}\nCI: ${input.ciConclusion}. ${input.ciSummary}`,
    );
    await emit(conn, ctx, { type: 'delivery.reported', jobId: job.id, actor: agent.id, targets: [job.staff_agent_id], payload: { delivery_id: id, pr_url: input.prUrl, head_sha: headSha } });
    return { delivery_id: id, next: 'Keep waiting. Staff checks CI on this commit and confirms, or tells you what is still wrong.' };
  });
}

export async function confirmDelivery(ctx: Ctx, agent: Agent, input: { jobId: string; headSha: string; ciConclusion: 'success'; evidence: string; openObjectionsNote?: string }) {
  const headSha = input.headSha.toLowerCase();
  if (!SHA.test(headSha)) throw invalid('head_sha must be the hex commit id you checked.');
  assertNoSecrets(input.evidence, input.openObjectionsNote);
  return tx(ctx, async (conn) => {
    const job = await lockJob(conn, input.jobId);
    requireStaffOf(agent, job);
    if (job.status !== 'delivering') throw conflict(`Job ${job.id} is ${job.status}, not delivering.`);
    const d = await queryOne(conn, `SELECT * FROM deliveries WHERE job_id = ? AND confirmed_at IS NULL ORDER BY reported_at DESC LIMIT 1 FOR UPDATE`, [job.id]);
    if (!d) throw conflict('The Senior has not reported delivery yet.');
    if (!sameCommit(d.head_sha, headSha)) {
      throw conflict(`You checked ${headSha}, but the Senior reported ${d.head_sha}. Check CI on the reported head commit, or ask the Senior to report the new head.`);
    }
    // An objection nobody answered should not disappear with the job. Staff answers it, or says on the record why not.
    const open = await openObjections(conn, job.id);
    const note = input.openObjectionsNote?.trim();
    if (open.length && !note) {
      throw conflict(`Open objections on this job: messages ${open.map((o) => o.id).join(', ')}. Answer each on its thread (in_reply_to), or pass open_objections_note saying why they need no answer.`);
    }
    await exec(conn, `UPDATE deliveries SET confirmed_by = ?, confirmed_at = ?, confirmation = ? WHERE id = ?`, [agent.id, ctx.clock.now(), input.evidence, d.id]);
    await closeAssignments(conn, ctx, job.id, 'accepted', 'implement');
    const unanswered = open.length ? ` Unanswered objections ${open.map((o) => o.id).join(', ')}: ${note}` : '';
    await systemMessage(conn, ctx, job.id, agent.id, 'decision', `Delivery confirmed at ${d.head_sha}: CI ${input.ciConclusion}. ${input.evidence}${unanswered}`);
    await setStatus(conn, ctx, job, 'done', agent.id, { delivery_id: d.id });
    await emit(conn, ctx, { type: 'delivery.confirmed', jobId: job.id, actor: agent.id, targets: [d.reported_by], payload: { delivery_id: d.id, head_sha: d.head_sha } });
    return { job_status: 'done' };
  });
}

/**
 * Client: marks a job done from any open state, for example when the PR is merged and the Senior stopped before
 * reporting, or the work was finished by hand. It is the Client's decision, so the job notes that no delivery was reported.
 * Open assignments are closed and open blockers resolved, so nothing keeps waiting on a finished job.
 */
export async function markDone(ctx: Ctx, jobId: string, reason: string) {
  if (!reason.trim()) throw invalid('Say why the job is done, for example: PR merged.');
  assertNoSecrets(reason);
  return tx(ctx, async (conn) => {
    const job = await lockJob(conn, jobId);
    if (CLOSED.includes(job.status)) throw conflict(`Job ${job.id} is already ${job.status}.`);
    const open = await query(conn, `SELECT linear_identifier, status FROM jobs WHERE parent_job_id = ? AND status NOT IN ('done', 'cancelled')`, [job.id]);
    if (open.length) throw conflict(`Subjobs are still open: ${open.map((c) => `${c.linear_identifier} is ${c.status}`).join('; ')}. Mark them done or cancel them first.`);
    const holders = (await query(conn, `SELECT DISTINCT owner_agent_id FROM assignments WHERE job_id = ? AND status = 'held'`, [job.id])).map((r) => r.owner_agent_id as string);
    await closeAssignments(conn, ctx, job.id, 'accepted');
    await exec(conn, `UPDATE blockers SET resolved_at = ?, resolved_by = ?, resolution = ? WHERE job_id = ? AND resolved_at IS NULL AND dismissed_at IS NULL`, [ctx.clock.now(), CLIENT, `Job marked done: ${reason}`, job.id]);
    await systemMessage(conn, ctx, job.id, CLIENT, 'decision', `The Client marked the job done without a delivery report: ${reason}`);
    await setStatus(conn, ctx, job, 'done', CLIENT, { reason });
    await emit(conn, ctx, { type: 'job.marked_done', jobId: job.id, actor: CLIENT, targets: [job.staff_agent_id, ...holders].filter(Boolean), payload: { reason } });
    return { job_id: job.id, status: 'done' };
  });
}
