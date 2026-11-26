import { parseJson, queryOne, type Conn } from './db.ts';
import { cardStartOfJobOrParent } from './card-links.ts';
import type { Block, Doc } from './design.ts';

/**
 * The design a design-lens review reads: the card the job was started from (or its parent was), at the design version it was started
 * from. Null when no card started the job. The text is Client-written design: the review marks it as data, and buildReviewPrompt
 * cuts it to the room the prompt has.
 */
export async function designForReview(conn: Conn, jobId: string): Promise<string | null> {
  const start = await cardStartOfJobOrParent(conn, jobId);
  if (!start) return null;
  const v = await queryOne(conn, 'SELECT doc FROM initiative_versions WHERE initiative_id = ? AND version = ?', [start.initiative_id, start.started_from_version]);
  if (!v) return null;
  return designText(parseJson<Doc>(v.doc), start.card_key, start.started_from_version);
}

/**
 * The card's design as the review reads it: its goal, scope, out of scope and acceptance, and the decisions and contracts the card
 * lists, in full (the same lists the Staff prompt gives its job). A superseded decision keeps its notice, as the Staff prompt does.
 * Null when the document has no such card.
 */
export function designText(doc: Doc, cardKey: string, version: number): string | null {
  const card = doc.blocks.find((b): b is Extract<Block, { kind: 'card' }> => b.kind === 'card' && b.id === cardKey);
  if (!card) return null;
  const decisions = new Map(doc.blocks.filter((b): b is Extract<Block, { kind: 'decision' }> => b.kind === 'decision').map((b) => [b.id, b] as const));
  const contracts = new Map(doc.blocks.filter((b): b is Extract<Block, { kind: 'contract' }> => b.kind === 'contract').map((b) => [b.id, b] as const));
  const list = (items: string[]) => (items.length ? items.map((i) => `- ${i}`).join('\n') : '- None listed.');
  const full = (ids: string[] | undefined, found: Map<string, { id: string; title: string; body: string; superseded_by?: string }>) =>
    (ids ?? [])
      .map((id) => found.get(id))
      .filter((b): b is { id: string; title: string; body: string; superseded_by?: string } => Boolean(b))
      .map((b) => `${b.id} "${b.title}"\n${b.body}${b.superseded_by ? `\nSuperseded by: ${b.superseded_by}` : ''}`)
      .join('\n\n') || 'None listed.';
  return `Card ${card.id} "${card.title}" in repository ${card.repo}, design v${version}.

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
}
