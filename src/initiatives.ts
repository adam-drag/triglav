import { z } from 'zod';
import { tx, type Ctx } from './context.ts';
import { exec, parseJson, query, queryOne, type Conn } from './db.ts';
import { applyOps, blockDiff, checkDoc, DesignError, describeRevision, REPO_SLUG, type Doc } from './design.ts';
import { architectChatInitiative, insertArchitectChat } from './chat.ts';
import { conflict, invalid, newId, notFound } from './lib.ts';
import { REPO_NAME } from './gate-check.ts';

/**
 * Initiatives: a layer above jobs with a living design (src/design.ts) in immutable versions, and an Architect chat that
 * owns it (src/architect.ts). The Client imports a design; the Architect proposes revisions; only the Client's Confirm
 * applies one (src/operator-actions.ts, ARCHITECT_ACTIONS).
 */

export const INITIATIVE_KEY = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** A branch name the runner may pass to git: no leading dash, no "..", plain characters. */
export const BRANCH = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,100}$/;
const SAFE_PATH = /^\/[A-Za-z0-9._@+ /-]{1,500}$/;

/**
 * A repository of an initiative. path and base tell the runner where to keep its read-only worktree at origin/<base>.
 * github is the GitHub slug of a merged gate check (gate-check.ts, REPO_NAME); deploy is for the deployed gates of a later
 * phase. Both come from the Client's import, never from the Architect.
 */
export const RepoSchema = z
  .object({
    slug: z.string().regex(REPO_SLUG),
    path: z.string().regex(SAFE_PATH).refine((p) => !p.split('/').includes('..'), 'no ".." in a path'),
    base: z.string().regex(BRANCH),
    github: z.string().regex(REPO_NAME).optional(),
    deploy: z
      .object({ workflow: z.string().max(200), job: z.string().max(200).optional(), step: z.string().max(200).optional(), note: z.string().max(1000).optional() })
      .strict()
      .optional(),
  })
  .strict();
export type Repo = z.infer<typeof RepoSchema>;

export const ImportSchema = z
  .object({
    key: z.string().regex(INITIATIVE_KEY),
    title: z.string().min(1).max(300),
    repos: z.array(RepoSchema).min(1).max(10),
    cap: z.number().int().min(1).max(20).optional(),
    milestones_open: z.array(z.string().max(24)).max(20).optional(),
    version: z.number().int().min(1).max(10_000).optional(),
    source: z.string().min(1).max(300),
    doc: z.unknown(),
  })
  .strict();

const designError = (e: unknown) => (e instanceof DesignError ? invalid(e.message) : e);

/** Every card, and every deployed gate, names one of the initiative's repositories: at import and after each revision. */
function checkRepos(doc: Doc, slugs: string[]) {
  for (const b of doc.blocks) if (b.kind === 'card' && (!slugs.includes(b.repo) || b.gates.some((g) => g.kind === 'deployed' && !slugs.includes(g.repo)))) throw invalid(`Card ${b.id} names a repository that is not in repos.`);
}

/** The Client imports a design: a new initiative at the given version (1 by default), with its Architect chat. */
export async function importInitiative(ctx: Ctx, raw: unknown) {
  const input = ImportSchema.parse(raw);
  let doc: Doc;
  try {
    doc = checkDoc(input.doc);
  } catch (e) {
    throw designError(e);
  }
  const slugs = input.repos.map((r) => r.slug);
  if (new Set(slugs).size !== slugs.length) throw invalid('Two repositories have the same slug.');
  checkRepos(doc, slugs);
  const id = newId('ini');
  const chatId = newId('cht');
  const version = input.version ?? 1;
  const now = ctx.clock.now();
  await tx(ctx, async (conn) => {
    // tx() holds the global write lock, so two imports of one key run one after the other and the second stops here.
    if (await queryOne(conn, 'SELECT id FROM initiatives WHERE `key` = ? FOR UPDATE', [input.key])) throw conflict(`An initiative ${input.key} already exists.`);
    await exec(conn, 'INSERT INTO initiatives (id, `key`, title, repos, status, cap, milestones_open, current_version, chat_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
      id,
      input.key,
      input.title,
      JSON.stringify(input.repos),
      'active',
      input.cap ?? 3,
      JSON.stringify(input.milestones_open ?? []),
      version,
      chatId,
      now,
      now,
    ]);
    await exec(conn, `INSERT INTO initiative_versions (initiative_id, version, doc, changed, trigger_kind, trigger_ref, summary, created_by, created_at) VALUES (?, ?, ?, '[]', 'import', ?, ?, 'client', ?)`, [
      id,
      version,
      JSON.stringify(doc),
      input.source,
      `Imported from ${input.source}`.slice(0, 1000),
      now,
    ]);
    await insertArchitectChat(conn, chatId, `Architect: ${input.title}`, id, now);
  });
  return { id, key: input.key, version, chat_id: chatId };
}

