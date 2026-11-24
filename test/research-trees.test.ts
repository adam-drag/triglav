import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DIFF_MAX, personaFolder, prepareTrees, studyBlock, sweepTrees, treesRoot, type ResearchTree } from '../scripts/research-trees.ts';
import { exec } from '../src/db.ts';
import { headOfJob, MAX_TREE_JOBS, treesOfRun } from '../src/research-trees.ts';
import { createPersona } from '../src/research.ts';
import { createTestCtx } from './helpers.ts';

const DAY = 24 * 3600_000;

/** A home folder with one repository: two commits on main, and origin/main at the second. */
function fixture(): { home: string; repo: string; first: string; second: string; env: NodeJS.ProcessEnv; git: (cwd: string, ...args: string[]) => string } {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'rt-home-')));
  const env = { PATH: process.env.PATH!, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
  const repo = join(home, 'work', 'app');
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  git(repo, 'add', 'a.txt');
  git(repo, 'commit', '-q', '-m', 'one');
  const first = git(repo, 'rev-parse', 'HEAD');
  writeFileSync(join(repo, 'a.txt'), 'two\n');
  writeFileSync(join(repo, 'b.txt'), 'new\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'two');
  const second = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'update-ref', 'refs/remotes/origin/main', second);
  return { home, repo, first, second, env, git };
}

const spec = (over: Partial<ResearchTree>): ResearchTree => ({ job: 'PRM-1', repo: '', base: 'main', sha: null, source: 'base', diff: false, ...over });

