import { z } from 'zod';

/**
 * The design document of an initiative (docs/plans/initiative-room.md): blocks with stable ids, one immutable copy per
 * version. A revision is a list of structural operations on blocks; the Client confirms it from a summary this module
 * writes from the stored operations, never from the model's prose. Pure (no database), so tests and the dashboard agree.
 */

export const DOC_FORMAT = 1;
export const MAX_BODY = 20_000;
const MAX_ITEM = 4_000;
const MAX_ITEMS = 100;
const MAX_BLOCKS = 600;
export const MAX_OPS = 100;

/** A card key: also the slug a job card is known by in gates and dependencies. */
export const CARD_KEY = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const REPO_SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
const ID = {
  decision: /^D[1-9][0-9]{0,2}$/,
  open: /^O-[a-z0-9][a-z0-9-]{0,47}$/,
  contract: /^C-[a-z0-9][a-z0-9-]{0,47}$/,
  checkpoint: /^CP-[A-Z0-9]{1,8}$/,
  wave: /^W-[a-z0-9][a-z0-9-]{0,23}$/,
  text: /^T-[a-z0-9][a-z0-9-]{0,47}$/,
  dod: /^DOD-[a-z0-9][a-z0-9-]{0,23}$/,
  card: CARD_KEY,
} as const;
export type BlockKind = keyof typeof ID;
export const BLOCK_KINDS = Object.keys(ID) as BlockKind[];

const text = (max = MAX_BODY) => z.string().max(max);
const line = z.string().min(1).max(300);
const items = z.array(text(MAX_ITEM)).max(MAX_ITEMS);
const id = (kind: BlockKind) => z.string().regex(ID[kind], `not a ${kind} id`);

export const GateSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('merged'), job: id('card') }).strict(),
  z.object({ kind: z.literal('deployed'), repo: z.string().regex(REPO_SLUG), after: id('card'), note: text(500).optional() }).strict(),
  z.object({ kind: z.literal('decision'), ref: id('open') }).strict(),
  z.object({ kind: z.literal('milestone'), ref: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 -]{0,23}$/) }).strict(),
  z.object({ kind: z.literal('client_step'), ref: id('checkpoint') }).strict(),
]);
export type Gate = z.infer<typeof GateSchema>;

export const BlockSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), id: id('text'), title: line.optional(), body: text() }).strict(),
  z.object({ kind: z.literal('dod'), id: id('dod'), title: line, items }).strict(),
  z.object({ kind: z.literal('decision'), id: id('decision'), title: line, body: text(), superseded_by: text(300).optional() }).strict(),
  z.object({ kind: z.literal('open'), id: id('open'), title: line, body: text(), options: text().optional(), rec: text().optional(), holds: text(500).optional(), closed: text(1000).optional() }).strict(),
  z.object({ kind: z.literal('contract'), id: id('contract'), title: line, body: text() }).strict(),
  z.object({ kind: z.literal('checkpoint'), id: id('checkpoint'), title: line, steps: items }).strict(),
  z.object({ kind: z.literal('wave'), id: id('wave'), title: line, when: text(1000), jobs: z.array(id('card')).max(40), checkpoint: id('checkpoint').optional() }).strict(),
  z
    .object({
      kind: z.literal('card'),
      id: id('card'),
      title: line,
      repo: z.string().regex(REPO_SLUG),
      wave: id('wave'),
      size: z.enum(['S', 'M', 'L', 'XL']).optional(),
      step: text(300).optional(),
      milestone: z.string().max(24).optional(),
      note: text(2000).optional(),
      pr: z.string().regex(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/).optional(),
      merged: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      deps: z.array(id('card')).max(30),
      decisions: z.array(id('decision')).max(40).optional(),
      /** The contracts this card names, listed by the design (the prompt never matches text). */
      contracts: z.array(id('contract')).max(40).optional(),
      /** Set by an import or a Client-confirmed revision for work done before the room. Shown as recorded, not checked. */
      delivered: z.object({ pr: z.string().regex(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/).optional(), note: text(2000).optional() }).strict().optional(),
      goal: text(),
      scope: items,
      out: items,
      accept: items,
      verify: items,
      traps: items,
      safety: items,
      dod: items,
      gates: z.array(GateSchema).max(30),
    })
    .strict(),
]);
export type Block = z.infer<typeof BlockSchema>;

