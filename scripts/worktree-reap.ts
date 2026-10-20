/**
 * Removes a finished job's git worktree for the host runner (`reap_worktree` launch, src/worktrees.ts). The server
 * only sends a path. Everything is checked here with fixed git commands, and any doubt keeps the worktree:
 *
 * - the path is inside the home directory and is the top of a linked worktree, never a main checkout;
 * - git lists it as a worktree of its repository, and it is not locked;
 * - nothing is uncommitted or untracked (ignored files such as node_modules do not count);
 * - every commit of HEAD is on a remote-tracking branch, so a later Senior can get it back from the remote.
 *
 * Then `git worktree remove` deletes the directory and git's record of it. The branch stays.
 */
import { execFile } from 'node:child_process';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';

function git(args: string[], cwd: string, env: NodeJS.ProcessEnv, timeout = 60_000): Promise<string> {
  return new Promise((done, fail) => {
    execFile('git', ['-c', 'core.fsmonitor=false', '--no-pager', ...args], { cwd, env, timeout, maxBuffer: 16 << 20 }, (err, stdout, stderr) =>
      err ? fail(new Error(`git ${args[0]} failed: ${`${stderr}`.trim().split('\n')[0] || err.message}`)) : done(stdout),
    );
  });
}

const short = (s: string) => JSON.stringify(s.length > 120 ? `${s.slice(0, 120)}...` : s);

export async function reapWorktree(path: string, home: string, env: NodeJS.ProcessEnv): Promise<string> {
  let real: string;
  try {
    real = realpathSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 'already gone';
    throw e;
  }
  if (!real.startsWith(home + '/')) throw new Error(`${short(path)} is outside ${home}`);
  // A linked worktree has a .git file; a main checkout has a .git directory and is never removed.
  let dotGit;
  try {
    dotGit = lstatSync(join(real, '.git'));
  } catch {
    throw new Error(`${short(real)} is not a git worktree`);
  }
  if (!dotGit.isFile()) throw new Error(`${short(real)} is a main checkout, not a linked worktree`);
  if (realpathSync((await git(['rev-parse', '--show-toplevel'], real, env)).trim()) !== real) throw new Error(`${short(real)} is not the top of its worktree`);
  const gitDir = realpathSync((await git(['rev-parse', '--absolute-git-dir'], real, env)).trim());
  const commonDir = realpathSync(resolve(real, (await git(['rev-parse', '--git-common-dir'], real, env)).trim()));
  if (gitDir === commonDir) throw new Error(`${short(real)} is a main checkout, not a linked worktree`);

  // The first entry is the main checkout; the removal runs from there.
  const entries = (await git(['worktree', 'list', '--porcelain'], real, env)).split(/\n\n+/).map((b) => b.split('\n').filter(Boolean)).filter((b) => b.length);
  const pathOf = (b: string[]) => b.find((l) => l.startsWith('worktree '))?.slice('worktree '.length) ?? '';
  const main = entries[0] ? pathOf(entries[0]) : '';
  const own = entries.slice(1).find((b) => {
    try {
      return realpathSync(pathOf(b)) === real;
    } catch {
      return false;
    }
  });
  if (!main || !own) throw new Error(`git does not list ${short(real)} as a linked worktree`);
  if (own.some((l) => l === 'locked' || l.startsWith('locked '))) throw new Error(`kept: ${short(real)} is locked`);

  const dirty = (await git(['status', '--porcelain', '--untracked-files=normal'], real, env)).split('\n').filter(Boolean);
  if (dirty.length) throw new Error(`kept: ${dirty.length} uncommitted or untracked path(s), first ${short(dirty[0]!.slice(3))}`);
  const unpushed = Number((await git(['rev-list', '--count', 'HEAD', '--not', '--remotes'], real, env)).trim());
  if (unpushed !== 0) throw new Error(`kept: ${Number.isFinite(unpushed) ? unpushed : 'some'} commit(s) are on no remote branch`);

  const mainReal = realpathSync(main);
  // Deleting a large node_modules can take a while.
  await git(['worktree', 'remove', real], mainReal, env, 10 * 60_000);
  if (existsSync(real)) throw new Error(`${short(real)} is still there after git worktree remove`);
  return `removed ${real}`;
}
