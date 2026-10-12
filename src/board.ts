import type { PoolConnection } from 'mysql2/promise';
import type { Agent } from './agents.ts';
import { POLICY, tx, type Ctx } from './context.ts';
import { exec, json, parseJson, query, queryOne, type Conn, type Row } from './db.ts';
import { emit, waitUntil } from './events.ts';
import { CLIENT, CLOSED, generalThreadId, lockJob } from './jobs.ts';
import { addSeconds, assertNoSecrets, conflict, forbidden, invalid, newId, notFound } from './lib.ts';

export const MESSAGE_TYPES = ['discussion', 'reply', 'proposal', 'progress'] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number] | 'question' | 'decision' | 'review_finding' | 'escalation';
export const STANCES = ['inform', 'support', 'approve', 'challenge', 'disagree', 'reject'] as const;
export type Stance = (typeof STANCES)[number];
const OBJECTIONS: Stance[] = ['challenge', 'disagree', 'reject'];

/** The author of a board write: a registered agent or the human Client. */
export type Author = { kind: 'agent'; agent: Agent } | { kind: 'client' };

const authorId = (a: Author) => (a.kind === 'client' ? CLIENT : a.agent.id);

/**
 * Makes a write idempotent per author and request_id. The placeholder row is inserted inside the
 * write's transaction, so a concurrent duplicate waits on the row lock and then sees the response.
 */
async function idempotent<T>(ctx: Ctx, actor: string, requestId: string | undefined, fn: (conn: PoolConnection) => Promise<T>): Promise<T> {
  if (!requestId) return tx(ctx, fn);
  const prior = await queryOne(ctx.pool, `SELECT response FROM idempotency WHERE actor = ? AND request_id = ?`, [actor, requestId]);
  if (prior) return parseJson<T>(prior.response);
  try {
    return await tx(ctx, async (conn) => {
      await exec(conn, `INSERT INTO idempotency (actor, request_id, response, created_at) VALUES (?, ?, 'null', ?)`, [actor, requestId, ctx.clock.now()]);
      const result = await fn(conn);
      await exec(conn, `UPDATE idempotency SET response = ? WHERE actor = ? AND request_id = ?`, [json(result), actor, requestId]);
      return result;
    });
  } catch (error) {
    if ((error as { code?: string }).code === 'ER_DUP_ENTRY') {
      const row = await queryOne(ctx.pool, `SELECT response FROM idempotency WHERE actor = ? AND request_id = ?`, [actor, requestId]);
      if (row) return parseJson<T>(row.response);
    }
    throw error;
  }
}