export const DocSchema = z.object({ format: z.literal(DOC_FORMAT), title: line, blocks: z.array(BlockSchema).max(MAX_BLOCKS) }).strict();
export type Doc = z.infer<typeof DocSchema>;

const issues = (e: z.ZodError) =>
  e.issues
    .slice(0, 5)
    .map((i) => `${i.path.join('.') || 'document'}: ${i.message}`)
    .join('; ');

/** Thrown for a document or revision that does not hold together. The message is safe to show to the Architect and the Client. */
export class DesignError extends Error {}

/**
 * Parses a document and checks its shape and that every reference points at a block that exists. The source rule of deployed
 * gates is checked apart (sourceGaps), so a revision can be judged against the stored design it changes.
 */
export function parseDesign(raw: unknown): Doc {
  const parsed = DocSchema.safeParse(raw);
  if (!parsed.success) throw new DesignError(`The design is not valid: ${issues(parsed.error)}`);
  const doc = parsed.data;
  const byId = new Map<string, Block>();
  for (const b of doc.blocks) {
    if (byId.has(b.id)) throw new DesignError(`Two blocks have the id ${b.id}.`);
    byId.set(b.id, b);
  }
  const need = (ref: string, kind: BlockKind, where: string) => {
    if (byId.get(ref)?.kind !== kind) throw new DesignError(`${where} refers to ${ref}, which is not a ${kind} block of this design.`);
  };
  for (const b of doc.blocks) {
    if (b.kind === 'wave') {
      for (const j of b.jobs) need(j, 'card', `Wave ${b.id}`);
      if (b.checkpoint) need(b.checkpoint, 'checkpoint', `Wave ${b.id}`);
    }
    if (b.kind !== 'card') continue;
    need(b.wave, 'wave', `Card ${b.id}`);
    for (const d of b.deps) need(d, 'card', `Card ${b.id}`);
    for (const d of b.decisions ?? []) need(d, 'decision', `Card ${b.id}`);
    for (const c of b.contracts ?? []) need(c, 'contract', `Card ${b.id}`);
    for (const g of b.gates) {
      if (g.kind === 'merged') need(g.job, 'card', `A gate of ${b.id}`);
      if (g.kind === 'deployed') {
        need(g.after, 'card', `A gate of ${b.id}`);
      }
      if (g.kind === 'decision') need(g.ref, 'open', `A gate of ${b.id}`);
      if (g.kind === 'client_step') need(g.ref, 'checkpoint', `A gate of ${b.id}`);
    }
  }
  return doc;
}

/**
 * The deployed gates whose source card has no merged gate. A deployed gate reads the merge commit from that merged gate, so the
 * design needs one for each source a deployed gate names. The key names the card and the source, so two designs can be compared.
 */
export function sourceGaps(doc: Doc): { key: string; message: string }[] {
  const merged = new Set<string>();
  for (const b of doc.blocks) if (b.kind === 'card') for (const g of b.gates) if (g.kind === 'merged') merged.add(g.job);
  const gaps: { key: string; message: string }[] = [];
  for (const b of doc.blocks) {
    if (b.kind !== 'card') continue;
    for (const g of b.gates) {
      if (g.kind === 'deployed' && !merged.has(g.after)) {
        gaps.push({ key: `${b.id}:${g.after}`, message: `The deployed gate of ${b.id} needs the merge commit of ${g.after}, and only a merged gate naming ${g.after} records it. Add that merged gate to the design.` });
      }
    }
  }
  return gaps;
}

/** Parses a new design, and applies the source rule: every deployed gate needs its merged source. */
export function checkDoc(raw: unknown): Doc {
  const doc = parseDesign(raw);
  const gap = sourceGaps(doc)[0];
  if (gap) throw new DesignError(gap.message);
  return doc;
}

// ---------------------------------------------------------------- revisions

/**
 * A JSON string with object keys sorted, for comparing blocks. MySQL's JSON type does not keep key order, so a block read
 * back from the database and the same block parsed by the schema differ under plain JSON.stringify.
 */
export function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v) ?? 'null';
}

const anyId = z.string().min(1).max(64);
export const OpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add'), block: z.record(z.string(), z.unknown()), after: anyId.optional() }).strict(),
  z.object({ op: z.literal('update'), id: anyId, set: z.record(z.string(), z.unknown()) }).strict(),
  z.object({ op: z.literal('remove'), id: anyId }).strict(),
]);
export type Op = z.infer<typeof OpSchema>;
export const OpsSchema = z.array(OpSchema).min(1).max(MAX_OPS);

