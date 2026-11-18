import { z } from 'zod';
import type { Agent } from './agents.ts';
import { postMessageTx, type Author } from './board.ts';
import { raiseBlockerTx, resolveBlockerTx } from './blockers.ts';
import { tx, type Ctx } from './context.ts';
import { exec, query, queryOne, type Conn } from './db.ts';
import { REPO_SLUG } from './design.ts';
import { cardOfJob } from './card-links.ts';
import { initiativeById, versionOf } from './initiatives.ts';
import { assertNoSecrets, conflict, forbidden, invalid, newId, notFound } from './lib.ts';
import { CLIENT, generalThreadId, lockJob } from './jobs.ts';

/**
 * The Architect answers a Staff question on a job of its own initiative (docs/plans/initiative-room.md, phase 3). An
 * answer needs a citation: a decision of the current design, or a line of a repository file at a commit. A decision is
 * checked here. A code line is read by the runner (a quote_check launch: `git -C <repo> show <sha>:<path>`, no shell)
 * and the answer is posted only when the quote is on that line. A refused answer is never posted.
 *
 * An answer may also be given to a client_decision blocker: the answer is posted on the job's General thread and resolves
 * the blocker, marked delegated (the blocker's resolver is the Architect). The Client can Reopen it until Staff's next
 * message, and then it is an escalation again. An escalation is the Architect's recommendation, put to the Client as a
 * client_decision blocker: Accept posts it as the Client's answer and resolves the blocker in one click.
 */

/** A full commit id, lower case. */
const SHA = /^[0-9a-f]{40}$/;
/** A path inside a repository: relative, plain characters, and no empty, "." or ".." segment. */
export const QUOTE_PATH = /^(?!\/)[A-Za-z0-9._@+/-]{1,300}$/;
const segmentsOk = (p: string) => p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
const ANSWER_MAX = 4000;
const QUOTE_MAX = 500;
/** The same text after collapsing whitespace, so a quote matches a line whatever its indentation. */
const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

export const CitationSchema = z.union([
  z.object({ decision: z.string().regex(/^D\d{1,4}$/) }).strict(),
  z
    .object({
      code: z
        .object({
          repo: z.string().regex(REPO_SLUG),
          path: z.string().max(300).refine((p) => QUOTE_PATH.test(p) && segmentsOk(p), 'a repository-relative path'),
          line: z.number().int().min(1).max(1_000_000),
          sha: z.string().regex(SHA, 'a full 40-character commit id'),
          quote: z.string().min(1).max(QUOTE_MAX),
        })
        .strict(),
    })
    .strict(),
]);
export type Citation = z.infer<typeof CitationSchema>;

type AnswerRow = { id: string; initiative_id: string; job_id: string; thread_id: string; answer: string; citation: unknown; state: string; target: string; blocker_id: string | null; message_id: number | null };

const parseCitation = (v: unknown): Citation | null => {
  const c = typeof v === 'string' ? JSON.parse(v) : v;
  return c && (('decision' in c) || ('code' in c)) ? (c as Citation) : null;
};

/** A short label for a citation, used in the posted answer and in the blocker's resolution. */
const citationLabel = (c: Citation) => ('decision' in c ? `${c.decision}` : `${c.code.path}:${c.code.line} at ${c.code.sha.slice(0, 12)} (${c.code.repo})`);

/** The Architect as an author on the board. Its id is its own agents row, never the Client's. */
async function architectAuthor(conn: Conn, agentId: string): Promise<Author> {
  const row = await queryOne(conn, 'SELECT id, nickname, role, focus, runtime, model, parent_agent_id FROM agents WHERE id = ?', [agentId]);
  if (!row) throw notFound(`Architect agent ${agentId}`);
  // 'architect' is not a Staff role, so the row is cast here. postMessage reads only the id, and the researcher check.
  return { kind: 'agent', agent: { ...row, session_id: '' } as unknown as Agent };
}

/** The Architect agent of an initiative. Set at import (initiatives.architect_agent_id). */
async function architectIdOf(conn: Conn, initiativeId: string): Promise<string> {
  const r = await queryOne(conn, 'SELECT architect_agent_id FROM initiatives WHERE id = ?', [initiativeId]);
  if (!r?.architect_agent_id) throw invalid('This initiative has no Architect agent.');
  return String(r.architect_agent_id);
}