describe('the pinned trees of a research run, made by the runner', () => {
  it('makes a read-only tree at the head commit, with the files of that commit', async () => {
    const f = fixture();
    const [t] = await prepareTrees([spec({ repo: f.repo, sha: f.first, source: 'delivery' })], f.home, f.env, 'persona-a');
    expect(t!.note).toBeNull();
    expect(t!.path).toBe(join(treesRoot(f.home), createHash('sha256').update(f.repo).digest('hex').slice(0, 16), f.first));
    expect(readFileSync(join(t!.path!, 'a.txt'), 'utf8')).toBe('one\n');
    expect(existsSync(join(t!.path!, 'b.txt'))).toBe(false);
    expect(f.git(t!.path!, 'rev-parse', 'HEAD')).toBe(f.first);
    expect(lstatSync(join(t!.path!, '.git')).isFile()).toBe(true);
    rmSync(f.home, { recursive: true, force: true });
  });

  it('reuses the tree of a commit that an earlier run made', async () => {
    const f = fixture();
    const [a] = await prepareTrees([spec({ repo: f.repo, sha: f.second, source: 'delivery' })], f.home, f.env, 'persona-a');
    const [b] = await prepareTrees([spec({ repo: f.repo, sha: f.second, source: 'delivery' })], f.home, f.env, 'persona-a');
    expect(b!.path).toBe(a!.path);
    expect(f.git(f.repo, 'worktree', 'list')).toContain(a!.path!);
    rmSync(f.home, { recursive: true, force: true });
  });

  it('refuses a commit that is not in the checkout, and never fetches it', async () => {
    const f = fixture();
    const [t] = await prepareTrees([spec({ repo: f.repo, sha: '1'.repeat(40), source: 'delivery' })], f.home, f.env, 'persona-a');
    expect(t!.path).toBeNull();
    expect(t!.note).toMatch(/not in this checkout/);
    rmSync(f.home, { recursive: true, force: true });
  });

  it('a job with no head is read at origin/<base> as the checkout has it, and says so when that ref is missing', async () => {
    const f = fixture();
    const [t] = await prepareTrees([spec({ repo: f.repo, source: 'base' })], f.home, f.env, 'persona-a');
    expect(f.git(t!.path!, 'rev-parse', 'HEAD')).toBe(f.second);
    f.git(f.repo, 'update-ref', '-d', 'refs/remotes/origin/main');
    const [none] = await prepareTrees([spec({ repo: f.repo, source: 'base', base: 'other' })], f.home, f.env, 'persona-a');
    expect(none!.path).toBeNull();
    expect(none!.note).toMatch(/does not fetch/);
    rmSync(f.home, { recursive: true, force: true });
  });

  it('writes symlinks as plain files and runs no hook of the repository', async () => {
    const f = fixture();
    symlinkSync('a.txt', join(f.repo, 'link.txt'));
    f.git(f.repo, 'add', 'link.txt');
    f.git(f.repo, 'commit', '-q', '-m', 'link');
    const linked = f.git(f.repo, 'rev-parse', 'HEAD');
    const hook = join(f.repo, '.git', 'hooks', 'post-checkout');
    writeFileSync(hook, `#!/bin/sh\ntouch ${join(f.home, 'hook-ran')}\n`);
    chmodSync(hook, 0o755);
    const [t] = await prepareTrees([spec({ repo: f.repo, sha: linked, source: 'delivery' })], f.home, f.env, 'persona-a');
    expect(lstatSync(join(t!.path!, 'link.txt')).isSymbolicLink()).toBe(false);
    expect(existsSync(join(f.home, 'hook-ran'))).toBe(false);
    rmSync(f.home, { recursive: true, force: true });
  });

  it('refuses a folder that is not the top of a checkout, and a repository outside the home folder', async () => {
    const f = fixture();
    mkdirSync(join(f.repo, 'sub'));
    const [inner] = await prepareTrees([spec({ repo: join(f.repo, 'sub'), sha: f.first, source: 'delivery' })], f.home, f.env, 'persona-a');
    expect(inner!.note).toMatch(/not the top of a git checkout|not a folder inside the home folder/);
    const [outside] = await prepareTrees([spec({ repo: '/etc', sha: f.first, source: 'delivery' })], f.home, f.env, 'persona-a');
    expect(outside!.note).toMatch(/not a folder inside the home folder/);
    rmSync(f.home, { recursive: true, force: true });
  });

  it('writes the review diff of the change, in the persona folder, and cuts a diff longer than DIFF_MAX', async () => {
    const f = fixture();
    mkdirSync(personaFolder(f.home, 'persona-a'), { recursive: true });
    // The base is the first commit, so the diff is the change of the second one.
    f.git(f.repo, 'update-ref', 'refs/remotes/origin/main', f.first);
    const [t] = await prepareTrees([spec({ repo: f.repo, sha: f.second, source: 'review', diff: true })], f.home, f.env, 'persona-a');
    expect(t!.diff).toBe(join(personaFolder(f.home, 'persona-a'), 'pr-PRM-1.diff'));
    const text = readFileSync(t!.diff!, 'utf8');
    expect(text).toContain('+new');
    expect(text).toContain('b.txt');
    writeFileSync(join(f.repo, 'big.txt'), `${'x'.repeat(100)}\n`.repeat(Math.ceil((DIFF_MAX + 10_000) / 101)));
    f.git(f.repo, 'add', 'big.txt');
    f.git(f.repo, 'commit', '-q', '-m', 'big');
    const big = f.git(f.repo, 'rev-parse', 'HEAD');
    const [cut] = await prepareTrees([spec({ repo: f.repo, sha: big, source: 'review', diff: true })], f.home, f.env, 'persona-a');
    const bigText = readFileSync(cut!.diff!, 'utf8');
    expect(bigText.length).toBeLessThan(DIFF_MAX + 200);
    expect(bigText).toContain('[cut: the diff is longer than');
    rmSync(f.home, { recursive: true, force: true });
  });

  it('a bad job name becomes a generic name, and a bad base branch is a note, not a run failure', async () => {
    const f = fixture();
    const [t] = await prepareTrees([spec({ job: '../x', repo: f.repo, base: '--upload', sha: f.first, source: 'delivery' })], f.home, f.env, 'persona-a');
    expect(t!.job).toBe('job');
    expect(t!.note).toMatch(/bad base branch/);
    rmSync(f.home, { recursive: true, force: true });
  });

  it('the sweep removes a tree not used for a day, and keeps a tree with changes in it', async () => {
    const f = fixture();
    const [old] = await prepareTrees([spec({ repo: f.repo, sha: f.first, source: 'delivery' })], f.home, f.env, 'persona-a');
    const [dirty] = await prepareTrees([spec({ repo: f.repo, sha: f.second, source: 'delivery' })], f.home, f.env, 'persona-a');
    writeFileSync(join(dirty!.path!, 'untracked.txt'), 'keep me\n');
    const twoDaysAgo = new Date(Date.now() - 2 * DAY);
    utimesSync(old!.path!, twoDaysAgo, twoDaysAgo);
    utimesSync(dirty!.path!, twoDaysAgo, twoDaysAgo);
    // Both are old. git refuses to remove the one with an untracked file, so only the clean one goes.
    const removed = await sweepTrees(f.home, new Date(), f.env);
    expect(removed).toBe(1);
    expect(existsSync(old!.path!)).toBe(false);
    expect(existsSync(dirty!.path!)).toBe(true);
    rmSync(join(dirty!.path!, 'untracked.txt'));
    utimesSync(dirty!.path!, twoDaysAgo, twoDaysAgo);
    expect(await sweepTrees(f.home, new Date(), f.env)).toBe(1);
    expect(existsSync(dirty!.path!)).toBe(false);
    rmSync(f.home, { recursive: true, force: true });
  });

  it('the block the prompt gets names each folder and diff, and says when nothing is pinned', () => {
    expect(studyBlock([])).toMatch(/Pinned trees for this run: none/);
    const block = studyBlock([
      { job: 'PRM-1', path: '/h/trees/x/0123456789abcdef0123456789abcdef01234567', sha: '0123456789abcdef0123456789abcdef01234567', source: 'delivery', diff: '/h/research/p/pr-PRM-1.diff', note: null },
      { job: 'PRM-2', path: null, sha: null, source: 'base', diff: null, note: 'not pinned: origin/main is not in this checkout, and the runner does not fetch' },
    ]);
    expect(block).toContain('PRM-1: /h/trees/x/0123456789abcdef0123456789abcdef01234567 at 0123456789ab (the job\'s PR head)');
    expect(block).toContain('review diff of PRM-1: /h/research/p/pr-PRM-1.diff');
    expect(block).toContain('PRM-2: not pinned: origin/main is not in this checkout');
  });
});

