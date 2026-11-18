import type { Conn } from './db.ts';
import { queryOne } from './db.ts';

/**
 * The card a job was started from, or null for a job that no card started. The job is found through its request, and a
 * retried request is followed back to the request the card's start recorded (job_requests.retry_of).
 */
export async function cardOfJob(conn: Conn, jobId: string): Promise<{ initiative_id: string; card_key: string } | null> {
  let req = await queryOne(conn, 'SELECT id, retry_of FROM job_requests WHERE job_id = ? ORDER BY created_at DESC LIMIT 1', [jobId]);
  for (let hops = 0; req && req.retry_of && hops < 20; hops++) req = await queryOne(conn, 'SELECT id, retry_of FROM job_requests WHERE id = ?', [req.retry_of]);
  if (!req) return null;
  const start = await queryOne(conn, 'SELECT initiative_id, card_key FROM initiative_card_starts WHERE request_id = ? ORDER BY started_at DESC LIMIT 1', [req.id]);
  return start ? { initiative_id: String(start.initiative_id), card_key: String(start.card_key) } : null;
}