/** The thread of a job, checked to belong to it, and the job's Staff. */
async function jobThread(conn: Conn, jobId: string, threadId: string) {
  const t = await queryOne(conn, 'SELECT id, job_id FROM threads WHERE id = ?', [threadId]);
  if (!t || String(t.job_id) !== jobId) throw invalid(`Thread ${threadId} is not a thread of job ${jobId}.`);
  return String(t.id);
}

/** Posts the Architect's answer on a thread, and asks the job's Staff to read it. Runs on the caller's transaction. */
async function postAs(conn: Conn, ctx: Ctx, architectId: string, jobId: string, threadId: string, body: string) {
  const author = await architectAuthor(conn, architectId);
  const job = await queryOne(conn, 'SELECT staff_agent_id FROM jobs WHERE id = ?', [jobId]);
  const staffId = String(job?.staff_agent_id ?? '');
  const res = await postMessageTx(conn as Parameters<typeof postMessageTx>[0], ctx, author, { jobId, threadId, type: 'reply', stance: 'inform', body, mentions: staffId ? [staffId] : [] });
  return { message_id: Number(res.message_id) };
}

/**
 * Resolves the blocker of a delegated answer, as the Architect, on the caller's transaction. A blocker that is no longer
 * open throws, so the post and the resolution roll back together: nothing is posted for a closed blocker.
 */
async function resolveDelegatedTx(conn: Conn, ctx: Ctx, architectId: string, blockerId: string, resolution: string) {
  const b = await queryOne(conn, 'SELECT * FROM blockers WHERE id = ? FOR UPDATE', [blockerId]);
  if (!b || b.resolved_at || b.dismissed_at || b.kind !== 'client_decision') throw conflict('The client decision closed before the answer was posted, so nothing was posted.');
  const job = await lockJob(conn, String(b.job_id));
  await resolveBlockerTx(conn, ctx, architectId, b, job, resolution);
}

/** The open client_decision blocker, if any, read without a lock (the pre-check before the transaction). */
async function openBlocker(conn: Conn, blockerId: string) {
  const b = await queryOne(conn, 'SELECT * FROM blockers WHERE id = ?', [blockerId]);
  return b && !b.resolved_at && !b.dismissed_at && b.kind === 'client_decision' ? b : null;
}

/** Whether a blocker is still open, read on the caller's connection. */
async function blockerOpen(conn: Conn, blockerId: string) {
  const b = await queryOne(conn, 'SELECT kind, resolved_at, dismissed_at FROM blockers WHERE id = ? FOR UPDATE', [blockerId]);
  return !!b && !b.resolved_at && !b.dismissed_at && b.kind === 'client_decision';
}

/**
 * Answers a Staff question with a citation. Only a job that a card of this initiative started is answered. The answer goes
 * to a thread of that job, or (blocker_id) to the job's open client_decision blocker, which it resolves.
 */
