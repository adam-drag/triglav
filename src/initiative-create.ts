import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { architectMessage } from './architect-refs.ts';
import { tx, type Ctx } from './context.ts';
import { exec, queryOne, type Conn } from './db.ts';
import { checkDoc, DesignError, DOC_FORMAT, MAX_BODY, type Doc } from './design.ts';
import { insertInitiative, keyTaken, RepoSchema, type NewInitiative, type Repo } from './initiatives.ts';
import { checkRepoPath } from './job-requests.ts';
import { closeResearchJob, lockJob } from './jobs.ts';
import { AppError, assertNoSecrets, conflict, invalid, newId, notFound } from './lib.ts';

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

/** An initiative has at most this many repositories. */
const MAX_REPOS = 10;
const RepoInput = z
  .object({
    path: z.string(),
    base: z.string().max(200),
    slug: z.string().max(100).optional(),
  })
  .strict();

export const CreateSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    repos: z.array(RepoInput).min(1).max(MAX_REPOS),
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
  const { key, chatId } = await tx(ctx, (conn) => insertWithKey(conn, ctx, { title: input.title, repos, doc, trigger: 'create', triggerRef: null, summary: 'Created from the New job form' }));
  return { key, version: 1, chat_id: chatId };
}

/**
 * Inserts a new initiative at version 1 under a key made from its title. The key check runs inside the caller's
 * transaction: the write lock makes the check and the insert one step, and a deadlock retry (withTx) runs the callback
 * again with a new suffix.
 */
async function insertWithKey(conn: Conn, ctx: Ctx, a: Pick<NewInitiative, 'title' | 'repos' | 'doc' | 'trigger' | 'triggerRef' | 'summary'>) {
  const id = newId('ini');
  const chatId = newId('cht');
  for (let attempt = 0; attempt < KEY_TRIES; attempt++) {
    const key = initiativeKey(a.title, randomBytes(SUFFIX_CHARS / 2).toString('hex'));
    if (await keyTaken(conn, key)) continue;
    await insertInitiative(conn, { ...a, id, chatId, key, cap: 3, milestones_started: [], version: 1, now: ctx.clock.now() });
    return { id, key, chatId };
  }
  throw conflict('Could not find a free address for the initiative. Try again.');
}

/** Start an initiative from a version of a research report: the title, the repositories besides the report's own, a note. */
export const FromReportSchema = z
  .object({
    version: z.number().int().min(1),
    title: z.string().trim().min(1).max(300),
    repos: z.array(RepoInput).max(MAX_REPOS - 1),
    note: z.string().trim().max(4000).optional(),
  })
  .strict();

/**
 * A new initiative from a version of a research job's report (the report page's Start an initiative). In one transaction:
 * the research job's repository comes first, version 1 holds a brief that names the report with its summary and the
 * Client's note, the report is linked (so the Architect reads it with read_report and can cite it), and the research job is
 * closed, as Start implementation closes it. The report body is not copied: it can be ten times the size of a design text.
 * Then the Architect gets a first message to draft the design from the report; the Client's click is the yes for that run.
 */
export async function createInitiativeFromReport(ctx: Ctx, jobId: string, raw: unknown, home: string | undefined = process.env.ORCH_HOST_HOME) {
  const input = FromReportSchema.parse(raw);
  assertNoSecrets(input.title, input.note ?? '');
  const job = await queryOne(ctx.pool, 'SELECT id, kind, linear_identifier, title, repo_path, base_branch FROM jobs WHERE id = ?', [jobId]);
  if (!job) throw notFound(`Job ${jobId}`);
  if (job.kind !== 'research') throw conflict('Only a research job has a report to start an initiative from.');
  const report = await queryOne(ctx.pool, 'SELECT version, summary FROM job_reports WHERE job_id = ? AND version = ?', [jobId, input.version]);
  if (!report) throw notFound(`Version ${input.version} of the report of job ${jobId}`);
  const repos = reposOf([{ path: String(job.repo_path), base: String(job.base_branch) }, ...input.repos], home);
  if (new Set(repos.map((r) => r.path)).size !== repos.length) throw invalid('A repository is listed twice.');
  const source = `version ${input.version} of the report of research job ${job.linear_identifier}`;
  const brief = [
    `This initiative starts from ${source}: ${job.title}. The report is linked to this initiative: read it with read_report.`,
    `Summary of the report:\n${report.summary}`,
    input.note ? `The Client's note:\n${input.note}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  const doc = skeletonOf(input.title, brief);
  const made = await tx(ctx, async (conn) => {
    // The research job is locked first, so two clicks, or a click and Start implementation, cannot both pass.
    const locked = await lockJob(conn, jobId);
    if (locked.status !== 'report_ready') throw conflict(`Job ${jobId} is ${locked.status}. Start an initiative from a report you are reading (status report_ready).`);
    const linked = await queryOne(conn, 'SELECT i.`key` FROM initiative_reports r JOIN initiatives i ON i.id = r.initiative_id WHERE r.job_id = ?', [jobId]);
    if (linked) throw conflict(`This report is already linked to initiative ${linked.key}.`);
    const starting = await queryOne(conn, `SELECT id FROM job_requests WHERE from_job_id = ? AND status IN ('queued', 'started') AND dismissed_at IS NULL`, [jobId]);
    if (starting) throw conflict(`An implementation job is already starting from this report (request ${starting.id}). Cancel it first to start an initiative.`);
    const ini = await insertWithKey(conn, ctx, { title: input.title, repos, doc, trigger: 'research', triggerRef: `${jobId}@v${input.version}`, summary: `Created from ${source}` });
    await exec(conn, 'INSERT INTO initiative_reports (job_id, initiative_id, linked_at) VALUES (?, ?, ?)', [jobId, ini.id, ctx.clock.now()]);
    await closeResearchJob(conn, ctx, jobId, `Initiative started: ${ini.key} (${input.title}).`);
    return ini;
  });
  const text = `Draft the design of this initiative from ${source}. Read the whole report with read_report, then propose the design as a revision: the decisions, the open questions, the contracts, the waves and the job cards. Cite the report where it gives the reason.`;
  // The initiative stands without the message: if it cannot be sent, the room opens and the Client writes to the Architect.
  let messageError: string | null = null;
  try {
    await architectMessage(ctx, made.chatId, { text });
  } catch (e) {
    messageError = e instanceof Error ? e.message : String(e);
  }
  return { key: made.key, version: 1, chat_id: made.chatId, message_error: messageError };
}
