import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ARCHITECT_TOOLS, architectArgs, architectPrompt, SECRET_FILES } from '../src/architect-args.ts';
import { architectMcpConfig, checkedArchitect } from '../scripts/operator.ts';
import { prepareWorktrees } from '../scripts/initiative-worktrees.ts';
import { reapWorktree } from '../scripts/worktree-reap.ts';

const root = '/home/u/.local/state/triglav/initiatives/ptp';
const base = { model: 'claude-opus-5-5', effort: 'high', sessionId: null, mcpConfigPath: '/tmp/triglav-x/architect-mcp.json', root, worktrees: [`${root}/frontend`, `${root}/pages`], home: '/home/u', checkouts: ['/home/u/work/frontend'], systemPrompt: 'card' };
const denied = (dir: string) => [`Read(/${dir}/**/.env*)`, `Read(/${dir}/**/.npmrc)`, `Read(/${dir}/**/*.pem)`, `Read(/${dir}/**/*.key)`];

describe('the Architect process arguments', () => {
  it('pins every restriction: no settings files, three read tools, Read rules only for its worktrees and checkouts, its one MCP server', () => {
    expect(architectArgs(base)).toEqual([
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--model', 'claude-opus-5-5', '--effort', 'high',
      '--setting-sources', '',
      '--permission-mode', 'dontAsk',
      '--no-chrome',
      '--tools', 'Read,Grep,Glob',
      '--allowedTools', 'mcp__initiative', `Read(/${root}/frontend/**)`, `Read(/${root}/pages/**)`, 'Read(//home/u/work/frontend/**)',
      '--disallowedTools', ...denied(`${root}/frontend`), ...denied(`${root}/pages`), ...denied('/home/u/work/frontend'),
      '--strict-mcp-config',
      '--mcp-config', '/tmp/triglav-x/architect-mcp.json',
      '--append-system-prompt', 'card',
    ]);
  });

  it('never has Bash, a write tool or a bare Read, Grep or Glob', () => {
    const args = architectArgs(base);
    expect(ARCHITECT_TOOLS).toEqual(['Read', 'Grep', 'Glob']);
    const allowed = args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--disallowedTools'));
    for (const a of allowed) expect(a === 'mcp__initiative' || /^Read\(\/\/.+\/\*\*\)$/.test(a)).toBe(true);
    for (const banned of ['Bash', 'Write', 'Edit', 'WebFetch', 'WebSearch', 'ToolSearch', 'Read', 'Grep', 'Glob', '--add-dir', '--dangerously-skip-permissions', 'operator']) expect(allowed).not.toContain(banned);
    expect(args).not.toContain('--add-dir');
    expect(args.join(' ')).not.toMatch(/Bash/);
  });

  it('resumes a session, and refuses odd values and worktrees outside its folder', () => {
    const session = '0f7c2e8a-1b2c-4d5e-8f90-123456789abc';
    expect(architectArgs({ ...base, sessionId: session }).slice(-2)).toEqual(['--resume', session]);
    expect(() => architectArgs({ ...base, model: '--dangerously-skip-permissions' })).toThrow(/bad model/);
    expect(() => architectArgs({ ...base, effort: 'max effort' })).toThrow(/bad effort/);
    expect(() => architectArgs({ ...base, sessionId: '--resume' })).toThrow(/bad session/);
    expect(() => architectArgs({ ...base, worktrees: ['/home/u'] })).toThrow(/direct child/);
    expect(() => architectArgs({ ...base, worktrees: [`${root}/a/b`] })).toThrow(/direct child/);
    expect(() => architectArgs({ ...base, worktrees: [`${root}/../x`] })).toThrow(/bad worktree/);
    expect(() => architectArgs({ ...base, worktrees: [`${root}/x)**,Bash(`] })).toThrow(/bad worktree/);
  });

  it('reads a checkout only inside the home folder, once, and denies its secret files', () => {
    expect(SECRET_FILES).toEqual(['.env*', '.npmrc', '*.pem', '*.key']);
    expect(() => architectArgs({ ...base, checkouts: ['/etc'] })).toThrow(/inside the home folder/);
    expect(() => architectArgs({ ...base, checkouts: ['/home/u'] })).toThrow(/inside the home folder/);
    expect(() => architectArgs({ ...base, checkouts: ['/home/uv/app'] })).toThrow(/inside the home folder/);
    expect(() => architectArgs({ ...base, checkouts: ['/home/u/../etc'] })).toThrow(/bad checkout/);
    expect(() => architectArgs({ ...base, checkouts: ['/home/u/app)**,Bash('] })).toThrow(/bad checkout/);
    const args = architectArgs({ ...base, worktrees: [], checkouts: ['/home/u/app', '/home/u/app/'] });
    expect(args.slice(args.indexOf('--allowedTools'), args.indexOf('--strict-mcp-config'))).toEqual(['--allowedTools', 'mcp__initiative', 'Read(//home/u/app/**)', '--disallowedTools', ...denied('/home/u/app')]);
    // Nothing readable: no Read rule and no empty --disallowedTools before the next flag.
    const none = architectArgs({ ...base, worktrees: [], checkouts: [] });
    expect(none.slice(none.indexOf('--allowedTools'), none.indexOf('--strict-mcp-config'))).toEqual(['--allowedTools', 'mcp__initiative']);
  });

  it('writes an MCP config with the initiative server only, and checks what Triglav sends', () => {
    const token = `orch_chat_${'a'.repeat(43)}`;
    const config = JSON.parse(architectMcpConfig({ mcpUrl: 'http://127.0.0.1:7400/architect/mcp', token }));
    expect(Object.keys(config.mcpServers)).toEqual(['initiative']);
    expect(config.mcpServers.initiative).toEqual({ type: 'http', url: 'http://127.0.0.1:7400/architect/mcp', headers: { Authorization: `Bearer ${token}` } });
    expect(() => architectMcpConfig({ mcpUrl: 'x', token: 'bad token' })).toThrow(/bad chat token/);
    expect(checkedArchitect({ key: 'ptp', title: 'A\nB', model: 'm', effort: 'high', repos: [{ slug: 'app', path: '/home/u/app', base: 'main', extra: 1 }] })).toEqual({
      key: 'ptp', title: 'A B', model: 'm', effort: 'high', repos: [{ slug: 'app', path: '/home/u/app', base: 'main' }],
    });
    expect(() => checkedArchitect({ key: '../x', title: 't', model: 'm', effort: 'e', repos: [] })).toThrow(/bad initiative/);
    expect(() => checkedArchitect(null)).toThrow(/bad initiative/);
  });

  it('tells the Architect where its code is, after its card', () => {
    const p = architectPrompt('## Architect\ncard', { key: 'ptp', title: 'Public pages' }, [
      { slug: 'frontend', base: 'main', path: `${root}/frontend`, sha: 'a'.repeat(40), note: null, checkout: '/home/u/work/frontend' },
      { slug: 'pages', base: 'main', path: `${root}/pages`, sha: null, note: 'Not available: gone', checkout: null },
    ]);
    expect(p).toBe(`## Architect\ncard\n\nYour initiative: ptp (Public pages).\nRead-only code:\n- frontend: ${root}/frontend (origin/main at aaaaaaaaaaaa). The Client's checkout: /home/u/work/frontend\n- pages: ${root}/pages (origin/main). Not available: gone`);
  });
});

