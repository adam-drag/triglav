/**
 * The host runner's report of the Claude Code background sessions that `claude agents --json` lists as busy
 * (scripts/runner.ts, every 60 s). It sets `agent_sessions.busy_at`, which presenceOf counts as working for
 * POLICY.busySessionSec: a long tool call or model turn writes no transcript line until it ends (seen 2026-10-29, a
 * Bash call of over 9 minutes). No agent event and no wake: a report changes presence only.
 */
import { z } from 'zod';
import { presenceOf } from './agents.ts';
import type { Ctx } from './context.ts';
import { withTx } from './db.ts';

export const MAX_BUSY_SESSIONS = 200;
export const BUSY_STATUSES = ['busy', 'idle'] as const;
export const BUSY_STATES = ['working', 'blocked', 'idle', 'waiting', 'done'] as const;
/** Fits 200 entries with room to spare; the route refuses a larger body before parsing. */
export const BUSY_BODY_LIMIT = 64 * 1024;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// The values `claude agents --json` printed on 2026-10-29. The runner sends null for any other, so the server never
// gets free text from that output and a new value in a later Claude Code does not make the whole report fail.
const STATUS = z.enum(BUSY_STATUSES).nullable();
const STATE = z.enum(BUSY_STATES).nullable();

export const busyReportSchema = z
  .object({
    sessions: z
      .array(z.object({ sessionId: z.string().max(36).regex(UUID), status: STATUS, state: STATE }).strict())
      .max(MAX_BUSY_SESSIONS),
  })
  .strict();

export type BusyReport = z.infer<typeof busyReportSchema>;

/**
 * Sets busy_at on open sessions whose transcript_session is reported busy. Never creates a row. A session reported
 * idle, or with state blocked (the lost-connection case in AGENTS.md), is not busy. Seniors are left out: a subagent
 * shares its parent's process, so the parent's busy state says nothing about the Senior. Tells open dashboards (one
 * `presence` message on /api/stream) only when some agent's presence changed.
 */
export async function recordBusySessions(ctx: Ctx, report: BusyReport): Promise<{ updated: number }> {
  const ids = [...new Set(report.sessions.filter((s) => s.status === 'busy' && s.state !== 'blocked').map((s) => s.sessionId))];
  if (!ids.length) return { updated: 0 };
  const now = ctx.clock.now();
  const { updated, changed } = await withTx(ctx.pool, async (conn) => {
    const [rows] = await conn.query<any[]>(
      `SELECT s.id, s.last_seen_at, s.waiting_until, s.ended_at, s.transcript_at, s.busy_at FROM agent_sessions s JOIN agents a ON a.id = s.agent_id
       WHERE s.ended_at IS NULL AND s.transcript_session IN (?) AND a.runtime = 'claude-code' AND a.role <> 'senior' FOR UPDATE`,
      [ids],
    );
    if (!rows.length) return { updated: 0, changed: false };
    // Presence also moves by the clock between reports (active turns working once the last call ages out), so compare
    // with what the previous report left as well as with what this one changes.
    const at = (t: Date): Ctx => ({ ...ctx, clock: { ...ctx.clock, now: () => t } });
    const changed = rows.some((r) => {
      const after = presenceOf(ctx, { ...r, busy_at: now });
      return after !== presenceOf(ctx, r) || (r.busy_at && after !== presenceOf(at(r.busy_at), r));
    });
    await conn.query(`UPDATE agent_sessions SET busy_at = ? WHERE id IN (?)`, [now, rows.map((r) => r.id)]);
    return { updated: rows.length, changed };
  });
  // Not 'change': that wakes every waiting agent's event check. 'presence' only tells open dashboards to refetch.
  if (changed) ctx.bus.emit('presence');
  return { updated };
}
