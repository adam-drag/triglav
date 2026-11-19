import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { tx, type Ctx } from './context.ts';
import { queryOne } from './db.ts';
import { checkDoc, DesignError, DOC_FORMAT, MAX_BODY, type Doc } from './design.ts';
import { insertInitiative, RepoSchema, type Repo } from './initiatives.ts';
import { checkRepoPath } from './job-requests.ts';
import { AppError, assertNoSecrets, conflict, invalid, newId } from './lib.ts';

/**
 * New initiative from the New job form (docs/plans/initiative-room.md, card new-initiative-form, C-create and C-skeleton).
 * The Client gives a title, the repositories and a prompt; the server makes the key and the version 1 skeleton. It lives in
 * its own module because it needs checkRepoPath (job-requests.ts), which imports the initiative jobs module, and that
 * module imports initiatives.ts: importing it from initiatives.ts would close an import cycle.
 */

/** The key is the title's slug, a dash and a random suffix; the whole key must fit INITIATIVE_KEY (63 characters). */
const SUFFIX_CHARS = 6;
const KEY_SLUG_MAX = 63 - SUFFIX_CHARS - 1;
/** A repository slug is at most 40 characters (REPO_SLUG, src/design.ts). */
const REPO_SLUG_MAX = 40;
/** A random suffix collides with an existing key almost never; a bounded number of new suffixes is still enough. */
const KEY_TRIES = 5;

export const CreateSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    repos: z
      .array(
        z
          .object({
            path: z.string(),
            base: z.string().max(200),
            slug: z.string().max(100).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(10),
    prompt: z.string().trim().min(1).max(MAX_BODY),
  })
  .strict();
export type CreateInput = z.infer<typeof CreateSchema>;

/** Lowercase, hyphens for each run of other characters, no leading or trailing hyphen. */
function titleSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** The key of a new initiative: the title's slug (or "initiative" when it has none), a dash and the suffix. */
export function initiativeKey(title: string, suffix: string): string {
  const slug = titleSlug(title).slice(0, KEY_SLUG_MAX).replace(/-+$/, '');
  return `${slug || 'initiative'}-${suffix}`;
}

/** A repository's default slug: its folder name, lowercase, other characters made hyphens. */
function folderSlug(path: string): string {
  const folder = path.split('/').pop() ?? '';
  return folder
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '') || 'repo';
}

/** The first free slug of a folder: the folder's own, then with -2, -3 and so on, all at most 40 characters. */
function freeSlug(folder: string, taken: Set<string>): string {
  const base = folderSlug(folder);
  for (let n = 1; ; n++) {
    const tail = n === 1 ? '' : `-${n}`;
    const candidate = `${base.slice(0, REPO_SLUG_MAX - tail.length).replace(/-+$/, '')}${tail}`;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
}

/** Runs one repository's checks and names its position in any refusal, never its path or its value. */
function atRepo<T>(index: number, check: () => T): T {
  try {
    return check();
  } catch (e) {
    if (e instanceof AppError) throw invalid(`Repository ${index + 1}: ${e.message}`);
    if (e instanceof z.ZodError) throw invalid(`Repository ${index + 1}: ${e.issues[0]?.path.join('.') || 'value'} is not valid.`);
    throw e;
  }
}

/**
 * The repositories of a new initiative. Each path goes through checkRepoPath (which expands ~ with the host home), then the
 * home bound when ORCH_HOST_HOME is set, then RepoSchema. Without ORCH_HOST_HOME there is no bound: checkRepoPath still
 * refuses a ~ path, and the runner checks the directory itself.
 */
export function reposOf(rows: CreateInput['repos'], home: string | undefined): Repo[] {
  const explicit = rows.map((r) => r.slug).filter((s): s is string => s !== undefined);
  if (new Set(explicit).size !== explicit.length) throw invalid('Two repositories have the same slug.');
  const taken = new Set(explicit);
  const root = home?.replace(/\/+$/, '');
  return rows.map((row, index) =>
    atRepo(index, () => {
      const path = checkRepoPath(row.path, home);
      if (root !== undefined && (path === root || !path.startsWith(`${root}/`))) throw invalid('The path must be inside the home folder (ORCH_HOST_HOME).');
      const slug = row.slug ?? freeSlug(path, taken);
      return RepoSchema.parse({ slug, path, base: row.base });
    }),
  );
}

/** The version 1 skeleton (C-skeleton): the title and one text block that holds the prompt. No cards, gates or decisions. */
function skeletonOf(title: string, prompt: string): Doc {
  try {
    return checkDoc({ format: DOC_FORMAT, title, blocks: [{ kind: 'text', id: 'T-brief', body: prompt }] });
  } catch (e) {
    throw e instanceof DesignError ? invalid(e.message) : e;
  }
}

/**
 * Creates an empty initiative from the New job form: a key the server makes, the repositories, and version 1 with the prompt
 * as data. `home` is ORCH_HOST_HOME; it is read from the environment when the caller does not pass one.
 */
export async function createInitiative(ctx: Ctx, raw: unknown, home: string | undefined = process.env.ORCH_HOST_HOME) {
  const input = CreateSchema.parse(raw);
  assertNoSecrets(input.title, input.prompt);
  const repos = reposOf(input.repos, home);
  const doc = skeletonOf(input.title, input.prompt);
  const id = newId('ini');
  const chatId = newId('cht');
  const now = ctx.clock.now();
  const key = await tx(ctx, async (conn) => {
    // The key check runs inside the transaction: the write lock makes the check and the insert one step, and a deadlock
    // retry (withTx) runs this callback again with a new suffix.
    for (let attempt = 0; attempt < KEY_TRIES; attempt++) {
      const candidate = initiativeKey(input.title, randomBytes(SUFFIX_CHARS / 2).toString('hex'));
      if (await queryOne(conn, 'SELECT id FROM initiatives WHERE `key` = ? FOR UPDATE', [candidate])) continue;
      await insertInitiative(conn, {
        id,
        chatId,
        key: candidate,
        title: input.title,
        repos,
        cap: 3,
        milestones_started: [],
        version: 1,
        doc,
        trigger: 'create',
        triggerRef: null,
        summary: 'Created from the New job form',
        now,
      });
      return candidate;
    }
    throw conflict('Could not find a free address for the initiative. Try again.');
  });
  return { key, version: 1, chat_id: chatId };
}
