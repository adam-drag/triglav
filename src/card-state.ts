import { createHash } from 'node:crypto';
import type { Block, Doc, Gate } from './design.ts';

/**
 * The one gate evaluator (docs/plans/initiative-room.md, phase 2). It turns the design version, the gate rows and each
 * card's latest start into a card state: Delivered, Running (with the job's status), Ready, Your step or Locked. The API,
 * the Jobs tab and Start all read it, so they cannot disagree. Pure: the caller loads the facts.
 *
 * decision and milestone gates are read from the design: a decision is met when its open decision is closed, a milestone
 * when it is in the initiative's started milestones. A merged, deployed or client_step gate is met only by a gate row: a
 * runner check (merged) or a manual mark with a reason. A client_step mark re-opens when its checkpoint's steps change.
 */

export type GateKind = Gate['kind'];
export type CardState = 'delivered' | 'running' | 'ready' | 'your_step' | 'locked';

export type GateRow = { met_at: string | null; met_by: string | null; reason: string | null; evidence: unknown; checkpoint_hash: string | null };

/** The hash a client_step mark keeps: the checkpoint's steps, trimmed, with runs of spaces collapsed. */
export function checkpointHash(steps: string[]): string {
  return createHash('sha256').update(JSON.stringify(steps.map((s) => s.trim().replace(/\s+/g, ' ')))).digest('hex');
}
export type CardStart = { request_status: string; job_id: string | null; job_status: string | null; dismissed: boolean; started_from_version: number; started_at: string };
/** Rows keyed by `${card key}|${gate key}`; starts keyed by card key (the latest start only). */
export type Facts = { rows: Map<string, GateRow>; starts: Map<string, CardStart> };

export type GateView = {
  key: string;
  kind: GateKind;
  label: string;
  met: boolean;
  met_by: string | null;
  met_at: string | null;
  reason: string | null;
  evidence: unknown;
  /** The Client may mark it by hand. Decision and milestone gates follow the design and are never marked. */
  markable: boolean;
  /** A client_step mark whose checkpoint changed after it was made: it is open again until the Client marks it. */
  reopened: boolean;
};

export type CardView = {
  key: string;
  title: string;
  repo: string;
  wave: string;
  state: CardState;
  /** Delivered from the design (an import or a confirmed revision), not from a job. Shown as recorded, not checked. */
  recorded: boolean;
  /** The job's status while it runs (or `starting` before Staff registers it). */
  phase: string | null;
  job_id: string | null;
  started_from_version: number | null;
  gates: GateView[];
  open: number;
};

export const gateKeyOf = (g: Gate): string => {
  if (g.kind === 'merged') return `merged:${g.job}`;
  if (g.kind === 'deployed') return `deployed:${g.repo}:${g.after}`;
  if (g.kind === 'decision') return `decision:${g.ref}`;
  if (g.kind === 'milestone') return `milestone:${g.ref}`;
  return `client_step:${g.ref}`;
};

export const gateLabel = (g: Gate, titles: Map<string, string>): string => {
  if (g.kind === 'merged') return `${g.job} merged${titles.get(g.job) ? ` (${titles.get(g.job)})` : ''}`;
  if (g.kind === 'deployed') return `${g.repo} deployed after ${g.after}`;
  if (g.kind === 'decision') return `Decision ${g.ref} decided`;
  if (g.kind === 'milestone') return `Milestone ${g.ref} started`;
  return `Your step ${g.ref}`;
};

/**
 * A start that still holds the card: its job is not finished or cancelled, or Staff has not registered it yet. A request
 * the Client dismissed holds nothing, so its card can be started again.
 */
function activeStart(s: CardStart | undefined): boolean {
  if (!s) return false;
  if (s.job_id) return s.job_status !== 'done' && s.job_status !== 'cancelled';
  return !s.dismissed && (s.request_status === 'queued' || s.request_status === 'started');
}

export function evaluateCards(doc: Doc, milestonesStarted: string[], facts: Facts): CardView[] {
  const titles = new Map(doc.blocks.map((b) => [b.id, b.title ?? ''] as const));
  const openDecisions = new Map(doc.blocks.filter((b) => b.kind === 'open').map((b) => [b.id, Boolean(b.closed)] as const));
  const started = new Set(milestonesStarted);
  const checkpoints = new Map(doc.blocks.filter((b): b is Extract<Block, { kind: 'checkpoint' }> => b.kind === 'checkpoint').map((b) => [b.id, checkpointHash(b.steps)] as const));
  const out: CardView[] = [];
  for (const card of doc.blocks) {
    if (card.kind !== 'card') continue;
    const seen = new Set<string>();
    const gates: GateView[] = [];
    for (const g of card.gates) {
      const key = gateKeyOf(g);
      if (seen.has(key)) continue;
      seen.add(key);
      const row = facts.rows.get(`${card.id}|${key}`);
      const markable = g.kind === 'merged' || g.kind === 'deployed' || g.kind === 'client_step';
      let met = Boolean(row?.met_at);
      let reopened = false;
      if (g.kind === 'decision') met = openDecisions.get(g.ref) === true;
      if (g.kind === 'milestone') met = started.has(g.ref);
      // A row without a hash predates the column; it is adopted by the room's next read (adoptCheckpointHashes).
      if (g.kind === 'client_step' && met && row?.checkpoint_hash && row.checkpoint_hash !== checkpoints.get(g.ref)) {
        met = false;
        reopened = true;
      }
      gates.push({
        key,
        kind: g.kind,
        label: gateLabel(g, titles),
        met,
        met_by: met && markable ? (row?.met_by ?? null) : null,
        met_at: row?.met_at ?? null,
        reason: row?.reason ?? null,
        evidence: row?.evidence ?? null,
        markable,
        reopened,
      });
    }
    const start = facts.starts.get(card.id);
    const busy = activeStart(start);
    const recorded = Boolean(card.delivered) && start?.job_status !== 'done';
    const delivered = start?.job_status === 'done' || Boolean(card.delivered);
    const unmet = gates.filter((g) => !g.met);
    let state: CardState;
    if (delivered) state = 'delivered';
    else if (busy) state = 'running';
    else if (unmet.length === 0) state = 'ready';
    else if (unmet.every((g) => g.kind === 'client_step')) state = 'your_step';
    else state = 'locked';
    out.push({
      key: card.id,
      title: card.title,
      repo: card.repo,
      wave: card.wave,
      state,
      recorded,
      phase: busy ? (start?.job_status ?? 'starting') : null,
      job_id: start?.job_id ?? null,
      started_from_version: start?.started_from_version ?? null,
      gates,
      open: unmet.length,
    });
  }
  return out;
}
