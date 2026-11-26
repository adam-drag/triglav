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
