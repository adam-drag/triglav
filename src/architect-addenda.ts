import { tx, type Ctx } from './context.ts';
import { exec, queryOne, type Conn } from './db.ts';
import { cardOfJob } from './card-links.ts';
import { acknowledgeCard, changeOfStart, startOfJobCard, type CardChange } from './initiative-jobs.ts';
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
 * The most text an addendum may carry. The Confirm card shows the header and the text whole (addendumHead), and placeAction cuts
 * the card summary at CONFIRM_SUMMARY_MAX, so the header and the text must fit under that cap. The card change takes the room
 * left. The Architect's schema (src/architect.ts) uses this constant too, so the two cannot drift.
 */
export const ADDENDUM_MAX_CHARS = 600;
/** The cap of a Confirm card's summary (placeAction in src/operator-actions.ts). */
export const CONFIRM_SUMMARY_MAX = 1500;
/** The most fields a card change lists (changeSince in src/initiative-jobs.ts keeps this many), so the count text is sized for it. */
const CHANGE_FIELDS_MAX = 40;

/**
 * The room the card change needs at least: its lead (with the card key, up to 64 characters) and the longest count text. The header
 * and text must leave this much of CONFIRM_SUMMARY_MAX, so the change text always fits its room.
 */
export function changeRoomMin(cardKey: string): number {
  return ` Card ${cardKey} changed since its start: `.length + `${CHANGE_FIELDS_MAX} fields, not shown.`.length;
}

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
  // The change of the job's own start, as it is now: the Confirm card shows this stored diff, and the acknowledgement goes to that start.
  const startId = await startOfJobCard(conn, i.id, target.card_key, a.job_id);
  const change: CardChange | undefined = startId ? await changeOfStart(conn, i, await versionOf(conn, i.id, i.current_version), startId) : undefined;
  // The Confirm card shows the header and the text whole, so they must leave the card change its room (changeRoomMin).
  const head = addendumHead({ body: a.text, card_key: target.card_key, design_version: i.current_version, linear_identifier: target.job.linear_identifier, title: target.job.title });
  const room = changeRoomMin(target.card_key);
  if (head.length + room > CONFIRM_SUMMARY_MAX) throw invalid(`The addendum and its header come to ${head.length} characters, and the Confirm card shows at most ${CONFIRM_SUMMARY_MAX - room} of them with the card change. Shorten the text.`);
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

/** The header and the text of a Confirm card: the part the Architect controls, shown whole. */
function addendumHead(a: { body: string; card_key: string; design_version: number | string; linear_identifier: string; title: string }): string {
  return `Send an addendum to ${a.linear_identifier} ${a.title} (card ${a.card_key}, design v${a.design_version}), posted on its General thread as the Architect: "${a.body}"`;
}

/** A field value as the Confirm card shows it: JSON, cut at CARD_VALUE_MAX characters. */
const CARD_VALUE_MAX = 120;
function clip(v: unknown): string {
  const s = JSON.stringify(v) ?? 'null';
  return s.length > CARD_VALUE_MAX ? `${s.slice(0, CARD_VALUE_MAX - 3)}...` : s;
}

/**
 * The card's change for the Confirm card: as many fields as fit in `room` characters, and a count of the rest. A long change
 * never pushes the addendum out of the card.
 */
function changeText(cardKey: string, change: CardChange | null, room: number): string {
  if (!change) return '';
  const lead = ` Card ${cardKey} changed since its start: `;
  if (change.fields.length === 0) return `${lead}no field.`;
  const items = change.fields.map((f) => `${f.field} ${clip(f.before)} -> ${clip(f.after)}`);
  // The tail is counted at its longest, so the text stays under the room whatever the count of the fields left out.
  const tail = `; and ${items.length} more.`.length;
  let text = '';
  let n = 0;
  while (n < items.length) {
    const next = `${n ? '; ' : ''}${items[n]}`;
    if (lead.length + text.length + next.length + tail > room) break;
    text += next;
    n++;
  }
  if (n === items.length) return `${lead}${text}.`;
  return n ? `${lead}${text}; and ${items.length - n} more.` : `${lead}${items.length} ${items.length === 1 ? 'field' : 'fields'}, not shown.`;
}

/** The Confirm card's text for an addendum: the header and the text whole, then the card change in the room left. */
export function addendumCardText(a: { body: string; card_key: string; design_version: number | string; linear_identifier: string; title: string; card_diff: CardChange | null }): string {
  const head = addendumHead(a);
  return `${head}${changeText(a.card_key, a.card_diff, CONFIRM_SUMMARY_MAX - head.length)}`;
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
