/**
 * The file overlap warning on Start (phase 5 of the initiative room, docs/plans/initiative-room.md, criterion 7).
 *
 * A card names the files it is likely to touch in its text: path-like tokens in scope, accept, verify, traps and safety.
 * A running implementation job of the same initiative and repository has its changed paths from its newest finished review
 * run that sent a valid list (review_run_deltas.changed_paths, the runner's diff from the rules commit to head). A card token
 * matches a path when they are equal or the token is a folder that holds the path. Generated files (lockfiles) match nothing.
 * The warning never blocks Start. It is only as fresh as that review run, and only as complete as its list (`more` counts
 * the paths the runner left out).
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

/** The paths a card names in its text, sorted, without duplicates. Pure. Cut at MAX_LIKELY. */
export function likelyPaths(card: Record<string, unknown>): string[] {
  const found = new Set<string>();
  for (const field of OVERLAP_FIELDS) {
    const items = card[field];
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      if (typeof item !== 'string') continue;
      for (const m of item.slice(0, FIELD_MAX).matchAll(TOKEN)) {
        const p = pathToken(m[0]);
        if (p) found.add(p);
      }
    }
  }
  return [...found].sort().slice(0, MAX_LIKELY);
}

/** Whether a changed path is one of the card's likely paths: equal, or inside a folder the card names. Pure. */
export function touches(changed: string, likely: string[]): boolean {
  return likely.some((t) => (t.endsWith('/') ? changed.startsWith(t) : changed === t || changed.startsWith(`${t}/`)));
}

export interface OverlapWarning {
  job_id: string;
  card: string | null;
  head_sha: string;
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
  /** Running jobs with no finished review run that sent a valid list: no data, not no overlap. */
  no_data: string[];
  /** Jobs whose list was cut and showed no overlap: the cut list may hide one. */
  incomplete: string[];
}

/**
 * The newest finished review run that sent a valid list, per job. A job may have several seats in one review, and every seat
 * of a review sends the same list, so the first row per job is the answer. Runs on the caller's connection.
 */
export async function reviewedPaths(conn: Conn, jobIds: string[]) {
  const out = new Map<string, { head_sha: string; reviewed_at: Date; paths: { paths: string[]; more: number }; source: string | null }>();
  if (!jobIds.length) return out;
  const ph = jobIds.map(() => '?').join(', ');
  // A split card runs its work as subjobs, and their reviews carry their own ids: the newest list of a subjob counts for the root job.
  const family = await query(conn, `SELECT id, parent_job_id FROM jobs WHERE id IN (${ph}) OR parent_job_id IN (${ph})`, [...jobIds, ...jobIds]);
  const rootOf = new Map<string, string>(jobIds.map((j) => [j, j]));
  for (const f of family) if (f.parent_job_id && jobIds.includes(String(f.parent_job_id))) rootOf.set(String(f.id), String(f.parent_job_id));
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
  for (const r of rows) {
    const job = rootOf.get(String(r.job_id)) ?? String(r.job_id);
    if (out.has(job)) continue;
    const paths = parseChangedPaths(typeof r.changed_paths === 'string' ? JSON.parse(r.changed_paths) : r.changed_paths);
    if (!paths) continue;
    const rules = parseRulesSummary(typeof r.rules === 'string' ? JSON.parse(r.rules) : r.rules);
    out.set(job, { head_sha: String(r.head_sha), reviewed_at: r.finished_at as Date, paths, source: rules?.source ?? null });
  }
  return out;
}

/**
 * The warning for one card: which running jobs (`running`, job id and card key, same initiative and repository) changed a
 * path the card names. Pure apart from the query; the caller passes the running jobs it found.
 */
export async function overlapOf(conn: Conn, card: Record<string, unknown>, running: { job_id: string; card_key: string | null }[]): Promise<OverlapView> {
  const likely = likelyPaths(card);
  const view: OverlapView = { running: running.length, likely, warnings: [], no_data: [], incomplete: [] };
  if (!likely.length || !running.length) return view;
  const seen = await reviewedPaths(conn, running.map((j) => j.job_id));
  for (const j of running) {
    const got = seen.get(j.job_id);
    if (!got) {
      view.no_data.push(j.job_id);
      continue;
    }
    const hits = got.paths.paths.filter((p) => touches(p, likely));
    if (hits.length) view.warnings.push({ job_id: j.job_id, card: j.card_key, head_sha: got.head_sha, reviewed_at: got.reviewed_at, source: got.source, truncated: got.paths.more > 0, paths: hits });
    else if (got.paths.more > 0) view.incomplete.push(j.job_id);
  }
  return view;
}
