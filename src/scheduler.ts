import { LIVE_SESSION_SQL, liveSessionParams, NO_LIVE_SIBLING_SQL, STALE_FOR_REAP_SQL, staleForReapParams } from './agents.ts';
import { timeoutReviewRuns } from './code-review.ts';
import { dispatchResearch } from './research.ts';
import { raiseBlockerTx, resolveBlockerTx } from './blockers.ts';
import { dueQuestions, reconcileQuestion } from './board.ts';
import { POLICY, tx, type Ctx } from './context.ts';
import { exec, query, queryOne } from './db.ts';
import { emit } from './events.ts';
import { failUnregisteredStarts } from './job-requests.ts';
import { lockJob, refreshFromLinear } from './jobs.ts';
import { addSeconds, newId } from './lib.ts';
import { expireStaleLaunches, ingestTelemetry } from './telemetry.ts';

/** One pass of every time-based rule. Safe to run concurrently with requests and to repeat. */
export async function tick(ctx: Ctx): Promise<void> {
  const now = ctx.clock.now();
  for (const threadId of await dueQuestions(ctx.pool, now)) await reconcileQuestion(ctx, threadId);
  await expireLeases(ctx);
  await flagUnavailableStaff(ctx);
  await clearReturnedStaff(ctx);
  await reapAbandonedSessions(ctx);
  await dispatchResearch(ctx);
  await expireStaleLaunches(ctx);
  await timeoutReviewRuns(ctx);
  await failUnregisteredStarts(ctx);
}

async function expireLeases(ctx: Ctx) {
  const now = ctx.clock.now();
  const expired = await query(ctx.pool, `SELECT id FROM assignments WHERE status = 'held' AND lease_expires_at <= ?`, [now]);
  for (const { id } of expired) {
    await tx(ctx, async (conn) => {
      const a = await queryOne(conn, `SELECT * FROM assignments WHERE id = ? FOR UPDATE`, [id]);
      if (!a || a.status !== 'held' || a.lease_expires_at > now) return;
      const failed = Number(a.failed_attempts) + 1;
      await exec(conn, `UPDATE attempts SET ended_at = ?, outcome = 'lease_expired' WHERE assignment_id = ? AND number = ?`, [now, a.id, a.current_attempt]);
      await exec(conn, `UPDATE assignments SET status = 'open', owner_agent_id = NULL, lease_expires_at = NULL, failed_attempts = ? WHERE id = ?`, [failed, a.id]);
      const job = await queryOne(conn, `SELECT * FROM jobs WHERE id = ?`, [a.job_id]);
      await emit(conn, ctx, {
        type: 'assignment.orphaned',
        jobId: a.job_id,
        actor: 'scheduler',
        targets: [job?.staff_agent_id].filter(Boolean),
        payload: { assignment_id: a.id, attempt: a.current_attempt, previous_owner: a.owner_agent_id, failed_attempts: failed, reason: 'lease_expired' },
      });
      if (failed >= POLICY.maxFailedAttempts && job && !['done', 'cancelled', 'blocked'].includes(job.status)) {
        await raiseBlockerTx(conn, ctx, 'scheduler', {
          jobId: a.job_id,
          kind: 'failed_execution',
          requestedDecision: `${failed} attempts on ${a.id} ended without a result. Decide whether to retry with a different approach, split the job, or stop.`,
          unblockCondition: 'Staff resolves the blocker before issuing another spawn ticket.',
        });
      }
    });
  }
}

/** A Staff agent offline for longer than the offline threshold blocks its open parent jobs. */
async function flagUnavailableStaff(ctx: Ctx) {
  const cutoff = addSeconds(ctx.clock.now(), -POLICY.presenceOfflineSec);
  const rows = await query(
    ctx.pool,
    `SELECT j.id, j.staff_agent_id FROM jobs j
     WHERE j.parent_job_id IS NULL AND j.status NOT IN ('done', 'cancelled') AND j.staff_agent_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM blockers b WHERE b.job_id = j.id AND b.kind = 'unavailable_owner' AND b.resolved_at IS NULL)
       AND NOT EXISTS (SELECT 1 FROM agent_sessions s WHERE s.agent_id = j.staff_agent_id AND s.ended_at IS NULL
                         AND (s.last_seen_at > ? OR s.waiting_until > ? OR s.transcript_at > ?))`,
    [cutoff, ctx.clock.now(), cutoff],
  );
  for (const row of rows) {
    await tx(ctx, async (conn) => {
      await raiseBlockerTx(conn, ctx, 'scheduler', {
        jobId: row.id,
        kind: 'unavailable_owner',
        requestedDecision: `Staff agent ${row.staff_agent_id} is offline. Assign a new Staff agent to this job; it receives a handover summary.`,
        unblockCondition: 'The Staff agent comes back online, or the Client starts a new Staff agent or reassigns the job to an active one.',
      });
    });
  }
}

