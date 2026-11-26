import { z } from 'zod';
import type { Ctx } from './context.ts';
import { tx } from './context.ts';
import { queryOne } from './db.ts';
import { invalid } from './lib.ts';
import { assertJobOfInitiative } from './architect-jobs.ts';
import { architectAuthor } from './architect-answers.ts';
import { postMessageTx } from './board.ts';
import { generalThreadId, lockJob } from './jobs.ts';

/**
 * The Architect's plain message on a job of its initiative (the post_message tool, docs/plans/architect-sight.md step 2).
 * It is a view for Staff, never a decision: a decision is still answer_staff_question with a citation, and a product choice
 * is still escalate. The message is posted as the Architect (never as the Client), mentions only the job's Staff, and goes
 * through the board's own rules: the reply cap per thread, the secret check, and the reason a challenge needs.
 */
export const POST_MAX_CHARS = 2000;

export const PostSchema = z
  .object({
    job_id: z.string().min(1).max(64),
    thread_id: z.string().min(1).max(64).optional().describe('A thread of the job. Leave out for its General thread.'),
    body: z.string().min(1).max(POST_MAX_CHARS).describe(`At most ${POST_MAX_CHARS} characters, plain text.`),
    stance: z.enum(['inform', 'challenge']).default('inform').describe('inform: a view or a fact you checked. challenge: you disagree with something on the thread, and the reason is required.'),
    reason: z.string().min(1).max(1000).optional().describe('Required for a challenge: what is wrong, with the file, line or decision you checked.'),
    in_reply_to: z.number().int().min(1).optional().describe('A message of the same thread that this one answers.'),
    mention_staff: z.boolean().default(true).describe('Whether the job\'s Staff is tagged, so it reads the message at once.'),
  })
  .strict();

export async function architectPost(ctx: Ctx, initiativeId: string, input: z.input<typeof PostSchema>) {
  const a = PostSchema.parse(input);
  await assertJobOfInitiative(ctx.pool, initiativeId, a.job_id);
  if (a.stance === 'challenge' && !a.reason) throw invalid('A challenge needs a reason: what is wrong, and what you checked.');
  return tx(ctx, async (conn) => {
    const ini = await queryOne(conn, 'SELECT architect_agent_id FROM initiatives WHERE id = ?', [initiativeId]);
    if (!ini?.architect_agent_id) throw invalid('This initiative has no Architect agent yet.');
    const job = await lockJob(conn, a.job_id);
    // A thread of the job, or its General thread. A thread of another job is refused, so a message cannot land on another job's board.
    let threadId: string;
    if (a.thread_id) {
      const t = await queryOne(conn, 'SELECT job_id FROM threads WHERE id = ?', [a.thread_id]);
      if (!t || String(t.job_id) !== a.job_id) throw invalid(`Thread ${a.thread_id} is not a thread of job ${a.job_id}.`);
      threadId = a.thread_id;
    } else {
      threadId = await generalThreadId(conn, a.job_id);
    }
    const staffId = job.staff_agent_id ? String(job.staff_agent_id) : null;
    const res = await postMessageTx(conn, ctx, await architectAuthor(conn, String(ini.architect_agent_id)), {
      jobId: a.job_id,
      threadId,
      type: 'discussion',
      stance: a.stance,
      reason: a.stance === 'challenge' ? a.reason! : null,
      body: a.body,
      inReplyTo: a.in_reply_to ?? null,
      mentions: a.mention_staff && staffId ? [staffId] : [],
    });
    return { message_id: Number(res.message_id), thread_id: threadId, job_id: a.job_id };
  });
}