describe('the commit a research run reads, decided from the database', () => {
  let env: Awaited<ReturnType<typeof createTestCtx>>;
  beforeAll(async () => {
    env = await createTestCtx();
  });
  afterAll(async () => {
    await env.close();
  });

  const insertJob = async (id: string, ident: string) => {
    const now = env.clock.now();
    await exec(
      env.ctx.pool,
      `INSERT INTO jobs (id, linear_issue_id, linear_identifier, linear_url, linear_snapshot, title, repo_path, base_branch, staff_agent_id, status, linear_fetched_at, created_at, updated_at)
       VALUES (?, ?, ?, '', '{}', 't', '/home/adam/workspace/app', 'main', NULL, 'delivering', ?, ?, ?)`,
      [id, `prompt:${id}`, ident, now, now, now],
    );
  };

  it('the head of a job is its newest review package or delivery, whichever is later', async () => {
    await insertJob('job_head1', 'PRM-HEAD1');
    const t0 = new Date('2026-11-20T10:00:00.000Z');
    await exec(env.ctx.pool, `INSERT INTO review_packages (id, assignment_id, attempt_number, job_id, round, summary, artifacts, validation, limitations, finding_dispositions, submitted_at, head_sha) VALUES ('pkg_h1', 'asg_h1', 1, 'job_head1', 1, 's', '[]', 'v', '', '[]', ?, ?)`, [t0, 'a'.repeat(40)]);
    expect(await headOfJob(env.ctx.pool, 'job_head1')).toEqual({ head_sha: 'a'.repeat(40), pr_url: null, head_source: 'review' });
    await exec(env.ctx.pool, `INSERT INTO deliveries (id, job_id, assignment_id, attempt_number, reported_by, pr_url, head_sha, reported_at, copilot_summary, ci_summary) VALUES ('dlv_h1', 'job_head1', 'asg_h1', 1, 'agt', 'https://github.com/o/r/pull/9', ?, ?, '', '')`, ['b'.repeat(40), new Date('2026-11-20T11:00:00.000Z')]);
    expect(await headOfJob(env.ctx.pool, 'job_head1')).toEqual({ head_sha: 'b'.repeat(40), pr_url: 'https://github.com/o/r/pull/9', head_source: 'delivery' });
  });

  it('a run reads at most MAX_TREE_JOBS jobs, and only a job with a review item gets its diff', async () => {
    const persona = await createPersona(env.ctx, { nickname: `rt-${Date.now()}`, focus: 'x', repo_path: '/home/adam/workspace', model: 'gpt-6.1-sol', effort: 'medium' });
    const runId = 'run_trees1';
    await exec(env.ctx.pool, `INSERT INTO research_runs (id, persona_id, ticket_hash, status, created_at) VALUES (?, ?, ?, 'queued', ?)`, [runId, persona.id, 'c'.repeat(64), env.clock.now()]);
    const jobs = [];
    for (let i = 0; i < MAX_TREE_JOBS + 1; i++) {
      const id = `job_run${i}`;
      await insertJob(id, `PRM-RUN${i}`);
      jobs.push(id);
    }
    const now = env.clock.now();
    await exec(env.ctx.pool, `INSERT INTO research_inbox (id, persona_id, kind, job_id, event_id, title, status, run_id, created_at) VALUES ('inb_t1', ?, 'question', ?, 1, 't', 'claimed', ?, ?), ('inb_t2', ?, 'review', ?, 2, 't', 'claimed', ?, ?)`, [
      persona.id, jobs[0], runId, new Date(now.getTime() - 3000), persona.id, jobs[1], runId, new Date(now.getTime() - 2000),
    ]);
    for (const j of jobs.slice(2)) {
      await exec(env.ctx.pool, `INSERT INTO research_inbox (id, persona_id, kind, job_id, event_id, title, status, run_id, created_at) VALUES (?, ?, 'question', ?, 3, 't', 'claimed', ?, ?)`, [`inb_${j}`, persona.id, j, runId, now]);
    }
    const plan = await treesOfRun(env.ctx.pool, runId);
    expect(plan.persona).toBe(persona.id);
    expect(plan.trees).toHaveLength(MAX_TREE_JOBS + 1);
    expect(plan.trees.slice(0, MAX_TREE_JOBS).map((t) => t.job)).toEqual(['PRM-RUN0', 'PRM-RUN1', 'PRM-RUN2', 'PRM-RUN3']);
    expect(plan.trees[MAX_TREE_JOBS]).toMatchObject({ job: 'PRM-RUN4', source: 'limit' });
    expect(plan.trees[1]).toMatchObject({ job: 'PRM-RUN1', diff: false, source: 'base', sha: null });
    await exec(env.ctx.pool, `INSERT INTO review_packages (id, assignment_id, attempt_number, job_id, round, summary, artifacts, validation, limitations, finding_dispositions, submitted_at, head_sha) VALUES ('pkg_r1', 'asg_r1', 1, ?, 1, 's', '[]', 'v', '', '[]', ?, ?)`, [jobs[1], now, 'c'.repeat(40)]);
    const again = await treesOfRun(env.ctx.pool, runId);
    expect(again.trees[1]).toMatchObject({ job: 'PRM-RUN1', sha: 'c'.repeat(40), source: 'review', diff: true });
  });
});
