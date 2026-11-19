import { tx, type Ctx } from './context.ts';
import { exec, queryOne, type Conn } from './db.ts';
import { cardOfJob } from './card-links.ts';
import { acknowledgeCard, changesSinceStart, startOfJobCard, type CardChange } from './initiative-jobs.ts';
import { initiativeById, versionOf } from './initiatives.ts';
import { postAs } from './architect-answers.ts';
import { generalThreadId } from './jobs.ts';
import { assertNoSecrets, conflict, forbidden, invalid, newId, notFound, RetryableAction } from './lib.ts';

/**
 * Addenda to a running job of an initiative (docs/plans/initiative-room.md, phase 4). The Architect proposes an addendum
 * (src/architect.ts, propose_addendum); a row holds its text, and a chat action (ARCHITECT_ACTIONS.apply_addendum) asks the
 * Client. The Confirm card is written from this row, never from the model's words. On Confirm the text is checked again and
 * posted on the job's General thread as the Architect's agent, never as the Client, and the card's change since its start
 * is acknowledged. Only the card's root job takes one: a subjob has no card start of its own.
 */

/**
 * The most text an addendum may carry. The Confirm card shows the whole text (addendumCardText), and placeAction cuts the card
 * summary at CONFIRM_SUMMARY_MAX, so the text must fit under that cap with its header and the card change. The Architect's
 * schema (src/architect.ts) uses this constant too, so the two cannot drift.
 */
export const ADDENDUM_MAX_CHARS = 600;
/** The cap of a Confirm card's summary (placeAction in src/operator-actions.ts). */
export const CONFIRM_SUMMARY_MAX = 1500;

/** The job an addendum may go to: a job of this initiative that is still running. A finished, cancelled or foreign job is refused. */
export async function addendumTarget(conn: Conn, initiativeId: string, jobId: string) {
  const link = await cardOfJob(conn, jobId);
  if (!link || link.initiative_id !== initiativeId) throw forbidden('That job is not a job of your initiative.');
  const job = await queryOne(conn, 'SELECT id, status, linear_identifier, title FROM jobs WHERE id = ?', [jobId]);
  if (!job) throw notFound(`Job ${jobId}`);
  if (job.status === 'done' || job.status === 'cancelled') throw conflict(`${job.linear_identifier} is ${job.status}, so it takes no addendum.`);
  return { card_key: link.card_key, job };
}

/** Stores a proposed addendum as pending, after the target check. Runs on the caller's transaction. */
export async function insertAddendum(conn: Conn, ctx: Ctx, initiativeId: string, a: { job_id: string; text: string; reason?: string }) {
  const i = await initiativeById(conn, initiativeId);
  if (i.status !== 'active') throw conflict(`Initiative ${i.key} is ${i.status}.`);
  const target = await addendumTarget(conn, initiativeId, a.job_id);
  assertNoSecrets(a.text, a.reason);
  // The card's change since its start, as it is now: the Confirm card shows this stored diff, not a later one.
  const change: CardChange | undefined = (await changesSinceStart(conn, i, await versionOf(conn, i.id, i.current_version))).get(target.card_key);
  // The Confirm card must show every character that gets posted, so a text that does not fit with its header and the change is refused here.
  const shown = addendumCardText({ body: a.text, card_key: target.card_key, design_version: i.current_version, linear_identifier: target.job.linear_identifier, title: target.job.title, card_diff: change ?? null });
  if (shown.length > CONFIRM_SUMMARY_MAX) throw invalid(`The addendum and the card change come to ${shown.length} characters, more than the Confirm card shows (${CONFIRM_SUMMARY_MAX}). Shorten the text.`);
  const id = newId('add');
  await exec(conn, `INSERT INTO initiative_addenda (id, initiative_id, job_id, card_key, design_version, body, reason, card_diff, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`, [
    id,
    initiativeId,
    a.job_id,
    target.card_key,
    i.current_version,
    a.text,
    a.reason ?? null,
    change ? JSON.stringify(change) : null,
    ctx.clock.now(),
  ]);
  return { id, card_key: target.card_key, job: target.job };
}

/** The Confirm card's text for an addendum. The body is shown whole: ADDENDUM_MAX_CHARS keeps it under the card cap. */
export function addendumCardText(a: { body: string; card_key: string; design_version: number | string; linear_identifier: string; title: string; card_diff: CardChange | null }): string {
  const diff = a.card_diff ? ` Card ${a.card_key} changed since its start: ${a.card_diff.fields.map((f) => `${f.field} ${JSON.stringify(f.before)} -> ${JSON.stringify(f.after)}`).join('; ') || 'no field'}.` : '';
  return `Send an addendum to ${a.linear_identifier} ${a.title} (card ${a.card_key}, design v${a.design_version}), posted on its General thread as the Architect: "${a.body}"${diff}`;
}

