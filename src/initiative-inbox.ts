import type { Ctx } from './context.ts';
import { query, queryOne } from './db.ts';
import { clientQueue } from './blockers.ts';
import { cardOfJob } from './card-links.ts';
import { openAnswers, autoDecisionsOf } from './architect-answers.ts';
import { cardStatesOf } from './initiative-jobs.ts';
import { initiativeByKey } from './initiatives.ts';

/** The states of an auto decision the Client may still want to look at (the room's AUTO_TO_REVIEW). */
const AUTO_TO_REVIEW = ['held', 'checking', 'posted'];

/**
 * What waits for the Client in each active initiative, for the Inbox's Initiatives section and the room's strip.
 *
 * - decisions: the open Client blockers of the initiative's jobs (a job a card started, or a subjob of one), each with the
 *   Architect's open escalation of it, if any. The Inbox shows these here and not under Client decisions, so a decision is
 *   listed once. An escalation of a blocker that is not the Client's (external, failed execution) is listed on its own.
 * - answers: delegated answers Reopen can still take back. auto: auto decisions not yet kept or undone.
 * - revisions: design changes the Architect proposed that wait for the Client. your_step: cards waiting on a Client step.
 *
 * An unavailable owner is not a decision: the Inbox shows it with the Staff it is about, so it is never grouped here.
 * Without a key, only initiatives with something waiting are returned; with one, that initiative always is.
 */
export async function initiativeInbox(ctx: Ctx, key?: string) {
  const rows = key
    ? [await initiativeByKey(ctx.pool, key)]
    : await Promise.all((await query(ctx.pool, "SELECT `key` FROM initiatives WHERE status = 'active' ORDER BY updated_at DESC")).map((r) => initiativeByKey(ctx.pool, String(r.key))));
  const ids = new Set(rows.map((i) => i.id));

  const answers = (await openAnswers(ctx)).filter((a) => ids.has(String(a.initiative_id)));
  const escalations = new Map<string, (typeof answers)[number]>();
  for (const a of answers) if (a.state === 'escalated') escalations.set(String(a.blocker_id), a);

  // Each open Client blocker goes to the initiative of its escalation, or of the card its job (or the job's parent) came from.
  const byInitiative = new Map<string, Record<string, unknown>[]>();
  const placed = new Set<string>();
  for (const b of await clientQueue(ctx)) {
    if (b.kind === 'unavailable_owner') continue;
    const esc = escalations.get(String(b.id));
    const initiativeId = esc ? String(esc.initiative_id) : ((await cardOfJob(ctx.pool, String(b.parent_job_id ?? b.job_id)))?.initiative_id ?? null);
    if (!initiativeId || !ids.has(initiativeId)) continue;
    placed.add(String(b.id));
    byInitiative.set(initiativeId, [...(byInitiative.get(initiativeId) ?? []), { ...b, escalation: esc ?? null }]);
  }

  const groups = [];
  for (const i of rows) {
    const mine = answers.filter((a) => String(a.initiative_id) === i.id);
    const revisions = Number((await queryOne(ctx.pool, "SELECT COUNT(*) AS n FROM initiative_revisions WHERE initiative_id = ? AND state = 'pending'", [i.id]))?.n ?? 0);
    const auto = (await autoDecisionsOf(ctx, i.id)).filter((d) => !(d as { reviewed_at?: unknown }).reviewed_at && AUTO_TO_REVIEW.includes(String((d as { state?: unknown }).state)));
    const yourStep = (await cardStatesOf(ctx.pool, i)).filter((c) => c.state === 'your_step').map((c) => ({ key: c.key, title: c.title }));
    const group = {
      key: i.key,
      title: i.title,
      decisions: byInitiative.get(i.id) ?? [],
      // An escalation whose blocker is not on the Client's list (an external blocker, say): it is answered with Accept only.
      escalations: mine.filter((a) => a.state === 'escalated' && !placed.has(String(a.blocker_id))),
      answers: mine.filter((a) => a.state !== 'escalated'),
      auto,
      revisions,
      your_step: yourStep,
    };
    const waiting = group.decisions.length + group.escalations.length + group.answers.length + group.auto.length + group.revisions + group.your_step.length;
    if (key || waiting > 0) groups.push(group);
  }
  return groups;
}

