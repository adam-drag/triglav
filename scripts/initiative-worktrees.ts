/**
 * The read-only code an Architect reads (docs/plans/initiative-room.md): one git worktree per repository of an initiative,
 * at origin/<base>, under ~/.local/state/triglav/initiatives/<key>/<slug>. The runner prepares them before it starts an
 * Architect process. Every field comes from Triglav and is checked here; the commands are fixed.
 *
 * - Never the Client's checkout itself: a linked, detached worktree of it, so the Client's working tree is never read.
 * - core.symlinks=false on every checkout: a link in the repository becomes a plain file holding its target, so it cannot
 *   point Read outside the worktree. (Claude Code also refuses a Read through a link that leaves the allowed folder.)
 * - core.hooksPath=/dev/null: a repository's checkout hooks do not run.
 * - Locked (`worktree add --lock`), so `git worktree prune` and the job worktree reaper leave it alone.
 * - A failed fetch keeps the worktree at the commit it has, and says so.
 */
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const INITIATIVE_KEY = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const REPO_SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const BRANCH = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,100}$/;

const GIT_CONFIG = ['-c', 'core.symlinks=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '--no-pager'];

/**
 * One git command, in a process group of its own (spawn with detached; execFile ignores that option), so a cancel or the
 * timeout ends what git started too (ssh under a fetch), not only git.
 */
function git(args: string[], cwd: string, env: NodeJS.ProcessEnv, signal?: AbortSignal, timeout = 120_000): Promise<string> {
  return new Promise((done, fail) => {
    if (signal?.aborted) return fail(new Error(`git ${args[0]} failed: cancelled`));
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
    const onAbort = () => kill('cancelled');
    const timer = setTimeout(() => kill('timed out'), timeout);
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (d) => (stdout.length < 16 << 20 ? (stdout += d) : kill('too much output')));
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-4000)));
    const end = (err: string | null) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (err === null) done(stdout);
      else fail(new Error(`git ${args[0]} failed: ${why || stderr.trim().split('\n').pop() || err}`.slice(0, 300)));
    };
    child.on('error', (e) => end(e.message));
    child.on('close', (code, sig) => end(code === 0 && !why ? null : `exit ${code ?? sig}`));
  });
}

export type InitiativeRepo = { slug: string; path: string; base: string };
export type PreparedTree = { slug: string; base: string; path: string; sha: string | null; note: string | null };

/** The folder of one initiative, created 0700. Refuses a link or a folder outside `root`. */
export function initiativeDir(root: string, key: string): string {
  if (!INITIATIVE_KEY.test(key)) throw new Error('bad initiative key');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const dir = join(root, key);
  if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) throw new Error('the initiative folder is a link');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

/**
 * Creates or refreshes the worktree of one repository at origin/<base>. `home` bounds the repository path. Returns the
 * worktree with its commit, or a note when it could not be prepared or only partly (the Architect is told).
 */
export async function prepareWorktree(dir: string, repo: InitiativeRepo, home: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<PreparedTree> {
  const out: PreparedTree = { slug: repo.slug, base: repo.base, path: join(dir, repo.slug), sha: null, note: null };
  try {
    if (!REPO_SLUG.test(repo.slug)) throw new Error('bad repository slug');
    if (!BRANCH.test(repo.base)) throw new Error('bad base branch');
    const src = realpathSync(repo.path);
    if (!src.startsWith(home + '/') || !statSync(src).isDirectory()) throw new Error(`${repo.path} is not a folder inside ${home}`);
    if (realpathSync((await git(['rev-parse', '--show-toplevel'], src, env, signal)).trim()) !== src) throw new Error(`${repo.path} is not the top of a git checkout`);
    const common = realpathSync(resolve(src, (await git(['rev-parse', '--git-common-dir'], src, env, signal)).trim()));
    try {
      await git(['fetch', '--quiet', 'origin', repo.base], src, env, signal);
    } catch (e) {
      out.note = `Could not fetch origin/${repo.base} (${(e as Error).message}); the code may be older than the remote`;
    }
    const target = `refs/remotes/origin/${repo.base}`;
    if (!existsSync(out.path)) {
      await git(['worktree', 'add', '--lock', '--detach', out.path, target], src, env, signal);
    } else {
      // Only our own worktree of this repository is refreshed: never a link, a plain folder or another repository's checkout.
      if (lstatSync(out.path).isSymbolicLink() || !lstatSync(join(out.path, '.git')).isFile()) throw new Error(`${out.path} is not a worktree made by Triglav`);
      const theirs = realpathSync(resolve(out.path, (await git(['rev-parse', '--git-common-dir'], out.path, env, signal)).trim()));
      if (theirs !== common) throw new Error(`${out.path} belongs to another repository`);
      await git(['checkout', '--quiet', '--force', '--detach', target], out.path, env, signal);
    }
    out.sha = (await git(['rev-parse', 'HEAD'], out.path, env, signal)).trim();
  } catch (e) {
    out.note = `Not available: ${(e as Error).message}`;
    out.sha = null;
  }
  return out;
}

/**
 * Every repository of an initiative, one after the other (they may share a repository's lock). `signal` stops it: the git
 * command running is killed and the repositories left are skipped (a Stop in the room while a fetch hangs).
 */
export async function prepareWorktrees(root: string, key: string, repos: InitiativeRepo[], home: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<{ dir: string; trees: PreparedTree[] }> {
  const dir = initiativeDir(root, key);
  const trees: PreparedTree[] = [];
  for (const r of repos) {
    if (signal?.aborted) break;
    trees.push(await prepareWorktree(dir, r, home, env, signal));
  }
  return { dir, trees };
}
