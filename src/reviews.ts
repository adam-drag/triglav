import type { Agent } from './agents.ts';
import { raiseBlockerTx } from './blockers.ts';
import { systemMessage } from './board.ts';
import { POLICY, tx, type Ctx } from './context.ts';
import { exec, json, parseJson, query, queryOne } from './db.ts';
import { emit } from './events.ts';
import { closeAssignments, lockJob, requireAttempt, setStatus } from './jobs.ts';
import { assertNoSecrets, conflict, forbidden, invalid, newId, notFound } from './lib.ts';
import { gateAt } from './review-gate.ts';

export interface Finding {
  id: string;
  required: boolean;
  text: string;
  evidence?: string;
}

export interface Disposition {
  finding_id: string;
  disposition: 'fixed' | 'disputed' | 'deferred';
  note: string;
}

export async function submitReviewPackage(
  ctx: Ctx,
  agent: Agent,
  input: {
    assignmentId: string;
    attempt: number;
    /** The exact commit the package is about. The local code review gate must pass on it. */
    headSha: string;
    summary: string;
    artifacts: string[];
    validation: string;
    limitations?: string;
    findingDispositions?: Disposition[];
  },
) {
  if (!input.summary.trim() || !input.validation.trim()) throw invalid('A review package needs a summary and the validation you ran with its result.');
  if (!/^[0-9a-f]{40}$/.test(input.headSha ?? '')) throw invalid('head_sha must be the full 40-character lowercase sha of the commit you submit.');
  assertNoSecrets(input.summary, input.validation, input.limitations, ...input.artifacts, ...(input.findingDispositions ?? []).map((d) => d.note));
  return tx(ctx, async (conn) => {
    const a = await requireAttempt(conn, ctx, agent, input.assignmentId, input.attempt);
    if (a.kind !== 'implement') throw invalid('Only implementation assignments submit review packages.');
    const job = await lockJob(conn, a.job_id);
    if (job.status !== 'in_progress') throw conflict(`Job ${job.id} is ${job.status}, not in progress.`);
    if (job.control !== 'continue') throw conflict(`Job ${job.id} is ${job.control === 'pause' ? 'paused' : 'cancelled'}.`);
    // The local code review gate applies in every review mode, also CI only and repositories without Copilot.
    const gate = await gateAt(conn, job.id, input.headSha);
    if (!gate.passes) throw conflict(`Review package refused: the local code review gate does not pass on ${input.headSha.slice(0, 12)}. ${gate.reason}`);
    const previous = await queryOne(
      conn,
      `SELECT p.id, p.round, v.outcome, v.findings FROM review_packages p LEFT JOIN review_verdicts v ON v.package_id = p.id WHERE p.job_id = ? ORDER BY p.round DESC LIMIT 1`,
      [job.id],
    );
    const dispositions = input.findingDispositions ?? [];
    if (previous?.outcome === 'changes') {
      const required = parseJson<Finding[]>(previous.findings).filter((f) => f.required);
      const missing = required.filter((f) => !dispositions.some((d) => d.finding_id === f.id));
      if (missing.length) throw invalid(`Give a disposition for every required finding. Missing: ${missing.map((f) => f.id).join(', ')}.`);
    }
    const round = previous ? Number(previous.round) + 1 : 1;
    const id = newId('pkg');
    await exec(
      conn,
      `INSERT INTO review_packages (id, assignment_id, attempt_number, job_id, round, summary, artifacts, validation, limitations, finding_dispositions, head_sha, gate_review_id, submitted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, a.id, input.attempt, job.id, round, input.summary, json(input.artifacts), input.validation, input.limitations ?? null, json(dispositions), input.headSha, gate.reviewId, ctx.clock.now()],
    );
    await setStatus(conn, ctx, job, 'in_review', agent.id, { package_id: id, round });
    const threadId = await systemMessage(conn, ctx, job.id, agent.id, 'progress', `Review package round ${round} submitted: ${input.summary}\nValidation: ${input.validation}${input.limitations ? `\nLimitations: ${input.limitations}` : ''}`);
    await emit(conn, ctx, { type: 'review.submitted', jobId: job.id, threadId, actor: agent.id, targets: [job.staff_agent_id], payload: { package_id: id, round, head_sha: input.headSha } });
    return { package_id: id, round, head_sha: input.headSha, gate_review_id: gate.reviewId };
  });
}

export async function recordVerdict(ctx: Ctx, agent: Agent, input: { packageId: string; outcome: 'accept' | 'changes'; findings: Finding[] }) {
  assertNoSecrets(...input.findings.flatMap((f) => [f.text, f.evidence]));
  const ids = new Set<string>();
  for (const f of input.findings) {
    if (ids.has(f.id)) throw invalid(`Finding id ${f.id} is used twice.`);
    ids.add(f.id);
    if (f.required && !f.evidence?.trim()) throw invalid(`Required finding ${f.id} needs evidence.`);
  }
  if (input.outcome === 'changes' && !input.findings.some((f) => f.required)) throw invalid('Requesting changes needs at least one required finding.');
  if (input.outcome === 'accept' && input.findings.some((f) => f.required)) throw invalid('An accepted package cannot have required findings.');
  return tx(ctx, async (conn) => {
    const pkg = await queryOne(conn, `SELECT * FROM review_packages WHERE id = ?`, [input.packageId]);
    if (!pkg) throw notFound(`Review package ${input.packageId}`);
    const job = await lockJob(conn, pkg.job_id);
    const reviewer = await queryOne(conn, `SELECT id FROM assignments WHERE job_id = ? AND kind = 'review' AND status = 'held' AND owner_agent_id = ? AND lease_expires_at > ?`, [job.id, agent.id, ctx.clock.now()]);
    const isStaff = agent.role === 'staff' && job.staff_agent_id === agent.id;
    const reviewerAssigned = await queryOne(conn, `SELECT id FROM assignments WHERE job_id = ? AND kind = 'review' AND status = 'held'`, [job.id]);
    if (!(reviewer || (isStaff && !reviewerAssigned))) {
      throw forbidden('Only the assigned reviewer gives the verdict (the owning Staff when no reviewer is assigned). Post other findings as assessments.');
    }
    if (job.status !== 'in_review') throw conflict(`Job ${job.id} is ${job.status}, not in review.`);
    const latest = await queryOne(conn, `SELECT id FROM review_packages WHERE job_id = ? ORDER BY round DESC LIMIT 1`, [job.id]);
    if (latest?.id !== pkg.id) throw conflict('A newer package exists. Review the latest round.');
    const existing = await queryOne(conn, `SELECT id FROM review_verdicts WHERE package_id = ?`, [pkg.id]);
    if (existing) throw conflict('This package already has a verdict.');
    await exec(conn, `INSERT INTO review_verdicts (id, package_id, reviewer, outcome, findings, created_at) VALUES (?, ?, ?, ?, ?, ?)`, [
      newId('vrd'),
      pkg.id,
      agent.id,
      input.outcome,
      json(input.findings),
      ctx.clock.now(),
    ]);
    const lines = input.findings.map((f) => `- [${f.required ? 'required' : 'optional'}] ${f.id}: ${f.text}${f.evidence ? ` (evidence: ${f.evidence})` : ''}`);
    const threadId = await systemMessage(conn, ctx, job.id, agent.id, 'review_finding', `Verdict on round ${pkg.round}: ${input.outcome}\n${lines.join('\n')}`);
    await closeAssignments(conn, ctx, job.id, 'reviewed', 'review');
    const implementer = await queryOne(conn, `SELECT owner_agent_id FROM assignments WHERE id = ?`, [pkg.assignment_id]);
    if (input.outcome === 'accept') {
      // Accepted by review, but not done: the Senior still takes the PR through Copilot and CI (delivery.ts).
      await setStatus(conn, ctx, job, 'delivering', agent.id, { package_id: pkg.id });
    } else if (Number(pkg.round) >= POLICY.maxReviewRounds) {
      await setStatus(conn, ctx, job, 'in_progress', agent.id, { package_id: pkg.id, verdict: 'changes' });
      await raiseBlockerTx(conn, ctx, agent.id, {
        jobId: job.id,
        kind: 'no_convergence',
        requestedDecision: `Review did not converge after ${pkg.round} rounds. Decide whether to accept as is, change scope, or stop.`,
        unblockCondition: 'The Client decides how to proceed.',
      });
    } else {
      await setStatus(conn, ctx, job, 'in_progress', agent.id, { package_id: pkg.id, verdict: 'changes' });
    }
    await emit(conn, ctx, {
      type: 'review.verdict',
      jobId: job.id,
      threadId,
      actor: agent.id,
      targets: [implementer?.owner_agent_id, job.staff_agent_id].filter((t) => t && t !== agent.id),
      payload: { package_id: pkg.id, outcome: input.outcome, round: pkg.round },
    });
    return { job_status: job.status };
  });
}

export async function reviewQueue(ctx: Ctx) {
  return query(ctx.pool, `SELECT p.* FROM review_packages p LEFT JOIN review_verdicts v ON v.package_id = p.id WHERE v.id IS NULL`);
}
