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
  maxHeldPerParent: 2,
  maxHeldOverall: 10,
  linearRefreshSec: 5 * 60,
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
