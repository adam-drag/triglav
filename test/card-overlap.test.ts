import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exec, queryOne } from '../src/db.ts';
import { generatedPath, likelyPaths, overlapOf, touches } from '../src/card-overlap.ts';
import { changedPathsOf, goodChangedPath, MAX_CHANGED_PATHS, parseChangedPaths } from '../src/review-rules.ts';
import { recordReviewOutput } from '../src/code-review.ts';
import { newId } from '../src/lib.ts';
import { createTestCtx, TEST_DB_URL } from './helpers.ts';

// The file overlap warning on Start (phase 5, criteria 5 and 6): the card's likely paths, the runner's list and its checks.

const SHA = 'a'.repeat(40);

describe('likely paths of a card', () => {
  it('reads path-like tokens from scope, accept, verify, traps and safety, and not from out', () => {
    const card = {
      goal: 'Change src/never.ts only in prose.',
      scope: ['Edit `src/lib/store.ts` and the folder src/lib/ (see https://example.com/a/b).'],
      out: ['Do not touch docs/private.md.'],
      accept: ['Add test/store.spec.ts, see src/lib/store.ts.'],
      verify: ['Run pnpm test.'],
      traps: ['pnpm-lock.yaml changes on every install, ignore it. Also ../escape.ts and /abs/path.ts.'],
      safety: [],
    };
    expect(likelyPaths(card)).toEqual(['src/lib/', 'src/lib/store.ts', 'test/store.spec.ts']);
  });

  it('refuses a generated file, a URL, an absolute path and a parent segment', () => {
    expect(generatedPath('apps/web/pnpm-lock.yaml')).toBe(true);
    expect(generatedPath('src/lock.ts')).toBe(false);
    expect(likelyPaths({ scope: ['pnpm-lock.yaml and https://x.io/y/z and /etc/hosts and a/../b.ts'] })).toEqual([]);
  });

  it('matches an equal path or a folder the card names, and not a longer name', () => {
    expect(touches('src/lib/store.ts', ['src/lib/store.ts'])).toBe(true);
    expect(touches('src/lib/store.ts', ['src/lib/'])).toBe(true);
    expect(touches('src/lib/store.ts', ['src/li'])).toBe(false);
    expect(touches('src/lib2/store.ts', ['src/lib'])).toBe(false);
    expect(touches('src/lib/store.ts', ['store.ts'])).toBe(false);
  });

  it('cuts a very long field, so the scan stays bounded', () => {
    const long = `${'x'.repeat(5000)} src/late/file.ts`;
    expect(likelyPaths({ scope: [long] })).toEqual([]);
  });
});

describe('the runner list and its server check (criterion 5)', () => {
  it('accepts a plain list and refuses a bad path, a backslash, a bidi control, a count over the cap and a malformed value', () => {
    expect(parseChangedPaths({ paths: ['src/a.ts', 'docs/'], more: 0 })).toEqual({ paths: ['src/a.ts', 'docs/'], more: 0 });
    expect(parseChangedPaths({ paths: ['/abs.ts'], more: 0 })).toBeNull();
    expect(parseChangedPaths({ paths: ['a/../b.ts'], more: 0 })).toBeNull();
    expect(parseChangedPaths({ paths: ['a\\b.ts'], more: 0 })).toBeNull();
    expect(parseChangedPaths({ paths: ['a‮b.ts'], more: 0 })).toBeNull();
    expect(parseChangedPaths({ paths: ['x'.repeat(301)], more: 0 })).toBeNull();
    expect(parseChangedPaths({ paths: Array.from({ length: MAX_CHANGED_PATHS + 1 }, (_, i) => `f${i}.ts`), more: 0 })).toBeNull();
    expect(parseChangedPaths({ paths: ['a.ts'], more: 1, extra: true })).toBeNull();
    expect(parseChangedPaths({ paths: 'a.ts', more: 0 })).toBeNull();
    expect(parseChangedPaths(null)).toBeNull();
  });

  it('the runner keeps the good paths, counts the rest, and caps the count', () => {
    expect(changedPathsOf(['a.ts', '/bad', 'b.ts'])).toEqual({ paths: ['a.ts', 'b.ts'], more: 1 });
    const many = Array.from({ length: MAX_CHANGED_PATHS + 5 }, (_, i) => `f${i}.ts`);
    expect(changedPathsOf(many).paths).toHaveLength(MAX_CHANGED_PATHS);
    expect(changedPathsOf(many).more).toBe(5);
    expect(goodChangedPath('x⁦y')).toBe(false);
  });
});

