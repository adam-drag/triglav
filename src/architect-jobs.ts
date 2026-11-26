import type { Conn } from './db.ts';
import { query, queryOne } from './db.ts';
import { cardOfJob } from './card-links.ts';
import { forbidden } from './lib.ts';
import { getJob } from './jobs.ts';
import { reviewView } from './code-review.ts';

/**
 * The Architect's view of the jobs of its own initiative (get_job, get_code_review in src/architect.ts): what a Senior is
 * doing, what was delivered, what the local review found. A job belongs to the initiative when a card of it started the job
 * or its parent (cardOfJob, the rule the wake and list_blockers use). An unknown job and another initiative's job get the
 * same refusal, so the answer does not tell which jobs exist.
 */
const NOT_YOURS = 'That job is not a job of your initiative.';
/** Text fields of a job are cut here: the full text is on its threads (read_thread). */
const TEXT_MAX = 4000;
const cut = (v: unknown) => (v === null || v === undefined ? null : String(v).slice(0, TEXT_MAX));

export async function assertJobOfInitiative(conn: Conn, initiativeId: string, jobId: string): Promise<void> {
  const job = await queryOne(conn, 'SELECT parent_job_id FROM jobs WHERE id = ?', [jobId]);
  if (!job) throw forbidden(NOT_YOURS);
  for (const id of [jobId, job.parent_job_id ? String(job.parent_job_id) : null]) {
    const link = id ? await cardOfJob(conn, id) : null;
    if (link && link.initiative_id === initiativeId) return;
  }
  throw forbidden(NOT_YOURS);
}

/** One job: status, plan and criteria, subjobs, Senior progress, deliveries, review packages and local code reviews, blockers, threads. */
export async function architectJobView(conn: Conn, initiativeId: string, jobId: string) {
  await assertJobOfInitiative(conn, initiativeId, jobId);
  const full = await getJob(conn, jobId);
  const j = full.job as Record<string, unknown>;
  const codeReviews = await query(conn, 'SELECT id, round_no, status, verdict, base_sha, head_sha, created_at, finished_at FROM code_reviews WHERE job_id = ? ORDER BY created_at', [jobId]);
  return {
    job: { id: j.id, identifier: j.linear_identifier, title: j.title, status: j.status, kind: j.kind, parent_job_id: j.parent_job_id, repo_path: j.repo_path, base_branch: j.base_branch, required: j.required, control: j.control, acceptance_criteria: cut(j.acceptance_criteria), plan: cut(j.plan) },
    subjobs: full.subjobs,
    depends_on: full.depends_on,
    assignments: full.assignments.map((a) => ({ id: a.id, kind: a.kind, status: a.status, attempt: a.current_attempt, last_progress: cut(a.last_progress) })),
    deliveries: full.deliveries.map((d) => ({ id: d.id, pr_url: d.pr_url, head_sha: d.head_sha, copilot_summary: cut(d.copilot_summary), ci_summary: cut(d.ci_summary), reported_at: d.reported_at, confirmed_at: d.confirmed_at })),
    review_packages: full.reviews.map((p) => {
      const r = p as Record<string, unknown>;
      return { id: r.id, round: r.round, summary: cut(r.summary), submitted_at: r.submitted_at, outcome: (r.verdict as { outcome?: string } | null)?.outcome ?? null };
    }),
    code_reviews: codeReviews,
    blockers: full.blockers.map((b) => ({ id: b.id, kind: b.kind, requested_decision: cut(b.requested_decision), recommendation: cut(b.recommendation), raised_by: b.raised_by, created_at: b.created_at, resolved_at: b.resolved_at, resolution: cut(b.resolution) })),
    threads: full.threads,
  };
}

/** One local code review of a job of the initiative, as a Senior or Staff of the job sees it. */
export async function architectCodeReview(conn: Conn, initiativeId: string, reviewId: string) {
  const review = await queryOne(conn, 'SELECT * FROM code_reviews WHERE id = ?', [reviewId]);
  if (!review) throw forbidden('That code review is not on a job of your initiative.');
  try {
    await assertJobOfInitiative(conn, initiativeId, String(review.job_id));
  } catch {
    throw forbidden('That code review is not on a job of your initiative.');
  }
  return reviewView(conn, review);
}
