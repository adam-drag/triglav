import { parseJson, queryOne, type Conn } from './db.ts';
import { cardStartOfJob } from './card-links.ts';
import type { Block, Doc } from './design.ts';

/**
 * The design a design-lens review reads: the card the job was started from, at the design version it was started from, with
 * the decisions and contracts the card lists, in full (the same lists the Staff prompt gives its job). Null when no card started
 * the job. The text is Client-written design: the review marks it as data.
 */
export const DESIGN_MAX_CHARS = 20000;

export async function designForReview(conn: Conn, jobId: string): Promise<string | null> {
  const start = await cardStartOfJob(conn, jobId);
  if (!start) return null;
  const v = await queryOne(conn, 'SELECT doc FROM initiative_versions WHERE initiative_id = ? AND version = ?', [start.initiative_id, start.started_from_version]);
  if (!v) return null;
  const doc = parseJson<Doc>(v.doc);
  const card = doc.blocks.find((b): b is Extract<Block, { kind: 'card' }> => b.kind === 'card' && b.id === start.card_key);
  if (!card) return null;
  const decisions = new Map(doc.blocks.filter((b): b is Extract<Block, { kind: 'decision' }> => b.kind === 'decision').map((b) => [b.id, b] as const));
  const contracts = new Map(doc.blocks.filter((b): b is Extract<Block, { kind: 'contract' }> => b.kind === 'contract').map((b) => [b.id, b] as const));
  const list = (items: string[]) => (items.length ? items.map((i) => `- ${i}`).join('\n') : '- None listed.');
  const full = (ids: string[] | undefined, found: Map<string, { id: string; title: string; body: string }>) =>
    (ids ?? []).map((id) => found.get(id)).filter((b): b is { id: string; title: string; body: string } => Boolean(b)).map((b) => `${b.id} "${b.title}"\n${b.body}`).join('\n\n') || 'None listed.';
  const text = `Card ${card.id} "${card.title}" in repository ${card.repo}, design v${start.started_from_version}.

Goal:
${card.goal}

Scope:
${list(card.scope)}

Out of scope:
${list(card.out)}

Acceptance:
${list(card.accept)}

Decisions the change must honour, in full:
${full(card.decisions, decisions)}

Contracts the change must keep, in full:
${full(card.contracts, contracts)}`;
  return text.length > DESIGN_MAX_CHARS ? `${text.slice(0, DESIGN_MAX_CHARS)}\n[design cut at ${DESIGN_MAX_CHARS} characters]` : text;
}
