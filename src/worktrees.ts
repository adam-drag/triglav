import { POLICY, tx, type Ctx } from './context.ts';
import { exec, query, queryOne, type Conn } from './db.ts';
import { addSeconds, conflict, newId } from './lib.ts';

/*
 * Every Senior works in its own git worktree, usually with its own node_modules or .venv. Nothing removed them, and on
 * 2026-10-20 they filled the host disk. Triglav records each worktree a Senior names (report_progress,
 * request_code_review) and, once the job is done or cancelled, queues a `reap_worktree` launch. The host runner
 * removes the worktree only if it is a linked worktree with nothing uncommitted, untracked or unpushed
 * (`reapWorktree` in scripts/runner.ts); otherwise it keeps it and says why. The branch stays. A follow-up clones or
 * adds a worktree again from the pushed branch.
 */

/** A worktree a Senior used for a job. Recording it again after it was removed (a reopened job) makes it live again. */
export async function recordWorktree(conn: Conn, ctx: Ctx, jobId: string, path: string) {
  await exec(
    conn,
    `INSERT INTO worktrees (path, job_id, recorded_at) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE removed_at = NULL`,
    [path, jobId, ctx.clock.now()],
  );
}

/**
 * The worktree row `w` can go: its job is finished, no unfinished job recorded the same path, no Senior holds it, no
 * review reads it, and it is not a repository Staff or a researcher works in.
 */
const REAPABLE_SQL = `w.removed_at IS NULL
  AND EXISTS (SELECT 1 FROM jobs j WHERE j.id = w.job_id AND j.status IN ('done', 'cancelled'))
  AND NOT EXISTS (SELECT 1 FROM worktrees o JOIN jobs oj ON oj.id = o.job_id WHERE o.path = w.path AND o.removed_at IS NULL AND oj.status NOT IN ('done', 'cancelled'))
  AND NOT EXISTS (SELECT 1 FROM assignments a WHERE a.worktree_path = w.path AND a.status = 'held')
  AND NOT EXISTS (SELECT 1 FROM code_reviews c WHERE c.worktree = w.path AND c.status = 'running')
  AND NOT EXISTS (SELECT 1 FROM jobs r WHERE r.repo_path = w.path)
  AND NOT EXISTS (SELECT 1 FROM researcher_personas p WHERE p.repo_path = w.path)`;

/** True when the path may be removed now. `nextLaunch` checks it again at pickup. */
export async function worktreeReapable(conn: Conn, path: string): Promise<boolean> {
  return !!(await queryOne(conn, `SELECT 1 FROM worktrees w WHERE w.path = ? AND ${REAPABLE_SQL} LIMIT 1`, [path]));
}

/**
 * Scheduler: queues a `reap_worktree` launch per finished worktree. At most `maxQueuedWorktreeReaps` wait at a time,
 * so a backlog does not hold up Staff resumes and reviews behind it. A path whose last removal failed (kept: it has
 * unpushed work, say) is tried again after `worktreeReapRetrySec`.
 */
export async function reapFinishedWorktrees(ctx: Ctx) {
  const now = ctx.clock.now();
  const waiting = await queryOne(ctx.pool, `SELECT COUNT(*) AS n FROM launches WHERE kind = 'reap_worktree' AND finished_at IS NULL`);
  const room = POLICY.maxQueuedWorktreeReaps - Number(waiting?.n ?? 0);
  if (room <= 0) return;
  const retryAfter = addSeconds(now, -POLICY.worktreeReapRetrySec);
  const paths = await query(
    ctx.pool,
    `SELECT DISTINCT w.path FROM worktrees w
     WHERE ${REAPABLE_SQL}
       AND NOT EXISTS (SELECT 1 FROM launches l WHERE l.kind = 'reap_worktree' AND l.cwd = w.path AND (l.finished_at IS NULL OR l.finished_at > ?))
     ORDER BY w.path LIMIT ${room}`,
    [retryAfter],
  );
  for (const { path } of paths) {
    await tx(ctx, async (conn) => {
      // The SELECT above ran outside the lock: check again before queueing.
      const pending = await queryOne(conn, `SELECT id FROM launches WHERE kind = 'reap_worktree' AND cwd = ? AND (finished_at IS NULL OR finished_at > ?)`, [path, retryAfter]);
      if (pending || !(await worktreeReapable(conn, path as string))) return;
      await exec(conn, `INSERT INTO launches (id, agent_id, kind, cwd, runtime, requested_at) VALUES (?, NULL, 'reap_worktree', ?, 'git', ?)`, [newId('lch'), path, now]);
    });
  }
}

/** The runner's report on a `reap_worktree` launch: `ok: ...` means the worktree is gone. */
export async function finishWorktreeReap(conn: Conn, ctx: Ctx, path: string, result: string) {
  const now = ctx.clock.now();
  await exec(
    conn,
    `UPDATE worktrees SET last_result = ?, last_result_at = ?, removed_at = IF(?, ?, removed_at) WHERE path = ? AND removed_at IS NULL`,
    [result.slice(0, 500), now, result.startsWith('ok'), now, path],
  );
}

export async function worktreesOfJob(conn: Conn, jobId: string) {
  return query(conn, `SELECT path, recorded_at, removed_at, last_result, last_result_at FROM worktrees WHERE job_id = ? ORDER BY recorded_at`, [jobId]);
}

/** The runner reports the free space of the disk that holds the home directory. */
export async function recordHostDisk(ctx: Ctx, d: { free_bytes: number; total_bytes: number }) {
  await exec(
    ctx.pool,
    `INSERT INTO host_disk (id, free_bytes, total_bytes, checked_at) VALUES (1, ?, ?, ?)
     ON DUPLICATE KEY UPDATE free_bytes = VALUES(free_bytes), total_bytes = VALUES(total_bytes), checked_at = VALUES(checked_at)`,
    [d.free_bytes, d.total_bytes, ctx.clock.now()],
  );
}

const GIB = 1024 ** 3;

/**
 * A new Senior adds a checkout. Refused while the last fresh report says the disk is below `minFreeDiskBytes`. A report
 * older than `hostDiskFreshSec`, or none, changes nothing.
 */
export async function assertDiskRoom(conn: Conn, ctx: Ctx) {
  const d = await queryOne(conn, `SELECT free_bytes, checked_at FROM host_disk WHERE id = 1`);
  if (!d || ctx.clock.now().getTime() - new Date(d.checked_at).getTime() > POLICY.hostDiskFreshSec * 1000) return;
  if (Number(d.free_bytes) >= POLICY.minFreeDiskBytes) return;
  throw conflict(
    `The host disk has ${(Number(d.free_bytes) / GIB).toFixed(1)} GiB free, below ${POLICY.minFreeDiskBytes / GIB} GiB. A new Senior would add another checkout. Raise an external blocker asking the Client to free disk space, and start the Senior when it is resolved.`,
  );
}
