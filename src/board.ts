import type { PoolConnection } from 'mysql2/promise';
import { presenceOf, type Agent, type Presence } from './agents.ts';
import { closePlanReview, planReviewSettled } from './plan-review.ts';
import { POLICY, tx, type Ctx } from './context.ts';
import { exec, json, parseJson, query, queryOne, type Conn, type Row } from './db.ts';
import { emit, waitUntil } from './events.ts';
import { CLIENT, CLOSED, generalThreadId, lockJob } from './jobs.ts';
import { addSeconds, assertNoSecrets, conflict, forbidden, invalid, newId, notFound } from './lib.ts';

export const MESSAGE_TYPES = ['discussion', 'reply', 'proposal', 'progress'] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number] | 'question' | 'decision' | 'review_finding' | 'escalation' | 'dissent';
export const STANCES = ['inform', 'support', 'approve', 'challenge', 'disagree', 'reject'] as const;
export type Stance = (typeof STANCES)[number];
const OBJECTIONS: Stance[] = ['challenge', 'disagree', 'reject'];
export const PRIORITIES = ['normal', 'critical'] as const;
export type Priority = (typeof PRIORITIES)[number];

/** The author of a board write: a registered agent or the human Client. */
export type Author = { kind: 'agent'; agent: Agent } | { kind: 'client' };

const authorId = (a: Author) => (a.kind === 'client' ? CLIENT : a.agent.id);

/** The mention target that puts a message in the Client's inbox. It is not an agent id. */
export const CLIENT_TAG = 'client';

/** The body of a Client message that only asks the mentioned agents for their view. */
export const VIEW_REQUEST_BODY = 'The Client asks for your own view on this thread. Say where you agree and challenge what you disagree with.';

/**
 * Who the Client can ask for a view on a job's thread: someone who will see the mention and can answer.
 * The job's Staff, agents holding a live assignment on the job or its parent's other subjobs, and enabled researchers.
 */
export async function viewCandidates(conn: Conn, jobId: string, now: Date): Promise<{ id: string; nickname: string; role: string }[]> {
  const job = await queryOne(conn, `SELECT id, parent_job_id, staff_agent_id FROM jobs WHERE id = ?`, [jobId]);
  if (!job) return [];
  const root = job.parent_job_id ?? job.id;
  const rows = await query(
    conn,
    `SELECT a.id, a.nickname, a.role FROM agents a WHERE a.id = ?
     UNION
     SELECT a.id, a.nickname, a.role FROM assignments s JOIN jobs j ON j.id = s.job_id JOIN agents a ON a.id = s.owner_agent_id
       WHERE s.status = 'held' AND s.lease_expires_at > ? AND (j.id = ? OR j.parent_job_id = ?)
     UNION
     SELECT a.id, a.nickname, a.role FROM researcher_personas p JOIN agents a ON a.id = p.agent_id WHERE p.enabled = 1`,
    [job.staff_agent_id ?? '', now, root, root],
  );
  return rows.map((r) => ({ id: String(r.id), nickname: String(r.nickname), role: String(r.role) }));
}

/** Thread events that wake an agent and ask it to answer there. A plain message.posted does not wake Staff. */
const ASKING_TYPES = ['mention', 'refinement.client_reply', 'question.opened', 'question.synthesis_requested', 'question.challenged', 'question.late_challenge'];

export type Responder =
  | { agent_id: string; role: 'researcher'; state: 'queued' | 'researching' }
  | { agent_id: string; role: string; state: 'asked'; presence: Presence; asked_at: Date };

/**
 * Who is expected to answer on a thread, for the dashboard. A researcher: an open inbox item for the thread (queued,
 * or claimed by a run). Any other agent: a waking event on the thread that targets it, with no message by it on the
 * thread since (every message, decision and system note goes through insertMessage). Presence is the agent's, not the
 * thread's: an online Staff may be busy with something else.
 */