type InitiativeRow = { id: string; key: string; title: string; repos: Repo[]; status: string; cap: number; milestones_open: string[]; current_version: number; chat_id: string | null; created_at: Date; updated_at: Date };
const row = (r: Record<string, unknown>): InitiativeRow => ({ ...(r as InitiativeRow), repos: parseJson<Repo[]>(r.repos), milestones_open: parseJson<string[]>(r.milestones_open) });

export async function initiativeByKey(conn: Conn, key: string): Promise<InitiativeRow> {
  const r = await queryOne(conn, 'SELECT * FROM initiatives WHERE `key` = ?', [key]);
  if (!r) throw notFound(`Initiative ${key}`);
  return row(r);
}

export async function initiativeById(conn: Conn, id: string): Promise<InitiativeRow> {
  const r = await queryOne(conn, 'SELECT * FROM initiatives WHERE id = ?', [id]);
  if (!r) throw notFound(`Initiative ${id}`);
  return row(r);
}

export async function listInitiatives(ctx: Ctx) {
  const rows = await query(
    ctx.pool,
    "SELECT i.id, i.`key`, i.title, i.status, i.current_version, i.repos, i.updated_at, v.created_at AS version_at, (SELECT COUNT(*) FROM initiative_revisions r WHERE r.initiative_id = i.id AND r.state = 'pending') AS pending_revisions FROM initiatives i JOIN initiative_versions v ON v.initiative_id = i.id AND v.version = i.current_version ORDER BY i.updated_at DESC",
  );
  return rows.map((r) => ({ ...r, repos: parseJson<Repo[]>(r.repos).map((x) => x.slug), pending_revisions: Number(r.pending_revisions) }));
}

export async function versionOf(conn: Conn, initiativeId: string, version: number) {
  const v = await queryOne(conn, `SELECT * FROM initiative_versions WHERE initiative_id = ? AND version = ?`, [initiativeId, version]);
  if (!v) throw notFound(`Version ${version}`);
  return { version: Number(v.version), doc: parseJson<Doc>(v.doc), changed: parseJson<string[]>(v.changed), trigger_kind: v.trigger_kind as string, trigger_ref: (v.trigger_ref as string | null) ?? null, summary: v.summary as string, created_by: v.created_by as string, created_at: v.created_at as Date };
}

/** The room: the initiative, the version asked for (the current one by default), the list of versions and the open revisions. */
export async function getInitiative(ctx: Ctx, key: string, version?: number) {
  const i = await initiativeByKey(ctx.pool, key);
  const shown = await versionOf(ctx.pool, i.id, version ?? i.current_version);
  const versions = await query(ctx.pool, `SELECT version, changed, trigger_kind, trigger_ref, summary, created_by, created_at FROM initiative_versions WHERE initiative_id = ? ORDER BY version DESC`, [i.id]);
  const revisions = await query(ctx.pool, `SELECT id, base_version, summary, state, action_id, applied_version, created_at, decided_at FROM initiative_revisions WHERE initiative_id = ? ORDER BY state = 'pending' DESC, created_at DESC LIMIT 50`, [i.id]);
  // Where each block last changed: the room marks a block "updated in vN" when that is after the first version.
  const first = versions.length ? Number(versions[versions.length - 1].version) : shown.version;
  const updatedIn: Record<string, number> = {};
  for (const v of [...versions].reverse()) {
    if (Number(v.version) > shown.version) break;
    if (Number(v.version) === first) continue;
    // A removed block is in `changed` too, but there is nothing to mark.
    for (const b of parseJson<string[]>(v.changed)) if (shown.doc.blocks.some((x) => x.id === b)) updatedIn[b] = Number(v.version);
  }
  return {
    initiative: { id: i.id, key: i.key, title: i.title, status: i.status, cap: i.cap, milestones_open: i.milestones_open, current_version: i.current_version, chat_id: i.chat_id, repos: i.repos.map((r) => ({ slug: r.slug, base: r.base, github: r.github ?? null })) },
    version: shown,
    updated_in: updatedIn,
    versions: versions.map((v) => ({ ...v, version: Number(v.version), changed: parseJson<string[]>(v.changed) })),
    revisions,
  };
}

