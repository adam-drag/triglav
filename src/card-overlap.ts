/**
 * The file overlap warning on Start (phase 5 of the initiative room, docs/plans/initiative-room.md, criterion 7).
 *
 * A card names the files it is likely to touch in its text: path-like tokens in scope, accept, verify, traps and safety.
 * A running implementation job of the same initiative and repository has its changed paths from the newest finished review
 * run that sent a valid list (code_review_run_deltas.changed_paths, the runner's diff from the rules commit to head). The live
 * subjobs of a split card are reviewed on their own diffs, so their newest lists are merged under the root job. A card token
 * matches a path when they are equal or the token is a folder that holds the path. Generated files (lockfiles) match nothing.
 * The warning never blocks Start. It is as old as the oldest list it merges, and only as complete as those lists (`more`
 * counts the paths the runner left out).
 */
import type { Conn } from './db.ts';
import { query } from './db.ts';
import { goodChangedPath, parseChangedPaths, parseRulesSummary } from './review-rules.ts';

/** The card fields whose text names files: scope, accept, verify, traps and safety. `out` names what not to touch, so it is left out. */
export const OVERLAP_FIELDS = ['scope', 'accept', 'verify', 'traps', 'safety'] as const;
/** Per card text, the characters read. A longer field is cut here, so a huge field costs a bounded scan. */
const FIELD_MAX = 4000;
/** Path-like runs of plain characters. One character class and one `+`: the scan is linear. */
const TOKEN = /[A-Za-z0-9._@+/-]+/g;
/** Generated files that every change may touch: a warning on them would fire on every card. */
const GENERATED = new Set(['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lock', 'bun.lockb', 'Cargo.lock', 'go.sum', 'uv.lock', 'poetry.lock', 'Gemfile.lock', 'composer.lock']);
const MAX_LIKELY = 200;

export const generatedPath = (p: string): boolean => GENERATED.has(p.slice(p.lastIndexOf('/') + 1));

/** A token that reads as a repository path: it has a folder part or a file extension, and is not a URL, an absolute path or a "..". */
function pathToken(raw: string): string | null {
  // A sentence's final dot is not part of the name ("see src/a.ts."), and a leading "./" is the same path.
  let t = raw.replace(/^\.\//, '').replace(/\.+$/, '');
  if (!t || t.startsWith('/') || t.includes('..') || t.includes('//')) return null;
  const folder = t.endsWith('/');
  if (folder) t = t.slice(0, -1);
  const hasFolder = t.includes('/');
  const hasExt = /\.[A-Za-z0-9]{1,8}$/.test(t);
  if (!folder && !hasFolder && !hasExt) return null;
  const out = folder ? `${t}/` : t;
  return goodChangedPath(out) && !generatedPath(out) ? out : null;
}

/**
 * The paths a card names in its text, sorted, without duplicates. Pure. `truncated` is true when a field was longer than
 * FIELD_MAX (its tail was not read) or the card named more than MAX_LIKELY paths (the sorted list was cut), so the preview
 * can say the list is not the whole of it.
 */
export function likelyPaths(card: Record<string, unknown>): { paths: string[]; truncated: boolean } {
  const found = new Set<string>();
  let truncated = false;
  for (const field of OVERLAP_FIELDS) {
    const items = card[field];
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      if (typeof item !== 'string') continue;
      let text = item;
      if (item.length > FIELD_MAX) {
        truncated = true;
        // The cut may split a name: "src/" of "src/lib/store.ts" would read as a folder. The run of path characters at the end goes.
        // Only when the next character continues a name: a name that ends exactly at the cut is complete.
        const head = item.slice(0, FIELD_MAX);
        const continues = /[A-Za-z0-9._@+/-]/.test(item.charAt(FIELD_MAX));
        text = continues ? head.slice(0, head.length - (head.match(/[A-Za-z0-9._@+/-]*$/)?.[0].length ?? 0)) : head;
      }
      for (const m of text.matchAll(TOKEN)) {
        const p = pathToken(m[0]);
        if (p) found.add(p);
      }
    }
  }
  const sorted = [...found].sort();
  if (sorted.length > MAX_LIKELY) truncated = true;
  return { paths: sorted.slice(0, MAX_LIKELY), truncated };
}

/** Whether a changed path is one of the card's likely paths: equal, or inside a folder the card names. Pure. */
export function touches(changed: string, likely: string[]): boolean {
  return likely.some((t) => (t.endsWith('/') ? changed.startsWith(t) : changed === t || changed.startsWith(`${t}/`)));
}

export interface OverlapWarning {
  job_id: string;
  card: string | null;
  /** The newest reviewed head. `heads` has every head merged in (a split card has one per distinct head of its live subjobs with a review list). */
  head_sha: string;
  heads: string[];
  reviewed_at: Date;
  /** The rules source the list was read at: origin is the reliable one; others mean the job's base was stale or missing. */
  source: string | null;
  /** The list the runner sent was cut: this job may touch more paths than shown. */
  truncated: boolean;
  paths: string[];
}

export interface OverlapView {
  /** Running jobs of the same initiative and repository that were checked (zero: nothing to warn about). */
  running: number;
  /** The paths the card names. Empty means the card names none, and the preview says so. */
  likely: string[];
  warnings: OverlapWarning[];
  /** The card's path list was cut (a long field, or more than MAX_LIKELY paths): a path past the cut is not checked. */
  likely_truncated: boolean;
  /** Running jobs with no finished review run that sent a valid list, or with a started part that has none: no data, not no overlap. */
  no_data: string[];
  /** Jobs whose list was cut and showed no overlap: the cut list may hide one. */
  incomplete: string[];
}

