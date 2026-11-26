import type { Conn } from './db.ts';
import { query, queryOne } from './db.ts';

/**
 * The card start a job was started from, or null for a job that no card started. A job can have several requests (a retry, or a
 * request that takes the job over), so each request of the job is tried, newest first. For each one, a retried request is
 * followed back through job_requests.retry_of, and the first request with a card start recorded (initiative_card_starts)
 * gives the start.
 */
export async function cardStartOfJob(conn: Conn, jobId: string): Promise<{ initiative_id: string; card_key: string; started_from_version: number } | null> {
  const reqs = await query(conn, 'SELECT id FROM job_requests WHERE job_id = ? ORDER BY created_at DESC', [jobId]);
  for (const r of reqs) {
    let id: string | null = String(r.id);
    for (let hops = 0; id && hops < 20; hops++) {
      const start = await queryOne(conn, 'SELECT initiative_id, card_key, started_from_version FROM initiative_card_starts WHERE request_id = ? ORDER BY started_at DESC LIMIT 1', [id]);
      if (start) return { initiative_id: String(start.initiative_id), card_key: String(start.card_key), started_from_version: Number(start.started_from_version) };
      const row: { retry_of: string | null } | null | undefined = await queryOne(conn, 'SELECT retry_of FROM job_requests WHERE id = ?', [id]);
      id = row?.retry_of ? String(row.retry_of) : null;
    }
  }
  return null;
}

/**
 * The card start of a job, or of its parent when the job has none of its own. A subjob of a split is inserted without a request
 * (splits.ts, insertJob), so the start of the card its parent was started from is the one that counts. Used where the design of
 * the card is read (the design lens); the wakes and list_blockers keep cardStartOfJob, as they always did.
 */
export async function cardStartOfJobOrParent(conn: Conn, jobId: string): Promise<{ initiative_id: string; card_key: string; started_from_version: number } | null> {
  const own = await cardStartOfJob(conn, jobId);
  if (own) return own;
  const job = await queryOne(conn, 'SELECT parent_job_id FROM jobs WHERE id = ?', [jobId]);
  return job?.parent_job_id ? cardStartOfJob(conn, String(job.parent_job_id)) : null;
}

/** The card a job was started from, or null for a job that no card started (see cardStartOfJob). */
export async function cardOfJob(conn: Conn, jobId: string): Promise<{ initiative_id: string; card_key: string } | null> {
  const start = await cardStartOfJob(conn, jobId);
  return start ? { initiative_id: start.initiative_id, card_key: start.card_key } : null;
}

/**
 * The jobs of an initiative: every job of a request chain that a card start of the initiative began (a retry follows retry_of back to
 * its start), and the subjobs of those jobs (a split's subjobs have no request of their own). The same chain as
 * openBlockersOfInitiative (blockers.ts), plus the subjobs, for the digest.
 */
export async function jobIdsOfInitiative(conn: Conn, initiativeId: string): Promise<string[]> {
  const jobs = (
    await query(
      conn,
      `WITH RECURSIVE chain (id) AS (
         SELECT request_id FROM initiative_card_starts WHERE initiative_id = ?
         UNION
         SELECT r.id FROM job_requests r JOIN chain c ON r.retry_of = c.id
       )
       SELECT DISTINCT r.job_id FROM job_requests r JOIN chain c ON c.id = r.id`,
      [initiativeId],
    )
  ).map((r) => String(r.job_id));
  if (jobs.length === 0) return [];
  const subjobs = (await query(conn, `SELECT id FROM jobs WHERE parent_job_id IN (${jobs.map(() => '?').join(', ')})`, jobs)).map((r) => String(r.id));
  return [...new Set([...jobs, ...subjobs])];
}