/** What one version changed against the one before it, block by block, for History. */
export async function versionDiff(ctx: Ctx, key: string, version: number) {
  const i = await initiativeByKey(ctx.pool, key);
  const next = await versionOf(ctx.pool, i.id, version);
  const prev = await queryOne(ctx.pool, `SELECT MAX(version) AS v FROM initiative_versions WHERE initiative_id = ? AND version < ?`, [i.id, version]);
  if (prev?.v == null) return { version, base: null, blocks: [] };
  const base = await versionOf(ctx.pool, i.id, Number(prev.v));
  return { version, base: base.version, blocks: blockDiff(base.doc, next.doc) };
}

/** A revision with the changes it would make, block by block, for the Confirm card in the room. */
export async function revisionView(ctx: Ctx, key: string, revisionId: string) {
  const i = await initiativeByKey(ctx.pool, key);
  const r = await queryOne(ctx.pool, `SELECT * FROM initiative_revisions WHERE id = ? AND initiative_id = ?`, [revisionId, i.id]);
  if (!r) throw notFound(`Revision ${revisionId}`);
  const base = await versionOf(ctx.pool, i.id, Number(r.base_version));
  let blocks: ReturnType<typeof blockDiff> = [];
  try {
    blocks = blockDiff(base.doc, applyOps(base.doc, parseJson(r.ops)).doc);
  } catch {
    /* a revision is checked when proposed; a base that no longer fits shows no blocks */
  }
  return { id: r.id, state: r.state, base_version: Number(r.base_version), summary: r.summary, applied_version: r.applied_version, blocks };
}

// ---------------------------------------------------------------- revisions

/**
 * Stores a revision the Architect proposed, after checking it applies cleanly to the current version. Returns the lines
 * of the Confirm card, written from the stored operations.
 */
export async function storeRevision(conn: Conn, ctx: Ctx, initiativeId: string, rawOps: unknown, summary: string) {
  const i = await initiativeById(conn, initiativeId);
  if (i.status !== 'active') throw conflict(`Initiative ${i.key} is ${i.status}.`);
  const base = await versionOf(conn, i.id, i.current_version);
  let lines: string[];
  try {
    lines = describeRevision(base.doc, rawOps);
    checkRepos(applyOps(base.doc, rawOps).doc, i.repos.map((r) => r.slug));
  } catch (e) {
    throw designError(e);
  }
  if (!lines.length) throw invalid('This revision changes nothing.');
  const id = newId('rev');
  await exec(conn, `INSERT INTO initiative_revisions (id, initiative_id, base_version, ops, summary, state, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)`, [id, i.id, base.version, JSON.stringify(rawOps), summary.slice(0, 1000), ctx.clock.now()]);
  return { id, base_version: base.version, lines };
}

/** The Confirm card's text: what the revision does, from the database. */
export async function describeStoredRevision(conn: Conn, revisionId: string): Promise<string> {
  const r = await queryOne(conn, `SELECT r.*, i.title, i.\`key\` FROM initiative_revisions r JOIN initiatives i ON i.id = r.initiative_id WHERE r.id = ?`, [revisionId]);
  if (!r) throw notFound(`Revision ${revisionId}`);
  const base = await versionOf(conn, r.initiative_id as string, Number(r.base_version));
  let lines: string[];
  try {
    lines = describeRevision(base.doc, parseJson(r.ops));
  } catch (e) {
    throw designError(e);
  }
  return cardText(`Apply as design v${Number(r.base_version) + 1} of ${r.title} (${r.key}):`, lines);
}