/**
 * Applies a revision to a document and returns the new document with the ids of the blocks it added or changed. Every
 * operation must apply cleanly and the result must be a valid design, or nothing is applied.
 */
export function applyOps(base: Doc, rawOps: unknown): { doc: Doc; changed: string[]; removed: string[] } {
  const parsedOps = OpsSchema.safeParse(rawOps);
  if (!parsedOps.success) throw new DesignError(`The revision is not valid: ${issues(parsedOps.error)}`);
  const blocks: Record<string, unknown>[] = base.blocks.map((b) => ({ ...b }));
  const index = (bid: string) => blocks.findIndex((b) => b.id === bid);
  const touched = new Set<string>();
  const removed: string[] = [];
  parsedOps.data.forEach((op, n) => {
    const at = `Operation ${n + 1} (${op.op})`;
    if (op.op === 'add') {
      const bid = String(op.block.id ?? '');
      if (index(bid) >= 0) throw new DesignError(`${at}: a block ${bid} already exists. Use update.`);
      let pos = blocks.length;
      if (op.after !== undefined) {
        const i = index(op.after);
        if (i < 0) throw new DesignError(`${at}: there is no block ${op.after} to add after.`);
        pos = i + 1;
      } else {
        // Without a place, a block goes after the last block of its own kind, so decisions stay together.
        const last = blocks.map((b) => b.kind).lastIndexOf(op.block.kind);
        if (last >= 0) pos = last + 1;
      }
      blocks.splice(pos, 0, { ...op.block });
      touched.add(bid);
    } else if (op.op === 'update') {
      const i = index(op.id);
      if (i < 0) throw new DesignError(`${at}: there is no block ${op.id}.`);
      if ('id' in op.set || 'kind' in op.set) throw new DesignError(`${at}: a block's id and kind never change. Remove it and add a new one.`);
      const next: Record<string, unknown> = { ...blocks[i] };
      for (const [k, v] of Object.entries(op.set)) {
        if (v === null) delete next[k];
        else next[k] = v;
      }
      blocks[i] = next;
      touched.add(op.id);
    } else {
      const i = index(op.id);
      if (i < 0) throw new DesignError(`${at}: there is no block ${op.id}.`);
      blocks.splice(i, 1);
      touched.delete(op.id);
      removed.push(op.id);
    }
  });
  const doc = parseDesign({ ...base, blocks });
  // A stored design may already lack a merged source (it was stored before the rule). That gap stays as it is, so writes that
  // leave it alone (a status line, a gate mark) still go through; a revision that newly leaves a deployed gate without one is refused.
  // Counted by key: a second gap with the same key (a second deployed gate on the same card and source) is a new one.
  const known = new Map<string, number>();
  for (const g of sourceGaps(base)) known.set(g.key, (known.get(g.key) ?? 0) + 1);
  const fresh = sourceGaps(doc).find((g) => {
    const n = known.get(g.key) ?? 0;
    if (n > 0) known.set(g.key, n - 1);
    return n === 0;
  });
  if (fresh) throw new DesignError(fresh.message);
  const before = new Map(base.blocks.map((b) => [b.id, stable(b)]));
  const changed = doc.blocks.filter((b) => touched.has(b.id) && before.get(b.id) !== stable(b)).map((b) => b.id);
  return { doc, changed, removed: removed.filter((r) => before.has(r) && !doc.blocks.some((b) => b.id === r)) };
}

/** The block ids that differ between two documents: added or changed. */
export function changedBetween(a: Doc, b: Doc): string[] {
  const before = new Map(a.blocks.map((x) => [x.id, stable(x)]));
  return b.blocks.filter((x) => before.get(x.id) !== stable(x)).map((x) => x.id);
}

const KIND_NAMES: Record<BlockKind, string> = { text: 'text', dod: 'definition of done', decision: 'decision', open: 'open decision', contract: 'contract', checkpoint: 'checkpoint', wave: 'wave', card: 'job card' };
const label = (b: { id: string; kind: string; title?: string }) => `${KIND_NAMES[b.kind as BlockKind] ?? b.kind} ${b.id}${b.title ? ` "${b.title.slice(0, 120)}"` : ''}`;