export async function answerStaffQuestion(ctx: Ctx, initiativeId: string, a: { job_id: string; thread_id?: string; blocker_id?: string; answer: string; citation: unknown }) {
  const i = await initiativeById(ctx.pool, initiativeId);
  const link = await cardOfJob(ctx.pool, a.job_id);
  if (!link || link.initiative_id !== i.id) throw forbidden(`Job ${a.job_id} is not a job of initiative ${i.key}.`);
  const answer = a.answer.trim();
  if (!answer) throw invalid('The answer is empty.');
  if (answer.length > ANSWER_MAX) throw invalid(`The answer is longer than ${ANSWER_MAX} characters.`);
  if (a.citation === undefined || a.citation === null) throw invalid('An answer needs a citation: a decision of the design, or a line of a repository file at a commit.');
  const citation = CitationSchema.parse(a.citation);
  const architectId = await architectIdOf(ctx.pool, i.id);
  const now = ctx.clock.now();
  const version = await versionOf(ctx.pool, i.id, i.current_version);

  let threadId: string;
  let target: 'thread' | 'blocker' = 'thread';
  if (a.blocker_id) {
    const b = await openBlocker(ctx.pool, a.blocker_id);
    if (!b || String(b.job_id) !== a.job_id) throw invalid(`Blocker ${a.blocker_id} is not an open client decision of job ${a.job_id}.`);
    threadId = await generalThreadId(ctx.pool, a.job_id);
    target = 'blocker';
  } else {
    if (!a.thread_id) throw invalid('Give thread_id, or blocker_id for a client decision.');
    threadId = await jobThread(ctx.pool, a.job_id, a.thread_id);
  }

  if ('decision' in citation) {
    const id = citation.decision;
    if (!version.doc.blocks.some((b) => b.kind === 'decision' && b.id === id)) throw invalid(`Decision ${id} is not in design version ${version.version}.`);
    const answerId = newId('ans');
    const postBody = `${answer}\n\nAnswered from ${id}, design v${version.version}.`;
    return tx(ctx, async (conn) => {
      if (a.blocker_id && !(await blockerOpen(conn, a.blocker_id))) throw conflict('The client decision closed before the answer, so nothing was posted.');
      const posted = await postAs(conn, ctx, architectId, a.job_id, threadId, postBody);
      await exec(conn, `INSERT INTO architect_answers (id, initiative_id, job_id, thread_id, answer, citation, design_version, state, message_id, target, blocker_id, created_at, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'posted', ?, ?, ?, ?, ?)`, [
        answerId,
        i.id,
        a.job_id,
        threadId,
        answer,
        JSON.stringify(citation),
        version.version,
        posted.message_id,
        target,
        a.blocker_id ?? null,
        now,
        now,
      ]);
      if (a.blocker_id) await resolveDelegatedTx(conn, ctx, architectId, a.blocker_id, `Answered by the Architect from ${id} (design v${version.version}): ${answer}`);
      return { state: 'posted' as const, answer_id: answerId, message_id: posted.message_id, target };
    });
  }

  const repo = i.repos.find((r) => r.slug === citation.code.repo);
  if (!repo) throw invalid(`Repository ${citation.code.repo} is not in initiative ${i.key}.`);
  const answerId = newId('ans');
  const launchId = newId('lch');
  await tx(ctx, async (conn) => {
    await exec(conn, `INSERT INTO architect_answers (id, initiative_id, job_id, thread_id, answer, citation, design_version, state, launch_id, target, blocker_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'checking', ?, ?, ?, ?)`, [
      answerId,
      i.id,
      a.job_id,
      threadId,
      answer,
      JSON.stringify(citation),
      version.version,
      launchId,
      target,
      a.blocker_id ?? null,
      now,
    ]);
    await exec(conn, `INSERT INTO launches (id, agent_id, kind, run_id, cwd, runtime, requested_at) VALUES (?, NULL, 'quote_check', ?, ?, 'git', ?)`, [launchId, answerId, repo.path, now]);
  });
  return { state: 'checking' as const, answer_id: answerId, target, citation: { code: { repo: repo.slug, path: citation.code.path, line: citation.code.line, sha: citation.code.sha } } };
}

/** The runner takes a quote_check launch: the repository, the commit and the path, read from the stored answer now. */
export async function quoteCheckLaunch(conn: Conn, ctx: Ctx, l: { id: string; run_id: string; cwd: string }) {
  const now = ctx.clock.now();
  const finish = async (result: string) => {
    await exec(conn, 'UPDATE launches SET finished_at = ?, result = ? WHERE id = ?', [now, result, l.id]);
    return null;
  };
  const a = await queryOne(conn, 'SELECT citation, state FROM architect_answers WHERE id = ?', [l.run_id]);
  if (!a || a.state !== 'checking') return finish('cancelled: the answer is no longer waiting for a check');
  const c = parseCitation(a.citation);
  if (!c || !('code' in c)) return finish('failed: not a code citation');
  return { id: l.id, kind: 'quote_check', runtime: 'git', cwd: l.cwd, sha: c.code.sha, path: c.code.path };
}

/** Marks a checking answer refused with a reason, and posts nothing. */
async function refuse(ctx: Ctx, answerId: string, reason: string) {
  await exec(ctx.pool, `UPDATE architect_answers SET state = 'refused', refusal = ?, decided_at = ? WHERE id = ? AND state = 'checking'`, [reason.slice(0, 500), ctx.clock.now(), answerId]);
}

/** A quote_check launch that never reached the runner, or was lost, refuses its answer. */
export async function failQuoteCheck(ctx: Ctx, launchId: string, reason: string) {
  const l = await queryOne(ctx.pool, 'SELECT run_id FROM launches WHERE id = ? AND kind = ?', [launchId, 'quote_check']);
  if (l?.run_id) await refuse(ctx, String(l.run_id), reason);
}

/**
 * The runner's `git show` finished. The answer is posted only when git read the file and the quote is on the cited line.
 * Anything else refuses the answer, and nothing is posted.
 */