/** The Confirm card's text: what the addendum sends, from the stored row. */
export async function describeAddendum(conn: Conn, addendumId: string): Promise<string> {
  const a = await queryOne(conn, 'SELECT a.body, a.card_key, a.card_diff, a.design_version, j.linear_identifier, j.title FROM initiative_addenda a JOIN jobs j ON j.id = a.job_id WHERE a.id = ?', [addendumId]);
  if (!a) throw notFound(`Addendum ${addendumId}`);
  return addendumCardText({
    body: String(a.body),
    card_key: String(a.card_key),
    design_version: a.design_version,
    linear_identifier: String(a.linear_identifier),
    title: String(a.title),
    card_diff: a.card_diff ? (JSON.parse(String(a.card_diff)) as CardChange) : null,
  });
}

/**
 * The Client confirmed. Checks the job again, posts the addendum as the Architect and acknowledges the card's change. A job
 * that finished or was cancelled since the proposal refuses it: the row becomes refused and nothing is posted.
 */
export async function applyAddendum(ctx: Ctx, addendumId: string): Promise<string> {
  const result = await tx(ctx, async (conn) => {
    const a = await queryOne(conn, 'SELECT * FROM initiative_addenda WHERE id = ? FOR UPDATE', [addendumId]);
    if (!a) throw notFound(`Addendum ${addendumId}`);
    if (a.state !== 'pending') throw conflict(`This addendum is already ${a.state}.`);
    // The initiative lock comes before the card acknowledgement's read and write, as in dismissCardChange. Nothing takes it
    // after the addendum row in the other order (decideAction locks only the chat action; closeAddendum only the addendum row).
    await queryOne(conn, 'SELECT id FROM initiatives WHERE id = ? FOR UPDATE', [String(a.initiative_id)]);
    const i = await initiativeById(conn, String(a.initiative_id));
    const refuse = async (reason: string) => {
      await exec(conn, `UPDATE initiative_addenda SET state = 'refused', refusal = ?, decided_at = ? WHERE id = ?`, [reason.slice(0, 500), ctx.clock.now(), addendumId]);
      return { posted: false as const, reason };
    };
    if (i.status !== 'active') return refuse(`Initiative ${i.key} is ${i.status}.`);
    let target: Awaited<ReturnType<typeof addendumTarget>>;
    try {
      target = await addendumTarget(conn, i.id, String(a.job_id));
    } catch (e) {
      return refuse(e instanceof Error ? e.message : 'The job takes no addendum.');
    }
    // The change is acknowledged on the start of the job the addendum goes to, not on the card's newest start (a reopened job
    // and its replacement share the card).
    const startId = await startOfJobCard(conn, i.id, target.card_key, String(a.job_id));
    if (!startId) return refuse(`${target.job.linear_identifier} has no start on card ${target.card_key}.`);
    const agent = await queryOne(conn, 'SELECT architect_agent_id FROM initiatives WHERE id = ?', [i.id]);
    if (!agent?.architect_agent_id) return refuse('The Architect has no agent row for this initiative.');
    const threadId = await generalThreadId(conn, String(a.job_id));
    // The header and the acknowledgement name the design version the text was written against (stored at proposal), not the
    // version current at Confirm: a later revision may have changed the same card again.
    const writtenAt = Number(a.design_version);
    const body = `Addendum from the Architect, design v${writtenAt}:\n\n${a.body}`;
    // A refused post throws, so the transaction rolls back and the addendum stays pending. The Client can confirm again.
    await postAs(conn, ctx, String(agent.architect_agent_id), String(a.job_id), threadId, body).catch((e: unknown) => {
      throw new RetryableAction(e instanceof Error ? e.message : 'The post was refused.');
    });
    await exec(conn, `UPDATE initiative_addenda SET state = 'posted', decided_at = ? WHERE id = ?`, [ctx.clock.now(), addendumId]);
    await acknowledgeCard(conn, ctx, i.id, target.card_key, 'addendum', null, writtenAt, startId);
    return { posted: true as const, reason: `Posted on ${target.job.linear_identifier}'s General thread as the Architect (design v${writtenAt}).` };
  });
  if (!result.posted) throw conflict(result.reason);
  return result.reason;
}

/** The Client denied the card or it expired: the addendum is closed and nothing is posted. Runs in the transaction that moves the card. */
export async function closeAddendum(conn: Conn, ctx: Ctx, addendumId: string, state: 'denied' | 'expired') {
  await exec(conn, `UPDATE initiative_addenda SET state = ?, decided_at = ? WHERE id = ? AND state = 'pending'`, [state, ctx.clock.now(), addendumId]);
}