/**
 * What the Client's Confirm card says, one line per block, written from the base version and the stored operations. It
 * names the blocks and the fields that change; the room shows the full text of each change beside it.
 */
export function describeRevision(base: Doc, rawOps: unknown): string[] {
  const { doc, removed } = applyOps(base, rawOps);
  const before = new Map(base.blocks.map((b) => [b.id, b as Record<string, unknown>]));
  const lines: string[] = [];
  for (const b of doc.blocks) {
    const old = before.get(b.id);
    if (!old) {
      lines.push(`Add ${label(b)}.`);
      continue;
    }
    const fields = Object.keys({ ...old, ...b }).filter((k) => stable(old[k]) !== stable((b as Record<string, unknown>)[k]));
    if (!fields.length) continue;
    if (b.kind === 'open' && fields.includes('closed') && b.closed) lines.push(`Close ${label(b)}: ${b.closed.slice(0, 200)}`);
    else lines.push(`Change ${label(b)}: ${fields.join(', ')}.`);
  }
  for (const r of removed) lines.push(`Remove ${label(before.get(r) as { id: string; kind: string; title?: string })}.`);
  return lines;
}

/** One line per block that changed between two versions, with the old and new value of each field, for History and the Confirm card. */
export function blockDiff(base: Doc, next: Doc): { id: string; kind: string; title: string | null; change: 'added' | 'changed' | 'removed'; fields: { field: string; before: unknown; after: unknown }[] }[] {
  const before = new Map(base.blocks.map((b) => [b.id, b as Record<string, unknown>]));
  const after = new Map(next.blocks.map((b) => [b.id, b as Record<string, unknown>]));
  const out: ReturnType<typeof blockDiff> = [];
  for (const [bid, b] of after) {
    const old = before.get(bid);
    const fields = Object.keys({ ...(old ?? {}), ...b })
      .filter((k) => k !== 'id' && k !== 'kind' && stable(old?.[k]) !== stable(b[k]))
      .map((k) => ({ field: k, before: old?.[k] ?? null, after: b[k] ?? null }));
    if (!old) out.push({ id: bid, kind: String(b.kind), title: (b.title as string) ?? null, change: 'added', fields });
    else if (fields.length) out.push({ id: bid, kind: String(b.kind), title: (b.title as string) ?? null, change: 'changed', fields });
  }
  for (const [bid, b] of before) {
    if (after.has(bid)) continue;
    const fields = Object.keys(b)
      .filter((k) => k !== 'id' && k !== 'kind')
      .map((k) => ({ field: k, before: b[k] ?? null, after: null }));
    out.push({ id: bid, kind: String(b.kind), title: (b.title as string) ?? null, change: 'removed', fields });
  }
  return out;
}

/**
 * The whole design of one version as a markdown file (Download as markdown, docs/plans/initiative-room.md, phase 5). Every
 * block, in the order the document holds them, under its id and title. Text fields become paragraphs, lists become bullets
 * and a gate becomes a bullet with its kind and fields. Pure: the file is written from the stored version only.
 */
export function designMarkdown(doc: Doc, version: number): string {
  const out: string[] = [`# ${doc.title}`, '', `Design version ${version}. Blocks in document order.`, ''];
  for (const b of doc.blocks) {
    const { id, kind, ...rest } = b as Record<string, unknown> & { id: string; kind: string };
    const title = typeof rest.title === 'string' && rest.title ? rest.title : null;
    out.push(`## ${id}${title ? `: ${title}` : ''}`, '', `Kind: ${kind}`, '');
    for (const [field, value] of Object.entries(rest)) {
      if (field === 'title' || value === undefined || value === null || value === '') continue;
      if (Array.isArray(value)) {
        out.push(`${field}:`, '');
        if (value.length === 0) out.push('- (none)');
        // A stored item may hold line breaks: indent every continuation line so the item stays one list item.
        for (const item of value) out.push(typeof item === 'string' ? `- ${item.replace(/\n/g, '\n  ')}` : `- ${JSON.stringify(item)}`);
        out.push('');
      } else if (typeof value === 'string') {
        out.push(`${field}:`, '', value, '');
      } else {
        out.push(`${field}: ${JSON.stringify(value)}`, '');
      }
    }
  }
  return `${out.join('\n').trimEnd()}\n`;
}
