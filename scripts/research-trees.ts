/**
 * The pinned trees of a research run (docs/plans/researcher-access.md, phase 2). The server decides which commit each job
 * is read at (src/research-trees.ts); this module makes that commit a read-only folder, and writes the review diff of a job
 * whose run has a review round. Every git command has fixed arguments and no shell, and runs with the environment the caller
 * gives (staffStartEnv, so no Triglav secret reaches it).
 *
 * A tree is a detached, locked worktree at the commit, built as the Architect's trees are (initiative-worktrees.ts): no
 * symlinks, no hooks, tracked files only. The runner never fetches: a commit that is not in the checkout is reported, not made.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const GIT_CONFIG = ['-c', 'core.symlinks=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '--no-pager'];

/** A review diff longer than this is cut, and the cut is said in the file: the researcher reads the tree for the rest. */
export const DIFF_MAX = 1_000_000;

/** A tree not used for this long is removed by the sweep. A run stops after 14 minutes, so a tree in use is never this old. */
export const TREE_KEEP_MS = 24 * 3600_000;

const SHA = /^[0-9a-f]{40}$/;
const BASE = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,100}$/;
const JOB = /^[A-Za-z0-9._-]{1,64}$/;
const PERSONA = /^[A-Za-z0-9_-]{1,80}$/;

/** What the server sends for one job of a run (src/research-trees.ts). `repo` and `base` are checked here again. */
export type ResearchTree = {
  job: string;
  repo: string;
  base: string;
  sha: string | null;
  source: 'delivery' | 'review' | 'base' | 'limit';
  diff: boolean;
};

/** The result for one job: a folder to read and, for a review round, the diff file. `note` says why a job has no folder. */
export type PreparedTree = { job: string; path: string | null; sha: string | null; source: string; diff: string | null; note: string | null };

/** `~/.local/state/triglav/research-trees`: one folder per repository, one tree per commit under it. */
export function treesRoot(home: string): string {
  return join(home, '.local', 'state', 'triglav', 'research-trees');
}

/** The stable working folder of a persona: Claude Code keeps one project per folder, so every run of a persona shares it. */
export function personaFolder(home: string, persona: string): string {
  if (!PERSONA.test(persona)) throw new Error('bad persona id');
  return join(home, '.local', 'state', 'triglav', 'research', persona);
}

/**
 * One git command, in a process group of its own, so the timeout ends what git started too. The output is capped: a
 * diff can be large, and a command that prints too much is stopped.
 */
function git(args: string[], cwd: string, env: NodeJS.ProcessEnv, timeout = 60_000, maxOut = 4 << 20): Promise<string> {
  return new Promise((done, fail) => {
    const child = spawn('git', [...GIT_CONFIG, ...args], { cwd, env: { ...env, GIT_TERMINAL_PROMPT: '0' }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let why = '';
    const kill = (reason: string) => {
      why ||= reason;
      try {
        if (child.pid) process.kill(-child.pid, 'SIGTERM');
      } catch {
        // Already gone.
      }
    };
    const timer = setTimeout(() => kill('timed out'), timeout);
    child.stdout.on('data', (d) => (stdout.length < maxOut ? (stdout += d) : kill('too much output')));
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-4000)));
    const end = (err: string | null) => {
      clearTimeout(timer);
      if (err === null) done(stdout);
      else fail(new Error(`git ${args[0]} failed: ${why || stderr.trim().split('\n').pop() || err}`.slice(0, 300)));
    };
    child.on('error', (e) => end(e.message));
    child.on('close', (code, sig) => end(code === 0 && !why ? null : `exit ${code ?? sig}`));
  });
}

/** The repository's real path, which must be a folder inside the home folder. */
function realRepo(path: string, home: string): string {
  if (typeof path !== 'string' || !path.startsWith('/')) throw new Error('the repository path is not absolute');
  const real = realpathSync(path);
  if (!real.startsWith(`${home}/`) || !statSync(real).isDirectory()) throw new Error('the repository is not a folder inside the home folder');
  return real;
}

const folderOf = (home: string, repo: string): string => join(treesRoot(home), createHash('sha256').update(repo).digest('hex').slice(0, 16));

const WHAT: Record<string, string> = {
  delivery: "the job's PR head",
  review: "the job's newest reviewed head",
  base: 'origin/<base> as this checkout has it (not fetched)',
};

