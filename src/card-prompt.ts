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

/**
 * The card's done-when list. A card names its items of the definition of done by number ("6 (load)" is item 6), so the
 * item text is added beside the number. With more than one definition of done in the design a number is ambiguous, so
 * the text stays as written.
 */
function doneWhen(card: CardBlock, doc: Doc): string[] {
  const dods = doc.blocks.filter((b): b is Extract<Block, { kind: 'dod' }> => b.kind === 'dod');
  const items = dods.length === 1 ? dods[0]!.items : null;
  return card.dod.map((d) => {
    const n = /^(\d+)\b/.exec(d)?.[1];
    const item = items && n ? items[Number(n) - 1] : undefined;
    return item ? `${d}: ${item}` : d;
  });
}

/** The Client's answers to the open decisions that this card's decision gates wait for. A gate is met by the answer. */
function closedAnswers(card: CardBlock, doc: Doc): string {
  const opens = card.gates.flatMap((g) => {
    if (g.kind !== 'decision') return [];
    const o = doc.blocks.find((b): b is Extract<Block, { kind: 'open' }> => b.kind === 'open' && b.id === g.ref);
    return o?.closed ? [o] : [];
  });
  return opens.length ? opens.map((o) => `${o.id} "${o.title}": ${o.closed}`).join('\n') : 'None.';
}

export function buildCardPrompt(p: CardPromptInput): string {
  const { card, doc } = p;
  const decisions = doc.blocks.filter((b): b is Extract<Block, { kind: 'decision' }> => b.kind === 'decision');
  const listed = (card.decisions ?? []).map((id) => decisions.find((d) => d.id === id)).filter((d): d is Extract<Block, { kind: 'decision' }> => Boolean(d));
  // The contracts are the card's own list, as the design has it. The card text is not searched for ids.
  const named = new Set(card.contracts ?? []);
  const contracts = doc.blocks.filter((b): b is Extract<Block, { kind: 'contract' }> => b.kind === 'contract' && named.has(b.id));
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
    ...(card.step ? [`Step\n${card.step}`] : []),
    ...(card.note ? [`Note\n${card.note}`] : []),
    `Scope\n${list(card.scope)}`,
    `Out of scope\n${list(card.out)}`,
    `Acceptance criteria\n${list(card.accept)}`,
    `Verification\n${list(card.verify)}`,
    `Traps\n${list(card.traps)}`,
    `Safety\n${list(card.safety)}`,
    `Done when\n${list(doneWhen(card, doc))}`,
    `Merged dependencies\n${merged}`,
    `Decisions of this card, in full\n${decisionsFull}`,
    `Answers to the open decisions this card waits for\n${closedAnswers(card, doc)}`,
    `All decisions, id and title only\n${index}`,
    `Contracts this card names\n${contractText}`,
    `Repository rules: read the repository's own instructions (AGENTS.md, CLAUDE.md or CONTRIBUTING.md) before you change code, and run the checks they name.`,
    `Questions: post them on the General thread of this job, not in another job's thread, and say which decision or contract they concern.`,
  ].join('\n\n');
}