export async function recordQuoteOutput(ctx: Ctx, launchId: string, body: { code: number | null; stdout: string; stderr: string }) {
  const l = await queryOne(ctx.pool, 'SELECT id, kind, run_id FROM launches WHERE id = ?', [launchId]);
  if (!l || l.kind !== 'quote_check') throw notFound(`Quote check ${launchId}`);
  const a = (await queryOne(ctx.pool, 'SELECT * FROM architect_answers WHERE id = ?', [l.run_id])) as AnswerRow | null;
  if (!a || a.state !== 'checking') return { ok: true, recorded: false };
  const c = parseCitation(a.citation);
  if (!c || !('code' in c)) return { ok: true, recorded: false };
  const { repo, path, line, sha, quote } = c.code;
  if (body.code !== 0) {
    await refuse(ctx, a.id, `The file ${path} is not at commit ${sha.slice(0, 12)} in ${repo}, or git could not read it.`);
    return { ok: true, recorded: true, state: 'refused' };
  }
  const text = body.stdout.split('\n')[line - 1];
  if (text === undefined || !squash(text).includes(squash(quote))) {
    await refuse(ctx, a.id, `The quote is not on line ${line} of ${path} at commit ${sha.slice(0, 12)}.`);
    return { ok: true, recorded: true, state: 'refused' };
  }
  const architectId = await architectIdOf(ctx.pool, a.initiative_id);
  const postBody = `${a.answer}\n\nAnswered from code at ${sha.slice(0, 12)}: ${path}:${line} (${repo}).`;
  const label = citationLabel(c);
  const done = await tx(ctx, async (conn) => {
    if (a.target === 'blocker' && a.blocker_id && !(await blockerOpen(conn, a.blocker_id))) return false;
    const posted = await postAs(conn, ctx, architectId, String(a.job_id), String(a.thread_id), postBody);
    await exec(conn, `UPDATE architect_answers SET state = 'posted', message_id = ?, decided_at = ? WHERE id = ? AND state = 'checking'`, [posted.message_id, ctx.clock.now(), a.id]);
    if (a.target === 'blocker' && a.blocker_id) await resolveDelegatedTx(conn, ctx, architectId, a.blocker_id, `Answered by the Architect from ${label}: ${a.answer}`);
    return true;
  });
  if (!done) {
    await refuse(ctx, a.id, 'The client decision closed before the answer was checked, so nothing was posted.');
    return { ok: true, recorded: true, state: 'refused' };
  }
  return { ok: true, recorded: true, state: 'posted' };
}

/**
 * The Architect escalates a question to the Client: a client_decision blocker on the job, with its recommendation. An open
 * escalation of the same question on the same job is reused, not raised again.
 */
export async function escalate(ctx: Ctx, initiativeId: string, a: { job_id: string; question: string; recommendation: string; why_client: string; checked: string }) {
  const i = await initiativeById(ctx.pool, initiativeId);
  const link = await cardOfJob(ctx.pool, a.job_id);
  if (!link || link.initiative_id !== i.id) throw forbidden(`Job ${a.job_id} is not a job of initiative ${i.key}.`);
  for (const t of [a.question, a.recommendation, a.why_client, a.checked]) if (!t.trim()) throw invalid('An escalation needs a question, a recommendation, why the Client decides, and what was checked.');
  assertNoSecrets(a.question, a.recommendation, a.why_client, a.checked);
  const architectId = await architectIdOf(ctx.pool, i.id);
  const threadId = await generalThreadId(ctx.pool, a.job_id);
  return tx(ctx, async (conn) => {
    const same = await queryOne(conn, `SELECT id FROM blockers WHERE job_id = ? AND kind = 'client_decision' AND raised_by = ? AND requested_decision = ? AND resolved_at IS NULL AND dismissed_at IS NULL LIMIT 1`, [a.job_id, architectId, a.question]);
    if (same) return { state: 'reused' as const, blocker_id: String(same.id) };
    const blockerId = await raiseBlockerTx(conn, ctx, architectId, {
      jobId: a.job_id,
      kind: 'client_decision',
      requestedDecision: a.question,
      recommendation: a.recommendation,
      recommendationActionable: true,
      unblockCondition: 'The Client accepts the recommendation, or answers the question in the room.',
      context: `${a.why_client}\nChecked: ${a.checked}`,
    });
    await exec(conn, `INSERT INTO architect_answers (id, initiative_id, job_id, thread_id, answer, citation, design_version, state, target, blocker_id, created_at) VALUES (?, ?, ?, ?, ?, '{"escalated":true}', ?, 'escalated', 'blocker', ?, ?)`, [
      newId('ans'),
      i.id,
      a.job_id,
      threadId,
      a.recommendation,
      i.current_version,
      blockerId,
      ctx.clock.now(),
    ]);
    return { state: 'escalated' as const, blocker_id: blockerId };
  });
}

