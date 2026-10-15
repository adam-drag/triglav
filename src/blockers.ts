import type { Agent } from './agents.ts';
import { systemMessage } from './board.ts';
import { tx, type Ctx } from './context.ts';
import { exec, query, queryOne, type Conn, type Row } from './db.ts';
import { emit } from './events.ts';
import { CLIENT, CLOSED, lockJob, setStatus } from './jobs.ts';
import { assertNoSecrets, conflict, forbidden, invalid, newId, notFound } from './lib.ts';

export const BLOCKER_KINDS = ['client_decision', 'external', 'failed_execution', 'unavailable_owner', 'no_convergence'] as const;
export type BlockerKind = (typeof BLOCKER_KINDS)[number];
/** Only these demand the Client's attention. */
export const CLIENT_KINDS: BlockerKind[] = ['client_decision', 'no_convergence'];

export interface BlockerInput {
  jobId: string;
  kind: BlockerKind;
  requestedDecision: string;
  context?: string;
  recommendation?: string;
  /** The agent can do the recommendation itself once the Client accepts it; false when the Client has to act. */
  recommendationActionable?: boolean;
  unblockCondition: string;
  /** Commands the Client should run, each shown in its own copyable box. */
  commands?: { label?: string; command: string }[];
}

export async function raiseBlockerTx(conn: Conn, ctx: Ctx, actor: string, input: BlockerInput): Promise<string> {
  const job = await lockJob(conn, input.jobId);
  if (CLOSED.includes(job.status)) throw conflict(`Job ${job.id} is ${job.status}.`);
  const responsible = CLIENT_KINDS.includes(input.kind) ? CLIENT : input.kind === 'unavailable_owner' ? CLIENT : (job.staff_agent_id ?? CLIENT);
  const id = newId('blk');
  await exec(
    conn,
    `INSERT INTO blockers (id, job_id, kind, responsible, context, requested_decision, recommendation, recommendation_actionable, unblock_condition, commands, raised_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, job.id, input.kind, responsible, input.context ?? null, input.requestedDecision, input.recommendation ?? null, input.recommendationActionable ? 1 : 0, input.unblockCondition, input.commands?.length ? JSON.stringify(input.commands) : null, actor, ctx.clock.now()],
  );
  if (job.status !== 'blocked') {
    await exec(conn, `UPDATE jobs SET previous_status = ? WHERE id = ?`, [job.status, job.id]);
    await setStatus(conn, ctx, job, 'blocked', actor, { blocker_id: id, kind: input.kind });
  }
  await systemMessage(
    conn,
    ctx,
    job.id,
    actor,
    'escalation',
    `Blocked (${input.kind}): ${input.requestedDecision}${input.recommendation ? `\nRecommendation: ${input.recommendation}` : ''}\nUnblocks when: ${input.unblockCondition}`,
  );
  await emit(conn, ctx, {
    type: 'blocker.raised',
    jobId: job.id,
    actor,
    targets: [responsible, job.staff_agent_id].filter((t) => t && t !== actor),
    payload: { blocker_id: id, kind: input.kind, client_attention: CLIENT_KINDS.includes(input.kind) },
  });
  return id;
}

export async function raiseBlocker(ctx: Ctx, agent: Agent, input: BlockerInput) {
  if (!['staff', 'senior'].includes(agent.role)) throw forbidden('Only Staff or a Senior raises blockers.');
  if (!input.requestedDecision.trim() || !input.unblockCondition.trim()) throw invalid('Say what decision or action is needed and what unblocks the work.');
  if (input.recommendationActionable && !input.recommendation?.trim()) throw invalid('recommendation_actionable needs a recommendation.');
  if (input.kind === 'unavailable_owner' || input.kind === 'no_convergence') throw invalid(`${input.kind} blockers are raised by the orchestrator.`);
  assertNoSecrets(input.context, input.requestedDecision, input.recommendation, input.unblockCondition, ...(input.commands ?? []).flatMap((c) => [c.label, c.command]));
  return tx(ctx, async (conn) => {
    const job = await lockJob(conn, input.jobId);
    const involved =
      job.staff_agent_id === agent.id ||
      (await queryOne(conn, `SELECT id FROM assignments WHERE job_id = ? AND owner_agent_id = ? AND status = 'held'`, [job.id, agent.id]));
    if (!involved) throw forbidden('You can only raise blockers on jobs you own or hold an assignment on.');
    return { blocker_id: await raiseBlockerTx(conn, ctx, agent.id, input) };
  });
}

export async function resolveBlocker(ctx: Ctx, by: { kind: 'client' } | { kind: 'agent'; agent: Agent }, input: { blockerId: string; resolution: string }) {
  if (!input.resolution.trim()) throw invalid('Say how the blocker was resolved.');
  assertNoSecrets(input.resolution);
  return tx(ctx, async (conn) => {
    const b = await queryOne(conn, `SELECT * FROM blockers WHERE id = ? FOR UPDATE`, [input.blockerId]);
    if (!b) throw notFound(`Blocker ${input.blockerId}`);
    if (b.resolved_at || b.dismissed_at) throw conflict('This blocker is already closed.');
    const job = await lockJob(conn, b.job_id);
    const actor = by.kind === 'client' ? CLIENT : by.agent.id;
    if (b.kind === 'unavailable_owner') {
      // A written answer cannot bring the Staff agent back, and the scheduler would raise the blocker again at once.
      throw conflict('An unavailable owner is not unblocked by an answer. Reassign the job to an active Staff agent, or bring the Staff session back; the blocker then clears by itself.');
    }
    if (by.kind === 'agent') {
      if (CLIENT_KINDS.includes(b.kind) || b.kind === 'unavailable_owner') throw forbidden('Only the Client resolves this blocker.');
      if (job.staff_agent_id !== by.agent.id) throw forbidden('Only the owning Staff resolves this blocker.');
    }
    return resolveBlockerTx(conn, ctx, actor, b, job, input.resolution);
  });
}

/** Restores the job from `blocked` once this was its last open blocker (resolved or dismissed). */
async function unblockIfClear(conn: Conn, ctx: Ctx, job: Row, blockerId: string, actor: string) {
  const open = await queryOne(conn, `SELECT COUNT(*) AS n FROM blockers WHERE job_id = ? AND resolved_at IS NULL AND dismissed_at IS NULL`, [job.id]);
  if (Number(open?.n) === 0 && job.status === 'blocked') {
    await setStatus(conn, ctx, job, job.previous_status ?? 'planning', actor, { blocker_id: blockerId });
    await exec(conn, `UPDATE jobs SET previous_status = NULL WHERE id = ?`, [job.id]);
  }
}

/** Marks a locked, open blocker resolved and unblocks the job when it was the last one. */
export async function resolveBlockerTx(conn: Conn, ctx: Ctx, actor: string, b: Row, job: Row, resolution: string) {
  await exec(conn, `UPDATE blockers SET resolved_at = ?, resolved_by = ?, resolution = ? WHERE id = ?`, [ctx.clock.now(), actor, resolution, b.id]);
  await systemMessage(conn, ctx, job.id, actor, 'decision', `Blocker ${b.kind} resolved: ${resolution}`);
  await unblockIfClear(conn, ctx, job, b.id, actor);
  await emit(conn, ctx, { type: 'blocker.resolved', jobId: job.id, actor, targets: [job.staff_agent_id].filter((t) => t && t !== actor), payload: { blocker_id: b.id, resolution } });
  return { job_status: job.status };
}

/**
 * The Client looked at a Client decision and it no longer applies: the job finished another way, the situation
 * changed, or the Staff that raised it is gone. Unlike resolveBlocker this needs no answer the job continues on.
 */
export async function dismissBlocker(ctx: Ctx, blockerId: string, note?: string) {
  if (note !== undefined) assertNoSecrets(note);
  return tx(ctx, async (conn) => {
    const b = await queryOne(conn, `SELECT * FROM blockers WHERE id = ? FOR UPDATE`, [blockerId]);
    if (!b) throw notFound(`Blocker ${blockerId}`);
    if (b.resolved_at || b.dismissed_at) throw conflict('This decision is already closed.');
    if (!CLIENT_KINDS.includes(b.kind)) throw conflict('Only a Client decision is dismissed this way: reassign the job, or let the owning Staff resolve its own blocker.');
    const job = await lockJob(conn, b.job_id);
    await exec(conn, `UPDATE blockers SET dismissed_at = ? WHERE id = ?`, [ctx.clock.now(), b.id]);
    await systemMessage(conn, ctx, job.id, CLIENT, 'decision', `Decision dismissed as no longer applicable${note ? `: ${note}` : ''}.`);
    await unblockIfClear(conn, ctx, job, b.id, CLIENT);
    await emit(conn, ctx, { type: 'blocker.resolved', jobId: job.id, actor: CLIENT, targets: [job.staff_agent_id].filter(Boolean), payload: { blocker_id: b.id, dismissed: true } });
    return { job_status: job.status };
  });
}

export async function clientQueue(ctx: Ctx) {
  return query(
    ctx.pool,
    `SELECT b.*, j.linear_identifier, j.title AS job_title, j.parent_job_id, j.staff_agent_id,
       (SELECT JSON_ARRAYAGG(JSON_OBJECT('agent_id', d.agent_id, 'body', d.body, 'at', d.created_at)) FROM decision_advice d WHERE d.blocker_id = b.id) AS advice
     FROM blockers b JOIN jobs j ON j.id = b.job_id
     WHERE b.resolved_at IS NULL AND b.dismissed_at IS NULL AND b.responsible = 'client' ORDER BY b.created_at`,
  );
}

/** Open Client decisions with the advice researchers already gave, for researchers deciding whether to weigh in. */
export async function openDecisions(ctx: Ctx) {
  const rows = await query(
    ctx.pool,
    `SELECT b.id AS blocker_id, b.job_id, j.linear_identifier, j.title AS job_title, b.context, b.requested_decision, b.recommendation, b.commands, b.raised_by, b.created_at,
       (SELECT JSON_ARRAYAGG(JSON_OBJECT('agent_id', d.agent_id, 'body', d.body)) FROM decision_advice d WHERE d.blocker_id = b.id) AS advice
     FROM blockers b JOIN jobs j ON j.id = b.job_id
     WHERE b.resolved_at IS NULL AND b.dismissed_at IS NULL AND b.kind = 'client_decision' ORDER BY b.created_at`,
  );
  return rows.map((r) => ({ ...r, advice: (typeof r.advice === 'string' ? JSON.parse(r.advice) : r.advice) ?? [] }));
}

/** A researcher's short view on an open Client decision. One per researcher per decision; a second call replaces it. */
export async function adviseDecision(ctx: Ctx, agent: Agent, blockerId: string, body: string) {
  if (agent.role !== 'researcher') throw forbidden('Only researchers give advice on Client decisions.');
  const text = body.trim();
  if (text.length < 150 || text.length > 1200) throw invalid('Advice must be 150 to 1200 characters: what you would do and why, in a few sentences.');
  assertNoSecrets(text);
  const b = await queryOne(ctx.pool, `SELECT id, job_id, kind, resolved_at, dismissed_at FROM blockers WHERE id = ?`, [blockerId]);
  if (!b || b.kind !== 'client_decision') throw invalid('No such Client decision.');
  if (b.resolved_at || b.dismissed_at) throw conflict('The Client already decided.');
  await tx(ctx, async (conn) => {
    await exec(conn, `INSERT INTO decision_advice (blocker_id, agent_id, body, created_at) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE body = VALUES(body), created_at = VALUES(created_at)`, [
      blockerId, agent.id, text, ctx.clock.now(),
    ]);
    await emit(conn, ctx, { type: 'decision.advised', jobId: b.job_id, actor: agent.id, targets: [], payload: { blocker_id: blockerId } });
  });
  return { ok: true };
}
