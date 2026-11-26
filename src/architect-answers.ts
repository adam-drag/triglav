import { z } from 'zod';
import type { Agent } from './agents.ts';
import { postMessageTx, type Author } from './board.ts';
import { ESCALATABLE_KINDS, raiseBlockerTx, RELEASE_NOTES_MAX, resolveBlockerTx } from './blockers.ts';
export { RELEASE_NOTES_MAX };
import { tx, type Ctx } from './context.ts';
import { exec, parseJson, query, queryOne, type Conn } from './db.ts';
import { REPO_SLUG } from './design.ts';
import { emit } from './events.ts';
import { cardOfJob } from './card-links.ts';
import { routeRefusedAnswer } from './architect-wake.ts';
import { assertReportQuote, REPORT_QUOTE_MIN } from './initiative-reports.ts';
import { initiativeById, insertArchitectAgent, versionOf } from './initiatives.ts';
import { assertNoSecrets, conflict, forbidden, invalid, newId, notFound } from './lib.ts';
import { CLIENT, generalThreadId, lockJob } from './jobs.ts';
import { AUTO_DECISIONS_PER_DAY, AUTO_HOLD_MINUTES, autoModeOf, noteRefusalTx, resetRefusalsTx } from './architect-auto.ts';
import { pieceGrantedBy } from './review-gate.ts';

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
/** A quote shorter than this, after whitespace is collapsed, matches too many lines to prove a citation. */
const QUOTE_MIN = 8;
/** The same text after collapsing whitespace, so a quote matches a line whatever its indentation. */
const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

