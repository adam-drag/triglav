import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { reapWorktree } from '../scripts/worktree-reap.ts';

const ENV = { PATH: process.env.PATH!, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: { ...ENV, HOME: cwd }, encoding: 'utf8' }).trim();

/** A home with a bare remote, a main clone and one linked worktree on a pushed branch, with an ignored node_modules. */
function setup() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'reap-home-')));
  const remote = join(home, 'remote.git');
  git(home, 'init', '-q', '--bare', '-b', 'main', remote);
  const main = join(home, 'repo');
  git(home, 'clone', '-q', remote, main);
  writeFileSync(join(main, '.gitignore'), 'node_modules/\n');
  git(main, 'add', '.gitignore');
  git(main, 'commit', '-qm', 'init');
  git(main, 'push', '-q', 'origin', 'main');
  const wt = join(home, 'repo-job_1');
  git(main, 'worktree', 'add', '-q', '-b', 'feature', wt);
  writeFileSync(join(wt, 'a.txt'), 'a\n');
  git(wt, 'add', 'a.txt');
  git(wt, 'commit', '-qm', 'feature');
  git(wt, 'push', '-q', '-u', 'origin', 'feature');
  mkdirSync(join(wt, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(wt, 'node_modules', 'pkg', 'index.js'), '');
  return { home, main, wt };
}

describe('reapWorktree', () => {
  it('removes a clean, pushed linked worktree with an ignored node_modules, and keeps the branch and the main checkout', async () => {
    const { home, main, wt } = setup();
    expect(await reapWorktree(wt, home, ENV)).toBe(`removed ${wt}`);
    expect(existsSync(wt)).toBe(false);
    expect(existsSync(join(main, '.gitignore'))).toBe(true);
    expect(git(main, 'branch', '--list', 'feature')).toContain('feature');
    expect(git(main, 'worktree', 'list')).not.toContain('repo-job_1');
  });

  it('keeps a worktree with a commit that is on no remote branch', async () => {
    const { home, wt } = setup();
    writeFileSync(join(wt, 'b.txt'), 'b\n');
    git(wt, 'add', 'b.txt');
    git(wt, 'commit', '-qm', 'local only');
    await expect(reapWorktree(wt, home, ENV)).rejects.toThrow(/kept: 1 commit\(s\) are on no remote branch/);
    expect(existsSync(join(wt, 'b.txt'))).toBe(true);
  });

  it('keeps a worktree with an untracked or a modified file', async () => {
    const { home, wt } = setup();
    writeFileSync(join(wt, 'notes.md'), 'scratch\n');
    await expect(reapWorktree(wt, home, ENV)).rejects.toThrow(/kept: 1 uncommitted or untracked path\(s\), first "notes.md"/);
    git(wt, 'clean', '-qf');
    writeFileSync(join(wt, 'a.txt'), 'changed\n');
    await expect(reapWorktree(wt, home, ENV)).rejects.toThrow(/kept: 1 uncommitted/);
    expect(existsSync(wt)).toBe(true);
  });

  it('keeps a locked worktree', async () => {
    const { home, main, wt } = setup();
    git(main, 'worktree', 'lock', wt);
    await expect(reapWorktree(wt, home, ENV)).rejects.toThrow(/kept: .* is locked/);
    expect(existsSync(wt)).toBe(true);
  });

  it('never removes a main checkout, a directory inside a worktree, a plain directory or a path outside home', async () => {
    const { home, main, wt } = setup();
    await expect(reapWorktree(main, home, ENV)).rejects.toThrow(/main checkout/);
    mkdirSync(join(wt, 'sub'));
    writeFileSync(join(wt, 'sub', '.git'), 'gitdir: /nowhere\n');
    await expect(reapWorktree(join(wt, 'sub'), home, ENV)).rejects.toThrow();
    const plain = join(home, 'plain');
    mkdirSync(plain);
    await expect(reapWorktree(plain, home, ENV)).rejects.toThrow(/not a git worktree/);
    const other = realpathSync(mkdtempSync(join(tmpdir(), 'reap-other-')));
    await expect(reapWorktree(other, home, ENV)).rejects.toThrow(/outside/);
    expect(existsSync(main) && existsSync(wt) && existsSync(plain) && existsSync(other)).toBe(true);
  });

  it('reports a path that no longer exists as already gone', async () => {
    const { home } = setup();
    expect(await reapWorktree(join(home, 'repo-job_gone'), home, ENV)).toBe('already gone');
  });
});