/** Makes the tree of one job, or says why the job is not pinned. Never throws. */
async function prepareOne(spec: ResearchTree, home: string, env: NodeJS.ProcessEnv, persona: string): Promise<PreparedTree> {
  const job = typeof spec.job === 'string' && JOB.test(spec.job) ? spec.job : 'job';
  const result = (over: Partial<PreparedTree>): PreparedTree => ({ job, path: null, sha: null, source: String(spec.source), diff: null, note: null, ...over });
  if (spec.source === 'limit') return result({ note: 'not pinned: this run reads at most four jobs' });
  try {
    const repo = realRepo(spec.repo, home);
    if (realpathSync((await git(['rev-parse', '--show-toplevel'], repo, env)).trim()) !== repo) throw new Error('the repository path is not the top of a git checkout');
    if (typeof spec.base !== 'string' || !BASE.test(spec.base)) throw new Error('bad base branch');
    const baseSha = (await git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${spec.base}^{commit}`], repo, env).catch(() => '')).trim() || null;
    let sha: string;
    if (spec.sha !== null) {
      if (typeof spec.sha !== 'string' || !SHA.test(spec.sha)) throw new Error('bad commit');
      sha = spec.sha;
    } else {
      if (!baseSha) throw new Error(`origin/${spec.base} is not in this checkout, and the runner does not fetch`);
      sha = baseSha;
    }
    await git(['cat-file', '-e', `${sha}^{commit}`], repo, env).catch(() => {
      throw new Error(`commit ${sha.slice(0, 12)} is not in this checkout`);
    });
    const dir = join(folderOf(home, repo), sha);
    if (existsSync(dir)) {
      if (lstatSync(dir).isSymbolicLink()) throw new Error('the tree folder is a link');
      const at = (await git(['rev-parse', 'HEAD'], dir, env)).trim();
      if (at !== sha) throw new Error(`the tree is at ${at.slice(0, 12)}, not ${sha.slice(0, 12)}`);
      const theirs = realpathSync(resolve(dir, (await git(['rev-parse', '--git-common-dir'], dir, env)).trim()));
      const ours = realpathSync(resolve(repo, (await git(['rev-parse', '--git-common-dir'], repo, env)).trim()));
      if (theirs !== ours) throw new Error('the tree belongs to another repository');
    } else {
      mkdirSync(folderOf(home, repo), { recursive: true, mode: 0o700 });
      await git(['worktree', 'add', '--lock', '--detach', dir, sha], repo, env);
    }
    // The sweep keeps a tree by its time: a tree in use is touched here.
    const now = new Date();
    utimesSync(dir, now, now);
    let diff: string | null = null;
    if (spec.diff && baseSha) {
      const mergeBase = (await git(['merge-base', baseSha, sha], repo, env)).trim();
      let text = await git(['diff', '--no-ext-diff', '--no-textconv', '--no-color', mergeBase, sha], repo, env, 60_000, 16 << 20);
      if (text.length > DIFF_MAX) text = `${text.slice(0, DIFF_MAX)}\n[cut: the diff is longer than ${DIFF_MAX} characters; read the tree for the rest]\n`;
      const file = join(personaFolder(home, persona), `pr-${job}.diff`);
      writeFileSync(file, text, { mode: 0o600 });
      diff = file;
    }
    return result({ path: dir, sha, diff });
  } catch (e) {
    return result({ note: `not pinned: ${(e as Error).message}`.slice(0, 300) });
  }
}

/**
 * Prepares the trees of one run, one job at a time. The persona folder must exist already (the diff files go there).
 * A failure is a note on that job, never a failed run.
 */
export async function prepareTrees(specs: ResearchTree[], home: string, env: NodeJS.ProcessEnv, persona: string): Promise<PreparedTree[]> {
  const out: PreparedTree[] = [];
  for (const spec of Array.isArray(specs) ? specs : []) out.push(await prepareOne(spec, home, env, persona));
  return out;
}

/** The lines the runner appends to the prompt: where each job's code is, and the review diff. Only folders and notes, no text from the board. */
export function studyBlock(prepared: PreparedTree[]): string {
  if (!prepared.length) return '\n\nPinned trees for this run: none. You have no code for this run; say so where it matters.';
  const lines = prepared.map((t) => (t.path ? `- ${t.job}: ${t.path} at ${(t.sha ?? '').slice(0, 12)} (${WHAT[t.source] ?? t.source})` : `- ${t.job}: ${t.note}`));
  const diffs = prepared.filter((t) => t.diff).map((t) => `- review diff of ${t.job}: ${t.diff}`);
  return [
    '',
    '',
    "Pinned trees for this run. Each folder is a read-only copy of one job's repository at one commit. Read only these folders.",
    ...lines,
    ...(diffs.length ? ['', ...diffs] : []),
  ].join('\n');
}

/**
 * Removes the trees not used for TREE_KEEP_MS. Each goes through git (unlock, then remove without --force), so a tree with
 * changes is kept and reported, not deleted. Returns how many were removed.
 */
export async function sweepTrees(home: string, now: Date, env: NodeJS.ProcessEnv, keepMs = TREE_KEEP_MS): Promise<number> {
  const root = treesRoot(home);
  if (!existsSync(root)) return 0;
  let removed = 0;
  for (const repoDir of readdirSync(root)) {
    const repoPath = join(root, repoDir);
    for (const sha of readdirSync(repoPath)) {
      const dir = join(repoPath, sha);
      if (!/^[0-9a-f]{40}$/.test(sha) || now.getTime() - statSync(dir).mtimeMs < keepMs) continue;
      try {
        if (!lstatSync(join(dir, '.git')).isFile()) continue;
        const common = realpathSync(resolve(dir, (await git(['rev-parse', '--git-common-dir'], dir, env)).trim()));
        await git(['--git-dir', common, 'worktree', 'unlock', dir], home, env).catch(() => undefined);
        await git(['--git-dir', common, 'worktree', 'remove', dir], home, env);
        removed += 1;
      } catch {
        // A tree git will not remove (changes in it, or it is gone) stays for the next sweep.
      }
    }
    if (readdirSync(repoPath).length === 0) rmdirSync(repoPath);
  }
  return removed;
}
