import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ARCHITECT_HOST_TOOLS, buildArchitectCommand, dropSecretSections, isSecretPath, parseHostRepos, type HostRepo } from '../scripts/architect-host-tools.ts';
import { runHostCommand } from '../scripts/operator-host-tools.ts';

const repos: HostRepo[] = [{ slug: 'app', github: 'acme/app', worktree: '/s/ptp/app', checkout: '/home/u/app' }, { slug: 'nogh', github: null, worktree: '/s/ptp/nogh', checkout: null }];
const build = (name: string, args: unknown) => buildArchitectCommand(name, args, repos).command;
const G = (dir: string) => ['--no-pager', '-C', dir, '-c', 'core.fsmonitor=false', '-c', 'core.pager=cat'];
const SAFE = ['--no-color', '--no-ext-diff', '--no-textconv'];
const DIFF_SAFE = [...SAFE, '--src-prefix=a/', '--dst-prefix=b/'];

describe('the Architect host tools', () => {
  it('builds each gh command with a fixed argv and the GitHub slug of the initiative, never one from the caller', () => {
    expect(build('pr_view', { repo: 'app', number: 7 }).args.slice(0, 5)).toEqual(['pr', 'view', '7', '-R', 'acme/app']);
    expect(build('pr_checks', { repo: 'app', number: 7 })).toEqual({ bin: 'gh', args: ['pr', 'checks', '7', '-R', 'acme/app', '--json', 'name,workflow,state,bucket,link,startedAt,completedAt'] });
    expect(build('pr_comments', { repo: 'app', number: 7 }).args).toEqual(['pr', 'view', '7', '-R', 'acme/app', '--json', 'comments,reviews']);
    expect(build('pr_review_comments', { repo: 'app', number: 7 }).args.slice(0, 2)).toEqual(['api', 'repos/acme/app/pulls/7/comments?per_page=100']);
    expect(build('pr_diff', { repo: 'app', number: 7 }).args).toEqual(expect.arrayContaining(['pr', 'diff', '7', '-R', 'acme/app', '--color', 'never', '--patch', '--exclude', '**/.env*', '--exclude', '**/*.pem']));
    expect(build('run_list', { repo: 'app', workflow: 'deploy.yml', branch: 'main', limit: 5 }).args).toEqual(expect.arrayContaining(['run', 'list', '-R', 'acme/app', '--workflow', 'deploy.yml', '--branch', 'main', '--limit', '5']));
    for (const name of ['pr_view', 'pr_checks', 'pr_comments', 'pr_diff']) expect(build(name, { repo: 'app', number: 1 }).bin).toBe('gh');
    expect(build('run_list', { repo: 'app' }).bin).toBe('gh');
  });

  it("refuses a repository that is not the initiative's, one without a GitHub slug, and anything but the listed properties", () => {
    expect(() => build('pr_view', { repo: 'other', number: 1 })).toThrow(/Unknown repository "other"\. Yours: app, nogh/);
    expect(() => build('pr_view', { repo: 'nogh', number: 1 })).toThrow(/no GitHub slug/);
    expect(() => build('pr_view', { repo: 'app', number: 0 })).toThrow(/Bad arguments/);
    expect(() => build('pr_view', { repo: 'app', number: 1, json: 'x' })).toThrow(/Bad arguments/);
    expect(() => build('git_log', { repo: 'app', extra: 1 })).toThrow(/Bad arguments/);
    expect(() => build('shell', {})).toThrow(/Unknown host tool/);
    expect(() => build('constructor', {})).toThrow(/Unknown host tool/);
    expect(() => build('run_list', { repo: 'app', workflow: '../x.yml' })).toThrow(/Bad arguments/);
    expect(() => build('run_list', { repo: 'app', branch: '--web' })).toThrow(/Bad arguments/);
    expect(() => build('run_list', { repo: 'app', limit: 31 })).toThrow(/Bad arguments/);
  });

  it('builds each git command in the worktree or the checkout, with no pager, no external diff and no textconv', () => {
    expect(build('git_log', { repo: 'app' })).toEqual({ bin: 'git', args: [...G('/s/ptp/app'), 'log', ...SAFE, '-n', '30', '--date=short', '--format=%h %ad %an %s', '--'] });
    expect(build('git_log', { repo: 'app', where: 'checkout', ref: 'feature/x', path: 'src/a.ts', n: 5 }).args).toEqual([...G('/home/u/app'), 'log', ...SAFE, '-n', '5', '--date=short', '--format=%h %ad %an %s', 'feature/x^{commit}', '--', 'src/a.ts']);
    expect(build('git_show', { repo: 'app', ref: 'abc1234' }).args).toEqual([...G('/s/ptp/app'), 'show', ...DIFF_SAFE, '--stat', '--patch', 'abc1234^{commit}', '--']);
    expect(build('git_diff', { repo: 'app', base: 'origin/main', head: 'feature/x', stat: true }).args).toEqual([...G('/s/ptp/app'), 'diff', ...DIFF_SAFE, '--stat', 'origin/main^{commit}...feature/x^{commit}', '--']);
    expect(build('git_file', { repo: 'app', path: 'src/a.ts' }).args).toEqual([...G('/s/ptp/app'), 'show', ...SAFE, 'HEAD:src/a.ts']);
    expect(build('git_blame', { repo: 'app', path: 'src/a.ts', start: 10, end: 20, ref: 'abc1234' }).args).toEqual([...G('/s/ptp/app'), 'blame', '--date=short', '-L', '10,20', 'abc1234^{commit}', '--', 'src/a.ts']);
    expect(() => build('git_log', { repo: 'nogh', where: 'checkout' })).toThrow(/no checkout this time/);
  });

  it('refuses a ref or a path that would be read as an option, climb out, or reach a secret file', () => {
    for (const ref of ['--output=/tmp/x', '-p', 'a..b', 'a b', 'a;b', '', 'a:b', 'x'.repeat(101)]) expect(() => build('git_show', { repo: 'app', ref })).toThrow(/Bad arguments/);
    for (const path of ['../x', 'a/../b', '/etc/passwd', '-x', 'a b', '.env', 'app/.env.local', 'keys/server.pem', 'a/b.key', '.npmrc', 'x/.npmrc']) {
      expect(() => build('git_file', { repo: 'app', path })).toThrow(/Bad arguments/);
      expect(() => build('git_blame', { repo: 'app', path, start: 1, end: 2 })).toThrow(/Bad arguments/);
    }
    expect(() => build('git_blame', { repo: 'app', path: 'a.ts', start: 5, end: 4 })).toThrow(/range/);
    expect(() => build('git_blame', { repo: 'app', path: 'a.ts', start: 1, end: 201 })).toThrow(/range/);
    expect(() => build('git_file', { repo: 'app', path: 'src/environment.ts' })).not.toThrow();
  });

  it('cuts the diff of a secret file out of every diff, and keeps the others', () => {
    const diff = ['diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', '+ok', 'diff --git a/.env.prod b/.env.prod', '+TOKEN=abc', 'diff --git a/deploy/tls.key b/deploy/tls.key', '+PRIVATE', 'diff --git a/src/b.ts b/src/b.ts', '+fine', ''].join('\n');
    const out = dropSecretSections(diff);
    expect(out).toContain('+ok');
    expect(out).toContain('+fine');
    expect(out).not.toContain('TOKEN=abc');
    expect(out).not.toContain('PRIVATE');
    expect(out).toContain('[diff of .env.prod left out: that file is not readable]');
    expect(isSecretPath('a/.env')).toBe(true);
    expect(isSecretPath('a/env.ts')).toBe(false);
    for (const name of ['pr_diff', 'git_show', 'git_diff']) expect((ARCHITECT_HOST_TOOLS as any)[name].filter).toBe(dropSecretSections);
    expect(buildArchitectCommand('git_diff', { repo: 'app', base: 'a', head: 'b' }, repos).filter(diff)).not.toContain('TOKEN=abc');
  });

  it('leaves out a diff section whose header it cannot check, as well as a secret one', () => {
    const quoted = 'diff --git "a/odd\\tname.pem" "b/odd\\tname.pem"\n+KEY\n';
    const noprefix = 'diff --git .env .env\n+TOKEN=abc\n';
    const merge = 'diff --cc .env\n+TOKEN=abc\n';
    const spaced = 'diff --git a/my .env b/my .env\n+TOKEN=abc\n';
    for (const section of [quoted, noprefix, merge, spaced]) {
      const out = dropSecretSections(`commit msg\n${section}diff --git a/ok.ts b/ok.ts\n+fine\n`);
      expect(out).not.toMatch(/KEY|TOKEN/);
      expect(out).toContain('commit msg');
      expect(out).toContain('+fine');
      expect(out).toContain('left out');
    }
  });

  it('reads the repositories from the server environment and drops a bad entry', () => {
    expect(parseHostRepos(JSON.stringify([{ slug: 'app', github: 'acme/app', worktree: '/s/app', checkout: '/home/u/app' }, { slug: 'x y', worktree: '/s' }, { slug: 'b', github: '--bad', worktree: '/s/../x', checkout: 'rel' }]))).toEqual([
      { slug: 'app', github: 'acme/app', worktree: '/s/app', checkout: '/home/u/app' },
      { slug: 'b', github: null, worktree: null, checkout: null },
    ]);
    expect(parseHostRepos(undefined)).toEqual([]);
    expect(parseHostRepos('not json')).toEqual([]);
    expect(parseHostRepos('{}')).toEqual([]);
  });

  describe('against a real repository', () => {
    const dir = mkdtempSync(join(tmpdir(), 'triglav-arch-host-'));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));
    const git = (...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'a.ts'), 'one\ntwo\n');
    writeFileSync(join(dir, '.env'), 'TOKEN=abc\n');
    git('add', '.');
    git('commit', '-q', '-m', 'first');
    writeFileSync(join(dir, 'src', 'a.ts'), 'one\ntwo\nthree\n');
    git('commit', '-q', '-am', 'second');
    const local: HostRepo[] = [{ slug: 'app', github: null, worktree: dir, checkout: null }];
    const run = async (name: string, args: unknown) => {
      const b = buildArchitectCommand(name, args, local);
      return b.filter(await runHostCommand(b.command, tmpdir(), b.okCodes));
    };

    it('logs, shows, diffs, reads and blames', async () => {
      expect((await run('git_log', { repo: 'app' })).trim().split('\n').map((l) => l.split(' ').slice(3).join(' '))).toEqual(['second', 'first']);
      expect(await run('git_show', { repo: 'app', ref: 'HEAD' })).toContain('+three');
      expect(await run('git_diff', { repo: 'app', base: 'HEAD~1', head: 'HEAD', path: 'src/a.ts' })).toContain('+three');
      expect(await run('git_file', { repo: 'app', path: 'src/a.ts', ref: 'HEAD~1' })).toBe('one\ntwo\n');
      expect(await run('git_blame', { repo: 'app', path: 'src/a.ts', start: 1, end: 3 })).toMatch(/three/);
    });

    it('refuses a blob or tree SHA as a ref, and a repository config that changes the diff header', async () => {
      const blob = git('rev-parse', 'HEAD:.env').trim();
      const tree = git('rev-parse', 'HEAD:src').trim();
      for (const ref of [blob, tree]) {
        await expect(run('git_show', { repo: 'app', ref })).rejects.toThrow();
        await expect(run('git_log', { repo: 'app', ref })).rejects.toThrow();
        await expect(run('git_diff', { repo: 'app', base: 'HEAD', head: ref })).rejects.toThrow();
        await expect(run('git_blame', { repo: 'app', path: 'src/a.ts', start: 1, end: 1, ref })).rejects.toThrow();
      }
      // With diff.noprefix on in the repository, the header still has a/ and b/, so the .env section is found and cut.
      git('config', 'diff.noprefix', 'true');
      const firstSha = git('rev-list', '--max-parents=0', 'HEAD').trim();
      const shown = await run('git_show', { repo: 'app', ref: firstSha });
      expect(shown).toContain('+one');
      expect(shown).not.toContain('TOKEN=abc');
      git('config', '--unset', 'diff.noprefix');
    });

    it('does not return a secret file, by path or inside a commit diff', async () => {
      await expect(run('git_file', { repo: 'app', path: '.env' })).rejects.toThrow(/Bad arguments/);
      const firstSha = git('rev-list', '--max-parents=0', 'HEAD').trim();
      const shown = await run('git_show', { repo: 'app', ref: firstSha });
      expect(shown).toContain('+one');
      expect(shown).not.toContain('TOKEN=abc');
    });
  });
});