export async function threadResponders(ctx: Ctx, threadId: string): Promise<Responder[]> {
  const thread = await queryOne(ctx.pool, `SELECT job_id FROM threads WHERE id = ?`, [threadId]);
  if (!thread) return [];
  const research = await query(
    ctx.pool,
    `SELECT p.agent_id, MAX(i.status = 'claimed') AS claimed FROM research_inbox i JOIN researcher_personas p ON p.id = i.persona_id
     WHERE i.thread_id = ? AND i.status IN ('new', 'claimed') AND p.enabled = 1 GROUP BY p.agent_id ORDER BY MIN(i.created_at)`,
    [threadId],
  );
  const out: Responder[] = research.map((r) => ({ agent_id: String(r.agent_id), role: 'researcher', state: Number(r.claimed) ? 'researching' : 'queued' }));
  const events = await query(ctx.pool, `SELECT type, actor, payload, created_at FROM events WHERE job_id = ? AND thread_id = ? AND type IN (?) ORDER BY id`, [
    thread.job_id,
    threadId,
    [...ASKING_TYPES, 'question.deadline_reached'],
  ]);
  // recordJobDecision writes a decision without a message, so decisions count as answers too.
  const said = await query(
    ctx.pool,
    `SELECT author AS who, MAX(received_at) AS at FROM messages WHERE thread_id = ? GROUP BY author
     UNION ALL SELECT decided_by, MAX(created_at) FROM decisions WHERE thread_id = ? GROUP BY decided_by`,
    [threadId, threadId],
  );
  const lastSaid = new Map<string, number>();
  for (const r of said) lastSaid.set(String(r.who), Math.max(lastSaid.get(String(r.who)) ?? 0, (r.at as Date).getTime()));
  const owner = (await queryOne(ctx.pool, `SELECT owner_staff_id FROM questions WHERE thread_id = ?`, [threadId]))?.owner_staff_id as string | undefined;
  const asked = new Map<string, Date>();
  for (const e of events) {
    const at = e.created_at as Date;
    const p = parseJson<{ targets?: string[]; state?: string }>(e.payload);
    // A deadline asks only when it leaves the decision to the owning Staff.
    const targets = e.type === 'question.deadline_reached' ? (p?.state === 'awaiting_staff_decision' && owner ? [owner] : []) : (p?.targets ?? []);
    for (const t of targets) {
      if (t === CLIENT || t === e.actor || asked.has(t) || (lastSaid.get(t) ?? 0) > at.getTime()) continue;
      asked.set(t, at);
    }
  }
  if (!asked.size) return out;
  // Researchers show only through open inbox items, so a deleted or disabled persona is never listed as asked.
  const sessions = await query(
    ctx.pool,
    `SELECT a.id, a.role, s.last_seen_at, s.waiting_until, s.ended_at, s.transcript_at FROM agents a JOIN agent_sessions s ON s.agent_id = a.id
     WHERE a.id IN (?) AND a.role <> 'researcher' ORDER BY s.started_at DESC`,
    [[...asked.keys()]],
  );
  for (const [agentId, at] of asked) {
    const s = sessions.find((r) => r.id === agentId);
    if (!s) continue;
    out.push({ agent_id: agentId, role: String(s.role), state: 'asked', presence: presenceOf(ctx, s as any), asked_at: at });
  }
  return out;
}

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
    priority?: Priority;
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
    `INSERT INTO messages (thread_id, job_id, author, type, stance, priority, reason, body, in_reply_to, mentions, to_client, intended_decision, received_at, timely)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      m.threadId,
      m.jobId,
      m.author,
      m.type,
      m.stance,
      m.priority ?? 'normal',
      m.reason ?? null,
      m.body,
      m.inReplyTo ?? null,
      json(m.mentions ?? []),
      m.mentions?.includes(CLIENT_TAG) ?? false,
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
  priority?: Priority;
  reason?: string | null;
  body: string;
  inReplyTo?: number | null;
  mentions?: string[];
  intendedDecision?: boolean;
  requestId?: string;
}

export async function postMessage(ctx: Ctx, author: Author, input: PostInput) {
  const stance = input.stance ?? 'inform';
  const priority = input.priority ?? 'normal';
  if (!input.body.trim()) throw invalid('The message body is empty.');
  if (stance !== 'inform' && !input.reason?.trim()) throw invalid(`A "${stance}" needs a reason. Give the reason and any evidence.`);
  assertNoSecrets(input.body, input.reason);
  const tagsClient = input.mentions?.includes(CLIENT_TAG) ?? false;
  if (tagsClient && author.kind === 'agent' && author.agent.role === 'researcher') {
    throw forbidden('Researchers advise on the board and do not tag the Client. Staff brings the Client what it needs.');
  }
  if (priority === 'critical') {
    if (!tagsClient) throw invalid('A critical message must be tagged to the client (mentions: ["client"]).');
    if (!input.reason?.trim()) throw invalid('A critical message needs a reason: what is broken, since when, and the current impact.');
  }
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
    // A Client mention asks that agent for its view, so it must be someone who will see it and can answer.
    const asked = author.kind === 'client' ? (input.mentions ?? []).filter((t) => t !== CLIENT_TAG) : [];
    if (asked.length) {
      const can = new Set((await viewCandidates(conn, thread.job_id, now)).map((c) => c.id));
      const cannot = asked.filter((t) => !can.has(t));
      if (cannot.length) throw invalid(`Cannot ask ${cannot.join(', ')} for a view: only the job's Staff, an agent working on the job, or an enabled researcher can answer.`);
    }
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
      priority,
      reason: input.reason,
      body: input.body,
      inReplyTo: input.inReplyTo,
      mentions: input.mentions,
      intendedDecision: input.intendedDecision,
      timely,
      receivedAt: now,
    });
    const payload = { message_id: id, type: input.type, stance, priority, author: actor, excerpt: input.body.slice(0, 200) };
    await emit(conn, ctx, {
      type: input.type === 'proposal' ? 'proposal.posted' : 'message.posted',
      jobId: thread.job_id,
      threadId,
      actor,
      targets: [job?.staff_agent_id, question?.asker].filter((t): t is string => !!t && t !== actor),
      payload,
    });
    for (const target of input.mentions ?? []) {
      if (target === CLIENT_TAG) continue;
      const mention = author.kind === 'client' ? { ...payload, view_requested: true } : payload;
      await emit(conn, ctx, { type: 'mention', jobId: thread.job_id, threadId, actor, targets: [target], payload: mention });
    }
    // The Client answered in the thread, so what was tagged to them there has been read.
    if (author.kind === 'client') {
      await exec(conn, `UPDATE messages SET client_seen_at = ? WHERE thread_id = ? AND to_client = 1 AND client_seen_at IS NULL`, [now, threadId]);
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
    // A closed plan review ends `collected`, and Staff may already have started Seniors on the plan.
    const closedPlanReview =
      question?.state === 'collected' && !!(await queryOne(conn, `SELECT 1 AS p FROM plan_reviews WHERE thread_id = ?`, [threadId]));
    if (question && !timely && OBJECTIONS.includes(stance) && (question.state === 'resolved' || closedPlanReview)) {
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

/** Messages agents tagged to the Client, newest first. Only the ones not read yet, unless includeRead is set. */
export async function clientInbox(ctx: Ctx, includeRead = false) {
  const rows = await query(
    ctx.pool,
    `SELECT m.id, m.thread_id, m.job_id, m.author, m.type, m.priority, m.body, m.received_at, m.client_seen_at, j.linear_identifier, j.title AS job_title, t.title AS thread_title
     FROM messages m JOIN jobs j ON j.id = m.job_id JOIN threads t ON t.id = m.thread_id
     WHERE m.to_client = 1${includeRead ? '' : ' AND m.client_seen_at IS NULL'} ORDER BY (m.priority = 'critical') DESC, m.id DESC LIMIT 100`,
  );
  return rows.map((m): Row => ({ ...m, id: Number(m.id) }));
}

/** Marks tagged messages as read: the given ones, or every unread one when no ids are given. */
export async function markInboxSeen(ctx: Ctx, ids?: number[]) {
  if (ids && ids.length === 0) return { marked: 0 };
  return tx(ctx, async (conn) => {
    const now = ctx.clock.now();
    // An explicit id (an individual Got it, or opening a thread) can clear a critical message. The
    // bulk case (no ids: "Mark all as read") excludes critical ones, however many there are, not just
    // the page clientInbox happens to show: a 100-row display cap must not cap what the bulk action clears.
    const only = ids ? ` AND id IN (?)` : ` AND priority != 'critical'`;
    const res = await exec(conn, `UPDATE messages SET client_seen_at = ? WHERE to_client = 1 AND client_seen_at IS NULL${only}`, ids ? [now, ids] : [now]);
    // An event wakes the other open dashboards, so their counts drop too.
    if (res.affectedRows > 0) await emit(conn, ctx, { type: 'inbox.seen', actor: CLIENT, payload: { count: res.affectedRows } });
    return { marked: res.affectedRows };
  });
}

/** Counts messages in a row: a post by the Client or another agent resets the count. */
async function enforceReplyCap(conn: Conn, threadId: string, agentId: string) {
  const recent = await query(conn, `SELECT author FROM messages WHERE thread_id = ? ORDER BY id DESC LIMIT ${POLICY.maxRepliesPerThread}`, [threadId]);
  if (recent.length === POLICY.maxRepliesPerThread && recent.every((m) => m.author === agentId)) {
    throw conflict(`You already posted ${recent.length} messages in a row in this thread and nobody has replied. Stop here until someone else posts.`);
  }
}

export interface QuestionInput {
  jobId: string;
  title: string;
  /** The agent tool requires these three; the Client may leave them out. */
  summary?: string;
  question: string;
  whyItMatters?: string;
  waitingWork?: string;
  options?: string;
  evidence?: string;
  windowSec?: number;
  requiresStaffDecision?: boolean;
  requestId?: string;
}

/** Opens a timed question. The server owns the clock: deadline = posted_at + window. */
export async function askQuestion(ctx: Ctx, author: Author, input: QuestionInput) {
  return idempotent(ctx, authorId(author), input.requestId, (conn) => openQuestion(conn, ctx, author, input));
}

/** askQuestion inside the caller's transaction, so a caller can write its own rows with the question or not at all. */
export async function openQuestion(conn: Conn, ctx: Ctx, author: Author, input: QuestionInput) {
  if (author.kind === 'agent' && !['senior', 'staff'].includes(author.agent.role)) {
    throw forbidden('Only a Senior, Staff, or the Client may open a timed question. Use post_message for discussion.');
  }
  const windowSec = input.windowSec ?? POLICY.questionWindowDefaultSec;
  if (!Number.isInteger(windowSec) || windowSec < POLICY.questionWindowMinSec || windowSec > POLICY.questionWindowMaxSec) {
    throw invalid(`window_sec must be between ${POLICY.questionWindowMinSec} and ${POLICY.questionWindowMaxSec}.`);
  }
  for (const [field, value] of Object.entries({ title: input.title, question: input.question })) {
    if (!value?.trim()) throw invalid(`${field} is required.`);
  }
  assertNoSecrets(input.title, input.summary, input.question, input.whyItMatters, input.waitingWork, input.options, input.evidence);
  const actor = authorId(author);
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
    input.summary?.trim() ? `- Objective and progress: ${input.summary}` : null,
    job.acceptance_criteria ? `- Acceptance criteria: ${job.acceptance_criteria}` : `- Acceptance criteria: not written yet`,
    input.whyItMatters?.trim() ? `- Why it matters: ${input.whyItMatters}` : null,
    input.waitingWork?.trim() ? `- Work waiting on the answer: ${input.waitingWork}` : null,
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
}

/**
 * Closes the collection window. Idempotent: does nothing before the deadline (except for a plan review every researcher
 * has answered) or after the first run.
 * Reads the durable thread, so a missed notification can never drop a timely reply.
 */
export async function reconcileQuestion(ctx: Ctx, threadId: string): Promise<boolean> {
  const open = await queryOne(ctx.pool, `SELECT deadline_at FROM questions WHERE thread_id = ? AND state = 'collecting'`, [threadId]);
  if (!open) return false;
  if (open.deadline_at > ctx.clock.now()) {
    const pr = await queryOne(ctx.pool, `SELECT 1 AS p FROM plan_reviews WHERE thread_id = ?`, [threadId]);
    if (!pr || !(await planReviewSettled(ctx.pool, threadId))) return false;
  }
  return tx(ctx, async (conn) => {
    const q = await queryOne(conn, `SELECT * FROM questions WHERE thread_id = ? FOR UPDATE`, [threadId]);
    if (!q || q.state !== 'collecting') return false;
    const planReview = !!(await queryOne(conn, `SELECT 1 AS p FROM plan_reviews WHERE thread_id = ?`, [threadId]));
    // A plan review also closes once every researcher it reached has answered; then the cut-off is now.
    const early = q.deadline_at > ctx.clock.now();
    if (early && !(planReview && (await planReviewSettled(conn, threadId)))) return false;
    const cutoff = early ? ctx.clock.now() : q.deadline_at;
    // The window ends now, so a later reply is late (not timely) and an objection in it reaches Staff as a late challenge.
    if (early) await exec(conn, `UPDATE questions SET deadline_at = ? WHERE thread_id = ?`, [cutoff, threadId]);
    const timely =await query(conn, `SELECT * FROM messages WHERE thread_id = ? AND id <> ? AND received_at <= ? ORDER BY id`, [threadId, q.message_id, cutoff]);
    // A plan review never waits on silence: the Seniors start when its window ends.
    if (timely.length === 0 && !planReview) {
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
    let unreviewed = false;
    if (!q.requires_staff_decision) {
      state = 'collected';
    } else {
      const intended = [...timely].reverse().find((m) => m.intended_decision && m.author === q.owner_staff_id);
      const objection = timely.some((m) => OBJECTIONS.includes(m.stance));
      // Silence is not agreement: Staff's answer becomes final on its own only when someone else looked at it.
      // 12 of 19 promoted decisions up to 2026-10-17 had no reply but Staff's.
      unreviewed = !!intended && !objection && !(await reviewedByOthers(conn, q, timely));
      if (intended && !objection && !unreviewed) {
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
    if (planReview) await closePlanReview(conn, ctx, threadId);
    await emit(conn, ctx, {
      type: 'question.deadline_reached',
      jobId: q.job_id,
      threadId,
      actor: 'scheduler',
      targets: [q.asker, q.owner_staff_id].filter((t) => t && t !== CLIENT),
      payload: { state, timely_replies: timely.length, decision_id: promoted, ...(unreviewed ? { unreviewed: true } : {}), ...(planReview ? { plan_review: true, objections: timely.filter((m) => OBJECTIONS.includes(m.stance)).length } : {}) },
    });
    return true;
  });
}

/**
 * Another agent replied in the window, or a researcher run read the question (get_item) and marked it. A Client reply
 * does not count: it may be a question rather than approval, and the Client can decide directly.
 */
async function reviewedByOthers(conn: Conn, q: Row, timely: Row[]) {
  if (timely.some((m) => m.author !== q.owner_staff_id && m.author !== CLIENT)) return true;
  const looked = await queryOne(
    conn,
    `SELECT 1 AS ok FROM research_inbox WHERE thread_id = ? AND kind = 'question' AND status IN ('handled', 'skipped') AND read_at IS NOT NULL AND done_at <= ? LIMIT 1`,
    [q.thread_id, q.deadline_at],
  );
  return !!looked;
}

/** A decision as a Senior sees it: what was decided, by whom, and why. */
export interface ActiveDecision {
  id: string;
  job_id: string;
  authority: 'staff' | 'client';
  created_at: Date;
  body: string;
  rationale: string | null;
}

/**
 * The decisions a Senior on this job should know: those of the job and of its parent (if any), newest first, without
 * the superseded ones. Never siblings or other jobs. Superseded follows getThread's rule (another decision names it in
 * supersedes_decision_id), checked against all decisions of both jobs, so a replacement in another thread still counts.
 */
export async function activeDecisions(conn: Conn, jobId: string): Promise<ActiveDecision[]> {
  const job = await queryOne(conn, `SELECT parent_job_id FROM jobs WHERE id = ?`, [jobId]);
  if (!job) throw notFound(`Job ${jobId}`);
  const jobIds = job.parent_job_id ? [jobId, job.parent_job_id as string] : [jobId];
  const rows = await query(
    conn,
    `SELECT id, job_id, authority, created_at, body, rationale, supersedes_decision_id FROM decisions WHERE job_id IN (?) ORDER BY created_at DESC, id DESC`,
    [jobIds],
  );
  const superseded = new Set(rows.map((d) => d.supersedes_decision_id as string | null).filter(Boolean));
  return rows
    .filter((d) => !superseded.has(d.id as string))
    .map((d) => ({ id: d.id, job_id: d.job_id, authority: d.authority, created_at: d.created_at, body: d.body, rationale: d.rationale ?? null }) as ActiveDecision);
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
    decisions: decisions.map((d) => ({ ...d, superseded: superseded.has(d.id), unreviewed: !!d.unreviewed })),
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
    let unreviewed = false;
    const ids = await query(conn, `SELECT id FROM messages WHERE thread_id = ?`, [thread.id]);
    const known = new Set(ids.map((r) => Number(r.id)));
    const unknown = input.consideredMessageIds.filter((id) => !known.has(id));
    if (unknown.length) throw invalid(`Messages ${unknown.join(', ')} are not in this thread.`);
    if (q) {
      if (q.state === 'collecting') {
        throw conflict(`The response window is still open until ${(q.deadline_at as Date).toISOString()}. Reply with intended_decision instead, or wait.`);
      }
      const timely = await query(conn, `SELECT id, author FROM messages WHERE thread_id = ? AND id <> ? AND received_at <= ?`, [thread.id, q.message_id, q.deadline_at]);
      const missing = timely.map((r) => Number(r.id)).filter((id) => !input.consideredMessageIds.includes(id));
      if (missing.length) throw invalid(`The decision must consider every timely reply. Missing: ${missing.join(', ')}.`);
      unreviewed = author.kind === 'agent' && !(await reviewedByOthers(conn, q, timely));
    }
    if (input.supersedesDecisionId) {
      const prior = await queryOne(conn, `SELECT id FROM decisions WHERE id = ? AND thread_id = ?`, [input.supersedesDecisionId, thread.id]);
      if (!prior) throw invalid(`Decision ${input.supersedesDecisionId} is not in this thread.`);
    }
    const id = newId('dec');
    await exec(
      conn,
      `INSERT INTO decisions (id, thread_id, job_id, decided_by, authority, body, rationale, considered_message_ids, supersedes_decision_id, unreviewed, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, thread.id, thread.job_id, actor, author.kind === 'client' ? 'client' : 'staff', input.body, input.rationale, json(input.consideredMessageIds), input.supersedesDecisionId ?? null, unreviewed, ctx.clock.now()],
    );
    await insertMessage(conn, ctx, { threadId: thread.id, jobId: thread.job_id, author: actor, type: 'decision', stance: 'inform', body: input.body, reason: input.rationale });
    if (q) await exec(conn, `UPDATE questions SET state = 'resolved' WHERE thread_id = ?`, [thread.id]);
    // The agents whose objections this decision lists hear the outcome, so they can accept it or file a dissent.
    // Other objections on the thread are not answered by it and stay open (openObjections).
    const objectors = input.consideredMessageIds.length
      ? (await query(conn, `SELECT DISTINCT author FROM messages WHERE thread_id = ? AND id IN (?) AND stance IN (?)`, [thread.id, input.consideredMessageIds, OBJECTIONS])).map((r) => r.author as string)
      : [];
    await emit(conn, ctx, {
      type: input.supersedesDecisionId ? 'decision.superseded' : 'decision.recorded',
      jobId: thread.job_id,
      threadId: thread.id,
      actor,
      targets: [...new Set([q?.asker, job?.staff_agent_id, ...objectors])].filter((t): t is string => !!t && t !== actor && t !== CLIENT),
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

type BoardFilter = { jobId?: string; openQuestionsOnly?: boolean };

function boardFilter(opts: BoardFilter) {
  const params: unknown[] = [];
  let where = '1=1';
  if (opts.jobId) {
    where += ' AND t.job_id = ?';
    params.push(opts.jobId);
  }
  if (opts.openQuestionsOnly) where += ` AND q.state IN ('collecting', 'awaiting_staff_decision')`;
  return { where, params };
}

/** Compact listing across all jobs, the thread with the newest message first. Researchers read this to decide where to engage. */
export async function listBoard(conn: Conn, opts: BoardFilter & { limit?: number; offset?: number }) {
  const { where, params } = boardFilter(opts);
  const rows = await query(
    conn,
    `SELECT t.id AS thread_id, t.kind, t.title, t.job_id, j.linear_identifier, j.title AS job_title, j.status AS job_status,
       q.state AS question_state, q.deadline_at, q.asker,
       (SELECT COUNT(*) FROM messages m WHERE m.thread_id = t.id) AS messages,
       (SELECT MAX(m.received_at) FROM messages m WHERE m.thread_id = t.id) AS last_message_at,
       (SELECT LEFT(m.body, 300) FROM messages m WHERE m.thread_id = t.id ORDER BY m.id LIMIT 1) AS first_message
     FROM threads t JOIN jobs j ON j.id = t.job_id LEFT JOIN questions q ON q.thread_id = t.id
     WHERE ${where} HAVING messages > 0 ORDER BY last_message_at DESC, t.id DESC LIMIT ${Math.min(opts.limit ?? 30, 200)} OFFSET ${Math.max(opts.offset ?? 0, 0)}`,
    params,
  );
  return rows;
}

/** How many threads with a message the board has, for paging. */
export async function countBoard(conn: Conn, opts: BoardFilter): Promise<number> {
  const { where, params } = boardFilter(opts);
  const row = await queryOne(
    conn,
    `SELECT COUNT(*) AS n FROM threads t JOIN jobs j ON j.id = t.job_id LEFT JOIN questions q ON q.thread_id = t.id
     WHERE ${where} AND EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = t.id)`,
    params,
  );
  return Number(row?.n ?? 0);
}

export async function dueQuestions(conn: Conn, now: Date): Promise<string[]> {
  const rows = await query(
    conn,
    `SELECT q.thread_id FROM questions q WHERE q.state = 'collecting' AND (q.deadline_at <= ? OR q.thread_id IN (
       SELECT pr.thread_id FROM plan_reviews pr WHERE pr.state = 'open' AND pr.thread_id IS NOT NULL
         AND EXISTS (SELECT 1 FROM research_inbox i WHERE i.thread_id = pr.thread_id AND i.kind = 'question')
         AND NOT EXISTS (SELECT 1 FROM research_inbox i WHERE i.thread_id = pr.thread_id AND i.kind = 'question' AND i.status IN ('new', 'claimed'))))`,
    [now],
  );
  return rows.map((r) => r.thread_id as string);
}

export type { Row };

/**
 * Objections by agents other than Staff that nobody with authority has answered yet: no Staff or Client reply to it
 * (in_reply_to, or a later message on the thread that mentions its author), and no decision that lists it.
 * Derived from the board, so an answer anywhere in the record closes it.
 */
export async function openObjections(conn: Conn, jobId: string) {
  const rows = await query(
    conn,
    `SELECT m.id, m.thread_id, m.author, m.stance, m.reason, LEFT(m.body, 300) AS excerpt, m.received_at, t.title AS thread_title
     FROM messages m JOIN agents a ON a.id = m.author JOIN threads t ON t.id = m.thread_id
     WHERE m.job_id = ? AND m.stance IN (?) AND m.type <> 'dissent' AND a.role <> 'staff'
       AND NOT EXISTS (
         SELECT 1 FROM messages r LEFT JOIN agents ra ON ra.id = r.author
         WHERE r.thread_id = m.thread_id AND r.id > m.id AND (ra.role = 'staff' OR r.author = ?)
           AND (r.in_reply_to = m.id OR JSON_CONTAINS(r.mentions, JSON_QUOTE(m.author))))
       AND NOT EXISTS (SELECT 1 FROM decisions d WHERE d.thread_id = m.thread_id AND JSON_CONTAINS(d.considered_message_ids, CAST(m.id AS JSON)))
     ORDER BY m.id`,
    [jobId, OBJECTIONS, CLIENT],
  );
  return rows.map((r): Row => ({ ...r, id: Number(r.id) }));
}

/**
 * Any agent but the deciding Staff may put one dissent per decision on record. It goes to the Client's inbox next to
 * Staff's rationale, so a disagreement with Staff does not depend on Staff choosing to escalate it.
 */
export async function fileDissent(ctx: Ctx, agent: Agent, input: { decisionId: string; reason: string }) {
  const reason = input.reason.trim();
  if (reason.length < 50 || reason.length > 1200) throw invalid('Give the reason in 50 to 1200 characters: what is wrong, your evidence, and what you would do instead.');
  assertNoSecrets(reason);
  return tx(ctx, async (conn) => {
    const d = await queryOne(conn, `SELECT * FROM decisions WHERE id = ?`, [input.decisionId]);
    if (!d) throw notFound(`Decision ${input.decisionId}`);
    const job = await lockJob(conn, d.job_id);
    if (CLOSED.includes(job.status)) throw conflict(`Job ${job.id} is ${job.status}.`);
    if (d.authority === 'client') throw forbidden('The Client made this decision. Post on the thread if you have new facts.');
    if (d.decided_by === agent.id) throw forbidden('You made this decision. Supersede it with record_decision if you changed your mind.');
    const newer = await queryOne(conn, `SELECT id FROM decisions WHERE supersedes_decision_id = ?`, [d.id]);
    if (newer) throw conflict(`Decision ${d.id} was superseded by ${newer.id}.`);
    try {
      await exec(conn, `INSERT INTO dissents (decision_id, agent_id, created_at) VALUES (?, ?, ?)`, [d.id, agent.id, ctx.clock.now()]);
    } catch (error) {
      if ((error as { code?: string }).code === 'ER_DUP_ENTRY') throw conflict('You already filed a dissent on this decision.');
      throw error;
    }
    const messageId = await insertMessage(conn, ctx, {
      threadId: d.thread_id,
      jobId: d.job_id,
      author: agent.id,
      type: 'dissent',
      stance: 'disagree',
      reason,
      body: reason,
      mentions: [CLIENT_TAG],
    });
    await exec(conn, `UPDATE dissents SET message_id = ? WHERE decision_id = ? AND agent_id = ?`, [messageId, d.id, agent.id]);
    await emit(conn, ctx, {
      type: 'decision.dissent',
      jobId: d.job_id,
      threadId: d.thread_id,
      actor: agent.id,
      targets: [job.staff_agent_id].filter((t): t is string => !!t),
      payload: { decision_id: d.id, message_id: messageId },
    });
    return { message_id: messageId, thread_id: d.thread_id };
  });
}
