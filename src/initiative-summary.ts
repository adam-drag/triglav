import type { Ctx } from './context.ts';
import { query, queryOne } from './db.ts';
import { cardStatesOf, runningCardJobs } from './initiative-jobs.ts';
import { initiativeByKey, versionOf } from './initiatives.ts';

/** The card states, in the order the progress bar draws them. */
export const CARD_STATES = ['delivered', 'running', 'your_step', 'ready', 'locked'] as const;

/**
 * Each initiative with its progress, for Home and the Initiatives page: the cards of the current version per state (the
 * Plan tab's evaluator, so it reads the database only), the first wave that still has a card to deliver, the implementation
 * jobs running, and when the Architect last wrote. Active initiatives come first, then the newest change.
 */
export async function initiativeSummaries(ctx: Ctx) {
  const keys = await query(ctx.pool, "SELECT `key` FROM initiatives ORDER BY status = 'active' DESC, updated_at DESC");
  const out = [];
  for (const { key } of keys) {
    const i = await initiativeByKey(ctx.pool, String(key));
    const v = await versionOf(ctx.pool, i.id, i.current_version);
    const states = new Map((await cardStatesOf(ctx.pool, i)).map((c) => [c.key, c.state]));
    const counts = Object.fromEntries(CARD_STATES.map((s) => [s, 0])) as Record<(typeof CARD_STATES)[number], number>;
    for (const s of states.values()) counts[s as (typeof CARD_STATES)[number]] += 1;
    // The current wave: the first, in design order, with a card that is not delivered yet.
    const cards = v.doc.blocks.filter((b) => b.kind === 'card') as { id: string; wave: string }[];
    const wave = v.doc.blocks.find((b) => b.kind === 'wave' && cards.some((c) => c.wave === b.id && states.get(c.id) !== 'delivered')) as { id: string; title: string } | undefined;
    const waveCards = wave ? cards.filter((c) => c.wave === wave.id) : [];
    const architect = i.chat_id ? await queryOne(ctx.pool, 'SELECT MAX(created_at) AS at FROM chat_messages WHERE chat_id = ?', [i.chat_id]) : null;
    out.push({
      key: i.key,
      title: i.title,
      status: i.status,
      version: i.current_version,
      repos: i.repos.map((r) => r.slug),
      updated_at: i.updated_at,
      cards: { total: states.size, ...counts },
      wave: wave ? { id: wave.id, title: wave.title, delivered: waveCards.filter((c) => states.get(c.id) === 'delivered').length, total: waveCards.length } : null,
      jobs_running: await runningCardJobs(ctx.pool, i.id),
      architect_at: architect?.at ?? null,
    });
  }
  return out;
}
