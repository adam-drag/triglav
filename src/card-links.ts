import type { Conn } from './db.ts';
import { query, queryOne } from './db.ts';

/**
 * The card a job was started from, or null for a job that no card started. A job can have several requests (a retry, or a
 * request that takes the job over), so each request of the job is tried, newest first. For each one, a retried request is
 * followed back through job_requests.retry_of, and the first request with a card start recorded (initiative_card_starts)
 * gives the card.
 */
export async function cardOfJob(conn: Conn, jobId: string): Promise<{ initiative_id: string; card_key: string } | null> {
  const reqs = await query(conn, 'SELECT id FROM job_requests WHERE job_id = ? ORDER BY created_at DESC', [jobId]);
  for (const r of reqs) {
    let id: string | null = String(r.id);
    for (let hops = 0; id && hops < 20; hops++) {
      const start = await queryOne(conn, 'SELECT initiative_id, card_key FROM initiative_card_starts WHERE request_id = ? ORDER BY started_at DESC LIMIT 1', [id]);
      if (start) return { initiative_id: String(start.initiative_id), card_key: String(start.card_key) };
      const row: { retry_of: string | null } | null | undefined = await queryOne(conn, 'SELECT retry_of FROM job_requests WHERE id = ?', [id]);
      id = row?.retry_of ? String(row.retry_of) : null;
    }
  }
  return null;
}
