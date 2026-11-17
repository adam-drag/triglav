import type { Block, Doc } from './design.ts';

/**
 * The prompt of a job started from a job card (docs/plans/initiative-room.md, phase 2). The server builds it from the
 * design version the card was started at, never from model text. Structure: merged dependencies with their PRs, the
 * card's listed decisions in full, an index of every decision (id and title), the contracts the card names, then the
 * card's own fields. Plain English, no em dashes.
 */

type CardBlock = Extract<Block, { kind: 'card' }>;

export type MergedDependency = { key: string; title: string; pr_url: string | null; merged_at: string | null };

export type CardPromptInput = {
  initiative: { key: string; title: string };
  doc: Doc;
  version: number;
  card: CardBlock;
  repo: { slug: string; path: string; base: string };
  merged: MergedDependency[];
};

const list = (items: string[]) => (items.length ? items.map((i) => `- ${i}`).join('\n') : '- None listed.');

/** The lines a job is told it must not change: the card's own text, which names the decisions and contracts it touches. */
function cardText(card: CardBlock): string {
  return [card.title, card.goal, card.note ?? '', card.step ?? '', ...card.scope, ...card.out, ...card.accept, ...card.verify, ...card.traps, ...card.safety, ...card.dod].join('\n');
}

export function buildCardPrompt(p: CardPromptInput): string {
  const { card, doc } = p;
  const decisions = doc.blocks.filter((b): b is Extract<Block, { kind: 'decision' }> => b.kind === 'decision');
  const listed = (card.decisions ?? []).map((id) => decisions.find((d) => d.id === id)).filter((d): d is Extract<Block, { kind: 'decision' }> => Boolean(d));
  const text = cardText(card);
  const contracts = doc.blocks.filter((b): b is Extract<Block, { kind: 'contract' }> => b.kind === 'contract' && new RegExp(`(^|[^A-Za-z0-9-])${b.id}($|[^A-Za-z0-9-])`).test(text));
  const merged = p.merged.length
    ? p.merged.map((m) => `- ${m.key} "${m.title}": ${m.pr_url ? `PR ${m.pr_url}, merged ${m.merged_at ?? 'date not recorded'}` : 'merged (the Client marked it)'}`).join('\n')
    : '- None.';
  const decisionsFull = listed.length
    ? listed.map((d) => `${d.id} "${d.title}"\n${d.body}${d.superseded_by ? `\nSuperseded by: ${d.superseded_by}` : ''}`).join('\n\n')
    : 'None listed for this card.';
  const index = decisions.length ? decisions.map((d) => `- ${d.id} "${d.title}"`).join('\n') : '- None.';
  const contractText = contracts.length ? contracts.map((c) => `${c.id} "${c.title}"\n${c.body}`).join('\n\n') : 'None named by this card.';
  return [
    `You are Staff for one job of the initiative "${p.initiative.title}" (${p.initiative.key}). The job implements the job card ${card.id} "${card.title}" of design version ${p.version}. The design is pinned at that version: the text below is what this job must do, even if the design changes later.`,
    `Repository: ${p.repo.slug}, at ${p.repo.path}. Base branch: ${p.repo.base}. Work on that repository only.`,
    `Goal\n${card.goal}`,
    `Scope\n${list(card.scope)}`,
    `Out of scope\n${list(card.out)}`,
    `Acceptance criteria\n${list(card.accept)}`,
    `Verification\n${list(card.verify)}`,
    `Traps\n${list(card.traps)}`,
    `Safety\n${list(card.safety)}`,
    `Done when\n${list(card.dod)}`,
    `Merged dependencies\n${merged}`,
    `Decisions of this card, in full\n${decisionsFull}`,
    `All decisions, id and title only\n${index}`,
    `Contracts this card names\n${contractText}`,
    `Repository rules: read the repository's own instructions (AGENTS.md, CLAUDE.md or CONTRIBUTING.md) before you change code, and run the checks they name.`,
    `Questions: post them on the General thread of this job, not in another job's thread, and say which decision or contract they concern.`,
  ].join('\n\n');
}
