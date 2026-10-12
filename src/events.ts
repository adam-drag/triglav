import { routeToInbox } from './research.ts';
import { exec, json, parseJson, query, queryOne, type Conn } from './db.ts';
import type { Ctx } from './context.ts';

export interface EventInput {
  type: string;
  jobId?: string | null;
  threadId?: string | null;
  actor: string;
  /** Agent ids (or "client") that this event is addressed to. */
  targets?: string[];
  payload?: Record<string, unknown>;
}

export interface EventRow {
  id: number;
  type: string;
  job_id: string | null;
  thread_id: string | null;
  actor: string;
  payload: Record<string, unknown> & { targets?: string[] };
  created_at: Date;
}

export async function emit(conn: Conn, ctx: Ctx, e: EventInput): Promise<void> {
  const payload = { ...(e.payload ?? {}), targets: e.targets ?? [] };
  const res = await exec(conn, `INSERT INTO events (type, job_id, thread_id, actor, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)`, [
    e.type,
    e.jobId ?? null,
    e.threadId ?? null,
    e.actor,
    json(payload),
    ctx.clock.now(),
  ]);
  // Researchers do not poll: the events they should see become inbox items in the same transaction.
  await routeToInbox(conn, ctx, { id: res.insertId, type: e.type, jobId: e.jobId ?? null, threadId: e.threadId ?? null, actor: e.actor, payload });
}

export type Scope = 'owned' | 'all_jobs';

/** Event types that wake a researcher by default. Everything stays readable through list_board. */
export const RESEARCHER_WAKE_TYPES = ['question.opened', 'question.extended', 'proposal.posted', 'mention', 'review.submitted', 'review.verdict', 'blocker.raised'];

/**
 * Event types that end a Staff wait. Every wake is a model turn that re-reads the Staff's whole context, so routine
 * events (job.status, progress, artifact.recorded, assignment.claimed, message.posted...) do not wake it. They are
 * not lost: they come back with the next waking event or when the wait times out.
 */
export const STAFF_WAKE_TYPES = [
  'question.opened',
  'question.deadline_reached',
  'question.synthesis_requested',
  'question.late_challenge',
  'question.extended',
  'review.submitted',
  'review.verdict',
  'delivery.reported',
  'assignment.orphaned',
  'blocker.raised',
  'blocker.resolved',
  'job.reopened',
  'job.handover',
  'job.cancelled',
  'linear.changed',
  'linear.diverged',
  'linear.new_subissue',
  'mention',
  'agent.poked',
  'job.paused',
  'job.resumed',
  // The Client answered or edited during refinement, or approved it. Staff revises or starts planning.
  'refinement.client_reply',
  'refinement.approved',
];

export async function latestEventId(conn: Conn): Promise<number> {
  const row = await queryOne(conn, `SELECT COALESCE(MAX(id), 0) AS id FROM events`);
  return Number(row?.id ?? 0);
}

/**
 * Reads events after the cursor that concern the agent. The cursor always advances to the newest
 * event scanned, so events outside the agent's scope are not scanned again.
 */
export async function readEvents(
  conn: Conn,
  agentId: string,
  opts: { cursor: number; scope: Scope; types?: string[] | null; limit?: number },
): Promise<{ events: EventRow[]; nextCursor: number }> {
  const maxId = await latestEventId(conn);
  if (maxId <= opts.cursor) return { events: [], nextCursor: opts.cursor };
  const params: unknown[] = [opts.cursor, maxId];
  let where = `e.id > ? AND e.id <= ?`;
  if (opts.scope === 'owned') {
    where += ` AND (
      JSON_CONTAINS(e.payload, JSON_QUOTE(?), '$.targets')
      OR e.job_id IN (SELECT id FROM jobs WHERE staff_agent_id = ?)
      OR e.job_id IN (SELECT job_id FROM assignments WHERE owner_agent_id = ? AND status = 'held')
    )`;
    params.push(agentId, agentId, agentId);
  } else {
    where += ` AND (e.job_id IS NOT NULL OR JSON_CONTAINS(e.payload, JSON_QUOTE(?), '$.targets'))`;
    params.push(agentId);
  }
  if (opts.types && opts.types.length > 0) {
    where += ` AND (e.type IN (?) OR JSON_CONTAINS(e.payload, JSON_QUOTE(?), '$.targets'))`;
    params.push(opts.types, agentId);
  }
  where += ` AND e.actor <> ?`;
  params.push(agentId);
  const limit = opts.limit ?? 100;
  const rows = await query(conn, `SELECT e.* FROM events e WHERE ${where} ORDER BY e.id LIMIT ${limit}`, params);
  const events = rows.map(toEventRow);
  const nextCursor = events.length === limit ? events[events.length - 1]!.id : maxId;
  return { events, nextCursor };
}

export function toEventRow(r: Record<string, any>): EventRow {
  return {
    id: Number(r.id),
    type: r.type,
    job_id: r.job_id,
    thread_id: r.thread_id,
    actor: r.actor,
    payload: parseJson(r.payload),
    created_at: r.created_at,
  };
}

/**
 * Waits until check() returns a value or maxWaitSec passes. Wakes on every committed change.
 * onTick runs every 30 seconds so a transport can send progress notifications.
 */
export async function waitUntil<T>(
  ctx: Ctx,
  check: () => Promise<T | null>,
  opts: { maxWaitSec: number; signal?: AbortSignal; onTick?: () => Promise<void> | void },
): Promise<T | null> {
  const first = await check();
  if (first !== null) return first;
  return new Promise<T | null>((resolve, reject) => {
    let done = false;
    let checking = false;
    let again = false;
    const cleanup = () => {
      done = true;
      clearTimeout(timer);
      clearInterval(ticker);
      ctx.bus.off('change', onChange);
      opts.signal?.removeEventListener('abort', onAbort);
    };
    const finish = (value: T | null) => {
      if (done) return;
      cleanup();
      resolve(value);
    };
    const onChange = async () => {
      if (done) return;
      if (checking) {
        again = true;
        return;
      }
      checking = true;
      try {
        do {
          again = false;
          const value = await check();
          if (value !== null) return finish(value);
        } while (again && !done);
      } catch (error) {
        if (!done) {
          cleanup();
          reject(error);
        }
      } finally {
        checking = false;
      }
    };
    const onAbort = () => finish(null);
    const timer = setTimeout(() => finish(null), opts.maxWaitSec * 1000);
    const ticker = setInterval(() => void opts.onTick?.(), 30_000);
    ctx.bus.on('change', onChange);
    opts.signal?.addEventListener('abort', onAbort);
  });
}
