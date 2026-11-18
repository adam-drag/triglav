import { z } from 'zod';
import type { Agent } from './agents.ts';
import { postMessage, type Author } from './board.ts';
import { tx, type Ctx } from './context.ts';
import { exec, query, queryOne, type Conn } from './db.ts';
import { REPO_SLUG } from './design.ts';
import { cardOfJob } from './initiative-jobs.ts';
import { initiativeById, versionOf } from './initiatives.ts';
import { forbidden, invalid, newId, notFound } from './lib.ts';

/**
 * The Architect answers a Staff question on a job of its own initiative (docs/plans/initiative-room.md, phase 3). An
 * answer needs a citation: a decision of the current design, or a line of a repository file at a commit. A decision is
 * checked here. A code line is read by the runner (a quote_check launch: `git -C <repo> show <sha>:<path>`, no shell)
 * and the answer is posted only when the quote is on that line. A refused answer is never posted.
 */

/** A full commit id, lower case. */
const SHA = /^[0-9a-f]{40}$/;
/** A path inside a repository: relative, no empty, "." or ".." segment, plain characters. */
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

/** The Architect as an author on the board. Its id is its own agents row, never the Client's. */
async function architectAuthor(conn: Conn, agentId: string): Promise<Author> {
  const row = await queryOne(conn, 'SELECT id, nickname, role, focus, runtime, model, parent_agent_id FROM agents WHERE id = ?', [agentId]);
  if (!row) throw notFound(`Architect agent ${agentId}`);
  // 'architect' is not a Staff role, so the row is cast here. postMessage reads only the id, and the researcher check.
  return { kind: 'agent', agent: { ...row, session_id: '' } as unknown as Agent };
}

/** The thread of a job, checked to belong to it. */
async function jobThread(conn: Conn, jobId: string, threadId: string) {
  const t = await queryOne(conn, 'SELECT id, job_id FROM threads WHERE id = ?', [threadId]);
  if (!t || String(t.job_id) !== jobId) throw invalid(`Thread ${threadId} is not a thread of job ${jobId}.`);
  const job = await queryOne(conn, 'SELECT staff_agent_id FROM jobs WHERE id = ?', [jobId]);
  return { thread_id: String(t.id), staff_id: String(job?.staff_agent_id ?? '') };
}

/**
 * Answers a Staff question with a citation. Only a job that a card of this initiative started is answered, and only in a
 * thread of that job. A decision is posted at once; a code citation waits for the runner's check.
 */
export async function answerStaffQuestion(ctx: Ctx, initiativeId: string, a: { job_id: string; thread_id: string; answer: string; citation: unknown }) {
  const i = await initiativeById(ctx.pool, initiativeId);
  const link = await cardOfJob(ctx.pool, a.job_id);
  if (!link || link.initiative_id !== i.id) throw forbidden(`Job ${a.job_id} is not a job of initiative ${i.key}.`);
  const answer = a.answer.trim();
  if (!answer) throw invalid('The answer is empty.');
  if (answer.length > ANSWER_MAX) throw invalid(`The answer is longer than ${ANSWER_MAX} characters.`);
  if (a.citation === undefined || a.citation === null) throw invalid('An answer needs a citation: a decision of the design, or a line of a repository file at a commit.');
  const citation = CitationSchema.parse(a.citation);
  const now = ctx.clock.now();
  const version = await versionOf(ctx.pool, i.id, i.current_version);

  if ('decision' in citation) {
    const id = citation.decision;
    if (!version.doc.blocks.some((b) => b.kind === 'decision' && b.id === id)) throw invalid(`Decision ${id} is not in design version ${version.version}.`);
    const posted = await postAs(ctx, await architectIdOf(ctx.pool, i.id), a.job_id, a.thread_id, `${answer}\n\nAnswered from ${id}, design v${version.version}.`);
    await exec(ctx.pool, `INSERT INTO architect_answers (id, initiative_id, job_id, thread_id, answer, citation, design_version, state, message_id, created_at, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'posted', ?, ?, ?)`, [
      newId('ans'),
      i.id,
      a.job_id,
      a.thread_id,
      answer,
      JSON.stringify(citation),
      version.version,
      posted.message_id,
      now,
      now,
    ]);
    return { state: 'posted' as const, message_id: posted.message_id, citation: { decision: id, design_version: version.version } };
  }

  const repo = i.repos.find((r) => r.slug === citation.code.repo);
  if (!repo) throw invalid(`Repository ${citation.code.repo} is not in initiative ${i.key}.`);
  const thread = await jobThread(ctx.pool, a.job_id, a.thread_id);
  const answerId = newId('ans');
  const launchId = newId('lch');
  await tx(ctx, async (conn) => {
    await exec(conn, `INSERT INTO architect_answers (id, initiative_id, job_id, thread_id, answer, citation, design_version, state, launch_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'checking', ?, ?)`, [
      answerId,
      i.id,
      a.job_id,
      thread.thread_id,
      answer,
      JSON.stringify(citation),
      version.version,
      launchId,
      now,
    ]);
    await exec(conn, `INSERT INTO launches (id, agent_id, kind, run_id, cwd, runtime, requested_at) VALUES (?, NULL, 'quote_check', ?, ?, 'git', ?)`, [launchId, answerId, repo.path, now]);
  });
  return { state: 'checking' as const, answer_id: answerId, citation: { code: { repo: repo.slug, path: citation.code.path, line: citation.code.line, sha: citation.code.sha } } };
}