async function insertMessage(
  conn: Conn,
  ctx: Ctx,
  m: {
    threadId: string;
    jobId: string;
    author: string;
    type: MessageType;
    stance: Stance;
    reason?: string | null;
    body: string;
    inReplyTo?: number | null;
    mentions?: string[];
    intendedDecision?: boolean;
    timely?: boolean | null;
    receivedAt?: Date;
  },
): Promise<number> {
  const result = await exec(
    conn,
    `INSERT INTO messages (thread_id, job_id, author, type, stance, reason, body, in_reply_to, mentions, intended_decision, received_at, timely)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      m.threadId,
      m.jobId,
      m.author,
      m.type,
      m.stance,
      m.reason ?? null,
      m.body,
      m.inReplyTo ?? null,
      json(m.mentions ?? []),
      m.intendedDecision ?? false,
      m.receivedAt ?? ctx.clock.now(),
      m.timely ?? null,
    ],
  );
  return result.insertId;
}

/** Board message used by other modules (blockers, reviews) so the board stays the full history. */
export async function systemMessage(conn: Conn, ctx: Ctx, jobId: string, author: string, type: MessageType, body: string, threadId?: string) {
  const thread = threadId ?? (await generalThreadId(conn, jobId));
  await insertMessage(conn, ctx, { threadId: thread, jobId, author, type, stance: 'inform', body });
  return thread;
}

export interface PostInput {
  jobId?: string;
  threadId?: string;
  type: (typeof MESSAGE_TYPES)[number];
  stance?: Stance;
  reason?: string | null;
  body: string;
  inReplyTo?: number | null;
  mentions?: string[];
  intendedDecision?: boolean;
  requestId?: string;
}

export async function postMessage(ctx: Ctx, author: Author, input: PostInput) {
  const stance = input.stance ?? 'inform';
  if (!input.body.trim()) throw invalid('The message body is empty.');
  if (stance !== 'inform' && !input.reason?.trim()) throw invalid(`A "${stance}" needs a reason. Give the reason and any evidence.`);
  assertNoSecrets(input.body, input.reason);
  const actor = authorId(author);
  return idempotent(ctx, actor, input.requestId, async (conn) => {
    let threadId = input.threadId;
    if (!threadId) {
      if (!input.jobId) throw invalid('Give job_id or thread_id.');
      threadId = await generalThreadId(conn, input.jobId);
    }
    const thread = await queryOne(conn, `SELECT * FROM threads WHERE id = ?`, [threadId]);
    if (!thread) throw notFound(`Thread ${threadId}`);
    const job = await queryOne(conn, `SELECT * FROM jobs WHERE id = ?`, [thread.job_id]);
    const question = await queryOne(conn, `SELECT * FROM questions WHERE thread_id = ? FOR UPDATE`, [threadId]);
    if (input.inReplyTo) {
      const parent = await queryOne(conn, `SELECT id FROM messages WHERE id = ? AND thread_id = ?`, [input.inReplyTo, threadId]);
      if (!parent) throw invalid(`Message ${input.inReplyTo} is not in thread ${threadId}.`);
    }
    if (author.kind === 'agent') await enforceReplyCap(conn, threadId, author.agent.id);
    const now = ctx.clock.now();
    let timely: boolean | null = null;
    if (question) timely = now <= question.deadline_at;
    if (input.intendedDecision) {
      if (!question) throw invalid('intended_decision applies to replies on a timed question.');
      if (author.kind !== 'agent' || author.agent.id !== question.owner_staff_id) throw forbidden('Only the owning Staff agent can mark a reply as its intended decision.');
      if (!timely) throw conflict('The response window has closed. Use record_decision instead.');
    }
    const id = await insertMessage(conn, ctx, {
      threadId,
      jobId: thread.job_id,
      author: actor,
      type: input.type,
      stance,
      reason: input.reason,
      body: input.body,
      inReplyTo: input.inReplyTo,
      mentions: input.mentions,
      intendedDecision: input.intendedDecision,
      timely,
      receivedAt: now,
    });
    const payload = { message_id: id, type: input.type, stance, author: actor, excerpt: input.body.slice(0, 200) };
    await emit(conn, ctx, {
      type: input.type === 'proposal' ? 'proposal.posted' : 'message.posted',
      jobId: thread.job_id,
      threadId,
      actor,
      targets: [job?.staff_agent_id, question?.asker].filter((t): t is string => !!t && t !== actor),
      payload,
    });
    for (const target of input.mentions ?? []) {
      await emit(conn, ctx, { type: 'mention', jobId: thread.job_id, threadId, actor, targets: [target], payload });
    }
    if (job?.status === 'refining' && author.kind === 'agent' && author.agent.role === 'staff') {
      // Staff's open questions and proposals reach the Client's activity feed; the Client answers in the dashboard.
      await emit(conn, ctx, { type: 'refinement.staff_posted', jobId: thread.job_id, threadId, actor, targets: [], payload });
    }
    if (job?.status === 'refining' && author.kind === 'client') {
      // A reply typed in an ordinary thread box counts as an answer, the same as the refine panel: it wakes Staff.
      await emit(conn, ctx, { type: 'refinement.client_reply', jobId: thread.job_id, threadId, actor, targets: [job.staff_agent_id].filter((t): t is string => !!t), payload: { excerpt: input.body.slice(0, 200), edited: [] } });
    }
    // An objection inside the window reaches Staff now, so it can answer in the thread while the challenger can still reply.
    if (question && timely && question.state === 'collecting' && question.requires_staff_decision && OBJECTIONS.includes(stance) && question.owner_staff_id && question.owner_staff_id !== actor) {
      await emit(conn, ctx, {
        type: 'question.challenged',
        jobId: thread.job_id,
        threadId,
        actor,
        targets: [question.owner_staff_id],
        payload: { message_id: id, stance, author: actor, deadline_at: new Date(question.deadline_at).toISOString() },
      });
    }
    if (question && !timely && OBJECTIONS.includes(stance) && question.state === 'resolved') {
      await emit(conn, ctx, {
        type: 'question.late_challenge',
        jobId: thread.job_id,
        threadId,
        actor,
        targets: [question.owner_staff_id].filter(Boolean),
        payload: { message_id: id, stance },
      });
    }
    return { message_id: id, thread_id: threadId, timely };
  });
}

async function enforceReplyCap(conn: Conn, threadId: string, agentId: string) {
  const mine = await query(conn, `SELECT id FROM messages WHERE thread_id = ? AND author = ? ORDER BY id`, [threadId, agentId]);
  if (mine.length < POLICY.maxRepliesPerThread) return;
  const lastMine = mine[mine.length - 1]!.id;
  const addressed = await queryOne(
    conn,
    `SELECT id FROM messages WHERE thread_id = ? AND id > ? AND (JSON_CONTAINS(mentions, JSON_QUOTE(?)) OR in_reply_to IN (SELECT id FROM messages WHERE author = ? AND thread_id = ?)) LIMIT 1`,
    [threadId, lastMine, agentId, agentId, threadId],
  );
  if (!addressed) {
    throw conflict(`You already posted ${mine.length} messages in this thread and nobody has addressed you since. Stop here unless someone mentions you.`);
  }
}

export interface QuestionInput {
  jobId: string;
  title: string;
  summary: string;
  question: string;
  whyItMatters: string;
  waitingWork: string;
  options?: string;
  evidence?: string;
  windowSec?: number;
  requiresStaffDecision?: boolean;
  requestId?: string;
}

/** Opens a timed question. The server owns the clock: deadline = posted_at + window. */
export async function askQuestion(ctx: Ctx, author: Author, input: QuestionInput) {
  if (author.kind === 'agent' && !['senior', 'staff'].includes(author.agent.role)) {
    throw forbidden('Only a Senior, Staff, or the Client may open a timed question. Use post_message for discussion.');
  }
  const windowSec = input.windowSec ?? POLICY.questionWindowDefaultSec;
  if (!Number.isInteger(windowSec) || windowSec < POLICY.questionWindowMinSec || windowSec > POLICY.questionWindowMaxSec) {
    throw invalid(`window_sec must be between ${POLICY.questionWindowMinSec} and ${POLICY.questionWindowMaxSec}.`);
  }
  for (const [field, value] of Object.entries({ title: input.title, summary: input.summary, question: input.question, why_it_matters: input.whyItMatters, waiting_work: input.waitingWork })) {
    if (!value?.trim()) throw invalid(`${field} is required so that an agent new to this job can help.`);
  }
  assertNoSecrets(input.title, input.summary, input.question, input.whyItMatters, input.waitingWork, input.options, input.evidence);
  const actor = authorId(author);
  return idempotent(ctx, actor, input.requestId, async (conn) => {
    const job = await lockJob(conn, input.jobId);
    if (CLOSED.includes(job.status)) throw conflict(`Job ${job.id} is ${job.status}.`);
    const parent = job.parent_job_id ? await queryOne(conn, `SELECT linear_identifier, title FROM jobs WHERE id = ?`, [job.parent_job_id]) : null;
    const now = ctx.clock.now();
    const deadline = addSeconds(now, windowSec);
    const threadId = newId('thr');
    const requiresStaff = input.requiresStaffDecision ?? true;
    await exec(conn, `INSERT INTO threads (id, job_id, kind, title, created_by, created_at) VALUES (?, ?, 'question', ?, ?, ?)`, [threadId, job.id, input.title, actor, now]);
    const body = [
      `QUESTION: ${input.question}`,
      ``,
      `Context for helpers new to this job:`,
      `- Job: ${job.id}, Linear ${job.linear_identifier} (${job.linear_url}): ${job.title}`,
      parent ? `- Sub-issue of ${parent.linear_identifier}: ${parent.title}` : `- Top-level ticket`,
      `- Asked by: ${actor}; owning Staff: ${job.staff_agent_id ?? 'none'}`,
      `- Thread: ${threadId}; window ${windowSec}s; deadline ${deadline.toISOString()}`,
      `- Objective and progress: ${input.summary}`,
      job.acceptance_criteria ? `- Acceptance criteria: ${job.acceptance_criteria}` : `- Acceptance criteria: not written yet`,
      `- Why it matters: ${input.whyItMatters}`,
      `- Work waiting on the answer: ${input.waitingWork}`,
      input.options ? `- Options considered: ${input.options}` : null,
      input.evidence ? `- Evidence: ${input.evidence}` : null,
      requiresStaff ? `- Needs a Staff decision before dependent work continues.` : `- Information request; no Staff decision required.`,
    ]
      .filter((l) => l !== null)
      .join('\n');
    const messageId = await insertMessage(conn, ctx, { threadId, jobId: job.id, author: actor, type: 'question', stance: 'inform', body, timely: true });
    await exec(
      conn,
      `INSERT INTO questions (thread_id, job_id, message_id, asker, owner_staff_id, window_sec, posted_at, deadline_at, requires_staff_decision, state, linear_updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'collecting', ?)`,
      [threadId, job.id, messageId, actor, job.staff_agent_id, windowSec, now, deadline, requiresStaff, job.linear_updated_at],
    );
    await emit(conn, ctx, {
      type: 'question.opened',
      jobId: job.id,
      threadId,
      actor,
      targets: [job.staff_agent_id].filter((t) => t && t !== actor),
      payload: { title: input.title, question: input.question, deadline_at: deadline.toISOString(), window_sec: windowSec, linear: job.linear_identifier },
    });
    return { thread_id: threadId, message_id: messageId, posted_at: now, deadline_at: deadline };
  });
}

/**
 * Closes the collection window. Idempotent: does nothing before the deadline or after the first run.
 * Reads the durable thread, so a missed notification can never drop a timely reply.
 */
export async function reconcileQuestion(ctx: Ctx, threadId: string): Promise<boolean> {
  const due = await queryOne(ctx.pool, `SELECT 1 AS due FROM questions WHERE thread_id = ? AND state = 'collecting' AND deadline_at <= ?`, [threadId, ctx.clock.now()]);
  if (!due) return false;
  return tx(ctx, async (conn) => {
    const q = await queryOne(conn, `SELECT * FROM questions WHERE thread_id = ? FOR UPDATE`, [threadId]);
    if (!q || q.state !== 'collecting' || q.deadline_at > ctx.clock.now()) return false;
    const timely = await query(conn, `SELECT * FROM messages WHERE thread_id = ? AND id <> ? AND received_at <= ? ORDER BY id`, [threadId, q.message_id, q.deadline_at]);
    if (timely.length === 0) {
      // Nobody answered: keep collecting for another full window instead of closing on silence.
      const deadline = addSeconds(q.deadline_at as Date, Number(q.window_sec));
      await exec(conn, `UPDATE questions SET deadline_at = ? WHERE thread_id = ?`, [deadline, threadId]);
      await emit(conn, ctx, {
        type: 'question.extended',
        jobId: q.job_id,
        threadId,
        actor: 'scheduler',
        targets: [q.asker, q.owner_staff_id].filter((t) => t && t !== CLIENT),
        payload: { deadline_at: deadline.toISOString(), reason: 'No replies before the deadline.' },
      });
      return false;
    }
    let state: string;
    let promoted: string | null = null;
    if (!q.requires_staff_decision) {
      state = 'collected';
    } else {
      const intended = [...timely].reverse().find((m) => m.intended_decision && m.author === q.owner_staff_id);
      const objection = timely.some((m) => OBJECTIONS.includes(m.stance));
      if (intended && !objection) {
        promoted = newId('dec');
        await exec(
          conn,
          `INSERT INTO decisions (id, thread_id, job_id, decided_by, authority, body, rationale, considered_message_ids, created_at)
           VALUES (?, ?, ?, ?, 'staff', ?, ?, ?, ?)`,
          [promoted, threadId, q.job_id, q.owner_staff_id, intended.body, 'Intended decision posted during the window; no timely objection.', json(timely.map((m) => Number(m.id))), ctx.clock.now()],
        );
        state = 'resolved';
      } else {
        state = 'awaiting_staff_decision';
      }
    }
    await exec(conn, `UPDATE questions SET state = ? WHERE thread_id = ?`, [state, threadId]);
    await emit(conn, ctx, {
      type: 'question.deadline_reached',
      jobId: q.job_id,
      threadId,
      actor: 'scheduler',
      targets: [q.asker, q.owner_staff_id].filter((t) => t && t !== CLIENT),
      payload: { state, timely_replies: timely.length, decision_id: promoted },
    });
    return true;
  });
}

export async function getThread(conn: Conn, threadId: string) {
  const thread = await queryOne(conn, `SELECT * FROM threads WHERE id = ?`, [threadId]);
  if (!thread) throw notFound(`Thread ${threadId}`);
  const job = await queryOne(conn, `SELECT id, linear_identifier, linear_url, title, status, staff_agent_id, linear_updated_at FROM jobs WHERE id = ?`, [thread.job_id]);
  const messages = (await query(conn, `SELECT * FROM messages WHERE thread_id = ? ORDER BY id`, [threadId])).map((m): Row => ({
    ...m,
    id: Number(m.id),
    mentions: parseJson<string[]>(m.mentions),
  }));
  const question = await queryOne(conn, `SELECT * FROM questions WHERE thread_id = ?`, [threadId]);
  const decisions = (await query(conn, `SELECT * FROM decisions WHERE thread_id = ? ORDER BY created_at`, [threadId])).map((d): Row => ({
    ...d,
    considered_message_ids: parseJson<number[]>(d.considered_message_ids),
  }));
  const superseded = new Set(decisions.map((d) => d.supersedes_decision_id).filter(Boolean));
  const ticketChanged =
    question && job?.linear_updated_at && question.linear_updated_at
      ? (job.linear_updated_at as Date).getTime() !== (question.linear_updated_at as Date).getTime()
      : false;
  return {
    thread,
    job,
    question: question ? ({ ...question, remaining_sec: null as number | null } as Row) : null,
    messages,
    decisions: decisions.map((d) => ({ ...d, superseded: superseded.has(d.id) })),
    current_decision: decisions.filter((d) => !superseded.has(d.id)).at(-1) ?? null,
    ticket_changed_since_posted: ticketChanged,
  };
}

export async function readThread(ctx: Ctx, threadId: string) {
  const t = await getThread(ctx.pool, threadId);
  if (t.question) t.question.remaining_sec = Math.max(0, Math.ceil(((t.question.deadline_at as Date).getTime() - ctx.clock.now().getTime()) / 1000));
  return t;
}

/** Returns once the window has closed and been reconciled, never earlier. */
export async function awaitQuestion(ctx: Ctx, agent: Agent, threadId: string, maxWaitSec: number, signal?: AbortSignal, onTick?: () => void) {
  const q = await queryOne(ctx.pool, `SELECT asker FROM questions WHERE thread_id = ?`, [threadId]);
  if (!q) throw notFound(`Question ${threadId}`);
  const ready = await waitUntil(
    ctx,
    async () => {
      await reconcileQuestion(ctx, threadId);
      const row = await queryOne(ctx.pool, `SELECT state FROM questions WHERE thread_id = ?`, [threadId]);
      return row && row.state !== 'collecting' ? row.state : null;
    },
    { maxWaitSec, signal, onTick },
  );
  const thread = await readThread(ctx, threadId);
  return { window_closed: ready !== null, state: thread.question!.state, thread };
}

export async function recordDecision(
  ctx: Ctx,
  author: Author,
  input: { threadId: string; body: string; rationale: string; consideredMessageIds: number[]; supersedesDecisionId?: string; requestId?: string },
) {
  assertNoSecrets(input.body, input.rationale);
  if (!input.rationale?.trim()) throw invalid('A decision needs a rationale.');
  const actor = authorId(author);
  return idempotent(ctx, actor, input.requestId, async (conn) => {
    const thread = await queryOne(conn, `SELECT * FROM threads WHERE id = ?`, [input.threadId]);
    if (!thread) throw notFound(`Thread ${input.threadId}`);
    const job = await queryOne(conn, `SELECT * FROM jobs WHERE id = ?`, [thread.job_id]);
    if (author.kind === 'agent' && (author.agent.role !== 'staff' || job?.staff_agent_id !== author.agent.id)) {
      throw forbidden('Only the owning Staff agent or the Client records decisions. Post your view as a reply with a stance.');
    }
    const q = await queryOne(conn, `SELECT * FROM questions WHERE thread_id = ? FOR UPDATE`, [thread.id]);
    const ids = await query(conn, `SELECT id FROM messages WHERE thread_id = ?`, [thread.id]);
    const known = new Set(ids.map((r) => Number(r.id)));
    const unknown = input.consideredMessageIds.filter((id) => !known.has(id));
    if (unknown.length) throw invalid(`Messages ${unknown.join(', ')} are not in this thread.`);
    if (q) {
      if (q.state === 'collecting') {
        throw conflict(`The response window is still open until ${(q.deadline_at as Date).toISOString()}. Reply with intended_decision instead, or wait.`);
      }
      const timely = await query(conn, `SELECT id FROM messages WHERE thread_id = ? AND id <> ? AND received_at <= ?`, [thread.id, q.message_id, q.deadline_at]);
      const missing = timely.map((r) => Number(r.id)).filter((id) => !input.consideredMessageIds.includes(id));
      if (missing.length) throw invalid(`The decision must consider every timely reply. Missing: ${missing.join(', ')}.`);
    }
    if (input.supersedesDecisionId) {
      const prior = await queryOne(conn, `SELECT id FROM decisions WHERE id = ? AND thread_id = ?`, [input.supersedesDecisionId, thread.id]);
      if (!prior) throw invalid(`Decision ${input.supersedesDecisionId} is not in this thread.`);
    }
    const id = newId('dec');
    await exec(
      conn,
      `INSERT INTO decisions (id, thread_id, job_id, decided_by, authority, body, rationale, considered_message_ids, supersedes_decision_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, thread.id, thread.job_id, actor, author.kind === 'client' ? 'client' : 'staff', input.body, input.rationale, json(input.consideredMessageIds), input.supersedesDecisionId ?? null, ctx.clock.now()],
    );
    await insertMessage(conn, ctx, { threadId: thread.id, jobId: thread.job_id, author: actor, type: 'decision', stance: 'inform', body: input.body, reason: input.rationale });
    if (q) await exec(conn, `UPDATE questions SET state = 'resolved' WHERE thread_id = ?`, [thread.id]);
    await emit(conn, ctx, {
      type: input.supersedesDecisionId ? 'decision.superseded' : 'decision.recorded',
      jobId: thread.job_id,
      threadId: thread.id,
      actor,
      targets: [q?.asker, job?.staff_agent_id].filter((t): t is string => !!t && t !== actor && t !== CLIENT),
      payload: { decision_id: id, body: input.body.slice(0, 200), supersedes: input.supersedesDecisionId ?? null },
    });
    return { decision_id: id };
  });
}