export const CitationSchema = z.union([
  z.object({ decision: z.string().regex(/^D\d{1,4}$/) }).strict(),
  // A research report version linked to the initiative. The quote is checked against the stored body, never the model's words.
  z
    .object({
      report: z
        .object({
          job_id: z.string().min(1).max(64),
          version: z.number().int().min(1).max(100_000),
          quote: z.string().min(1).max(QUOTE_MAX).refine((q) => squash(q).length >= REPORT_QUOTE_MIN, `a quote of at least ${REPORT_QUOTE_MIN} characters, not only spaces`),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      code: z
        .object({
          repo: z.string().regex(REPO_SLUG),
          path: z.string().max(300).refine((p) => QUOTE_PATH.test(p) && segmentsOk(p), 'a repository-relative path'),
          line: z.number().int().min(1).max(1_000_000),
          sha: z.string().regex(SHA, 'a full 40-character commit id'),
          quote: z.string().min(1).max(QUOTE_MAX).refine((q) => squash(q).length >= QUOTE_MIN, `a quote of at least ${QUOTE_MIN} characters, not only spaces`),
        })
        .strict(),
    })
    .strict(),
]);
export type Citation = z.infer<typeof CitationSchema>;

type AnswerRow = { id: string; initiative_id: string; job_id: string; thread_id: string; answer: string; citation: unknown; state: string; target: string; blocker_id: string | null; message_id: number | null; design_version: number; auto: number };

const parseCitation = (v: unknown): Citation | null => {
  const c = typeof v === 'string' ? JSON.parse(v) : v;
  return c && (('decision' in c) || ('code' in c) || ('report' in c)) ? (c as Citation) : null;
};

/** A short label for a citation, used in the posted answer and in the blocker's resolution. */
const citationLabel = (c: Citation) => ('decision' in c ? `${c.decision}` : 'report' in c ? `report ${c.report.job_id} v${c.report.version}` : `${c.code.path}:${c.code.line} at ${c.code.sha.slice(0, 12)} (${c.code.repo})`);

/** The Architect as an author on the board. Its id is its own agents row, never the Client's. */
export async function architectAuthor(conn: Conn, agentId: string): Promise<Author> {
  const row = await queryOne(conn, 'SELECT id, nickname, role, focus, runtime, model, parent_agent_id FROM agents WHERE id = ?', [agentId]);
  if (!row) throw notFound(`Architect agent ${agentId}`);
  // 'architect' is not a Staff role, so the row is cast here. postMessage reads only the id, and the researcher check.
  return { kind: 'agent', agent: { ...row, session_id: '' } as unknown as Agent };
}

/**
 * The Architect agent of an initiative. Set when the initiative is made (initiatives.architect_agent_id, by insertInitiative).
 * An initiative with none gets its agents row here, in its own transaction, so its first answer or escalation does not
 * fail. Call it outside any other transaction: tx() holds the write lock.
 */
export async function architectIdOf(ctx: Ctx, initiativeId: string): Promise<string> {
  return tx(ctx, async (conn) => {
    const r = await queryOne(conn, 'SELECT `key`, title, architect_agent_id FROM initiatives WHERE id = ? FOR UPDATE', [initiativeId]);
    if (!r) throw notFound(`Initiative ${initiativeId}`);
    if (r.architect_agent_id) return String(r.architect_agent_id);
    const id = newId('agt');
    await insertArchitectAgent(conn, { id, key: String(r.key), title: String(r.title) }, ctx.clock.now());
    await exec(conn, 'UPDATE initiatives SET architect_agent_id = ? WHERE id = ?', [id, initiativeId]);
    return id;
  });
}

/** The thread of a job, checked to belong to it, and the job's Staff. */
async function jobThread(conn: Conn, jobId: string, threadId: string) {
  const t = await queryOne(conn, 'SELECT id, job_id FROM threads WHERE id = ?', [threadId]);
  if (!t || String(t.job_id) !== jobId) throw invalid(`Thread ${threadId} is not a thread of job ${jobId}.`);
  return String(t.id);
}

/** Posts the Architect's answer on a thread, and asks the job's Staff to read it. Runs on the caller's transaction. */
export async function postAs(conn: Conn, ctx: Ctx, architectId: string, jobId: string, threadId: string, body: string) {
  const author = await architectAuthor(conn, architectId);
  const job = await queryOne(conn, 'SELECT staff_agent_id FROM jobs WHERE id = ?', [jobId]);
  const staffId = String(job?.staff_agent_id ?? '');
  const res = await postMessageTx(conn as Parameters<typeof postMessageTx>[0], ctx, author, { jobId, threadId, type: 'reply', stance: 'inform', body, mentions: staffId ? [staffId] : [] });
  return { message_id: Number(res.message_id) };
}

/** The kinds the Architect's post resolves: a delegated answer only a client decision, an auto decision every kind auto mode decides. */
const resolvableKinds = (auto: boolean): readonly string[] => (auto ? ESCALATABLE_KINDS : ['client_decision']);

/**
 * Resolves the blocker of a delegated answer or an auto decision, as the Architect, on the caller's transaction. A blocker
 * that is no longer open throws, so the post and the resolution roll back together: nothing is posted for a closed blocker.
 */
async function resolveDelegatedTx(conn: Conn, ctx: Ctx, architectId: string, blockerId: string, resolution: string, auto = false) {
  const b = await queryOne(conn, 'SELECT * FROM blockers WHERE id = ? FOR UPDATE', [blockerId]);
  if (!b || b.resolved_at || b.dismissed_at || !resolvableKinds(auto).includes(b.kind)) {
    throw conflict(auto ? 'The blocker closed before the decision was posted, so nothing was posted.' : 'The client decision closed before the answer was posted, so nothing was posted.');
  }
  const job = await lockJob(conn, String(b.job_id));
  await resolveBlockerTx(conn, ctx, architectId, b, job, resolution);
}

/** The open client_decision blocker, if any, read without a lock (the pre-check before the transaction). */
async function openBlocker(conn: Conn, blockerId: string) {
  const b = await queryOne(conn, 'SELECT * FROM blockers WHERE id = ?', [blockerId]);
  return b && !b.resolved_at && !b.dismissed_at && b.kind === 'client_decision' ? b : null;
}

/** Whether a blocker is still open and of a kind the post resolves (resolvableKinds), read under a lock on the caller's connection. */
async function blockerOpen(conn: Conn, blockerId: string, auto = false) {
  const b = await queryOne(conn, 'SELECT kind, resolved_at, dismissed_at FROM blockers WHERE id = ? FOR UPDATE', [blockerId]);
  return !!b && !b.resolved_at && !b.dismissed_at && resolvableKinds(auto).includes(b.kind);
}

/** Whether an escalation of the blocker is open: the Client decides it, so the Architect may not answer it. */
async function escalationOpen(conn: Conn, blockerId: string) {
  return !!(await queryOne(conn, `SELECT id FROM architect_answers WHERE blocker_id = ? AND state = 'escalated' LIMIT 1`, [blockerId]));
}

async function assertNotEscalated(conn: Conn, blockerId: string) {
  if (await escalationOpen(conn, blockerId)) throw invalid('This client decision is escalated to the Client, so the Architect cannot answer it.');
}

/** The initiative's current design version, read under its row lock in the caller's transaction. */
export async function currentVersionOf(conn: Conn, initiativeId: string) {
  const cur = await queryOne(conn, 'SELECT current_version FROM initiatives WHERE id = ? FOR UPDATE', [initiativeId]);
  if (!cur) throw notFound(`Initiative ${initiativeId}`);
  return versionOf(conn, initiativeId, Number(cur.current_version));
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
  // The citation can quote a repository line, so it is checked too, before any row or launch is written.
  assertNoSecrets(answer, JSON.stringify(citation));
  const architectId = await architectIdOf(ctx, i.id);
  const now = ctx.clock.now();

  let threadId: string;
  let target: 'thread' | 'blocker' = 'thread';
  if (a.blocker_id) {
    const b = await openBlocker(ctx.pool, a.blocker_id);
    if (!b || String(b.job_id) !== a.job_id) throw invalid(`Blocker ${a.blocker_id} is not an open client decision of job ${a.job_id}.`);
    // The Architect may not answer its own escalation: the Client decides those.
    if (String(b.raised_by) === architectId) throw invalid('The Architect cannot answer its own escalation, so the Client decides it.');
    threadId = await generalThreadId(ctx.pool, a.job_id);
    target = 'blocker';
  } else {
    if (!a.thread_id) throw invalid('Give thread_id, or blocker_id for a client decision.');
    threadId = await jobThread(ctx.pool, a.job_id, a.thread_id);
  }

  if ('decision' in citation) {
    const id = citation.decision;
    const answerId = newId('ans');
    return tx(ctx, async (conn) => {
      if (a.blocker_id && !(await blockerOpen(conn, a.blocker_id))) throw conflict('The client decision closed before the answer, so nothing was posted.');
      if (a.blocker_id) await assertNotEscalated(conn, a.blocker_id);
      // Read under the write lock: the citation is checked against the version the post is made from.
      const version = await currentVersionOf(conn, i.id);
      if (!version.doc.blocks.some((b) => b.kind === 'decision' && b.id === id)) throw invalid(`Decision ${id} is not in design version ${version.version}.`);
      const postBody = `${answer}\n\nAnswered from ${id}, design v${version.version}.`;
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

  if ('report' in citation) {
    const rc = citation.report;
    const answerId = newId('ans');
    return tx(ctx, async (conn) => {
      if (a.blocker_id && !(await blockerOpen(conn, a.blocker_id))) throw conflict('The client decision closed before the answer, so nothing was posted.');
      if (a.blocker_id) await assertNotEscalated(conn, a.blocker_id);
      // The report must be linked to this initiative, the version must exist and the quote must be in its body: else refused, nothing posted.
      await assertReportQuote(conn, i.id, rc);
      const version = await currentVersionOf(conn, i.id);
      const postBody = `${answer}\n\nAnswered from research report ${rc.job_id} v${rc.version}.`;
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
      if (a.blocker_id) await resolveDelegatedTx(conn, ctx, architectId, a.blocker_id, `Answered by the Architect from research report ${rc.job_id} v${rc.version} (design v${version.version}): ${answer}`);
      return { state: 'posted' as const, answer_id: answerId, message_id: posted.message_id, target };
    });
  }

  const repo = i.repos.find((r) => r.slug === citation.code.repo);
  if (!repo) throw invalid(`Repository ${citation.code.repo} is not in initiative ${i.key}.`);
  const answerId = newId('ans');
  const launchId = newId('lch');
  await tx(ctx, async (conn) => {
    if (a.blocker_id) await assertNotEscalated(conn, a.blocker_id);
    const version = await currentVersionOf(conn, i.id);
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

/**
 * Marks a checking answer (or a held auto decision) refused with a reason, and posts nothing. citationFault is true when the
 * cited line did not hold: for an auto decision that counts toward the stop after AUTO_REFUSALS_MAX in a row
 * (src/architect-auto.ts).
 */
async function refuse(conn: Conn, ctx: Ctx, answerId: string, reason: string, citationFault = false, from: 'checking' | 'held' = 'checking') {
  const row = await queryOne(conn, `SELECT initiative_id, job_id, auto FROM architect_answers WHERE id = ? AND state = ?`, [answerId, from]);
  if (!row) return;
  const short = reason.slice(0, 500);
  const upd = await exec(conn, `UPDATE architect_answers SET state = 'refused', refusal = ?, decided_at = ? WHERE id = ? AND state = ?`, [short, ctx.clock.now(), answerId, from]);
  if (upd.affectedRows === 1 && citationFault && Number(row.auto) === 1) await noteRefusalTx(conn, ctx, String(row.initiative_id));
  // The Architect hears of the refusal with the answer id and the reason, so it can correct the citation or escalate.
  if (upd.affectedRows === 1) await routeRefusedAnswer(conn, ctx, { initiativeId: String(row.initiative_id), jobId: String(row.job_id), answerId, reason: short });
}

/** A refusal from a path that runs outside any transaction (a runner report). Its wake commits with the refusal. */
const refuseNow = (ctx: Ctx, answerId: string, reason: string, citationFault = false) => tx(ctx, (conn) => refuse(conn, ctx, answerId, reason, citationFault));

/**
 * A quote_check launch that never reached the runner, was lost, or finished without its output refuses its answer. Runs in
 * the caller's transaction, so the refusal and its wake commit together with the launch's finish.
 */
export async function failQuoteCheck(conn: Conn, ctx: Ctx, launchId: string, reason: string) {
  const l = await queryOne(conn, 'SELECT run_id FROM launches WHERE id = ? AND kind = ?', [launchId, 'quote_check']);
  if (l?.run_id) await refuse(conn, ctx, String(l.run_id), reason);
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
    // A git exit code means git ran and the commit or path is not there, a fault of the citation. No code (a timeout, a kill,
    // an output over the cap, git missing) is a fault of the runner, so it does not count toward the stop.
    await refuseNow(ctx, a.id, `The file ${path} is not at commit ${sha.slice(0, 12)} in ${repo}, or git could not read it.`, body.code !== null);
    return { ok: true, recorded: true, state: 'refused' };
  }
  const text = body.stdout.split('\n')[line - 1];
  if (text === undefined || !squash(text).includes(squash(quote))) {
    await refuseNow(ctx, a.id, `The quote is not on line ${line} of ${path} at commit ${sha.slice(0, 12)}.`, true);
    return { ok: true, recorded: true, state: 'refused' };
  }
  const architectId = await architectIdOf(ctx, a.initiative_id);
  const auto = Number(a.auto) === 1;
  const label = citationLabel(c);
  const postBody = auto ? autoBody(a.answer, label) : `${a.answer}\n\nAnswered from code at ${sha.slice(0, 12)}: ${path}:${line} (${repo}).`;
  const done = await tx(ctx, async (conn) => {
    // Re-read under the write lock: a retried quote-output that overlaps the first one must not post the answer twice.
    const cur = await queryOne(conn, 'SELECT state FROM architect_answers WHERE id = ? FOR UPDATE', [a.id]);
    if (!cur || cur.state !== 'checking') return null;
    // An escalation placed while the check ran belongs to the Client: the answer is refused, not posted.
    if (a.target === 'blocker' && a.blocker_id && (await escalationOpen(conn, a.blocker_id))) return 'escalated' as const;
    if (a.target === 'blocker' && a.blocker_id && !(await blockerOpen(conn, a.blocker_id, auto))) return false;
    // An auto decision posts only while auto mode is still on: the Client may have switched it off while git ran.
    if (auto && !(await autoModeOf(conn, ctx, a.initiative_id)).on) return 'auto_off' as const;
    const posted = await postAs(conn, ctx, architectId, String(a.job_id), String(a.thread_id), postBody);
    await exec(conn, `UPDATE architect_answers SET state = 'posted', message_id = ?, decided_at = ? WHERE id = ? AND state = 'checking'`, [posted.message_id, ctx.clock.now(), a.id]);
    if (a.target === 'blocker' && a.blocker_id) {
      const resolution = auto ? `Decided by the Architect in auto mode, from ${label}: ${a.answer}` : `Answered by the Architect from ${label}: ${a.answer}`;
      await resolveDelegatedTx(conn, ctx, architectId, a.blocker_id, resolution, auto);
    }
    // The cited line held, so the run of refused citations ends here.
    if (auto) await resetRefusalsTx(conn, a.initiative_id);
    return true;
  });
  if (done === null) return { ok: true, recorded: false };
  if (done === 'auto_off') {
    await refuseNow(ctx, a.id, 'Auto mode was switched off while the code was checked, so nothing was posted. Escalate it if it still needs a decision.');
    return { ok: true, recorded: true, state: 'refused' };
  }
  if (done === 'escalated') {
    await refuseNow(ctx, a.id, 'The client decision is escalated to the Client, so nothing was posted.');
    return { ok: true, recorded: true, state: 'refused' };
  }
  if (!done) {
    await refuseNow(ctx, a.id, 'The client decision closed before the answer was checked, so nothing was posted.');
    return { ok: true, recorded: true, state: 'refused' };
  }
  return { ok: true, recorded: true, state: 'posted' };
}

/**
 * The Architect escalates a question to the Client: a client_decision blocker on the job, with its recommendation. An open
 * escalation of the same question on the same job is reused, not raised again.
 */
export async function escalate(ctx: Ctx, initiativeId: string, a: { job_id: string; question: string; recommendation: string; why_client: string; checked: string; blocker_id?: string }) {
  const i = await initiativeById(ctx.pool, initiativeId);
  const link = await cardOfJob(ctx.pool, a.job_id);
  if (!link || link.initiative_id !== i.id) throw forbidden(`Job ${a.job_id} is not a job of initiative ${i.key}.`);
  for (const t of [a.question, a.recommendation, a.why_client, a.checked]) if (!t.trim()) throw invalid('An escalation needs a question, a recommendation, why the Client decides, and what was checked.');
  assertNoSecrets(a.question, a.recommendation, a.why_client, a.checked);
  const architectId = await architectIdOf(ctx, i.id);
  const threadId = await generalThreadId(ctx.pool, a.job_id);
  return tx(ctx, async (conn) => {
    // The job row is locked before the reuse check. withTx's write_lock already runs the writes one at a time; the lock keeps
    // the check and the insert together under the job, whatever the caller.
    await lockJob(conn, a.job_id);
    let blockerId: string;
    let citationJson = '{"escalated":true}';
    if (a.blocker_id) {
      // A routed Staff question that is already a client decision: the escalation attaches to that blocker, so Accept resolves it.
      const b = await queryOne(conn, 'SELECT job_id, kind, raised_by, requested_decision, resolved_at, dismissed_at FROM blockers WHERE id = ? FOR UPDATE', [a.blocker_id]);
      // The job is checked before the kind, so a refusal never tells a blocker of another job from one of this job.
      if (!b || String(b.job_id) !== a.job_id) throw invalid(`Blocker ${a.blocker_id} is not an open blocker of job ${a.job_id} that can be escalated.`);
      if (b.kind === 'unavailable_owner') throw invalid(`Blocker ${a.blocker_id} is an unavailable owner: an answer cannot clear it. The Client reassigns Staff, or it clears when Staff returns.`);
      if (!ESCALATABLE_KINDS.includes(b.kind) || b.resolved_at || b.dismissed_at) throw invalid(`Blocker ${a.blocker_id} is not an open blocker of job ${a.job_id} that can be escalated.`);
      if (String(b.raised_by) === architectId) throw invalid(`Blocker ${a.blocker_id} is the Architect's own escalation: escalate the question without blocker_id to reuse it.`);
      const open = await queryOne(conn, `SELECT id FROM architect_answers WHERE blocker_id = ? AND state = 'escalated' LIMIT 1`, [a.blocker_id]);
      if (open) return { state: 'reused' as const, blocker_id: a.blocker_id };
      blockerId = a.blocker_id;
      // Stored with the Architect's own text, so the Inbox shows why the Client decides and what was checked.
      citationJson = JSON.stringify({ escalated: true, why_client: a.why_client, checked: a.checked });
    } else {
      // An open escalation of the same question is reused, whoever raised its blocker (a routed Staff one included).
      const same = await queryOne(conn, `SELECT id FROM blockers WHERE job_id = ? AND kind = 'client_decision' AND requested_decision = ? AND resolved_at IS NULL AND dismissed_at IS NULL AND (raised_by = ? OR id IN (SELECT blocker_id FROM architect_answers WHERE state = 'escalated' AND blocker_id IS NOT NULL)) LIMIT 1`, [a.job_id, a.question, architectId]);
      if (same) return { state: 'reused' as const, blocker_id: String(same.id) };
      blockerId = await raiseBlockerTx(conn, ctx, architectId, {
        jobId: a.job_id,
        kind: 'client_decision',
        requestedDecision: a.question,
        recommendation: a.recommendation,
        recommendationActionable: true,
        unblockCondition: 'The Client accepts the recommendation, or answers the question in the room.',
        context: `${a.why_client}\nChecked: ${a.checked}`,
      });
    }
    await exec(conn, `INSERT INTO architect_answers (id, initiative_id, job_id, thread_id, answer, citation, design_version, state, target, blocker_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'escalated', 'blocker', ?, ?)`, [
      newId('ans'),
      i.id,
      a.job_id,
      threadId,
      a.recommendation,
      citationJson,
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
    // An answer cannot clear an unavailable owner, and the scheduler would raise it again at once (see resolveBlocker).
    if (b.kind === 'unavailable_owner') throw conflict('An unavailable owner is not unblocked by an answer, so nothing was posted. The Client reassigns Staff, or it clears when Staff returns.');
    const job = await lockJob(conn, String(e.job_id));
    const threadId = await generalThreadId(conn, String(e.job_id));
    const res = await postMessageTx(conn as Parameters<typeof postMessageTx>[0], ctx, { kind: 'client' }, { jobId: String(e.job_id), threadId, type: 'reply', stance: 'inform', body: `${String(e.answer)}\n\nThe Client accepted the Architect's recommendation.` });
    await exec(conn, `UPDATE architect_answers SET state = 'posted', message_id = ?, decided_at = ? WHERE id = ? AND state = 'escalated'`, [Number(res.message_id), ctx.clock.now(), answerId]);
    await resolveBlockerTx(conn, ctx, CLIENT, b, job, `Accepted the Architect's recommendation: ${String(e.answer)}`);
    return { ok: true, message_id: Number(res.message_id) };
  });
}

/**
 * The Architect answers a client decision that asks for the release notes of a PR to be confirmed (from PR #92): approve
 * uses the block as written, suggest gives a corrected block. Only a blocker raised with a release_notes block qualifies, so
 * this path never answers another question without a citation. It is the one answer that needs no citation, because checking
 * release notes against the design is the Architect's call by rule. Like a delegated answer it is posted on the job's
 * General thread, resolves the blocker, and lands in the Client's list to review, where Approve keeps it and Take back makes
 * the question the Client's again until Staff replies.
 */
export async function answerReleaseNotes(ctx: Ctx, initiativeId: string, a: { blocker_id: string; verdict: 'approve' | 'suggest'; text?: string; note?: string }) {
  const text = a.text?.trim() ?? '';
  const note = a.note?.trim() ?? '';
  if (a.verdict === 'suggest' && !text) throw invalid('suggest needs the corrected block in text.');
  if (a.verdict === 'approve' && text) throw invalid('approve takes no text. To change the block, use suggest.');
  if (text.length > RELEASE_NOTES_MAX) throw invalid(`The block is longer than ${RELEASE_NOTES_MAX} characters.`);
  assertNoSecrets(text, note);
  const i = await initiativeById(ctx.pool, initiativeId);
  const b = await openBlocker(ctx.pool, a.blocker_id);
  // A job a card started, as for answer_staff_question: list_blockers, the wake and read_thread reach those jobs only.
  const link = b ? await cardOfJob(ctx.pool, String(b.job_id)) : null;
  if (!b || !link || link.initiative_id !== i.id) throw invalid(`Blocker ${a.blocker_id} is not an open client decision of your initiative.`);
  if (!b.release_notes) throw invalid(`Blocker ${a.blocker_id} carries no release notes block, so it is not yours to answer without a citation: use answer_staff_question or escalate it.`);
  const architectId = await architectIdOf(ctx, i.id);
  if (String(b.raised_by) === architectId) throw invalid('The Architect cannot answer its own escalation, so the Client decides it.');
  const jobId = String(b.job_id);
  const threadId = await generalThreadId(ctx.pool, jobId);
  const why = note ? `${note}\n\n` : '';
  // The approved block is kept in the answer, so the Client sees under To review what was approved, and Take back carries it.
  const answer = a.verdict === 'approve' ? `Release notes: approved, use the block as written.\n\n${why}${String(b.release_notes)}` : `Release notes: use this block instead.\n\n${why}${text}`;
  const answerId = newId('ans');
  const now = ctx.clock.now();
  return tx(ctx, async (conn) => {
    if (!(await blockerOpen(conn, a.blocker_id))) throw conflict('The client decision closed before the answer, so nothing was posted.');
    await assertNotEscalated(conn, a.blocker_id);
    const version = await currentVersionOf(conn, i.id);
    const posted = await postAs(conn, ctx, architectId, jobId, threadId, `${answer}\n\nAnswered by the Architect, by its release-notes rule (no citation).`);
    await exec(conn, `INSERT INTO architect_answers (id, initiative_id, job_id, thread_id, answer, citation, design_version, state, message_id, target, blocker_id, created_at, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'posted', ?, 'blocker', ?, ?, ?)`, [
      answerId,
      i.id,
      jobId,
      threadId,
      answer,
      JSON.stringify({ rule: 'release_notes', verdict: a.verdict }),
      version.version,
      posted.message_id,
      a.blocker_id,
      now,
      now,
    ]);
    const resolution = a.verdict === 'approve' ? 'The Architect approved the release notes as written.' : `The Architect suggested a corrected release notes block:\n\n${text}`;
    await resolveDelegatedTx(conn, ctx, architectId, a.blocker_id, resolution);
    return { state: 'posted' as const, answer_id: answerId, message_id: posted.message_id, verdict: a.verdict };
  });
}

/**
 * The Client takes a delegated answer back. Allowed until Staff's next message on the thread; after it, refused. The
 * answer becomes an escalation: a new client_decision blocker with the answer as its recommendation. The checks, the new
 * blocker and the state change run in one transaction, so two Reopens cannot both raise a blocker.
 */
export async function reopenAnswer(ctx: Ctx, answerId: string) {
  const found = await queryOne(ctx.pool, 'SELECT initiative_id FROM architect_answers WHERE id = ?', [answerId]);
  if (!found) throw notFound(`Answer ${answerId}`);
  const architectId = await architectIdOf(ctx, String(found.initiative_id));
  return tx(ctx, async (conn) => {
    const e = (await queryOne(conn, 'SELECT * FROM architect_answers WHERE id = ? FOR UPDATE', [answerId])) as AnswerRow | null;
    if (!e || e.state !== 'posted' || e.target !== 'blocker') throw conflict('Only a posted answer to a client decision can be reopened.');
    // Reopen raises a client decision with the answer as its recommendation, so only an answer to one can be taken back. An
    // auto decision on another kind is the exception: the Client's Undo makes the new client decision their own.
    const blocker = await queryOne(conn, 'SELECT kind FROM blockers WHERE id = ?', [e.blocker_id]);
    const auto = Number(e.auto) === 1;
    if (blocker?.kind !== 'client_decision' && !auto) throw conflict(`Only a posted answer to a client decision can be reopened: this one answers a ${String(blocker?.kind ?? 'missing')} blocker.`);
    // withTx takes the global write_lock first, which serializes this transaction against a Staff post. The thread row is
    // locked as well, the row postMessageTx locks first.
    await queryOne(conn, 'SELECT id FROM threads WHERE id = ? FOR UPDATE', [e.thread_id]);
    // Any Staff on the thread counts, not only the job's current one: a handover leaves the old Staff's posts under its id.
    const after = await queryOne(conn, `SELECT m.id FROM messages m JOIN agents g ON g.id = m.author WHERE m.thread_id = ? AND g.role = 'staff' AND m.id > ? LIMIT 1 FOR SHARE`, [e.thread_id, e.message_id ?? 0]);
    if (after) throw conflict('Staff has replied on this thread since the answer, so it can no longer be reopened.');
    const now = ctx.clock.now();
    const blockerId = await raiseBlockerTx(conn, ctx, architectId, {
      jobId: e.job_id,
      kind: 'client_decision',
      requestedDecision: auto ? `The Client took back the Architect's decision on a ${String(blocker?.kind).replace(/_/g, ' ')} blocker: ${e.answer.slice(0, 400)}` : `Reopened answer: ${e.answer.slice(0, 400)}`,
      recommendation: e.answer,
      recommendationActionable: true,
      unblockCondition: 'The Client accepts the recommendation, or answers the question in the room.',
      context: auto ? 'The Client took back a decision the Architect took in auto mode. Staff has not replied since.' : 'The Client took back an answer the Architect gave. Staff has not replied since.',
    });
    const upd = await exec(conn, `UPDATE architect_answers SET state = 'reopened', decided_at = ? WHERE id = ? AND state = 'posted'`, [now, answerId]);
    if (upd.affectedRows !== 1) throw conflict('This answer changed while it was reopened, so nothing was reopened.');
    // The reopened answer is an escalation again, so it is listed in the Inbox until the Client accepts it or answers in the room.
    await exec(conn, `INSERT INTO architect_answers (id, initiative_id, job_id, thread_id, answer, citation, design_version, state, target, blocker_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'escalated', 'blocker', ?, ?)`, [
      newId('ans'),
      e.initiative_id,
      e.job_id,
      e.thread_id,
      e.answer,
      JSON.stringify({ escalated: true, reopened: answerId }),
      e.design_version,
      blockerId,
      now,
    ]);
    return { state: 'escalated' as const, blocker_id: blockerId, reopened: answerId };
  });
}

/**
 * The answers the Client can act on: escalations whose blocker is still open, and delegated answers Reopen can still take
 * back (no Staff reply since, a client decision only, and not approved yet). Without an initiative, across all of them; with
 * one, for that initiative. The Inbox groups them by initiative (src/initiative-inbox.ts).
 */
const OPEN_ANSWERS_SQL = `SELECT a.id, a.initiative_id, i.\`key\` AS initiative_key, i.title AS initiative_title, a.job_id, a.thread_id, a.blocker_id, a.answer, a.citation, a.state, a.target, a.refusal, a.created_at, a.decided_at, a.design_version, b.requested_decision AS question, b.context
  FROM architect_answers a JOIN initiatives i ON i.id = a.initiative_id LEFT JOIN blockers b ON b.id = a.blocker_id
  WHERE ((a.state = 'escalated' AND b.resolved_at IS NULL AND b.dismissed_at IS NULL)
    OR (a.state = 'posted' AND a.target = 'blocker' AND a.auto = 0 AND a.reviewed_at IS NULL AND b.kind = 'client_decision' AND NOT EXISTS (SELECT 1 FROM messages m JOIN agents g ON g.id = m.author WHERE m.thread_id = a.thread_id AND g.role = 'staff' AND m.id > a.message_id)))`;

export const openAnswers = (ctx: Ctx, initiativeId?: string) =>
  initiativeId === undefined
    ? query(ctx.pool, `${OPEN_ANSWERS_SQL} ORDER BY a.created_at DESC LIMIT 100`)
    : query(ctx.pool, `${OPEN_ANSWERS_SQL} AND a.initiative_id = ? ORDER BY a.created_at DESC LIMIT 100`, [initiativeId]);

export const answersOfInitiative = (ctx: Ctx, initiativeId: string) =>
  query(ctx.pool, 'SELECT id, job_id, thread_id, answer, citation, design_version, state, target, blocker_id, refusal, message_id, created_at, decided_at FROM architect_answers WHERE initiative_id = ? ORDER BY created_at DESC LIMIT 100', [initiativeId]);

// ---------------------------------------------------------------- auto mode (src/architect-auto.ts)

/**
 * The citations of an auto decision: those of answer_staff_question, plus a Client answer (a blocker of this initiative that
 * the Client resolved). A product decision may cite only a design decision or a Client answer, never code or a report.
 */
export const DecideCitationSchema = z.union([...CitationSchema.options, z.object({ client_answer: z.string().min(1).max(64) }).strict()]);
type DecideCitation = z.infer<typeof DecideCitationSchema>;

const decideLabel = (c: DecideCitation) => ('client_answer' in c ? `the Client's answer on blocker ${c.client_answer}` : citationLabel(c));
const autoBody = (decision: string, label: string) => `${decision}\n\nDecided by the Architect in auto mode, from ${label}. The Client can take it back until you reply.`;

/**
 * Checks a citation that needs no runner: a design decision of the current version, a linked report, or a Client answer of
 * this initiative. decideBlocker runs it before its transaction, where a fault counts toward the stop, and again under the
 * write lock; postHeldDecisions runs it again when a hold ends, since the design can change during the hold.
 */
async function checkDecideCitation(conn: Conn, initiativeId: string, c: DecideCitation) {
  if ('decision' in c) {
    const v = await currentVersionOf(conn, initiativeId);
    if (!v.doc.blocks.some((b) => b.kind === 'decision' && b.id === c.decision)) throw invalid(`Decision ${c.decision} is not in design version ${v.version}.`);
  } else if ('report' in c) {
    await assertReportQuote(conn, initiativeId, c.report);
  } else if ('client_answer' in c) {
    const b = await queryOne(conn, 'SELECT job_id, resolved_by, resolution FROM blockers WHERE id = ?', [c.client_answer]);
    const link = b ? await cardOfJob(conn, String(b.job_id)) : null;
    // Only a resolution the Client wrote is an answer, and resolveBlockerTx emits blocker.resolved for it. A bulk close (mark
    // done, a cancel, a reassign) also stores resolved_by client, but it answers nothing and emits no such event. A dismissal
    // emits one, but leaves resolved_by empty.
    const answered =
      b && b.resolved_by === CLIENT && b.resolution && link && link.initiative_id === initiativeId
        ? await queryOne(conn, `SELECT id FROM events WHERE type = 'blocker.resolved' AND job_id = ? AND actor = ? AND JSON_UNQUOTE(JSON_EXTRACT(payload, '$.blocker_id')) = ? LIMIT 1`, [b.job_id, CLIENT, c.client_answer])
        : null;
    if (!answered) throw invalid(`Blocker ${c.client_answer} has no answer of the Client on a job of your initiative.`);
  }
}

/**
 * The budget of one auto decision, in the caller's transaction: at most AUTO_DECISIONS_PER_DAY in a rolling 24 hours, and at
 * most one grant of more local review rounds per piece of work (pieceGrantedBy, which counts a grant the Client undid too).
 * Resolving a round-limit failed_execution blocker grants the rounds (grantRoundsFor), and a human gate used to be the brake
 * on those tokens.
 */
async function assertAutoBudget(conn: Conn, ctx: Ctx, initiativeId: string, architectId: string, blockerId: string) {
  const since = new Date(ctx.clock.now().getTime() - 24 * 3_600_000);
  const n = Number((await queryOne(conn, `SELECT COUNT(*) AS n FROM architect_answers WHERE initiative_id = ? AND auto = 1 AND state NOT IN ('refused', 'undone') AND created_at > ?`, [initiativeId, since]))?.n ?? 0);
  if (n >= AUTO_DECISIONS_PER_DAY) throw invalid(`Auto mode took ${n} decisions in the last 24 hours, its limit: escalate this one to the Client.`);
  if (await pieceGrantedBy(conn, blockerId, architectId)) throw invalid('Auto mode already granted more review rounds for this piece of work: escalate this one to the Client.');
}

const AUTO_OFF = 'Auto mode is off, so you do not decide blockers: escalate it to the Client.';

/**
 * The Architect decides a blocker itself, in auto mode (src/architect-auto.ts). Refused unless auto mode is on, the reach
 * is empty (the decision is low blast radius), the blocker is an open blocker of a card job of this initiative that auto
 * mode decides, no escalation or other decision of it is open, the budget allows it, and the citation holds. A technical
 * decision is posted at once (a code citation after the runner's check); a product decision is held for
 * AUTO_HOLD_MINUTES, so the Client can undo it before Staff sees it.
 */
export async function decideBlocker(ctx: Ctx, initiativeId: string, a: { blocker_id: string; decision: string; kind: 'technical' | 'product'; reach: string[]; citation: unknown }) {
  const i = await initiativeById(ctx.pool, initiativeId);
  if (!(await autoModeOf(ctx.pool, ctx, i.id)).on) throw invalid(AUTO_OFF);
  if (a.reach.length) throw invalid(`The decision touches ${a.reach.join(', ')}, so it is the Client's: escalate it.`);
  const decision = a.decision.trim();
  if (!decision) throw invalid('The decision is empty.');
  if (decision.length > ANSWER_MAX) throw invalid(`The decision is longer than ${ANSWER_MAX} characters.`);
  const citation = DecideCitationSchema.parse(a.citation);
  if (a.kind === 'product' && !('decision' in citation) && !('client_answer' in citation)) {
    throw invalid('A product decision cites a design decision ({decision}) or a Client answer ({client_answer}). If neither covers it, escalate it.');
  }
  assertNoSecrets(decision, JSON.stringify(citation));
  const architectId = await architectIdOf(ctx, i.id);
  // The initiative is checked before the kind, so a refusal never tells a blocker of another initiative from one of this one.
  const notYours = () => invalid(`Blocker ${a.blocker_id} is not an open blocker of your initiative that you can decide.`);
  const b = await queryOne(ctx.pool, 'SELECT * FROM blockers WHERE id = ?', [a.blocker_id]);
  const link = b ? await cardOfJob(ctx.pool, String(b.job_id)) : null;
  if (!b || !link || link.initiative_id !== i.id) throw notYours();
  if (b.kind === 'unavailable_owner') throw invalid('An unavailable owner is not cleared by a decision: the Client reassigns Staff, or it clears when Staff returns.');
  if (!ESCALATABLE_KINDS.includes(b.kind) || b.resolved_at || b.dismissed_at) throw notYours();
  if (String(b.raised_by) === architectId) throw invalid('This blocker is your own escalation, so the Client decides it.');
  const jobId = String(b.job_id);
  const threadId = await generalThreadId(ctx.pool, jobId);
  let repoPath: string | null = null;
  // A citation that does not hold is refused before any row, and counts toward the stop after AUTO_REFUSALS_MAX in a row.
  try {
    if ('code' in citation) {
      const repo = i.repos.find((r) => r.slug === citation.code.repo);
      if (!repo) throw invalid(`Repository ${citation.code.repo} is not in initiative ${i.key}.`);
      repoPath = repo.path;
    } else {
      await checkDecideCitation(ctx.pool, i.id, citation);
    }
  } catch (error) {
    await tx(ctx, (conn) => noteRefusalTx(conn, ctx, i.id));
    throw error;
  }
  const label = decideLabel(citation);
  const answerId = newId('ans');
  const now = ctx.clock.now();
  return tx(ctx, async (conn) => {
    await lockJob(conn, jobId);
    // Read again under the write lock: the Client may have switched auto mode off, or confirmed a design version without the
    // cited decision, since the checks above.
    if (!(await autoModeOf(conn, ctx, i.id)).on) throw invalid(AUTO_OFF);
    if (!(await blockerOpen(conn, a.blocker_id, true))) throw notYours();
    if (await escalationOpen(conn, a.blocker_id)) throw invalid('Your escalation of this blocker is open, so the Client decides it.');
    if (await queryOne(conn, `SELECT id FROM architect_answers WHERE blocker_id = ? AND auto = 1 AND state IN ('held', 'checking') LIMIT 1`, [a.blocker_id])) {
      throw invalid('A decision of yours on this blocker is already waiting.');
    }
    await assertAutoBudget(conn, ctx, i.id, architectId, a.blocker_id);
    if (!('code' in citation)) await checkDecideCitation(conn, i.id, citation);
    const version = await currentVersionOf(conn, i.id);
    const insert = (state: string, extra: { hold_until?: Date; message_id?: number; launch_id?: string; decided_at?: Date }) =>
      exec(
        conn,
        `INSERT INTO architect_answers (id, initiative_id, job_id, thread_id, answer, citation, design_version, state, target, blocker_id, auto, decision_kind, hold_until, message_id, launch_id, created_at, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'blocker', ?, 1, ?, ?, ?, ?, ?, ?)`,
        [answerId, i.id, jobId, threadId, decision, JSON.stringify(citation), version.version, state, a.blocker_id, a.kind, extra.hold_until ?? null, extra.message_id ?? null, extra.launch_id ?? null, now, extra.decided_at ?? null],
      );
    // The event refreshes the open room (its Decided for you section). It wakes no agent.
    const announce = (state: string) => emit(conn, ctx, { type: 'architect.auto_decision', jobId, actor: architectId, targets: [], payload: { answer_id: answerId, blocker_id: a.blocker_id, state, kind: a.kind } });
    if ('code' in citation) {
      // A code citation holds only once the runner finds the quote: recordQuoteOutput resets the refusal count then.
      const launchId = newId('lch');
      await insert('checking', { launch_id: launchId });
      await exec(conn, `INSERT INTO launches (id, agent_id, kind, run_id, cwd, runtime, requested_at) VALUES (?, NULL, 'quote_check', ?, ?, 'git', ?)`, [launchId, answerId, repoPath, now]);
      await announce('checking');
      return { state: 'checking' as const, answer_id: answerId };
    }
    // The citation held, so the run of refused citations ends here, also for a decision that is held.
    await resetRefusalsTx(conn, i.id);
    if (a.kind === 'product') {
      const holdUntil = new Date(now.getTime() + AUTO_HOLD_MINUTES * 60_000);
      await insert('held', { hold_until: holdUntil });
      await announce('held');
      return { state: 'held' as const, answer_id: answerId, hold_until: holdUntil };
    }
    const posted = await postAs(conn, ctx, architectId, jobId, threadId, autoBody(decision, label));
    await insert('posted', { message_id: posted.message_id, decided_at: now });
    await resolveDelegatedTx(conn, ctx, architectId, a.blocker_id, `Decided by the Architect in auto mode, from ${label}: ${decision}`, true);
    await announce('posted');
    return { state: 'posted' as const, answer_id: answerId, message_id: posted.message_id };
  });
}

/**
 * Posts the held product decisions whose hold is over. Runs in the scheduler tick. A decision is not posted when auto mode
 * was switched off, the blocker closed, the Client took the blocker on, or its citation no longer holds: it is refused with
 * the reason, and the Architect hears of it, so it can decide again or escalate. A decision whose post fails (the reply cap
 * of its thread, say) is refused the same way, so one row never stops the rows after it or the tick's wake flush.
 */
export async function postHeldDecisions(ctx: Ctx) {
  const due = await query(ctx.pool, `SELECT id FROM architect_answers WHERE state = 'held' AND hold_until <= ? ORDER BY hold_until, id`, [ctx.clock.now()]);
  for (const { id } of due) {
    try {
      await postHeld(ctx, String(id));
    } catch (error) {
      const reason = `The decision could not be posted, so nothing was posted: ${(error as Error).message} Escalate it if it still needs a decision.`;
      await tx(ctx, (conn) => refuse(conn, ctx, String(id), reason, false, 'held'));
    }
  }
}

async function postHeld(ctx: Ctx, id: string) {
  await tx(ctx, async (conn) => {
    const e = (await queryOne(conn, `SELECT * FROM architect_answers WHERE id = ? AND state = 'held' FOR UPDATE`, [id])) as AnswerRow | null;
    if (!e || !e.blocker_id) return;
    const citation = DecideCitationSchema.parse(parseJson(e.citation));
    const stale = () => checkDecideCitation(conn, e.initiative_id, citation).then(() => null, (error: Error) => `${error.message} It changed during the hold, so nothing was posted.`);
    const why = !(await autoModeOf(conn, ctx, e.initiative_id)).on
      ? 'Auto mode was switched off before the hold ended, so nothing was posted. Escalate it if it still needs a decision.'
      : (await escalationOpen(conn, e.blocker_id))
        ? 'The Client is deciding this blocker, so nothing was posted.'
        : !(await blockerOpen(conn, e.blocker_id, true))
          ? 'The blocker closed before the hold ended, so nothing was posted.'
          : await stale();
    if (why) {
      await refuse(conn, ctx, e.id, why, false, 'held');
      return;
    }
    const ini = await queryOne(conn, 'SELECT architect_agent_id FROM initiatives WHERE id = ?', [e.initiative_id]);
    const architectId = String(ini?.architect_agent_id);
    const label = decideLabel(citation);
    const posted = await postAs(conn, ctx, architectId, e.job_id, e.thread_id, autoBody(e.answer, label));
    await exec(conn, `UPDATE architect_answers SET state = 'posted', message_id = ?, decided_at = ? WHERE id = ?`, [posted.message_id, ctx.clock.now(), e.id]);
    await resolveDelegatedTx(conn, ctx, architectId, e.blocker_id, `Decided by the Architect in auto mode, from ${label}: ${e.answer}`, true);
    await emit(conn, ctx, { type: 'architect.auto_decision', jobId: e.job_id, actor: architectId, targets: [], payload: { answer_id: e.id, blocker_id: e.blocker_id, state: 'posted' } });
  });
}

/**
 * The Client undoes an auto decision. Held or still waiting for its code check: nothing was posted, and nothing will be.
 * Posted: Reopen takes it back until Staff replies, and the blocker becomes a client decision of the Client's own. The held
 * case is tried first and its UPDATE checks the state, so a hold that ends in between goes to Reopen instead of failing.
 */
export async function undoDecision(ctx: Ctx, answerId: string) {
  const row = await queryOne(ctx.pool, 'SELECT auto FROM architect_answers WHERE id = ?', [answerId]);
  if (!row || Number(row.auto) !== 1) throw conflict('Only a decision the Architect took in auto mode is undone here.');
  const undone = await tx(ctx, async (conn) => {
    const upd = await exec(conn, `UPDATE architect_answers SET state = 'undone', decided_at = ? WHERE id = ? AND auto = 1 AND state IN ('held', 'checking')`, [ctx.clock.now(), answerId]);
    return upd.affectedRows === 1;
  });
  if (undone) return { state: 'undone' as const };
  const cur = await queryOne(ctx.pool, 'SELECT state FROM architect_answers WHERE id = ?', [answerId]);
  if (cur?.state === 'posted') return reopenAnswer(ctx, answerId);
  throw conflict('This decision can no longer be undone.');
}

/**
 * The Client approves an answer of the Architect: an auto decision, or a posted answer to a blocker. It leaves the list to
 * review and stands as it is. A second Approve changes nothing.
 */
export async function approveAnswer(ctx: Ctx, answerId: string) {
  const row = await queryOne(ctx.pool, 'SELECT auto, state, target FROM architect_answers WHERE id = ?', [answerId]);
  if (!row) throw notFound(`Answer ${answerId}`);
  if (Number(row.auto) !== 1 && !(row.state === 'posted' && row.target === 'blocker')) throw conflict('Only an auto decision or a posted answer to a blocker is approved.');
  await exec(ctx.pool, 'UPDATE architect_answers SET reviewed_at = ? WHERE id = ? AND reviewed_at IS NULL', [ctx.clock.now(), answerId]);
  return { ok: true };
}

/**
 * The room's "Decided for you": the auto decisions of the last 7 days, newest first, with the blocker's kind and question.
 * undoable says whether Undo still works: held or checking, or posted with no Staff reply since.
 */
export async function autoDecisionsOf(ctx: Ctx, initiativeId: string) {
  const rows = await query(
    ctx.pool,
    `SELECT a.id, a.job_id, a.thread_id, a.blocker_id, a.answer, a.citation, a.state, a.decision_kind, a.hold_until, a.reviewed_at, a.refusal, a.created_at, a.decided_at,
       b.kind AS blocker_kind, b.requested_decision AS question,
       (a.state IN ('held', 'checking') OR (a.state = 'posted' AND NOT EXISTS (SELECT 1 FROM messages m JOIN agents g ON g.id = m.author WHERE m.thread_id = a.thread_id AND g.role = 'staff' AND m.id > a.message_id))) AS undoable
     FROM architect_answers a LEFT JOIN blockers b ON b.id = a.blocker_id
     WHERE a.initiative_id = ? AND a.auto = 1 AND a.created_at > ? ORDER BY a.created_at DESC, a.id LIMIT 100`,
    [initiativeId, new Date(ctx.clock.now().getTime() - 7 * 24 * 3_600_000)],
  );
  return rows.map((r) => ({ ...r, undoable: Number(r.undoable) === 1 }));
}

