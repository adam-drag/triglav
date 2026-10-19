import type { PoolConnection } from 'mysql2/promise';
import { POLICY, tx, type Ctx } from './context.ts';
import { exec, query, queryOne, type Conn, type Row } from './db.ts';
import { emit, toEventRow } from './events.ts';
import { checkSeniorCaps } from './jobs.ts';
import { addSeconds, conflict, forbidden, invalid, newId, newSecret, notFound, sha256, TOKEN_PREFIX } from './lib.ts';

export const ROLES = ['staff', 'senior', 'reviewer', 'researcher'] as const;
export type Role = (typeof ROLES)[number];

export interface Agent {
  id: string;
  nickname: string;
  role: Role;
  focus: string | null;
  runtime: string;
  model: string | null;
  parent_agent_id: string | null;
  session_id: string;
}

export interface RegisterInput {
  role: Role;
  nickname: string;
  runtime: string;
  model?: string | null;
  focus?: string | null;
  spawnTicket?: string | null;
}

export interface Registration {
  agent_id: string;
  session_token: string;
  role: Role;
  assignment: { id: string; job_id: string; kind: string; attempt: number; lease_expires_at: Date } | null;
}

export async function registerAgent(ctx: Ctx, input: RegisterInput): Promise<Registration> {
  const needsTicket = input.role === 'senior' || input.role === 'reviewer';
  if (needsTicket && !input.spawnTicket) {
    throw forbidden(`A ${input.role} must register with a spawn ticket from its Staff agent.`);
  }
  if (!needsTicket && input.spawnTicket) {
    throw invalid(`A ${input.role} registers without a spawn ticket.`);
  }
  return tx(ctx, async (conn) => {
    const now = ctx.clock.now();
    let ticket: Row | undefined;
    if (input.spawnTicket) {
      ticket = await queryOne(conn, `SELECT * FROM spawn_tickets WHERE code_hash = ? FOR UPDATE`, [sha256(input.spawnTicket)]);
      if (!ticket) throw forbidden('Unknown spawn ticket.');
      if (ticket.used_at) throw forbidden('This spawn ticket was already used.');
      if (ticket.expires_at <= now) throw forbidden('This spawn ticket has expired. Ask your Staff agent for a new one.');
      if (ticket.role !== input.role) throw forbidden(`This spawn ticket is for a ${ticket.role}, not a ${input.role}.`);
    }
    const agentId = newId('agt');
    const sessionId = newId('ses');
    const token = newSecret(TOKEN_PREFIX);
    await exec(
      conn,
      `INSERT INTO agents (id, nickname, role, focus, runtime, model, parent_agent_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [agentId, input.nickname, input.role, input.focus ?? null, input.runtime, input.model ?? null, ticket?.issued_by ?? null, now],
    );
    await exec(conn, `INSERT INTO agent_sessions (id, agent_id, token_hash, started_at, last_seen_at) VALUES (?, ?, ?, ?, ?)`, [
      sessionId,
      agentId,
      sha256(token),
      now,
      now,
    ]);
    let assignment: Registration['assignment'] = null;
    if (ticket) {
      await exec(conn, `UPDATE spawn_tickets SET used_at = ?, used_by = ? WHERE code_hash = ?`, [now, agentId, ticket.code_hash]);
      assignment = await claimAssignment(conn, ctx, ticket.assignment_id, agentId);
    }
    await emit(conn, ctx, {
      type: 'agent.registered',
      actor: agentId,
      jobId: assignment?.job_id ?? null,
      payload: { nickname: input.nickname, role: input.role, runtime: input.runtime, parent_agent_id: ticket?.issued_by ?? null },
    });
    return { agent_id: agentId, session_token: token, role: input.role, assignment };
  });
}

/** Starts a new attempt on an assignment. The attempt number fences off every earlier holder. */
async function claimAssignment(conn: PoolConnection, ctx: Ctx, assignmentId: string, agentId: string) {
  const now = ctx.clock.now();
  const a = await queryOne(conn, `SELECT * FROM assignments WHERE id = ? FOR UPDATE`, [assignmentId]);
  if (!a) throw conflict('The assignment for this ticket no longer exists.');
  if (a.status === 'closed') throw conflict('The assignment for this ticket is closed.');
  if (a.status === 'held' && a.lease_expires_at > now) throw conflict('The assignment is already held by another agent.');
  const job = await queryOne(conn, `SELECT * FROM jobs WHERE id = ? FOR UPDATE`, [a.job_id]);
  if (!job) throw conflict('The job for this ticket no longer exists.');
  if (job.control === 'cancel' || job.status === 'cancelled') throw conflict('The job was cancelled.');
  if (job.control === 'pause') throw conflict('The job is paused. Wait until the Client resumes it.');
  const allowed = a.kind === 'implement' ? ['ready', 'in_progress', 'delivering'] : ['in_review'];
  if (!allowed.includes(job.status)) throw conflict(`The job is ${job.status}; this ticket can no longer start work. Ask your Staff agent.`);
  if (a.kind === 'implement') await checkSeniorCaps(conn, job, now);
  if (a.status === 'held') {
    await exec(conn, `UPDATE attempts SET ended_at = ?, outcome = 'lease_expired' WHERE assignment_id = ? AND number = ?`, [
      now,
      a.id,
      a.current_attempt,
    ]);
  }
  const attempt = Number(a.current_attempt) + 1;
  const lease = addSeconds(now, POLICY.leaseSec);
  await exec(conn, `UPDATE assignments SET status = 'held', owner_agent_id = ?, current_attempt = ?, lease_expires_at = ? WHERE id = ?`, [
    agentId,
    attempt,
    lease,
    a.id,
  ]);
  await exec(conn, `INSERT INTO attempts (assignment_id, number, agent_id, started_at) VALUES (?, ?, ?, ?)`, [a.id, attempt, agentId, now]);
  if (a.kind === 'implement' && job.status === 'ready') {
    await exec(conn, `UPDATE jobs SET status = 'in_progress', updated_at = ? WHERE id = ?`, [now, job.id]);
    await emit(conn, ctx, { type: 'job.status', jobId: job.id, actor: agentId, payload: { from: 'ready', to: 'in_progress' } });
  }
  await emit(conn, ctx, {
    type: 'assignment.claimed',
    jobId: job.id,
    actor: agentId,
    targets: job.staff_agent_id ? [job.staff_agent_id] : [],
    payload: { assignment_id: a.id, kind: a.kind, attempt },
  });
  return { id: a.id as string, job_id: a.job_id as string, kind: a.kind as string, attempt, lease_expires_at: lease };
}

/**
 * Resolves a session token to its agent, records presence, and renews the leases the agent holds.
 * Every agent call goes through here, so any call counts as a heartbeat.
 */
export async function authenticate(ctx: Ctx, token: string): Promise<Agent> {
  if (!token || !token.startsWith(TOKEN_PREFIX)) throw forbidden('Missing or malformed session token. Call register_agent first.');
  const row = await queryOne(
    ctx.pool,
    `SELECT a.*, s.id AS session_id, s.ended_at FROM agent_sessions s JOIN agents a ON a.id = s.agent_id WHERE s.token_hash = ?`,
    [sha256(token)],
  );
  if (!row) throw forbidden('Unknown session token. Register again with register_agent.');
  if (row.ended_at) throw forbidden('This session has ended. Register again with register_agent.');
  const now = ctx.clock.now();
  await exec(ctx.pool, `UPDATE agent_sessions SET last_seen_at = ? WHERE id = ?`, [now, row.session_id]);
  await exec(
    ctx.pool,
    `UPDATE assignments SET lease_expires_at = ? WHERE owner_agent_id = ? AND status = 'held' AND lease_expires_at > ?`,
    [addSeconds(now, POLICY.leaseSec), row.id, now],
  );
  return {
    id: row.id,
    nickname: row.nickname,
    role: row.role,
    focus: row.focus,
    runtime: row.runtime,
    model: row.model,
    parent_agent_id: row.parent_agent_id,
    session_id: row.session_id,
  };
}

export async function markWaiting(ctx: Ctx, agent: Agent, until: Date | null): Promise<void> {
  await exec(ctx.pool, `UPDATE agent_sessions SET waiting_until = ?, last_seen_at = ? WHERE id = ?`, [until, ctx.clock.now(), agent.session_id]);
}

/**
 * Ends the session and gives back every assignment it still holds. An ended session can no longer authenticate, so a
 * lease left to run out only blocked the next Senior for up to `leaseSec` and was then counted as a failed attempt.
 * In the normal flow the assignment is already closed (delivery confirmed, verdict recorded, job cancelled) and there
 * is nothing to release. A release is not a failed attempt; Staff gets `assignment.orphaned` with reason `session_ended`.
 */
export async function endSession(ctx: Ctx, agent: Agent, reason: string): Promise<void> {
  await tx(ctx, async (conn) => {
    const now = ctx.clock.now();
    await exec(conn, `UPDATE agent_sessions SET ended_at = ?, end_reason = ?, waiting_until = NULL WHERE id = ?`, [now, reason, agent.session_id]);
    const held = await query(conn, `SELECT * FROM assignments WHERE owner_agent_id = ? AND status = 'held' FOR UPDATE`, [agent.id]);
    for (const a of held) {
      await exec(conn, `UPDATE attempts SET ended_at = ?, outcome = 'session_ended' WHERE assignment_id = ? AND number = ? AND ended_at IS NULL`, [now, a.id, a.current_attempt]);
      const job = await queryOne(conn, `SELECT staff_agent_id, status FROM jobs WHERE id = ?`, [a.job_id]);
      if (!job || ['done', 'cancelled'].includes(job.status)) {
        await exec(conn, `UPDATE assignments SET status = 'closed', lease_expires_at = NULL WHERE id = ?`, [a.id]);
        continue;
      }
      await exec(conn, `UPDATE assignments SET status = 'open', owner_agent_id = NULL, lease_expires_at = NULL WHERE id = ?`, [a.id]);
      await emit(conn, ctx, {
        type: 'assignment.orphaned',
        jobId: a.job_id,
        actor: agent.id,
        targets: [job.staff_agent_id].filter(Boolean),
        payload: { assignment_id: a.id, attempt: a.current_attempt, previous_owner: agent.id, failed_attempts: Number(a.failed_attempts), reason: 'session_ended' },
      });
    }
    await emit(conn, ctx, { type: 'agent.left', actor: agent.id, payload: { reason } });
  });
}

// starting is for a researcher persona whose run is queued; between runs a persona is waiting.
/**
 * A session that called the orchestrator or waits in it within the active window: the Staff agent is back. The scheduler
 * (`clearReturnedStaff`) and a takeover that is about to start (`ownerIsLive`) use the same condition.
 */
export const LIVE_SESSION_SQL = `s.ended_at IS NULL AND (s.last_seen_at > ? OR s.waiting_until > ?)`;
export const liveSessionParams = (ctx: Ctx) => {
  const now = ctx.clock.now();
  return [addSeconds(now, -POLICY.presenceActiveSec), now];
};

/**
 * A session this stale is not coming back on its own: `reapAbandonedSessions` (scheduler) and `nextLaunch`'s
 * `reap_session` pickup recheck use the same condition, so a session that recovered between queueing and pickup is
 * not stopped.
 */
export const STALE_FOR_REAP_SQL = `s.last_seen_at <= ? AND (s.waiting_until IS NULL OR s.waiting_until <= ?) AND (s.transcript_at IS NULL OR s.transcript_at <= ?)`;
export const staleForReapParams = (ctx: Ctx) => {
  const now = ctx.clock.now();
  const cutoff = addSeconds(now, -POLICY.reapAgentSessionSec);
  return [cutoff, now, cutoff];
};

/**
 * No other agent sharing this session's underlying Claude Code process (the same `transcript_session`) is itself
 * still within `STALE_FOR_REAP_SQL`. `register_agent` never ends a caller's previous registration, so a conversation
 * that re-registers without calling `end_session` leaves two agent rows pointing at one process (`ingestTelemetry`
 * matches a transcript's tokens to whichever agent owns each one, not to a single "current" agent). Reaping the
 * older, now-unused registration must not stop a process another agent is actively using. Uses the same generous
 * two-hour-scale condition as the reap decision itself (not the two-minute `LIVE_SESSION_SQL` window), so a sibling
 * that is merely busy in a long tool call, with recent `transcript_at` but no recent orchestrator call, still vetoes
 * cleanup; `clearReturnedStaff` treats that same case as "still here" for the same reason. `reapAbandonedSessions`
 * and `nextLaunch`'s `reap_session` pickup recheck both require this alongside `STALE_FOR_REAP_SQL`, passing
 * `staleForReapParams(ctx)` twice (once for the row under test `s`, once for this check's own params), aliasing the
 * row under test `s`.
 */
export const NO_LIVE_SIBLING_SQL = `NOT EXISTS (SELECT 1 FROM agent_sessions o WHERE o.transcript_session = s.transcript_session AND o.agent_id <> s.agent_id AND o.ended_at IS NULL AND NOT (o.last_seen_at <= ? AND (o.waiting_until IS NULL OR o.waiting_until <= ?) AND (o.transcript_at IS NULL OR o.transcript_at <= ?)))`;

/**
 * Whether the agent has a live session, read with a lock on its session rows so that a heartbeat cannot commit between
 * this check and the caller's write. Lock order for a caller: job first, then these rows (a heartbeat takes only its own row).
 */
export async function ownerIsLive(conn: Conn, ctx: Ctx, agentId: string | null): Promise<boolean> {
  if (!agentId) return false;
  const live = await queryOne(conn, `SELECT s.id FROM agent_sessions s WHERE s.agent_id = ? AND ${LIVE_SESSION_SQL} LIMIT 1 FOR UPDATE`, [agentId, ...liveSessionParams(ctx)]);
  return !!live;
}

export type Presence = 'active' | 'waiting' | 'working' | 'stale' | 'offline' | 'ended' | 'starting';

export function presenceOf(ctx: Ctx, s: { last_seen_at: Date; waiting_until: Date | null; ended_at: Date | null; transcript_at?: Date | null }): Presence {
  if (s.ended_at) return 'ended';
  const now = ctx.clock.now().getTime();
  if (s.waiting_until && s.waiting_until.getTime() > now) return 'waiting';
  const idle = (now - s.last_seen_at.getTime()) / 1000;
  if (idle < POLICY.presenceActiveSec) return 'active';
  // Not calling the orchestrator, but its CLI transcript moved recently: busy with tools off the board.
  // Telemetry reads transcripts once a minute, so allow a minute on top of the active window.
  if (s.transcript_at && (now - s.transcript_at.getTime()) / 1000 < POLICY.presenceActiveSec + 60) return 'working';
  if (idle < POLICY.presenceOfflineSec) return 'stale';
  return 'offline';
}

function personaPresence(p: Record<string, any>): Presence {
  if (!p.enabled) return 'offline';
  return p.run_status === 'queued' ? 'starting' : 'waiting';
}

export async function listAgents(ctx: Ctx, opts: { includeInactive: boolean }) {
  const rows = await query(
    ctx.pool,
    `SELECT a.*, s.last_seen_at, s.waiting_until, s.ended_at, s.started_at, s.transcript_at,
       (SELECT JSON_ARRAYAGG(JSON_OBJECT('assignment_id', x.id, 'job_id', x.job_id, 'kind', x.kind, 'attempt', x.current_attempt))
          FROM assignments x WHERE x.owner_agent_id = a.id AND x.status = 'held') AS held
     FROM agents a JOIN agent_sessions s ON s.agent_id = a.id
     ORDER BY s.last_seen_at DESC`,
  );
  // A persona's agent has a session only while a run is going. Between runs it is waiting (or offline when disabled),
  // and a queued run shows as starting, so a new persona appears at once.
  const personas = await query(
    ctx.pool,
    `SELECT p.agent_id, p.enabled, a.nickname, a.focus, a.runtime, p.model, p.effort, a.created_at,
       (SELECT r.status FROM research_runs r WHERE r.persona_id = p.id ORDER BY r.created_at DESC LIMIT 1) AS run_status
     FROM researcher_personas p JOIN agents a ON a.id = p.agent_id`,
  );
  const persona = new Map(personas.map((p) => [p.agent_id as string, p]));
  // A persona has one session per run: keep only its latest (rows are newest first).
  const seen = new Set<string>();
  const latest = rows.filter((r) => {
    if (!persona.has(r.id)) return true;
    if (seen.has(r.id)) return false;
    seen.add(r.id);
    return true;
  });
  const agents = latest.map((r) => ({
    id: r.id as string,
    nickname: r.nickname as string,
    role: r.role as Role,
    focus: r.focus as string | null,
    runtime: r.runtime as string,
    model: r.model as string | null,
    effort: (r.effort ?? null) as string | null,
    parent_agent_id: r.parent_agent_id as string | null,
    started_at: r.started_at as Date,
    last_seen_at: r.last_seen_at as Date,
    presence: presenceOf(ctx, r as any),
    held: ((typeof r.held === 'string' ? JSON.parse(r.held) : r.held) ?? []) as { assignment_id: string; job_id: string; kind: string; attempt: number }[],
  }));
  for (const a of agents) {
    const p = persona.get(a.id);
    if (p && !['active', 'waiting', 'working'].includes(a.presence)) a.presence = personaPresence(p);
  }
  const pokes = await pokeStates(ctx);
  for (const a of agents) (a as { poke?: PokeState | null }).poke = pokes.get(a.id) ?? null;
  for (const p of personas) {
    if (seen.has(p.agent_id)) continue;
    agents.push({
      id: p.agent_id, nickname: p.nickname, role: 'researcher', focus: p.focus, runtime: p.runtime, model: p.model, effort: p.effort ?? null, parent_agent_id: null,
      started_at: p.created_at, last_seen_at: p.created_at, presence: personaPresence(p), held: [],
    });
  }
  return opts.includeInactive ? agents : agents.filter((a) => a.presence !== 'offline' && a.presence !== 'ended');
}

export interface PokeState {
  poked_at: Date;
  /** The first message the agent tagged to the Client after the poke, or null while the Client still waits. */
  reply: { message_id: number; thread_id: string; at: Date; excerpt: string } | null;
}

/** The latest poke of each agent, and the reply it sent to the Client since. */
async function pokeStates(ctx: Ctx): Promise<Map<string, PokeState>> {
  const pokes = await query(
    ctx.pool,
    `SELECT JSON_UNQUOTE(JSON_EXTRACT(payload, '$.targets[0]')) AS agent_id, MAX(created_at) AS poked_at FROM events WHERE type = 'agent.poked' GROUP BY agent_id`,
  );
  const states = new Map<string, PokeState>();
  if (pokes.length === 0) return states;
  const since = new Date(Math.min(...pokes.map((p) => (p.poked_at as Date).getTime())));
  const replies = await query(
    ctx.pool,
    `SELECT id, thread_id, author, body, received_at FROM messages WHERE to_client = 1 AND received_at >= ? AND author IN (?) ORDER BY id`,
    [since, pokes.map((p) => p.agent_id)],
  );
  for (const p of pokes) {
    const r = replies.find((m) => m.author === p.agent_id && (m.received_at as Date) >= (p.poked_at as Date));
    states.set(p.agent_id, {
      poked_at: p.poked_at,
      reply: r ? { message_id: Number(r.id), thread_id: r.thread_id, at: r.received_at, excerpt: String(r.body).slice(0, 200) } : null,
    });
  }
  return states;
}

/**
 * The Client asks an agent to report its status, or sends it a message: the note is the Client's own text.
 * Wakes a waiting agent; a busy one sees it on its next wait.
 */
export async function pokeAgent(ctx: Ctx, agentId: string, note: string | null) {
  return tx(ctx, async (conn) => {
    const agent = await queryOne(conn, `SELECT id FROM agents WHERE id = ?`, [agentId]);
    if (!agent) throw notFound(`Agent ${agentId}`);
    await emit(conn, ctx, {
      type: 'agent.poked',
      actor: 'client',
      targets: [agentId],
      payload: { note: note?.trim() || 'The Client asks for a short status: what you are doing, what you wait for, and whether anything is stuck.' },
    });
    return { ok: true };
  });
}

/** What the agent did and what was addressed to it, newest first. */
export async function agentActivity(ctx: Ctx, agentId: string, limit = 200) {
  const agent = (await listAgents(ctx, { includeInactive: true })).find((a) => a.id === agentId);
  if (!agent) throw notFound(`Agent ${agentId}`);
  const events = await query(
    ctx.pool,
    `SELECT * FROM events WHERE actor = ? OR JSON_CONTAINS(payload, JSON_QUOTE(?), '$.targets') ORDER BY id DESC LIMIT ${limit}`,
    [agentId, agentId],
  );
  const messages = await query(
    ctx.pool,
    `SELECT m.id, m.thread_id, m.type, m.stance, m.reason, m.body, m.received_at, t.title AS thread_title
     FROM messages m JOIN threads t ON t.id = m.thread_id WHERE m.author = ? ORDER BY m.id DESC LIMIT ${limit}`,
    [agentId],
  );
  return { agent, events: events.map(toEventRow), messages: messages.map((m) => ({ ...m, id: Number(m.id) })) };
}

/**
 * For the CLI Stop hook: what this session still owns, or null when it may end its turn.
 * Paused and cancelled jobs do not count, so pausing a job lets its agents stop and save usage.
 */
export async function openWorkFor(ctx: Ctx, token: string): Promise<string | null> {
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  const s = await queryOne(ctx.pool, `SELECT a.id, a.role, s.ended_at FROM agent_sessions s JOIN agents a ON a.id = s.agent_id WHERE s.token_hash = ?`, [sha256(token)]);
  if (!s || s.ended_at) return null;
  if (s.role === 'staff') {
    const jobs = await query(
      ctx.pool,
      `SELECT linear_identifier, status FROM jobs WHERE staff_agent_id = ? AND parent_job_id IS NULL AND status NOT IN ('done', 'cancelled') AND control = 'continue'`,
      [s.id],
    );
    return jobs.length ? `You are Staff on ${jobs.map((j) => `${j.linear_identifier} (${j.status})`).join(', ')}.` : null;
  }
  if (s.role === 'senior' || s.role === 'reviewer') {
    const held = await query(
      ctx.pool,
      `SELECT j.linear_identifier, j.status FROM assignments x JOIN jobs j ON j.id = x.job_id
       WHERE x.owner_agent_id = ? AND x.status = 'held' AND x.lease_expires_at > ? AND j.control = 'continue'`,
      [s.id, ctx.clock.now()],
    );
    return held.length ? `You hold work on ${held.map((j) => `${j.linear_identifier} (${j.status})`).join(', ')}.` : null;
  }
  return null;
}

export type Control = 'continue' | 'pause' | 'cancel';

/**
 * The control signal for an agent. A Senior or reviewer keeps seeing "cancel" for a job it worked on
 * even after cancellation closed its assignment, so it learns to stop on its next call. Staff learns
 * about cancellation from job events and only receives pause signals for open jobs it owns.
 */
export async function controlFor(conn: Conn, agentId: string): Promise<{ action: Control; job_ids: string[]; cancel_job_ids: string[]; pause_job_ids: string[] }> {
  const rows = await query(
    conn,
    `SELECT id, control FROM jobs WHERE control <> 'continue' AND (
       (staff_agent_id = ? AND control = 'pause' AND status NOT IN ('done', 'cancelled'))
       OR id IN (SELECT job_id FROM assignments WHERE owner_agent_id = ?))`,
    [agentId, agentId],
  );
  const cancel = rows.filter((r) => r.control === 'cancel').map((r) => r.id as string);
  const pause = rows.filter((r) => r.control === 'pause').map((r) => r.id as string);
  const action: Control = cancel.length ? 'cancel' : pause.length ? 'pause' : 'continue';
  return { action, job_ids: cancel.length ? cancel : pause, cancel_job_ids: cancel, pause_job_ids: pause };
}