export async function requestStaffSynthesis(ctx: Ctx, agent: Agent, input: { threadId: string; reason: string }) {
  return tx(ctx, async (conn) => {
    const q = await queryOne(conn, `SELECT * FROM questions WHERE thread_id = ? FOR UPDATE`, [input.threadId]);
    if (!q) throw notFound(`Question ${input.threadId}`);
    if (q.asker !== agent.id) throw forbidden('Only the asker requests a Staff synthesis.');
    if (q.state === 'collecting') throw conflict('The window is still open. Wait for the deadline.');
    if (q.state === 'awaiting_staff_decision') return { state: q.state };
    await exec(conn, `UPDATE questions SET state = 'awaiting_staff_decision' WHERE thread_id = ?`, [q.thread_id]);
    await insertMessage(conn, ctx, { threadId: q.thread_id, jobId: q.job_id, author: agent.id, type: 'reply', stance: 'inform', body: `Requesting a Staff decision: ${input.reason}` });
    await emit(conn, ctx, { type: 'question.synthesis_requested', jobId: q.job_id, threadId: q.thread_id, actor: agent.id, targets: [q.owner_staff_id], payload: { reason: input.reason } });
    return { state: 'awaiting_staff_decision' };
  });
}

/** Compact listing across all jobs. Researchers read this to decide where to engage. */
export async function listBoard(conn: Conn, opts: { jobId?: string; limit?: number; openQuestionsOnly?: boolean }) {
  const params: unknown[] = [];
  let where = '1=1';
  if (opts.jobId) {
    where += ' AND t.job_id = ?';
    params.push(opts.jobId);
  }
  if (opts.openQuestionsOnly) where += ` AND q.state IN ('collecting', 'awaiting_staff_decision')`;
  const rows = await query(
    conn,
    `SELECT t.id AS thread_id, t.kind, t.title, t.job_id, j.linear_identifier, j.title AS job_title, j.status AS job_status,
       q.state AS question_state, q.deadline_at, q.asker,
       (SELECT COUNT(*) FROM messages m WHERE m.thread_id = t.id) AS messages,
       (SELECT MAX(m.received_at) FROM messages m WHERE m.thread_id = t.id) AS last_message_at,
       (SELECT LEFT(m.body, 300) FROM messages m WHERE m.thread_id = t.id ORDER BY m.id LIMIT 1) AS first_message
     FROM threads t JOIN jobs j ON j.id = t.job_id LEFT JOIN questions q ON q.thread_id = t.id
     WHERE ${where} HAVING messages > 0 ORDER BY last_message_at DESC LIMIT ${Math.min(opts.limit ?? 30, 200)}`,
    params,
  );
  return rows;
}

export async function dueQuestions(conn: Conn, now: Date): Promise<string[]> {
  return (await query(conn, `SELECT thread_id FROM questions WHERE state = 'collecting' AND deadline_at <= ?`, [now])).map((r) => r.thread_id as string);
}

export type { Row };
