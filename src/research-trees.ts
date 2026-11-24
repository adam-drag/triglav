/**
 * Which commit each job of a research run is read at (docs/plans/researcher-access.md, phase 2). The runner makes a
 * read-only tree of that commit for each job (scripts/research-trees.ts); this module only decides the commit, from the
 * database, so the runner never picks a commit or a repository by itself.
 *
 * A job's code is the commit of its newest delivery or review package, whichever is later. A job with neither has no
 * head: its tree is origin/<base branch> as the runner's checkout has it, and the runner does not fetch.
 */
import { query, queryOne, type Conn } from './db.ts';

/** A run reads at most this many jobs' trees. Items of later jobs are still handled, from the board text only. */
export const MAX_TREE_JOBS = 4;

export type HeadOf = { head_sha: string | null; pr_url: string | null; head_source: 'delivery' | 'review' | null };

/** The commit a job's code is at: the newest of its delivery head and its newest review package head. */
export async function headOfJob(conn: Conn, jobId: string): Promise<HeadOf> {
  const delivery = await queryOne<{ head_sha: string; pr_url: string | null; reported_at: Date }>(
    conn,
    'SELECT head_sha, pr_url, reported_at FROM deliveries WHERE job_id = ? AND head_sha IS NOT NULL ORDER BY reported_at DESC LIMIT 1',
    [jobId],
  );
  const review = await queryOne<{ head_sha: string; submitted_at: Date }>(
    conn,
    'SELECT head_sha, submitted_at FROM review_packages WHERE job_id = ? AND head_sha IS NOT NULL ORDER BY submitted_at DESC LIMIT 1',
    [jobId],
  );
  const pr_url = delivery?.pr_url ?? null;
  if (delivery && (!review || new Date(delivery.reported_at) >= new Date(review.submitted_at))) return { head_sha: delivery.head_sha, pr_url, head_source: 'delivery' };
  if (review) return { head_sha: review.head_sha, pr_url, head_source: 'review' };
  return { head_sha: null, pr_url: null, head_source: null };
}

/** One tree the runner prepares for a run. `sha` is null when the job has no head: the runner then uses origin/<base>. */
export type ResearchTree = {
  job: string;
  repo: string;
  base: string;
  sha: string | null;
  source: 'delivery' | 'review' | 'base' | 'limit';
  /** A review round is among the run's items for this job: the runner also writes the review diff as a file. */
  diff: boolean;
};

/** The persona and the trees of a run, in the order its jobs first appear in the run's items. */
export async function treesOfRun(conn: Conn, runId: string): Promise<{ persona: string | null; trees: ResearchTree[] }> {
  const run = await queryOne<{ persona_id: string }>(conn, 'SELECT persona_id FROM research_runs WHERE id = ?', [runId]);
  const jobs = await query<{ job_id: string; has_review: number | string }>(
    conn,
    `SELECT job_id, MAX(kind = 'review') AS has_review FROM research_inbox
     WHERE run_id = ? AND job_id IS NOT NULL GROUP BY job_id ORDER BY MIN(created_at), job_id`,
    [runId],
  );
  const trees: ResearchTree[] = [];
  for (const [n, row] of jobs.entries()) {
    const job = await queryOne<{ linear_identifier: string; repo_path: string; base_branch: string }>(
      conn,
      'SELECT linear_identifier, repo_path, base_branch FROM jobs WHERE id = ?',
      [row.job_id],
    );
    if (!job) continue;
    const name = job.linear_identifier || row.job_id;
    if (n >= MAX_TREE_JOBS) {
      trees.push({ job: name, repo: '', base: '', sha: null, source: 'limit', diff: false });
      continue;
    }
    const head = await headOfJob(conn, row.job_id);
    trees.push({
      job: name,
      repo: job.repo_path,
      base: job.base_branch,
      sha: head.head_sha,
      source: head.head_source ?? 'base',
      diff: Boolean(Number(row.has_review)) && head.head_sha !== null,
    });
  }
  return { persona: run?.persona_id ?? null, trees };
}