/**
 * The Client accepts an escalation's recommendation: the recommendation is posted on the job's General thread as the
 * Client's answer, and the blocker is resolved, in one transaction. A blocker that is no longer open refuses the whole
 * Accept: nothing is posted and the escalation stays as it is.
 */
export async function acceptEscalation(ctx: Ctx, answerId: string) {
  return tx(ctx, async (conn) => {
    const e = await queryOne(conn, 'SELECT * FROM architect_answers WHERE id = ? FOR UPDATE', [answerId]);
    if (!e || e.state !== 'escalated' || !e.blocker_id) throw conflict('This is not an open escalation.');
    const b = await queryOne(conn, 'SELECT * FROM blockers WHERE id = ? FOR UPDATE', [e.blocker_id]);
    if (!b || b.resolved_at || b.dismissed_at) throw conflict('This escalation is already closed, so nothing was posted.');
    const job = await lockJob(conn, String(e.job_id));
    const threadId = await generalThreadId(conn, String(e.job_id));
    const res = await postMessageTx(conn as Parameters<typeof postMessageTx>[0], ctx, { kind: 'client' }, { jobId: String(e.job_id), threadId, type: 'reply', stance: 'inform', body: `${String(e.answer)}\n\nThe Client accepted the Architect's recommendation.` });
    await exec(conn, `UPDATE architect_answers SET state = 'posted', message_id = ?, decided_at = ? WHERE id = ? AND state = 'escalated'`, [Number(res.message_id), ctx.clock.now(), answerId]);
    await resolveBlockerTx(conn, ctx, CLIENT, b, job, `Accepted the Architect's recommendation: ${String(e.answer)}`);
    return { ok: true, message_id: Number(res.message_id) };
  });
}

/**
 * The Client takes a delegated answer back. Allowed until Staff's next message on the thread; after it, refused. The
 * answer becomes an escalation: a new client_decision blocker with the answer as its recommendation.
 */
export async function reopenAnswer(ctx: Ctx, answerId: string) {
  const e = (await queryOne(ctx.pool, 'SELECT * FROM architect_answers WHERE id = ?', [answerId])) as AnswerRow | null;
  if (!e || e.state !== 'posted') throw conflict('Only a posted answer can be reopened.');
  const job = await queryOne(ctx.pool, 'SELECT staff_agent_id FROM jobs WHERE id = ?', [e.job_id]);
  const staffId = String(job?.staff_agent_id ?? '');
  const after = await queryOne(ctx.pool, 'SELECT id FROM messages WHERE thread_id = ? AND author = ? AND id > ? LIMIT 1', [e.thread_id, staffId, e.message_id ?? 0]);
  if (after) throw conflict('Staff has replied on this thread since the answer, so it can no longer be reopened.');
  const architectId = await architectIdOf(ctx.pool, e.initiative_id);
  const question = `Reopened answer: ${e.answer.slice(0, 400)}`;
  return tx(ctx, async (conn) => {
    const blockerId = await raiseBlockerTx(conn, ctx, architectId, {
      jobId: e.job_id,
      kind: 'client_decision',
      requestedDecision: question,
      recommendation: e.answer,
      recommendationActionable: true,
      unblockCondition: 'The Client accepts the recommendation, or answers the question in the room.',
      context: 'The Client took back an answer the Architect gave. Staff has not replied since.',
    });
    await exec(conn, `UPDATE architect_answers SET state = 'reopened', decided_at = ? WHERE id = ? AND state = 'posted'`, [ctx.clock.now(), answerId]);
    return { state: 'reopened' as const, blocker_id: blockerId };
  });
}

/** The answers the Client can act on across initiatives: escalations waiting for Accept, and delegated answers Reopen can take back. */
export const openAnswers = (ctx: Ctx) =>
  query(ctx.pool, "SELECT a.id, i.`key` AS initiative_key, i.title AS initiative_title, a.job_id, a.answer, a.citation, a.state, a.target, a.refusal, a.created_at FROM architect_answers a JOIN initiatives i ON i.id = a.initiative_id WHERE a.state = 'escalated' OR (a.state = 'posted' AND a.target = 'blocker') ORDER BY a.created_at DESC LIMIT 100");

export const answersOfInitiative = (ctx: Ctx, initiativeId: string) =>
  query(ctx.pool, 'SELECT id, job_id, thread_id, answer, citation, design_version, state, target, blocker_id, refusal, message_id, created_at, decided_at FROM architect_answers WHERE initiative_id = ? ORDER BY created_at DESC LIMIT 100', [initiativeId]);