describe.skipIf(!TEST_DB_URL)('the overlap of a card with running jobs (criterion 6, the data)', () => {
  let env: Awaited<ReturnType<typeof createTestCtx>>;
  beforeAll(async () => {
    env = await createTestCtx();
  });
  afterAll(async () => {
    await env?.close();
  });

  /** An implement job with one finished review whose run sent `changed` (or nothing), finished at `finishedAt`. */
  async function reviewed(opts: { changed?: unknown; finishedAt: string; head?: string; source?: string }) {
    const job = newId('job');
    const review = newId('crv');
    const run = newId('crr');
    const at = new Date(opts.finishedAt);
    await exec(env.ctx.pool, `INSERT INTO jobs (id, parent_job_id, linear_issue_id, linear_identifier, linear_url, title, repo_path, base_branch, status, linear_snapshot, linear_fetched_at, created_at, updated_at, kind) VALUES (?, NULL, ?, ?, '', 'Running', '/home/u/app', 'main', 'in_progress', '{}', ?, ?, ?, 'implement')`, [job, job, job, at, at, at]);
    await exec(env.ctx.pool, `INSERT INTO code_reviews (id, job_id, requested_by, worktree, base_sha, head_sha, round_no, status, verdict, created_at, finished_at) VALUES (?, ?, 'x', '/wt', ?, ?, 1, 'done', 'ok', ?, ?)`, [review, job, '0'.repeat(40), opts.head ?? SHA, at, at]);
    await exec(env.ctx.pool, `INSERT INTO code_review_runs (id, review_id, seat, seat_kind, runtime, family, model, effort, status, finished_at) VALUES (?, ?, 'strong', 'strong', 'codex', 'codex', 'm', 'high', 'done', ?)`, [run, review, at]);
    const rules = { commit: SHA, source: opts.source ?? 'origin', files: [], omitted: [], omitted_more: 0, changed: [], changed_more: 0 };
    await exec(env.ctx.pool, `INSERT INTO code_review_run_deltas (run_id, rules, changed_paths) VALUES (?, ?, ?)`, [run, JSON.stringify(rules), opts.changed === undefined ? null : JSON.stringify(opts.changed)]);
    return { job, review, run };
  }

  const card = { scope: ['Change src/lib/ and test/store.spec.ts.'] };

  it('warns with the paths a running job changed that the card names, from its newest run with a list', async () => {
    const job = (await reviewed({ changed: { paths: ['src/lib/old.ts'], more: 0 }, finishedAt: '2026-11-18T10:00:00Z', head: 'b'.repeat(40) })).job;
    // The job's newer review has the list that counts; the older one is not read.
    const newer = newId('crv');
    const newerRun = newId('crr');
    const at = new Date('2026-11-19T09:00:00Z');
    await exec(env.ctx.pool, `INSERT INTO code_reviews (id, job_id, requested_by, worktree, base_sha, head_sha, round_no, status, verdict, created_at, finished_at) VALUES (?, ?, 'x', '/wt', ?, ?, 2, 'done', 'changes', ?, ?)`, [newer, job, '0'.repeat(40), 'c'.repeat(40), at, at]);
    await exec(env.ctx.pool, `INSERT INTO code_review_runs (id, review_id, seat, seat_kind, runtime, family, model, effort, status, finished_at) VALUES (?, ?, 'strong', 'strong', 'codex', 'codex', 'm', 'high', 'done', ?)`, [newerRun, newer, at]);
    await exec(env.ctx.pool, `INSERT INTO code_review_run_deltas (run_id, rules, changed_paths) VALUES (?, ?, ?)`, [newerRun, JSON.stringify({ commit: SHA, source: 'base_sha', files: [], omitted: [], omitted_more: 0, changed: [], changed_more: 0 }), JSON.stringify({ paths: ['src/lib/store.ts', 'docs/x.md'], more: 0 })]);
    const view = await overlapOf(env.ctx.pool, card, [{ job_id: job, card_key: 'a' }]);
    expect(view.running).toBe(1);
    expect(view.warnings).toEqual([expect.objectContaining({ job_id: job, card: 'a', head_sha: 'c'.repeat(40), source: 'base_sha', truncated: false, paths: ['src/lib/store.ts'] })]);
    expect(view.no_data).toEqual([]);
  });

  it('says there is no data for a job with no run that sent a list, and marks a cut list that shows no overlap', async () => {
    const none = await reviewed({ changed: undefined, finishedAt: '2026-11-18T10:00:00Z' });
    const cut = await reviewed({ changed: { paths: ['docs/only.md'], more: 40 }, finishedAt: '2026-11-18T11:00:00Z' });
    const unknown = newId('job');
    const view = await overlapOf(env.ctx.pool, card, [
      { job_id: none.job, card_key: 'a' },
      { job_id: cut.job, card_key: 'b' },
      { job_id: unknown, card_key: 'c' },
    ]);
    expect(view.no_data).toEqual([none.job, unknown]);
    expect(view.incomplete).toEqual([cut.job]);
    expect(view.warnings).toEqual([]);
  });

  it('a seat whose list is bad still finishes: the findings are kept and the list is not stored (criterion 5)', async () => {
    const job = newId('job');
    const review = newId('crv');
    const run = newId('crr');
    const launch = newId('lch');
    const at = env.clock.now();
    await exec(env.ctx.pool, `INSERT INTO jobs (id, parent_job_id, linear_issue_id, linear_identifier, linear_url, title, repo_path, base_branch, status, linear_snapshot, linear_fetched_at, created_at, updated_at, kind) VALUES (?, NULL, ?, ?, '', 'Bad list', '/home/u/app', 'main', 'in_progress', '{}', ?, ?, ?, 'implement')`, [job, job, job, at, at, at]);
    await exec(env.ctx.pool, `INSERT INTO code_reviews (id, job_id, requested_by, worktree, base_sha, head_sha, round_no, status, verdict, created_at) VALUES (?, ?, 'x', '/wt', ?, ?, 1, 'running', NULL, ?)`, [review, job, '0'.repeat(40), SHA, at]);
    await exec(env.ctx.pool, `INSERT INTO code_review_runs (id, review_id, seat, seat_kind, runtime, family, model, effort, status) VALUES (?, ?, 'strong', 'strong', 'codex', 'codex', 'm', 'high', 'running')`, [run, review]);
    await exec(env.ctx.pool, `INSERT INTO launches (id, agent_id, kind, run_id, cwd, runtime, requested_at) VALUES (?, NULL, 'code_review', ?, '/wt', 'codex', ?)`, [launch, run, at]);
    const stdout = [JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '{"findings":[]}' } }), JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } })].join('\n');
    await recordReviewOutput(env.ctx, launch, { code: 0, stdout, stderr: '', secs: 1, changed_paths: { paths: ['/bad'], more: 0 } });
    const got = await queryOne(env.ctx.pool, 'SELECT r.status, d.changed_paths FROM code_review_runs r LEFT JOIN code_review_run_deltas d ON d.run_id = r.id WHERE r.id = ?', [run]);
    expect(got!.status).not.toBe('failed');
    expect(got!.changed_paths ?? null).toBeNull();
  });
});