/**
 * Clears unavailable_owner blockers whose Staff agent is calling the orchestrator again, or is busy off the board: its
 * transcript moved within the "working" window of `presenceOf`. The flag above counts transcripts too, so without this a
 * Staff that is working in a long tool call would show as live and keep the blocker.
 */
async function clearReturnedStaff(ctx: Ctx) {
  const rows = await query(
    ctx.pool,
    `SELECT b.id FROM blockers b JOIN jobs j ON j.id = b.job_id
     WHERE b.kind = 'unavailable_owner' AND b.resolved_at IS NULL
       AND EXISTS (SELECT 1 FROM agent_sessions s WHERE s.agent_id = j.staff_agent_id AND (${LIVE_SESSION_SQL} OR (s.ended_at IS NULL AND s.transcript_at > ?)))`,
    [...liveSessionParams(ctx), addSeconds(ctx.clock.now(), -(POLICY.presenceActiveSec + 60))],
  );
  for (const { id } of rows) {
    await tx(ctx, async (conn) => {
      const b = await queryOne(conn, `SELECT * FROM blockers WHERE id = ? FOR UPDATE`, [id]);
      if (!b || b.resolved_at) return;
      const job = await lockJob(conn, b.job_id);
      await resolveBlockerTx(conn, ctx, 'scheduler', b, job, `Staff agent ${job.staff_agent_id} is back online.`);
    });
  }
}

/**
 * A claude-code session inactive past `reapAgentSessionSec` is not coming back on its own (a lost MCP connection or an
 * API error both leave it alive and idle forever, never retrying: see AGENTS.md). `flagUnavailableStaff` has long since
 * moved its job on; this only reclaims the host process. One launch per agent at a time (`requestResume`/`requestSwitch`
 * use the same guard, and the same `tx()` serializes against them: `write_lock` means two transactions are never both
 * inside their critical section, so a resume racing this insert always loses or wins outright, never both): `finishLaunch`
 * closes the session (`ended_at`) once the runner confirms the stop.
 */
async function reapAbandonedSessions(ctx: Ctx) {
  const candidates = await query(
    ctx.pool,
    `SELECT DISTINCT s.agent_id FROM agent_sessions s JOIN agents a ON a.id = s.agent_id
     WHERE s.ended_at IS NULL AND a.runtime = 'claude-code' AND s.transcript_session IS NOT NULL AND s.transcript_cwd IS NOT NULL
       AND ${STALE_FOR_REAP_SQL} AND ${NO_LIVE_SIBLING_SQL}
       AND NOT EXISTS (SELECT 1 FROM launches l WHERE l.agent_id = s.agent_id AND l.finished_at IS NULL)`,
    [...staleForReapParams(ctx), ...staleForReapParams(ctx)],
  );
  for (const { agent_id } of candidates) {
    await tx(ctx, async (conn) => {
      const now = ctx.clock.now();
      // The bulk SELECT above can be stale by the time this row is reached: recheck everything inside the lock.
      const s = await queryOne(
        conn,
        `SELECT s.transcript_session, s.transcript_cwd FROM agent_sessions s
         WHERE s.agent_id = ? AND s.ended_at IS NULL AND ${STALE_FOR_REAP_SQL} AND ${NO_LIVE_SIBLING_SQL}`,
        [agent_id, ...staleForReapParams(ctx), ...staleForReapParams(ctx)],
      );
      const pending = await queryOne(conn, `SELECT id FROM launches WHERE agent_id = ? AND finished_at IS NULL`, [agent_id]);
      if (!s || pending) return;
      await exec(
        conn,
        `INSERT INTO launches (id, agent_id, kind, session_id, cwd, runtime, requested_at) VALUES (?, ?, 'reap_session', ?, ?, 'claude-code', ?)`,
        [newId('lch'), agent_id, s.transcript_session, s.transcript_cwd, now],
      );
    });
  }
}

/** Runs one task on an interval, never overlapping itself. */
function every(intervalMs: number, name: string, task: () => Promise<void>): () => void {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await task();
    } catch (error) {
      console.error(`${name} failed`, error);
    } finally {
      running = false;
    }
  }, intervalMs);
  return () => clearInterval(timer);
}

/** Deadlines and leases tick every second. Linear refresh runs on its own, so a slow Linear never delays them. */
export function startScheduler(ctx: Ctx, intervalMs = 1000, telemetry: { claude?: string; codex?: string } = {}): () => void {
  const stops = [every(intervalMs, 'scheduler tick', () => tick(ctx)), every(60_000, 'linear refresh', () => refreshFromLinear(ctx))];
  if (telemetry.claude || telemetry.codex) stops.push(every(60_000, 'telemetry', () => ingestTelemetry(ctx, telemetry)));
  return () => stops.forEach((stop) => stop());
}