/** Posts the Architect's answer on the job's thread, and asks the Staff of the job for its reply. */
async function postAs(ctx: Ctx, architectId: string, jobId: string, threadId: string, body: string) {
  const author = await architectAuthor(ctx.pool, architectId);
  const job = await queryOne(ctx.pool, 'SELECT staff_agent_id FROM jobs WHERE id = ?', [jobId]);
  const staffId = String(job?.staff_agent_id ?? '');
  const res = await postMessage(ctx, author, { jobId, threadId, type: 'reply', stance: 'inform', body, mentions: staffId ? [staffId] : [] });
  return { message_id: Number(res.message_id) };
}

/** The Architect agent of an initiative. Set at import (initiatives.architect_agent_id). */
async function architectIdOf(conn: Conn, initiativeId: string): Promise<string> {
  const r = await queryOne(conn, 'SELECT architect_agent_id FROM initiatives WHERE id = ?', [initiativeId]);
  if (!r?.architect_agent_id) throw invalid('This initiative has no Architect agent.');
  return String(r.architect_agent_id);
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
  const c = (typeof a.citation === 'string' ? JSON.parse(a.citation) : a.citation) as Citation;
  if (!('code' in c)) return finish('failed: not a code citation');
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
  const a = await queryOne(ctx.pool, 'SELECT * FROM architect_answers WHERE id = ?', [l.run_id]);
  if (!a || a.state !== 'checking') return { ok: true, recorded: false };
  const c = (typeof a.citation === 'string' ? JSON.parse(a.citation) : a.citation) as Citation;
  if (!('code' in c)) return { ok: true, recorded: false };
  const { repo, path, line, sha, quote } = c.code;
  if (body.code !== 0) {
    await refuse(ctx, String(a.id), `The file ${path} is not at commit ${sha.slice(0, 12)} in ${repo}, or git could not read it.`);
    return { ok: true, recorded: true, state: 'refused' };
  }
  const text = body.stdout.split('\n')[line - 1];
  if (text === undefined || !squash(text).includes(squash(quote))) {
    await refuse(ctx, String(a.id), `The quote is not on line ${line} of ${path} at commit ${sha.slice(0, 12)}.`);
    return { ok: true, recorded: true, state: 'refused' };
  }
  const posted = await postAs(ctx, await architectIdOf(ctx.pool, String(a.initiative_id)), String(a.job_id), String(a.thread_id), `${String(a.answer)}\n\nAnswered from code at ${sha.slice(0, 12)}: ${path}:${line} (${repo}).`);
  await exec(ctx.pool, `UPDATE architect_answers SET state = 'posted', message_id = ?, decided_at = ? WHERE id = ? AND state = 'checking'`, [posted.message_id, ctx.clock.now(), a.id]);
  return { ok: true, recorded: true, state: 'posted' };
}

export const answersOfInitiative = (ctx: Ctx, initiativeId: string) =>
  query(ctx.pool, 'SELECT id, job_id, thread_id, answer, citation, design_version, state, refusal, message_id, created_at, decided_at FROM architect_answers WHERE initiative_id = ? ORDER BY created_at DESC LIMIT 100', [initiativeId]);
