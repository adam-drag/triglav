import { tx, type Ctx } from './context.ts';
import { exec } from './db.ts';
import { emit } from './events.ts';
import { invalid } from './lib.ts';
import { checkAgainstCatalog, detectedRuntimes, RUNTIME_LABELS, SAFE, type Detected } from './models.ts';
import { configOf, DEFAULT_PANEL, loadPanelConfig, MAX_CHEAP_SEATS, panelSeats, type PanelConfig, type SeatConfig } from './code-review.ts';

/*
 * The Client's setting for the local code review panel: one strong seat and up to MAX_CHEAP_SEATS cheap seats, each with a
 * runtime, model and effort. Saved in the `review_panel` row of `settings`. `requestCodeReview` reads it when a review is
 * requested, so a review that is already running keeps its seats. Without a row the panel is DEFAULT_PANEL. See
 * .claude/skills/triglav-code-review.
 */

const RUNTIMES = Object.keys(RUNTIME_LABELS);

/** Throws a reason the Client can act on when the panel is not acceptable. The model and effort checks are the ones a role gets. */
export function validatePanel(det: Detected, input: unknown): PanelConfig {
  const o = input as { strong?: unknown; cheap?: unknown } | null;
  if (!o || typeof o !== 'object' || !o.strong) throw invalid('The panel needs one strong seat.');
  if (!Array.isArray(o.cheap)) throw invalid('cheap must be a list of seats (it may be empty).');
  if (o.cheap.length > MAX_CHEAP_SEATS) throw invalid(`The panel may have at most ${MAX_CHEAP_SEATS} cheap seats, not ${o.cheap.length}.`);
  const seat = (label: string, raw: unknown): SeatConfig => {
    const s = raw as Record<string, unknown> | null;
    if (!s || typeof s !== 'object') throw invalid(`${label} must have a runtime, a model and an effort.`);
    for (const f of ['runtime', 'model', 'effort'] as const) {
      if (typeof s[f] !== 'string' || !(s[f] as string).length || (s[f] as string).length > 100) throw invalid(`${label}: ${f} is required (at most 100 characters).`);
    }
    const v = { runtime: s.runtime as string, model: s.model as string, effort: s.effort as string };
    if (!RUNTIMES.includes(v.runtime)) throw invalid(`${label}: the runtime must be ${RUNTIMES.join(' or ')}, not "${v.runtime}".`);
    for (const f of ['model', 'effort'] as const) {
      if (!SAFE.test(v[f])) throw invalid(`${label}: ${f} may only contain letters, digits, ".", "_", ":" and "-", and must start with a letter or digit.`);
    }
    try {
      checkAgainstCatalog(det, v);
    } catch (e) {
      throw invalid(`${label}: ${(e as Error).message}`);
    }
    return v as SeatConfig;
  };
  return { strong: seat('Strong seat', o.strong), cheap: o.cheap.map((c, i) => seat(`Cheap seat ${i + 1}`, c)) };
}

/** The saved panel (or the default) with the seat names a review would use, for the Models page. */
export async function reviewPanelView(ctx: Ctx) {
  const { config, saved, updated_at } = await loadPanelConfig(ctx.pool);
  return {
    panel: config,
    seats: panelSeats(config).map((s) => s.seat),
    is_default: !saved,
    default_panel: configOf(DEFAULT_PANEL),
    max_cheap_seats: MAX_CHEAP_SEATS,
    updated_at,
  };
}

export async function setReviewPanel(ctx: Ctx, input: unknown) {
  const panel = validatePanel(await detectedRuntimes(ctx), input);
  await tx(ctx, async (conn) => {
    await exec(conn, `INSERT INTO settings (name, value, updated_at) VALUES ('review_panel', ?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = VALUES(updated_at)`, [JSON.stringify(panel), ctx.clock.now()]);
    await emit(conn, ctx, { type: 'review_panel.changed', actor: 'client', payload: { panel } });
  });
  return reviewPanelView(ctx);
}

/** Back to DEFAULT_PANEL: the saved row is removed, so a later change of the default reaches this machine too. */
export async function resetReviewPanel(ctx: Ctx) {
  await tx(ctx, async (conn) => {
    await exec(conn, `DELETE FROM settings WHERE name = 'review_panel'`);
    await emit(conn, ctx, { type: 'review_panel.changed', actor: 'client', payload: { panel: configOf(DEFAULT_PANEL), reset: true } });
  });
  return reviewPanelView(ctx);
}