describe('the Architect worktrees', () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'triglav-arch-')));
  afterAll(() => rmSync(home, { recursive: true, force: true }));
  const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...a], { cwd, encoding: 'utf8' }).trim();

  // An "origin" with a commit that holds a symlink pointing out of the repository, and a clone of it as the Client's checkout.
  const origin = join(home, 'origin');
  mkdirSync(origin);
  git(origin, 'init', '-q');
  writeFileSync(join(origin, 'a.txt'), 'hello\n');
  symlinkSync('/etc/passwd', join(origin, 'leak'));
  git(origin, 'add', 'a.txt', 'leak');
  git(origin, 'commit', '-qm', 'one');
  const checkout = join(home, 'work', 'app');
  mkdirSync(join(home, 'work'));
  git(join(home, 'work'), 'clone', '-q', origin, 'app');
  writeFileSync(join(checkout, 'mine.txt'), 'uncommitted work of the Client\n');
  const state = join(home, '.local', 'state', 'triglav', 'initiatives');
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' };

  it('checks out origin/<base> in its own locked worktree, with symlinks as plain files', async () => {
    const { dir, trees } = await prepareWorktrees(state, 'ptp', [{ slug: 'app', path: checkout, base: 'main' }], home, env);
    expect(dir).toBe(join(state, 'ptp'));
    expect(trees).toEqual([{ slug: 'app', base: 'main', path: join(dir, 'app'), sha: git(origin, 'rev-parse', 'HEAD'), note: null, checkout }]);
    const wt = join(dir, 'app');
    expect(readFileSync(join(wt, 'a.txt'), 'utf8')).toBe('hello\n');
    // core.symlinks=false: the link is a plain file holding its target, so Read cannot follow it out.
    expect(lstatSync(join(wt, 'leak')).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(wt, 'leak'), 'utf8')).toBe('/etc/passwd');
    // The Client's checkout is untouched, and its uncommitted file is not in the worktree.
    expect(existsSync(join(wt, 'mine.txt'))).toBe(false);
    expect(git(checkout, 'status', '--porcelain')).toBe('?? mine.txt');
    expect(git(checkout, 'worktree', 'list', '--porcelain')).toMatch(/\nlocked/);
  });

  it('refreshes to a newer origin on the next start, and notes a repository it cannot use', async () => {
    writeFileSync(join(origin, 'b.txt'), 'two\n');
    git(origin, 'add', 'b.txt');
    git(origin, 'commit', '-qm', 'two');
    const { trees } = await prepareWorktrees(state, 'ptp', [{ slug: 'app', path: checkout, base: 'main' }, { slug: 'gone', path: join(home, 'nope'), base: 'main' }, { slug: 'out', path: '/etc', base: 'main' }], home, env);
    expect(trees[0]).toMatchObject({ sha: git(origin, 'rev-parse', 'HEAD'), note: null });
    expect(existsSync(join(state, 'ptp', 'app', 'b.txt'))).toBe(true);
    expect(trees[1]).toMatchObject({ sha: null, note: expect.stringMatching(/^Not available/), checkout: null });
    expect(trees[2]).toMatchObject({ sha: null, note: expect.stringMatching(/not a folder inside/), checkout: null });
  });

  it('stops at once when the start is cancelled: the hanging fetch is killed and the repositories left are skipped', async () => {
    git(join(home, 'work'), 'clone', '-q', origin, 'hangs');
    git(join(home, 'work', 'hangs'), 'remote', 'set-url', 'origin', 'ssh://example.invalid/r');
    const cancel = new AbortController();
    setTimeout(() => cancel.abort(), 300);
    const t0 = Date.now();
    const repos = [{ slug: 'hangs', path: join(home, 'work', 'hangs'), base: 'main' }, { slug: 'app', path: checkout, base: 'main' }];
    const { trees } = await prepareWorktrees(join(home, 'cancelled'), 'ptp', repos, home, { ...env, GIT_SSH_COMMAND: 'sleep 30;:' }, cancel.signal);
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(trees.map((t) => [t.slug, t.sha, t.checkout])).toEqual([['hangs', null, join(home, 'work', 'hangs')]]);
  });

  it('is never removed by the job worktree reaper', async () => {
    await expect(reapWorktree(join(state, 'ptp', 'app'), home, env)).rejects.toThrow(/initiative worktree/);
    expect(existsSync(join(state, 'ptp', 'app', 'a.txt'))).toBe(true);
  });

  it('is never removed by the reaper in the folder ORCH_INITIATIVES_DIR names either, reached through a link', async () => {
    const elsewhere = join(home, 'elsewhere');
    await prepareWorktrees(elsewhere, 'ptp', [{ slug: 'app', path: checkout, base: 'main' }], home, env);
    symlinkSync(elsewhere, join(home, 'via-link'));
    const before = process.env.ORCH_INITIATIVES_DIR;
    process.env.ORCH_INITIATIVES_DIR = join(home, 'via-link');
    try {
      await expect(reapWorktree(join(elsewhere, 'ptp', 'app'), home, env)).rejects.toThrow(/initiative worktree/);
    } finally {
      if (before === undefined) delete process.env.ORCH_INITIATIVES_DIR;
      else process.env.ORCH_INITIATIVES_DIR = before;
    }
    expect(existsSync(join(elsewhere, 'ptp', 'app', 'a.txt'))).toBe(true);
  });
});
