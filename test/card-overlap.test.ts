import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exec, parseJson, queryOne } from '../src/db.ts';
import { previewStart, startCard } from '../src/initiative-jobs.ts';
import { importInitiative } from '../src/initiatives.ts';
import { buildServer } from '../src/server.ts';
import { generatedPath, likelyPaths, overlapOf, touches } from '../src/card-overlap.ts';
import { changedPathsOf, goodChangedPath, MAX_CHANGED_PATHS, parseChangedPaths } from '../src/review-rules.ts';
import { recordReviewOutput } from '../src/code-review.ts';
import { newId } from '../src/lib.ts';
import { createTestCtx, TEST_DB_URL, testServerKeys, TEST_RUNNER_KEY } from './helpers.ts';

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
    expect(likelyPaths(card)).toEqual({ paths: ['src/lib/', 'src/lib/store.ts', 'test/store.spec.ts'], truncated: false });
  });

  it('refuses a generated file, a URL, an absolute path and a parent segment', () => {
    expect(generatedPath('apps/web/pnpm-lock.yaml')).toBe(true);
    expect(generatedPath('src/lock.ts')).toBe(false);
    expect(likelyPaths({ scope: ['pnpm-lock.yaml and https://x.io/y/z and /etc/hosts and a/../b.ts'] })).toEqual({ paths: [], truncated: false });
  });

  it('matches an equal path or a folder the card names, and not a longer name', () => {
    expect(touches('src/lib/store.ts', ['src/lib/store.ts'])).toBe(true);
    expect(touches('src/lib/store.ts', ['src/lib/'])).toBe(true);
    expect(touches('src/lib/store.ts', ['src/li'])).toBe(false);
    expect(touches('src/lib2/store.ts', ['src/lib'])).toBe(false);
    expect(touches('src/lib/store.ts', ['store.ts'])).toBe(false);
  });

  it('cuts a very long field, so the scan stays bounded, and says the list was cut', () => {
    const long = `${'x'.repeat(5000)} src/late/file.ts`;
    expect(likelyPaths({ scope: [long] })).toEqual({ paths: [], truncated: true });
    expect(likelyPaths({ scope: ['src/a.ts '.repeat(10) + 'x'.repeat(4000)] })).toEqual({ paths: ['src/a.ts'], truncated: true });
  });

  it('keeps a name that ends exactly at the cut, when the next character is not part of a name', () => {
    expect(likelyPaths({ scope: ['x '.repeat(1996) + 'src/a.ts' + ' ' + 'y'.repeat(100)] })).toEqual({ paths: ['src/a.ts'], truncated: true });
  });

  it('drops the name that the cut splits, so "src/" is not read as a folder', () => {
    // 'x '.repeat(1998) is 3996 characters, so the cut at 4000 leaves "src/" of "src/lib/store.ts".
    expect(likelyPaths({ scope: ['x '.repeat(1998) + 'src/lib/store.ts'] })).toEqual({ paths: [], truncated: true });
  });

  it('cuts a list of more than 200 paths and says so', () => {
    const many = Array.from({ length: 201 }, (_, i) => `src/f${String(i).padStart(3, '0')}.ts`);
    const got = likelyPaths({ scope: [many.join(' ')] });
    expect(got.paths).toHaveLength(200);
    expect(got.truncated).toBe(true);
    expect(likelyPaths({ scope: [many.slice(0, 200).join(' ')] })).toEqual({ paths: many.slice(0, 200), truncated: false });
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

  it('passes the cut of the card list to the view, so the preview can say it (criterion 6)', async () => {
    const view = await overlapOf(env.ctx.pool, { scope: ['x'.repeat(4001)] }, []);
    expect(view).toEqual(expect.objectContaining({ likely: [], likely_truncated: true, warnings: [] }));
    const whole = await overlapOf(env.ctx.pool, { scope: ['src/lib/store.ts'] }, []);
    expect(whole.likely_truncated).toBe(false);
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
  /** A review of a job with one finished run that stored `paths` (or no list), finished at `at`. */
  async function listed(job: string, paths: string[] | null, at: string, head = SHA, extra: { more?: number; source?: string } = {}) {
    const review = newId('crv');
    const run = newId('crr');
    const when = new Date(at);
    await exec(env.ctx.pool, `INSERT INTO code_reviews (id, job_id, requested_by, worktree, base_sha, head_sha, round_no, status, verdict, created_at, finished_at) VALUES (?, ?, 'x', '/wt', ?, ?, 1, 'done', 'ok', ?, ?)`, [review, job, '0'.repeat(40), head, when, when]);
    await exec(env.ctx.pool, `INSERT INTO code_review_runs (id, review_id, seat, seat_kind, runtime, family, model, effort, status, finished_at) VALUES (?, ?, 'strong', 'strong', 'codex', 'codex', 'm', 'high', 'done', ?)`, [run, review, when]);
    const rules = JSON.stringify({ commit: SHA, source: extra.source ?? 'origin', files: [], omitted: [], omitted_more: 0, changed: [], changed_more: 0 });
    await exec(env.ctx.pool, `INSERT INTO code_review_run_deltas (run_id, rules, changed_paths) VALUES (?, ?, ?)`, [run, rules, paths ? JSON.stringify({ paths, more: extra.more ?? 0 }) : null]);
    return run;
  }

  /** An implement job on a repository, with its status. */
  async function implementJob(repo: string, status: string, parent: string | null = null) {
    const job = newId('job');
    const at = env.clock.now();
    await exec(env.ctx.pool, `INSERT INTO jobs (id, parent_job_id, linear_issue_id, linear_identifier, linear_url, title, repo_path, base_branch, status, linear_snapshot, linear_fetched_at, created_at, updated_at, kind) VALUES (?, ?, ?, ?, '', ?, ?, 'main', ?, '{}', ?, ?, ?, 'implement')`, [job, parent, job, job, job, repo, status, at, at, at]);
    return job;
  }

  it('the runner route keeps changed_paths, so the server check sees the list (P1: the route used to strip it)', async () => {
    const job = await implementJob('/home/u/app', 'in_progress');
    const review = newId('crv');
    const run = newId('crr');
    const launch = newId('lch');
    const at = env.clock.now();
    await exec(env.ctx.pool, `INSERT INTO code_reviews (id, job_id, requested_by, worktree, base_sha, head_sha, round_no, status, verdict, created_at) VALUES (?, ?, 'x', '/wt', ?, ?, 1, 'running', NULL, ?)`, [review, job, '0'.repeat(40), SHA, at]);
    await exec(env.ctx.pool, `INSERT INTO code_review_runs (id, review_id, seat, seat_kind, runtime, family, model, effort, status) VALUES (?, ?, 'strong', 'strong', 'codex', 'codex', 'm', 'high', 'running')`, [run, review]);
    await exec(env.ctx.pool, `INSERT INTO launches (id, agent_id, kind, run_id, cwd, runtime, requested_at) VALUES (?, NULL, 'code_review', ?, '/wt', 'codex', ?)`, [launch, run, at]);
    const stdout = [JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '{"findings":[]}' } }), JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } })].join('\n');
    const app = buildServer(env.ctx, { ...(await testServerKeys()), webDir: '/nonexistent' });
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/runner/${launch}/review-output`,
        headers: { authorization: `Bearer ${TEST_RUNNER_KEY}`, 'content-type': 'application/json' },
        payload: { code: 0, stdout, stderr: '', secs: 1, changed_paths: { paths: ['src/lib/store.ts'], more: 0 } },
      });
      expect(res.statusCode, res.body).toBe(200);
    } finally {
      await app.close();
    }
    const got = await queryOne(env.ctx.pool, 'SELECT changed_paths FROM code_review_run_deltas WHERE run_id = ?', [run]);
    expect(parseJson(got!.changed_paths)).toEqual({ paths: ['src/lib/store.ts'], more: 0 });
  });

  it('a card job whose work is in subjobs reads the newest list of a subjob under the root job', async () => {
    const root = await implementJob('/home/u/app', 'in_progress');
    const sub = await implementJob('/home/u/app', 'in_progress', root);
    await listed(root, ['docs/old.md'], '2026-11-18T10:00:00Z');
    await listed(sub, ['src/lib/store.ts'], '2026-11-19T10:00:00Z');
    const view = await overlapOf(env.ctx.pool, card, [{ job_id: root, card_key: 'a' }]);
    expect(view.warnings).toEqual([expect.objectContaining({ job_id: root, paths: ['src/lib/store.ts'] })]);
    expect(view.no_data).toEqual([]);
  });

  it('merges the newest list of each live subjob under the root, and ignores a done subjob (criterion 6)', async () => {
    const root = await implementJob('/home/u/app', 'in_progress');
    const subA = await implementJob('/home/u/app', 'in_progress', root);
    const subB = await implementJob('/home/u/app', 'in_progress', root);
    const done = await implementJob('/home/u/app', 'done', root);
    await listed(subA, ['src/lib/store.ts'], '2026-11-19T08:00:00Z', 'b'.repeat(40));
    await listed(subB, ['src/lib/other.ts'], '2026-11-19T10:00:00Z');
    await listed(done, ['src/lib/done.ts'], '2026-11-19T12:00:00Z', 'c'.repeat(40));
    const view = await overlapOf(env.ctx.pool, card, [{ job_id: root, card_key: 'a' }]);
    expect(view.warnings).toEqual([expect.objectContaining({ job_id: root, head_sha: SHA, heads: [SHA, 'b'.repeat(40)], paths: ['src/lib/other.ts', 'src/lib/store.ts'] })]);
    expect(view.warnings[0].reviewed_at).toEqual(new Date('2026-11-19T08:00:00Z'));
  });

  it('a split card whose merged lists are cut and from a local base is cut and sourced local (criterion 6)', async () => {
    const root = await implementJob('/home/u/app', 'in_progress');
    const subA = await implementJob('/home/u/app', 'in_progress', root);
    const subB = await implementJob('/home/u/app', 'in_progress', root);
    await listed(subA, ['src/lib/store.ts'], '2026-11-19T08:00:00Z', 'b'.repeat(40), { more: 40, source: 'local' });
    await listed(subB, ['src/lib/other.ts'], '2026-11-19T10:00:00Z', SHA);
    const view = await overlapOf(env.ctx.pool, card, [{ job_id: root, card_key: 'a' }]);
    expect(view.warnings).toEqual([expect.objectContaining({ job_id: root, truncated: true, source: 'local', paths: ['src/lib/other.ts', 'src/lib/store.ts'] })]);
    expect(view.incomplete).toEqual([]);
  });

  it('a live subjob with no list makes the card no data, and the warning still shows the part that was read (criterion 6)', async () => {
    const root = await implementJob('/home/u/app', 'in_progress');
    const subA = await implementJob('/home/u/app', 'in_progress', root);
    await implementJob('/home/u/app', 'in_progress', root);
    await listed(subA, ['src/lib/store.ts'], '2026-11-19T08:00:00Z');
    const view = await overlapOf(env.ctx.pool, card, [{ job_id: root, card_key: 'a' }]);
    expect(view.warnings).toEqual([expect.objectContaining({ job_id: root, paths: ['src/lib/store.ts'] })]);
    expect(view.no_data).toEqual([root]);
  });

  it('a subjob still in planning, or in another repository, is neither no data nor a source of paths (criterion 6)', async () => {
    const root = await implementJob('/home/u/app', 'in_progress');
    const subA = await implementJob('/home/u/app', 'in_progress', root);
    await implementJob('/home/u/app', 'planning', root);
    const other = await implementJob('/home/u/lib', 'in_progress', root);
    await listed(subA, ['src/lib/other.ts'], '2026-11-19T08:00:00Z');
    await listed(other, ['src/lib/store.ts'], '2026-11-19T09:00:00Z');
    const view = await overlapOf(env.ctx.pool, card, [{ job_id: root, card_key: 'a' }]);
    expect(view.warnings).toEqual([expect.objectContaining({ job_id: root, heads: [SHA], paths: ['src/lib/other.ts'] })]);
    expect(view.no_data).toEqual([]);
  });

  it('a subjob blocked before it started is not no data, and one blocked after it started is (criterion 6)', async () => {
    const root = await implementJob('/home/u/app', 'in_progress');
    const subA = await implementJob('/home/u/app', 'in_progress', root);
    const blocked = await implementJob('/home/u/app', 'blocked', root);
    await exec(env.ctx.pool, `UPDATE jobs SET previous_status = 'planning' WHERE id = ?`, [blocked]);
    await listed(subA, ['src/lib/store.ts'], '2026-11-19T08:00:00Z');
    expect((await overlapOf(env.ctx.pool, card, [{ job_id: root, card_key: 'a' }])).no_data).toEqual([]);
    await exec(env.ctx.pool, `UPDATE jobs SET previous_status = 'in_progress' WHERE id = ?`, [blocked]);
    expect((await overlapOf(env.ctx.pool, card, [{ job_id: root, card_key: 'a' }])).no_data).toEqual([root]);
  });

  it('a started root of a split card with no list is not no data: it never has a review of its own (criterion 6)', async () => {
    const root = await implementJob('/home/u/app', 'in_progress');
    const subA = await implementJob('/home/u/app', 'in_progress', root);
    await listed(subA, ['src/lib/store.ts'], '2026-11-19T08:00:00Z');
    const view = await overlapOf(env.ctx.pool, card, [{ job_id: root, card_key: 'a' }]);
    expect(view.warnings).toEqual([expect.objectContaining({ job_id: root, paths: ['src/lib/store.ts'] })]);
    expect(view.no_data).toEqual([]);
  });

  it('the root and a subjob that share a head give one head, and the root review is merged (criterion 6)', async () => {
    const root = await implementJob('/home/u/app', 'in_progress');
    const subA = await implementJob('/home/u/app', 'in_progress', root);
    await listed(root, ['src/lib/other.ts'], '2026-11-19T07:00:00Z', SHA);
    await listed(subA, ['src/lib/store.ts'], '2026-11-19T08:00:00Z', SHA);
    const view = await overlapOf(env.ctx.pool, card, [{ job_id: root, card_key: 'a' }]);
    expect(view.warnings).toEqual([expect.objectContaining({ job_id: root, heads: [SHA], paths: ['src/lib/other.ts', 'src/lib/store.ts'], reviewed_at: new Date('2026-11-19T07:00:00Z') })]);
  });

  it('the root review head is one of the heads of a split card (criterion 6)', async () => {
    const root = await implementJob('/home/u/app', 'in_progress');
    const subA = await implementJob('/home/u/app', 'in_progress', root);
    await listed(root, ['src/lib/other.ts'], '2026-11-19T07:00:00Z', 'c'.repeat(40));
    await listed(subA, ['src/lib/store.ts'], '2026-11-19T08:00:00Z', SHA);
    const view = await overlapOf(env.ctx.pool, card, [{ job_id: root, card_key: 'a' }]);
    expect(view.warnings).toEqual([expect.objectContaining({ job_id: root, head_sha: SHA, heads: [SHA, 'c'.repeat(40)] })]);
  });

  it('previewStart warns only about a running job of the same initiative, repository and live status (criterion 6 filter)', async () => {
    const suffix = Math.random().toString(36).slice(2, 10);
    const path = `/home/u/filter-${suffix}`;
    const libPath = `/home/u/filter-lib-${suffix}`;
    const cardBlock = (id: string, scope: string[], repo = 'app') => ({ kind: 'card', id, title: `Card ${id}`, repo, wave: 'W-1', deps: [], goal: `Build ${id}.`, scope, out: [], accept: ['It works'], verify: ['Run the tests'], traps: [], safety: [], dod: [], gates: [] });
    const scope = ['Change src/lib/store.ts.'];
    const blocks = [{ kind: 'wave', id: 'W-1', title: 'Wave one', when: 'Now', jobs: ['a', 'b', 'c', 'd', 'e'] }, cardBlock('a', scope), cardBlock('b', scope), cardBlock('c', scope), cardBlock('d', scope, 'lib'), cardBlock('e', scope)];
    const repos = [
      { slug: 'app', path, base: 'main', github: 'owner/app' },
      { slug: 'lib', path: libPath, base: 'main', github: 'owner/lib' },
    ];
    const mine = `ovl-filter-${suffix}`;
    const other = `ovl-other-${suffix}`;
    await importInitiative(env.ctx, { key: mine, title: mine, repos, source: 'test', doc: { format: 1, title: mine, blocks } });
    await importInitiative(env.ctx, { key: other, title: other, repos, source: 'test', doc: { format: 1, title: other, blocks } });
    const startAndLink = async (key: string, cardKey: string, status: string, repoPath = path) => {
      const start = await startCard(env.ctx, key, cardKey, 1);
      const job = await implementJob(repoPath, status);
      // The request is registered by its job, so it no longer waits for the runner (MAX_QUEUED_REQUESTS).
      await exec(env.ctx.pool, "UPDATE job_requests SET job_id = ?, status = 'registered' WHERE id = ?", [job, start.request_id]);
      await listed(job, ['src/lib/store.ts'], '2026-11-19T11:00:00Z');
      return job;
    };
    const running = await startAndLink(mine, 'a', 'in_progress');
    await startAndLink(mine, 'c', 'done');
    const otherRepo = await startAndLink(mine, 'd', 'in_progress', libPath);
    const cancelled = await startAndLink(mine, 'e', 'cancelled');
    const elsewhere = await startAndLink(other, 'a', 'in_progress');
    const preview = await previewStart(env.ctx, mine, 'b');
    expect(preview.overlap.warnings.map((w) => w.job_id)).toEqual([running]);
    expect(preview.overlap.warnings.map((w) => w.job_id)).not.toContain(elsewhere);
    expect(preview.overlap.warnings.map((w) => w.job_id)).not.toContain(otherRepo);
    expect(preview.overlap.warnings.map((w) => w.job_id)).not.toContain(cancelled);
  });
});