/** Room on a Confirm card (chat_actions.summary is 1500 characters). The room's History shows the waiting revision in full. */
const CARD_MAX = 1400;
export function cardText(head: string, lines: string[]): string {
  const out = [head];
  let size = head.length;
  for (const [n, l] of lines.entries()) {
    const line = `- ${l.length > 300 ? `${l.slice(0, 297)}...` : l}`;
    const rest = lines.length - n;
    // Keep room for the closing line whenever lines remain after this one.
    if (size + line.length + 1 + (rest > 1 ? 60 : 0) > CARD_MAX) {
      out.push(`- ... and ${rest} more change${rest === 1 ? '' : 's'}. The room's History shows every change.`);
      break;
    }
    out.push(line);
    size += line.length + 1;
  }
  return out.join('\n');
}

/**
 * The Client confirmed: the revision becomes version N+1, with the revision as its trigger and the blocks it changed. A
 * revision whose base is no longer the current version is marked stale and refused: the Architect proposes it again.
 */
export async function applyRevision(ctx: Ctx, revisionId: string) {
  const result = await tx(ctx, async (conn) => {
    const r = await queryOne(conn, `SELECT * FROM initiative_revisions WHERE id = ? FOR UPDATE`, [revisionId]);
    if (!r) throw notFound(`Revision ${revisionId}`);
    if (r.state !== 'pending') throw conflict(`This revision is already ${r.state}.`);
    const i = row((await queryOne(conn, `SELECT * FROM initiatives WHERE id = ? FOR UPDATE`, [r.initiative_id]))!);
    if (Number(r.base_version) !== i.current_version) {
      await exec(conn, `UPDATE initiative_revisions SET state = 'stale', decided_at = ? WHERE id = ?`, [ctx.clock.now(), revisionId]);
      return { stale: true as const, current: i.current_version, base: Number(r.base_version) };
    }
    const base = await versionOf(conn, i.id, i.current_version);
    let applied: ReturnType<typeof applyOps>;
    try {
      applied = applyOps(base.doc, parseJson(r.ops));
    } catch (e) {
      throw designError(e);
    }
    const version = i.current_version + 1;
    const now = ctx.clock.now();
    await exec(conn, `INSERT INTO initiative_versions (initiative_id, version, doc, changed, trigger_kind, trigger_ref, summary, created_by, created_at) VALUES (?, ?, ?, ?, 'chat', ?, ?, 'client', ?)`, [
      i.id,
      version,
      JSON.stringify(applied.doc),
      // Removed blocks count as changed, so History names them too.
      JSON.stringify([...applied.changed, ...applied.removed]),
      revisionId,
      String(r.summary).slice(0, 1000),
      now,
    ]);
    await exec(conn, `UPDATE initiatives SET current_version = ?, updated_at = ? WHERE id = ?`, [version, now, i.id]);
    await exec(conn, `UPDATE initiative_revisions SET state = 'applied', applied_version = ?, decided_at = ? WHERE id = ?`, [version, now, revisionId]);
    return { stale: false as const, version, changed: applied.changed, removed: applied.removed };
  });
  if (result.stale) throw conflict(`The design moved on to v${result.current} after this revision was proposed against v${result.base}. Nothing was applied; ask the Architect to propose it again.`);
  return result;
}

/**
 * The Client denied the card, or it expired: the revision is closed and the design does not change. decideAction runs it in
 * the transaction that moves the card, and the open room drops the waiting revision when its chat stream shows the card's
 * new state. A revision is stored with its card in one transaction (propose_design_revision), so none waits without one.
 */
export async function closeRevision(conn: Conn, ctx: Ctx, revisionId: string, state: 'denied' | 'expired') {
  await exec(conn, `UPDATE initiative_revisions SET state = ?, decided_at = ? WHERE id = ? AND state = 'pending'`, [state, ctx.clock.now(), revisionId]);
}

/** The initiative a chat belongs to, for the Architect's tools and for the runner. */
export async function initiativeOfChat(conn: Conn, chatId: string) {
  const initiativeId = await architectChatInitiative(conn, chatId);
  if (!initiativeId) throw notFound(`Architect chat ${chatId}`);
  return initiativeById(conn, initiativeId);
}
