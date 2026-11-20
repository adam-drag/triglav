import type { Ctx } from './context.ts';
import { tx } from './context.ts';
import { queryOne } from './db.ts';
import { assertNoSecrets, conflict, forbidden, invalid } from './lib.ts';
import { cardOfJob } from './card-links.ts';
import { generalThreadId, lockJob } from './jobs.ts';
import { resolveBlockerTx } from './blockers.ts';
import { architectIdOf, postAs } from './architect-answers.ts';

/**
 * The Architect approves the release notes of a PR, or suggests a corrected block (src/architect-rules.ts, release_notes).
 * It answers a client decision blocker of a job of its initiative: the answer is posted on the job's General thread as the
 * Architect, and the blocker is resolved, in one transaction. No citation: the rule makes it the Architect's call.
 */
export async function answerReleaseNotes(ctx: Ctx, initiativeId: string, input: { blocker_id: string; verdict: 'approve' | 'suggest'; text?: string; note?: string }) {
  const text = input.text?.trim() ?? '';
  if (input.verdict === 'suggest' && !text) throw invalid('suggest needs the corrected block in text.');
  if (input.verdict === 'approve' && text) throw invalid('approve takes no text. To change the block, use suggest.');
  assertNoSecrets(text, input.note);
  // The Architect's agent row is made outside the transaction (architectIdOf holds its own).
  const architectId = await architectIdOf(ctx, initiativeId);
  return tx(ctx, async (conn) => {
    const b = await queryOne(conn, 'SELECT * FROM blockers WHERE id = ? FOR UPDATE', [input.blocker_id]);
    if (!b) throw invalid(`Blocker ${input.blocker_id} does not exist.`);
    const job = await lockJob(conn, String(b.job_id));
    // A subjob has no card of its own: it belongs to the card of the job it was split from.
    const link = (await cardOfJob(conn, String(job.id))) ?? (job.parent_job_id ? await cardOfJob(conn, String(job.parent_job_id)) : null);
    if (!link || link.initiative_id !== initiativeId) throw forbidden('That blocker is not on a job of your initiative.');
    if (b.kind !== 'client_decision') throw conflict(`Blocker ${b.id} is ${b.kind}, not a client decision.`);
    if (b.resolved_at || b.dismissed_at) throw conflict(`Blocker ${b.id} is no longer open.`);
    const why = input.note?.trim() ? `${input.note.trim()}\n\n` : '';
    const body =
      input.verdict === 'approve'
        ? `Release notes: approved, use the block as written.\n\n${why}(The Architect, by its release-notes rule.)`
        : `Release notes: use this block instead.\n\n${why}${text}\n\n(The Architect, by its release-notes rule.)`;
    const threadId = await generalThreadId(conn, String(job.id));
    const posted = await postAs(conn, ctx, architectId, String(job.id), threadId, body);
    const resolution = input.verdict === 'approve' ? 'The Architect approved the release notes as written.' : 'The Architect suggested a corrected release notes block on the General thread.';
    await resolveBlockerTx(conn, ctx, architectId, b, job, resolution);
    return { blocker_id: String(b.id), job_id: String(job.id), verdict: input.verdict, message_id: posted.message_id };
  });
}