/** The changed paths a running job (or the live subjobs of a split card) was reviewed with, merged under the root job. */
export interface ReviewedPaths {
  /** The head of each merged review, newest first. One head for a plain job; for a split card, one per distinct head of its live subjobs with a review list. */
  heads: string[];
  /** The oldest review time among the merged lists. */
  reviewed_at: Date;
  paths: { paths: string[]; more: number };
  /** The rules source of the newest list, or of a later one that is not origin. */
  source: string | null;
  /** The started subjobs of the card, in its repository, that have no list of their own: their files are not in `paths`. */
  unreviewed: number;
}

/**
 * The newest finished review run that sent a valid list, per job: the root of a card, and each live subjob of a split card in
 * the root's repository (a subjob is reviewed on its own diff, so its list is merged under the root). A done or cancelled
 * subjob counts for nothing.
 * Every seat of a review sends the same list, so the first row per job is its answer. Runs on the caller's connection.
 */
export async function reviewedPaths(conn: Conn, jobIds: string[]) {
  const out = new Map<string, ReviewedPaths>();
  if (!jobIds.length) return out;
  const ph = jobIds.map(() => '?').join(', ');
  const family = await query(conn, `SELECT id, parent_job_id, status, previous_status, repo_path FROM jobs WHERE id IN (${ph}) OR parent_job_id IN (${ph})`, [...jobIds, ...jobIds]);
  const repoOf = new Map(family.map((f) => [String(f.id), String(f.repo_path)]));
  // A blocked part counts by the status it was blocked from: one blocked in planning or ready has not started.
  const startedFrom = new Map(family.map((f) => [String(f.id), String(f.status) === 'blocked' && f.previous_status ? String(f.previous_status) : String(f.status)]));
  const rootOf = new Map<string, string>(jobIds.map((j) => [j, j]));
  for (const f of family) {
    const parent = f.parent_job_id ? String(f.parent_job_id) : '';
    const live = !['done', 'cancelled'].includes(String(f.status));
    // A subjob in another repository has paths relative to that repository, so the card's paths do not match them.
    if (parent && jobIds.includes(parent) && live && repoOf.get(parent) === String(f.repo_path)) rootOf.set(String(f.id), parent);
  }
  const ids = [...rootOf.keys()];
  const rows = await query(
    conn,
    `SELECT c.job_id, c.head_sha, r.finished_at, d.changed_paths, d.rules
       FROM code_reviews c
       JOIN code_review_runs r ON r.review_id = c.id
       JOIN code_review_run_deltas d ON d.run_id = r.id
      WHERE c.job_id IN (${ids.map(() => '?').join(', ')}) AND r.status = 'done' AND d.changed_paths IS NOT NULL
      ORDER BY r.finished_at DESC`,
    ids,
  );
  const taken = new Set<string>();
  for (const r of rows) {
    const job = String(r.job_id);
    if (taken.has(job)) continue;
    const paths = parseChangedPaths(typeof r.changed_paths === 'string' ? JSON.parse(r.changed_paths) : r.changed_paths);
    if (!paths) continue;
    taken.add(job);
    const rules = parseRulesSummary(typeof r.rules === 'string' ? JSON.parse(r.rules) : r.rules);
    const source = rules?.source ?? null;
    const finishedAt = r.finished_at as Date;
    const head = String(r.head_sha);
    const root = rootOf.get(job) ?? job;
    const cur = out.get(root);
    if (!cur) {
      out.set(root, { heads: [head], reviewed_at: finishedAt, paths: { paths: paths.paths, more: paths.more }, source, unreviewed: 0 });
      continue;
    }
    if (!cur.heads.includes(head)) cur.heads.push(head);
    if (finishedAt < cur.reviewed_at) cur.reviewed_at = finishedAt;
    cur.paths = { paths: [...new Set([...cur.paths.paths, ...paths.paths])].sort(), more: cur.paths.more + paths.more };
    if (source !== 'origin') cur.source = source;
  }
  // A part that has started and has no list is not checked. A part still in planning, ready or queued has not changed anything yet.
  const started = ['in_progress', 'in_review', 'delivering', 'blocked'];
  for (const [job, root] of rootOf) {
    const cur = out.get(root);
    if (cur && job !== root && started.includes(startedFrom.get(job) ?? '') && !taken.has(job)) cur.unreviewed += 1;
  }
  return out;
}

/**
 * The warning for one card: which running jobs (`running`, job id and card key, same initiative and repository) changed a
 * path the card names. Pure apart from the query; the caller passes the running jobs it found.
 */
export async function overlapOf(conn: Conn, card: Record<string, unknown>, running: { job_id: string; card_key: string | null }[]): Promise<OverlapView> {
  const { paths: likely, truncated: likelyTruncated } = likelyPaths(card);
  const view: OverlapView = { running: running.length, likely, likely_truncated: likelyTruncated, warnings: [], no_data: [], incomplete: [] };
  if (!likely.length || !running.length) return view;
  const seen = await reviewedPaths(conn, running.map((j) => j.job_id));
  for (const j of running) {
    const got = seen.get(j.job_id);
    if (!got) {
      view.no_data.push(j.job_id);
      continue;
    }
    // A started part with no list is not checked, so the job is no data, next to any warning from the parts that were read.
    if (got.unreviewed > 0) view.no_data.push(j.job_id);
    const hits = got.paths.paths.filter((p) => touches(p, likely));
    if (hits.length) view.warnings.push({ job_id: j.job_id, card: j.card_key, head_sha: got.heads[0], heads: got.heads, reviewed_at: got.reviewed_at, source: got.source, truncated: got.paths.more > 0, paths: hits });
    else if (got.paths.more > 0) view.incomplete.push(j.job_id);
  }
  return view;
}
