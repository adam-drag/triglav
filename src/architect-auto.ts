import type { Ctx } from './context.ts';
import { tx } from './context.ts';
import { exec, queryOne, type Conn } from './db.ts';
import { emit } from './events.ts';
import { conflict } from './lib.ts';
import { initiativeByKey } from './initiatives.ts';
import { openBlockersOfInitiative } from './blockers.ts';
import { wakeForAutoMode } from './architect-wake.ts';

/**
 * Architect auto mode (the triglav-initiatives skill, "Auto mode"). The Client switches it on for one initiative, and the
 * Architect then decides low blast radius blockers itself with decide_blocker (src/architect-answers.ts), inside the limits
 * below. Only a Client-session route changes the mode: the Architect has no tool for it.
 */

/** How long auto mode stays on after the Client switches it on. */
export const AUTO_MODE_HOURS = 24;
/** How long a product decision waits before Staff sees it, so the Client can undo it first. */
export const AUTO_HOLD_MINUTES = 15;
/** The most auto decisions of one initiative in a rolling 24 hours. */
export const AUTO_DECISIONS_PER_DAY = 20;
/** Refused citations in a row that switch auto mode off. */
export const AUTO_REFUSALS_MAX = 3;

/**
 * The blast radius items of the Staff card (src/guide/staff.md, step 4). A decision that touches any of them is "major or
 * more", and auto mode never decides it: decide_blocker refuses a non-empty reach and the Architect escalates instead.
 */
export const REACH = ['goal', 'scope', 'acceptance_criteria', 'user_visible_behaviour', 'service_contract', 'data', 'migration', 'security', 'auth', 'billing', 'hard_to_reverse'] as const;

export type AutoMode = { on: boolean; until: Date | null };

/** Whether auto mode is on for an initiative now. It is off once auto_mode_until has passed; nothing has to clear it. */
export async function autoModeOf(conn: Conn, ctx: Ctx, initiativeId: string): Promise<AutoMode> {
  const r = await queryOne(conn, 'SELECT auto_mode_until FROM initiatives WHERE id = ?', [initiativeId]);
  const until = r?.auto_mode_until ? new Date(r.auto_mode_until as Date) : null;
  const on = !!until && until.getTime() > ctx.clock.now().getTime();
  return { on, until: on ? until : null };
}

/**
 * The Client switches auto mode on (for AUTO_MODE_HOURS) or off. The event row is the log, and it refreshes the open room.
 * Switching on wakes the Architect when a blocker it could decide is already open: nothing else would wake it for that one.
 */
export async function setAutoMode(ctx: Ctx, key: string, on: boolean) {
  const i = await initiativeByKey(ctx.pool, key);
  const page = on ? await openBlockersOfInitiative(ctx, i.id) : null;
  const decidable = !!page && (page.next !== null || page.blockers.some((b) => b.kind !== 'unavailable_owner' && !b.escalated));
  return tx(ctx, async (conn) => {
    const cur = await queryOne(conn, 'SELECT status FROM initiatives WHERE id = ? FOR UPDATE', [i.id]);
    if (on && cur?.status !== 'active') throw conflict(`Initiative ${i.key} is ${String(cur?.status)}, so auto mode cannot be switched on.`);
    const until = on ? new Date(ctx.clock.now().getTime() + AUTO_MODE_HOURS * 3_600_000) : null;
    await exec(conn, 'UPDATE initiatives SET auto_mode_until = ?, auto_mode_refusals = 0 WHERE id = ?', [until, i.id]);
    await emit(conn, ctx, { type: 'initiative.auto_mode', actor: 'client', targets: [], payload: { initiative_id: i.id, on, until, reason: 'client' } });
    if (decidable) await wakeForAutoMode(conn, ctx, i.id);
    return { on, until };
  });
}

/**
 * A refused citation of an auto decision, in the caller's transaction. The count resets on every decision whose citation
 * holds (resetRefusalsTx, when the decision is taken, not when a held one is posted later); AUTO_REFUSALS_MAX in a row
 * switch auto mode off, so a confused Architect stops deciding until the Client looks.
 */
export async function noteRefusalTx(conn: Conn, ctx: Ctx, initiativeId: string) {
  await exec(conn, 'UPDATE initiatives SET auto_mode_refusals = auto_mode_refusals + 1 WHERE id = ?', [initiativeId]);
  const r = await queryOne(conn, 'SELECT auto_mode_refusals FROM initiatives WHERE id = ?', [initiativeId]);
  if (Number(r?.auto_mode_refusals) < AUTO_REFUSALS_MAX || !(await autoModeOf(conn, ctx, initiativeId)).on) return;
  await exec(conn, 'UPDATE initiatives SET auto_mode_until = NULL, auto_mode_refusals = 0 WHERE id = ?', [initiativeId]);
  await emit(conn, ctx, { type: 'initiative.auto_mode', actor: 'scheduler', targets: [], payload: { initiative_id: initiativeId, on: false, until: null, reason: 'refused_citations' } });
}

export const resetRefusalsTx = (conn: Conn, initiativeId: string) => exec(conn, 'UPDATE initiatives SET auto_mode_refusals = 0 WHERE id = ?', [initiativeId]);
