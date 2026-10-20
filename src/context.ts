import { EventEmitter } from 'node:events';
import type { Pool, PoolConnection } from 'mysql2/promise';
import { withTx } from './db.ts';
import type { Clock } from './lib.ts';
import type { LinearSource } from './linear.ts';

/** Fixed policy values. They are constants until a real need for configuration appears. */
export const POLICY = {
  questionWindowDefaultSec: 180,
  questionWindowMinSec: 60,
  questionWindowMaxSec: 300,
  leaseSec: 30 * 60,
  spawnTicketSec: 30 * 60,
  presenceActiveSec: 2 * 60,
  presenceOfflineSec: 15 * 60,
  // A claude-code session inactive this long is not coming back: flagUnavailableStaff has long since reassigned its
  // job (presenceOfflineSec), and it is well past the longest legitimate silent wait (waitMaxSec). Past this point
  // reapAbandonedSessions (scheduler) queues the host runner to stop its process, so it stops holding host memory.
  // Seen 2026-10-19: sessions that lost their MCP connection (or hit an API error) sat idle for days uncollected.
  reapAgentSessionSec: 2 * 60 * 60,
  // A resumed or switched session's first orchestrator call can be several seconds away (claude --bg starts the first
  // turn before MCP servers connect: 3.5 to 13.7 s measured, AGENTS.md), so a successful resume/switch gets this much
  // grace before reapAbandonedSessions reconsiders it, instead of looking exactly as stale as it did the instant
  // before the Client asked for it back (STALE_FOR_REAP_SQL, src/agents.ts; not flagUnavailableStaff or presence,
  // which read agent_sessions directly and must still show the truth while the session has not actually called home).
  reconnectGraceSec: 5 * 60,
  // A reap_session launch that itself failed (a busy fork, an unverifiable lineage, a listing read failure) gets this
  // long before reapAbandonedSessions tries the same agent again, so a persistent failure is not retried on every
  // scheduler tick (Copilot review on PR 37, 2026-10-19: unbounded retries were growing the launches table and
  // re-invoking the CLI every few seconds).
  reapRetryCooldownSec: 10 * 60,
  // A finished job's worktree is removed by the runner (src/worktrees.ts). One it kept (unpushed or uncommitted work)
  // is checked again this often. At most this many removals wait at once, so a backlog does not delay resumes.
  worktreeReapRetrySec: 6 * 60 * 60,
  maxQueuedWorktreeReaps: 5,
  // A picked reap_worktree with no report is failed after this (the runner's checks and removal can take ~16 min).
  worktreeReapLostSec: 20 * 60,
  // No new Senior while the runner's last report (fresher than hostDiskFreshSec) shows less free disk than this.
  minFreeDiskBytes: 15 * 1024 ** 3,
  hostDiskFreshSec: 15 * 60,
  // Every return of a wait is a model turn that re-reads the whole context (300k to 700k tokens for a Staff), so waits
  // are as long as the CLI timeouts allow (Claude Code 300 s, Codex 330 s, set in the CLI setup).
  waitDefaultSec: 240,
  // Staff caches its context for an hour, so it can wait 50 minutes and still wake on a warm cache. This needs the
  // Claude Code MCP timeout at 3500000 ms (verified 2026-10-09: a 3000 s wait returned cleanly). Seniors cache for
  // only 5 minutes, so they keep waitDefaultSec. A session whose client cuts a long wait is capped (wait_cap_sec).
  staffWaitSec: 3000,
  waitMaxSec: 3300,
  maxRepliesPerThread: 5,
  maxReviewRounds: 3,
  maxFailedAttempts: 3,
  maxHeldPerParent: 3,
  maxHeldOverall: 10,
  linearRefreshSec: 5 * 60,
  // A Senior's start prompt lists the job's decisions already made (jobs.ts decisionsBlock). Each decision's text is cut
  // to the first number and the whole block to the second; what does not fit is counted and left to get_job.
  decisionTextMaxChars: 600,
  decisionsBlockMaxChars: 4000,
} as const;

export interface Ctx {
  pool: Pool;
  clock: Clock;
  linear: LinearSource | null;
  bus: EventEmitter;
  baseUrl: string;
}

export function createCtx(opts: { pool: Pool; clock: Clock; linear: LinearSource | null; baseUrl: string }): Ctx {
  const bus = new EventEmitter();
  bus.setMaxListeners(0);
  return { ...opts, bus };
}

/** Runs fn in a transaction and wakes waiters after commit. */
export async function tx<T>(ctx: Ctx, fn: (conn: PoolConnection) => Promise<T>): Promise<T> {
  const result = await withTx(ctx.pool, fn);
  ctx.bus.emit('change');
  return result;
}
