import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { HOST_MCP_SCRIPT, operatorArgs, operatorMcpConfig, OperatorChats, OPERATOR_TOOLS, translate } from '../scripts/operator.ts';
import { cleanStalePrivateDirs, PRIVATE_DIR_PREFIX, removeAllPrivateFiles, writePrivateFile } from '../scripts/private-file.ts';

const TOKEN = 'orch_chat_' + 'a'.repeat(32);
const MCP_URL = 'http://127.0.0.1:7400/operator/mcp';
const base = { model: 'claude-sonnet-5-5', effort: 'medium', sessionId: null, mcpConfigPath: '/tmp/triglav-x/operator-mcp.json', logs: '/home/me/.local/state/triglav' };

describe('the Operator command the runner builds', () => {
  it('can read but never write: denies what it was not allowed, and sees only its own MCP server', () => {
    const args = operatorArgs(base);
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('dontAsk');
    expect(args).toContain('--strict-mcp-config');
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(args).not.toContain('--allow-dangerously-skip-permissions');
    const allowed = args[args.indexOf('--allowedTools') + 1]!.split(',');
    expect(allowed).toEqual(OPERATOR_TOOLS);
    for (const tool of allowed) expect(tool).not.toMatch(/^(Write|Edit|NotebookEdit)\b/);
    // No Bash at all: a prefix rule such as `git log:*` still lets `--output=FILE` write. The built-in tools are limited as well.
    for (const tool of allowed) expect(tool).not.toMatch(/^Bash/);
    expect(args[args.indexOf('--tools') + 1]).toBe('Read,Grep,Glob');
    // The config is a file: the argument is its path, and the token is not in any argument.
    expect(args[args.indexOf('--mcp-config') + 1]).toBe(base.mcpConfigPath);
    expect(JSON.stringify(args)).not.toContain(TOKEN);
    const mcp = JSON.parse(operatorMcpConfig({ mcpUrl: MCP_URL, token: TOKEN }));
    expect(mcp.mcpServers.triglav).toEqual({ type: 'http', url: MCP_URL, headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(mcp.mcpServers.host).toEqual({ type: 'stdio', command: process.execPath, args: [HOST_MCP_SCRIPT] });
    expect(existsSync(HOST_MCP_SCRIPT)).toBe(true);
    expect(Object.keys(mcp.mcpServers)).toEqual(['triglav', 'host']);
  });

  it('resumes the conversation of a chat that had a process before', () => {
    const session = '1b85d8aa-ea20-41ef-baa6-1de0d08eb630';
    const args = operatorArgs({ ...base, sessionId: session });
    expect(args.slice(-2)).toEqual(['--resume', session]);
    expect(operatorArgs(base)).not.toContain('--resume');
  });

  it('refuses a value that could be read as an option or that does not look right', () => {
    expect(() => operatorArgs({ ...base, model: '--dangerously-skip-permissions' })).toThrow(/bad model/);
    expect(() => operatorArgs({ ...base, effort: 'enormous' })).toThrow(/bad effort/);
    expect(() => operatorMcpConfig({ mcpUrl: MCP_URL, token: 'Bearer x' })).toThrow(/bad chat token/);
    expect(() => operatorArgs({ ...base, sessionId: '--resume' })).toThrow(/bad session/);
  });
});

describe('what the Claude stream means for the dashboard', () => {
  it('reports the session, streamed text and the final reply', () => {
    expect(translate({ type: 'system', subtype: 'init', session_id: 's1' })).toEqual([{ type: 'session', session_id: 's1' }]);
    expect(translate({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } } })).toEqual([{ type: 'delta', text: 'Hel' }]);
    expect(translate({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hmm' } } })).toEqual([]);
    expect(translate({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }] } })).toEqual([{ type: 'message', role: 'operator', text: 'Hello' }]);
    expect(translate({ type: 'assistant', message: { content: [{ type: 'text', text: '  ' }] } })).toEqual([]);
  });

  it('shows what the Operator looked at, without the tool name noise', () => {
    const events = translate({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'mcp__triglav__list_agents', input: {} },
          { type: 'tool_use', name: 'Read', input: { file_path: '/home/me/.local/state/triglav/runner.log' } },
          { type: 'tool_use', name: 'mcp__host__compose_logs', input: { service: 'orchestrator', tail: 50 } },
        ],
      },
    });
    expect(events.map((e: any) => e.text)).toEqual(['list_agents', 'Read /home/me/.local/state/triglav/runner.log', 'compose_logs {"service":"orchestrator","tail":50}']);
  });

  it('marks the end of a reply, with its error if it failed', () => {
    expect(translate({ type: 'result', subtype: 'success', is_error: false })).toEqual([{ type: 'turn_end', error: null }]);
    expect(translate({ type: 'result', subtype: 'error', is_error: true, result: 'usage limit reached' })).toEqual([{ type: 'turn_end', error: 'usage limit reached' }]);
  });

  it('turns the plan usage in the stream into percentages and ignores what it cannot read', () => {
    const e = translate({ type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.22, resetsAt: 1791716400 }, seven_day: { utilization: 0.33, resetsAt: 1792126800 }, junk: {} } } });
    expect(e).toHaveLength(1);
    const usage: any = e[0];
    expect(usage.windows.map((w: any) => [w.window, Math.round(w.used), w.resets_at])).toEqual([
      ['five_hour', 22, 1791716400],
      ['seven_day', 33, 1792126800],
    ]);
    expect(translate({ type: 'rate_limit_event', rate_limit_info: {} })).toEqual([]);
    expect(translate({ type: 'unknown' })).toEqual([]);
    expect(translate(null)).toEqual([]);
  });
});


describe('a file that holds a credential', () => {
  it('is created with mode 0600 in a private directory and removed on request, twice without error', () => {
    const f = writePrivateFile('x.json', '{"secret":1}');
    expect(statSync(f.path).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(f.path)).mode & 0o777).toBe(0o700);
    expect(readFileSync(f.path, 'utf8')).toBe('{"secret":1}');
    f.remove();
    expect(existsSync(f.path)).toBe(false);
    expect(existsSync(dirname(f.path))).toBe(false);
    expect(() => f.remove()).not.toThrow();
  });
});

describe('private files that outlive their process', () => {
  it('removeAllPrivateFiles removes every file that is still there', () => {
    const a = writePrivateFile('a.json', 'a');
    const b = writePrivateFile('b.json', 'b');
    removeAllPrivateFiles();
    expect(existsSync(a.path)).toBe(false);
    expect(existsSync(b.path)).toBe(false);
  });

  it('cleanStalePrivateDirs removes old directories of ours and leaves fresh ones and other names alone', () => {
    const root = mkdtempSync(join(tmpdir(), 'sweep-'));
    const mk = (name: string, ageMs: number) => {
      const dir = join(root, name);
      mkdirSync(dir);
      writeFileSync(join(dir, 'x.json'), 'secret');
      const t = new Date(Date.now() - ageMs);
      utimesSync(dir, t, t);
      return dir;
    };
    const old = mk(`${PRIVATE_DIR_PREFIX}old111`, 2 * 3600_000);
    const fresh = mk(`${PRIVATE_DIR_PREFIX}new111`, 60_000);
    const other = mk('not-ours-old', 2 * 3600_000);
    expect(cleanStalePrivateDirs(3600_000, root)).toBe(1);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(other)).toBe(true);
  });
});

describe('the Operator process the runner starts', () => {
  const servers: Server[] = [];
  afterEach(() => {
    for (const s of servers.splice(0)) s.close();
  });

  /** A Triglav stand-in that hands out one token per request and records what the runner posted. */
  const fakeTriglav = (tokenDelayMs = 0) =>
    new Promise<{ url: string; tokens: string[]; posts: string[]; bodies: string[] }>((done) => {
      const tokens: string[] = [];
      const posts: string[] = [];
      const bodies: string[] = [];
      const s = createServer((req, res) => {
        let body = '';
        req.on('data', (d) => (body += d));
        req.on('end', () => {
          posts.push(req.url!);
          bodies.push(body);
          res.setHeader('content-type', 'application/json');
          if (/^\/api\/runner\/chat\/cht_[0-9a-f]{16}\/token$/.test(req.url!)) {
            const t = `orch_chat_${String(tokens.length).padStart(2, '0')}${'b'.repeat(30)}`;
            tokens.push(t);
            return void setTimeout(() => res.end(JSON.stringify({ token: t })), tokenDelayMs);
          }
          res.end('{}');
        });
      });
      servers.push(s);
      s.listen(0, '127.0.0.1', () => done({ url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, tokens, posts, bodies }));
    });

  /** A stand-in for `claude`: it records its arguments and the MCP config file as it sees it, then waits for input. */
  function fakeClaude() {
    const dir = mkdtempSync(join(tmpdir(), 'fake-claude-'));
    const dump = join(dir, 'dump.jsonl');
    const bin = join(dir, 'claude');
    writeFileSync(
      bin,
      `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const path = args[args.indexOf('--mcp-config') + 1];
fs.appendFileSync(${JSON.stringify(dump)}, JSON.stringify({ pid: process.pid, args, path, mode: (fs.statSync(path).mode & 0o777).toString(8), content: fs.readFileSync(path, 'utf8'), env: Object.keys(process.env) }) + '\\n');
process.stdin.on('data', (d) => fs.appendFileSync(${JSON.stringify(dump + '.in')}, JSON.stringify({ pid: process.pid, text: String(d) }) + '\\n'));
process.stdin.resume();
`,
    );
    chmodSync(bin, 0o755);
    const runs = () => (existsSync(dump) ? readFileSync(dump, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { pid: number; args: string[]; path: string; mode: string; content: string }) : []);
    const received = () => (existsSync(dump + '.in') ? readFileSync(dump + '.in', 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { pid: number; text: string }) : []);
    return { bin, runs, received };
  }

  const until = async (cond: () => boolean) => {
    for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 50));
    expect(cond()).toBe(true);
  };

  const CHAT = 'cht_0123456789abcdef';
  const send = (text: string) => ({ kind: 'send', chat_id: CHAT, text, session_id: null });

  it('runs a confirmed mark_pr_ready as gh pr ready with a fixed argv, and refuses one whose repository or number does not check out', async () => {
    const triglav = await fakeTriglav();
    const dir = mkdtempSync(join(tmpdir(), 'fake-gh-'));
    const dump = join(dir, 'argv.jsonl');
    const gh = join(dir, 'gh');
    writeFileSync(gh, `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(dump)}, JSON.stringify(process.argv.slice(2)) + '\\n');\nconsole.log('Pull request owner/app#12 is marked as ready for review');\n`);
    chmodSync(gh, 0o755);
    const chats = new OperatorChats({ base: triglav.url, key: 'k', bin: '/nonexistent', gh, cwd: tmpdir(), logs: tmpdir(), model: 'claude-sonnet-5-5', effort: 'medium', log: () => {} });
    const host = (id: string, job: Record<string, string>) => chats.handle({ kind: 'host', chat_id: CHAT, text: JSON.stringify({ action_id: id, ...job }), session_id: null });
    const results = () => triglav.bodies.filter((b) => b.includes('action_result')).map((b) => JSON.parse(b).events[0] as { action_id: string; ok: boolean; text: string });
    host('act_' + 'a'.repeat(16), { action: 'mark_pr_ready', repo: 'owner/app', pr: '12' });
    await until(() => results().length === 1);
    expect(readFileSync(dump, 'utf8').trim().split('\n').map((l) => JSON.parse(l))).toEqual([['pr', 'ready', '12', '-R', 'owner/app']]);
    expect(results()[0]).toMatchObject({ action_id: 'act_' + 'a'.repeat(16), ok: true, text: expect.stringContaining('Marked owner/app#12 ready for review') });
    // A repository that is not owner/name, or a number that is not one, never reaches gh.
    host('act_' + 'b'.repeat(16), { action: 'mark_pr_ready', repo: '--repo=evil/x', pr: '12' });
    host('act_' + 'c'.repeat(16), { action: 'mark_pr_ready', repo: 'owner/app', pr: '12 --admin' });
    host('act_' + 'd'.repeat(16), { action: 'merge_pr', repo: 'owner/app', pr: '12' });
    await until(() => results().length === 4);
    expect(results().slice(1).every((r) => !r.ok)).toBe(true);
    expect(readFileSync(dump, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('never has the chat token in its arguments, keeps it in a 0600 file, and removes the file when the process ends', async () => {
    const triglav = await fakeTriglav();
    const { bin, runs } = fakeClaude();
    const chats = new OperatorChats({ base: triglav.url, key: 'k', bin, cwd: tmpdir(), logs: tmpdir(), model: 'claude-sonnet-5-5', effort: 'medium', log: () => {} });
    chats.handle(send('hello'));
    await until(() => runs().length === 1);
    const [run] = runs();
    const token = triglav.tokens[0]!;
    expect(JSON.stringify(run!.args)).not.toContain(token);
    expect(run!.args[run!.args.indexOf('--mcp-config') + 1]).toBe(run!.path);
    expect(run!.mode).toBe('600');
    expect(JSON.parse(run!.content).mcpServers.triglav.headers.Authorization).toBe(`Bearer ${token}`);
    // A second message goes to the same process: no new token, no new process.
    chats.handle(send('again'));
    await new Promise((r) => setTimeout(r, 300));
    expect(triglav.tokens).toHaveLength(1);
    expect(runs()).toHaveLength(1);
    expect(existsSync(run!.path)).toBe(true);
    // Stopping the process removes the file.
    chats.stop(CHAT);
    await until(() => !existsSync(run!.path));
    expect(existsSync(dirname(run!.path))).toBe(false);
    // The token ends with the process: the runner tells the server, with the token of that process.
    await until(() => triglav.posts.some((p, i) => p.endsWith('/token/revoke') && triglav.bodies[i]!.includes(token)));
    // The next message starts a new process with a new token and a new file.
    chats.handle(send('after the stop'));
    await until(() => runs().length === 2);
    expect(triglav.tokens).toHaveLength(2);
    expect(runs()[1]!.path).not.toBe(run!.path);
    expect(runs()[1]!.content).toContain(triglav.tokens[1]!);
    expect(runs()[1]!.content).not.toContain(token);
    chats.stop(CHAT);
    await until(() => !existsSync(runs()[1]!.path));
  });

  /** A stand-in for `claude` that ends one turn for each message it reads, as the stream-json output does. */
  function fakeTurns() {
    const dir = mkdtempSync(join(tmpdir(), 'fake-turns-'));
    const bin = join(dir, 'claude');
    writeFileSync(
      bin,
      `#!${process.execPath}
const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', () => process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false }) + '\\n'));
`,
    );
    chmodSync(bin, 0o755);
    return bin;
  }

  it('posts a replies clear at a turn end that a queued message follows, and none for a turn with nothing queued', async () => {
    const triglav = await fakeTriglav();
    const kinds = () =>
      triglav.bodies.flatMap((b) => {
        try {
          return ((JSON.parse(b) as { events?: { type: string; state?: string }[] }).events ?? []).map((e) => (e.state ? `${e.type}:${e.state}` : e.type));
        } catch {
          return [];
        }
      });
    // An Architect start needs the runner's home and initiatives folders; the repositories are empty, so no git runs.
    const chats = new OperatorChats({ base: triglav.url, key: 'k', bin: fakeTurns(), cwd: tmpdir(), logs: tmpdir(), home: tmpdir(), initiatives: tmpdir(), model: 'claude-sonnet-5-5', effort: 'medium', log: () => {} });
    // Two messages before the first turn ends: the first turn ends with the second still waiting.
    const architect = { key: 'ptp', title: 'P', model: 'claude-opus-5-5', effort: 'high', repos: [] };
    chats.handle({ ...send('first'), chat_kind: 'architect' as const, architect });
    chats.handle({ ...send('second'), chat_kind: 'architect' as const, architect });
    await until(() => kinds().includes('state:idle'));
    expect(kinds().filter((k) => k === 'replies_clear')).toHaveLength(1);
    expect(kinds().indexOf('replies_clear')).toBeLessThan(kinds().indexOf('state:idle'));
    chats.stop(CHAT);
    await until(() => triglav.posts.some((p) => p.endsWith('/token/revoke')));
  });

  it("leaves out a checkout the permission rules cannot hold, with a note, and still starts the Architect on its worktree", async () => {
    const triglav = await fakeTriglav();
    const texts = () => triglav.bodies.flatMap((b) => ((JSON.parse(b) as { events?: { text?: string }[] }).events ?? []).map((e) => e.text ?? ''));
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'arch-home-')));
    const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...a], { cwd, encoding: 'utf8' });
    const origin = join(home, 'origin');
    mkdirSync(origin);
    git(origin, 'init', '-q');
    writeFileSync(join(origin, 'a.txt'), 'a\n');
    git(origin, 'add', 'a.txt');
    git(origin, 'commit', '-qm', 'one');
    // The repository path is plain, but it resolves to a folder whose name a Read rule may not hold.
    git(home, 'clone', '-q', origin, 'caf\u00e9');
    execFileSync('ln', ['-s', join(home, 'caf\u00e9'), join(home, 'app')]);
    const argsLog = join(home, 'args.json');
    const bin = join(home, 'claude');
    writeFileSync(bin, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(argsLog)}, JSON.stringify(process.argv.slice(2)));\nrequire('node:readline').createInterface({ input: process.stdin }).on('line', () => process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false }) + '\\n'));\n`);
    chmodSync(bin, 0o755);
    const initiatives = join(home, 'initiatives');
    const chats = new OperatorChats({ base: triglav.url, key: 'k', bin, cwd: tmpdir(), logs: tmpdir(), home, initiatives, model: 'claude-sonnet-5-5', effort: 'medium', log: () => {} });
    const architect = { key: 'ptp', title: 'P', model: 'claude-opus-5-5', effort: 'high', repos: [{ slug: 'app', path: join(home, 'app'), base: 'main' }] };
    chats.handle({ ...send('hello'), chat_kind: 'architect' as const, architect });
    await until(() => existsSync(argsLog) && texts().some((t) => t.startsWith('Code for the Architect')));
    expect(texts().find((t) => t.startsWith('Code for the Architect'))).toBe(`Code for the Architect: app: The Client's checkout ${join(home, 'caf\u00e9')} cannot be read (bad checkout path)`);
    const args = JSON.parse(readFileSync(argsLog, 'utf8')) as string[];
    expect(args).toContain(`Read(/${join(initiatives, 'ptp', 'app')}/**)`);
    expect(args.join(' ')).not.toContain('caf\u00e9/**');
    chats.stop(CHAT);
    await until(() => triglav.posts.some((p) => p.endsWith('/token/revoke')));
  });

  it('posts no replies clear for a single turn, which ends with the chat idle', async () => {
    const triglav = await fakeTriglav();
    const kinds = () =>
      triglav.bodies.flatMap((b) => {
        try {
          return ((JSON.parse(b) as { events?: { type: string; state?: string }[] }).events ?? []).map((e) => (e.state ? `${e.type}:${e.state}` : e.type));
        } catch {
          return [];
        }
      });
    const chats = new OperatorChats({ base: triglav.url, key: 'k', bin: fakeTurns(), cwd: tmpdir(), logs: tmpdir(), home: tmpdir(), initiatives: tmpdir(), model: 'claude-sonnet-5-5', effort: 'medium', log: () => {} });
    // An Architect chat, so the clear could be posted: nothing queued at the turn end, so no clear.
    const architect = { key: 'ptp', title: 'P', model: 'claude-opus-5-5', effort: 'high', repos: [] };
    chats.handle({ ...send('only'), chat_kind: 'architect' as const, architect });
    await until(() => kinds().includes('state:idle'));
    expect(kinds()).not.toContain('replies_clear');
    chats.stop(CHAT);
    await until(() => triglav.posts.some((p) => p.endsWith('/token/revoke')));
  });

  it('posts no replies clear for an Operator chat, even with a message queued at a turn end', async () => {
    const triglav = await fakeTriglav();
    const kinds = () =>
      triglav.bodies.flatMap((b) => {
        try {
          return ((JSON.parse(b) as { events?: { type: string; state?: string }[] }).events ?? []).map((e) => (e.state ? `${e.type}:${e.state}` : e.type));
        } catch {
          return [];
        }
      });
    const chats = new OperatorChats({ base: triglav.url, key: 'k', bin: fakeTurns(), cwd: tmpdir(), logs: tmpdir(), model: 'claude-sonnet-5-5', effort: 'medium', log: () => {} });
    chats.handle(send('first'));
    chats.handle(send('second'));
    await until(() => kinds().includes('state:idle'));
    expect(kinds()).not.toContain('replies_clear');
    chats.stop(CHAT);
    await until(() => triglav.posts.some((p) => p.endsWith('/token/revoke')));
  });

  it('starts a new process for a message that arrives after a stop while the token is still being fetched', async () => {
    const triglav = await fakeTriglav(300);
    const { bin, runs, received } = fakeClaude();
    const chats = new OperatorChats({ base: triglav.url, key: 'k', bin, cwd: tmpdir(), logs: tmpdir(), model: 'claude-sonnet-5-5', effort: 'medium', log: () => {} });
    chats.handle(send('one'));
    chats.stop(CHAT);
    chats.handle(send('two'));
    await until(() => received().some((r) => r.text.includes('two')));
    // The first process may be killed before it logs anything. What matters is that "two" reached a process that is still alive,
    // so it was not written to the one that was being stopped, and that it arrived once.
    const got = received().filter((r) => r.text.includes('two'));
    expect(got).toHaveLength(1);
    expect(() => process.kill(got[0]!.pid, 0)).not.toThrow();
    expect(triglav.tokens).toHaveLength(2);
    chats.stop(CHAT);
    await until(() => runs().every((r) => !existsSync(r.path)));
  });

  it('cancels an Architect start on Stop: the hanging fetch ends, no token is minted, messages to it are not sent on, and the next one starts a process', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'triglav-arch-stop-')));
    const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...a], { cwd, encoding: 'utf8' });
    mkdirSync(join(home, 'origin'));
    git(join(home, 'origin'), 'init', '-q');
    writeFileSync(join(home, 'origin', 'a.txt'), 'a\n');
    git(join(home, 'origin'), 'add', 'a.txt');
    git(join(home, 'origin'), 'commit', '-qm', 'one');
    git(home, 'clone', '-q', join(home, 'origin'), 'app');
    git(join(home, 'app'), 'remote', 'set-url', 'origin', 'ssh://example.invalid/r');
    // The fetch runs this as ssh: a marker that hangs, so a process left behind is easy to find.
    const saved = { ssh: process.env.GIT_SSH_COMMAND, cfg: process.env.GIT_CONFIG_GLOBAL };
    process.env.GIT_SSH_COMMAND = 'sleep 29.37;:';
    process.env.GIT_CONFIG_GLOBAL = '/dev/null';
    try {
      const triglav = await fakeTriglav();
      const { bin, received } = fakeClaude();
      const chats = new OperatorChats({ base: triglav.url, key: 'k', bin, cwd: tmpdir(), logs: tmpdir(), model: 'claude-sonnet-5-5', effort: 'medium', log: () => {}, home, initiatives: join(home, 'initiatives') });
      const architect = { key: 'ptp', title: 'P', model: 'claude-opus-5-5', effort: 'high', repos: [{ slug: 'app', path: join(home, 'app'), base: 'main' }] };
      const msg = (text: string) => ({ ...send(text), chat_kind: 'architect' as const, architect });
      chats.handle(msg('one'));
      await until(() => execFileSync('ps', ['-eo', 'args'], { encoding: 'utf8' }).includes('sleep 29.37'));
      chats.stop(CHAT);
      // A message while the cancelled start winds down is not sent on either: the Client pressed Stop.
      chats.handle(msg('two'));
      const notices = () => triglav.bodies.filter((b) => b.includes('was stopped before it read your message')).length;
      await until(() => notices() === 2 && triglav.bodies.some((b) => b.includes('"stopped"')));
      expect(triglav.tokens).toHaveLength(0);
      // The next fetch fails at once, so the next message gets a process, with the first token.
      process.env.GIT_SSH_COMMAND = 'false;:';
      chats.handle(msg('three'));
      await until(() => received().some((r) => r.text.includes('three')));
      expect(received().filter((r) => /one|two/.test(r.text))).toHaveLength(0);
      expect(received().filter((r) => r.text.includes('three'))).toHaveLength(1);
      expect(triglav.tokens).toHaveLength(1);
      // What git started under the cancelled fetch is gone too.
      await until(() => !execFileSync('ps', ['-eo', 'args'], { encoding: 'utf8' }).includes('sleep 29.37'));
      chats.stop(CHAT);
    } finally {
      for (const [k, v] of [['GIT_SSH_COMMAND', saved.ssh], ['GIT_CONFIG_GLOBAL', saved.cfg]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it('spawns nothing for a start whose token arrives after a Stop or during shutdown, and revokes that token', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'triglav-arch-late-')));
    const triglav = await fakeTriglav(300);
    const { bin, runs } = fakeClaude();
    const chats = new OperatorChats({ base: triglav.url, key: 'k', bin, cwd: tmpdir(), logs: tmpdir(), model: 'claude-sonnet-5-5', effort: 'medium', log: () => {}, home, initiatives: join(home, 'initiatives') });
    // An Architect with no repositories asks for its token at once; the Stop comes while the token is on its way.
    chats.handle({ ...send('one'), chat_kind: 'architect' as const, architect: { key: 'ptp', title: 'P', model: 'claude-opus-5-5', effort: 'high', repos: [] } });
    await until(() => triglav.posts.some((p) => p.endsWith('/token')));
    chats.stop(CHAT);
    await until(() => triglav.posts.some((p, i) => p.endsWith('/token/revoke') && triglav.bodies[i]!.includes(triglav.tokens[0]!)));
    await until(() => triglav.bodies.some((b) => b.includes('was stopped before it read your message')));
    // An Operator start in flight when the runner shuts down: shutdown waits for it, and it ends without a process.
    const other = 'cht_fedcba9876543210';
    chats.handle({ kind: 'send', chat_id: other, text: 'two', session_id: null });
    await until(() => triglav.tokens.length === 2);
    await chats.shutdown();
    expect(triglav.posts.some((p, i) => p === `/api/runner/chat/${other}/token/revoke` && triglav.bodies[i]!.includes(triglav.tokens[1]!))).toBe(true);
    // A message after shutdown starts nothing and is answered with the same line.
    chats.handle(send('three'));
    await until(() => triglav.bodies.filter((b) => b.includes('was stopped before it read your message')).length === 3);
    await new Promise((r) => setTimeout(r, 400));
    expect(triglav.tokens).toHaveLength(2);
    expect(runs()).toHaveLength(0);
  });

  it('removes the file when the command cannot be started', async () => {
    const triglav = await fakeTriglav();
    // A temp directory of its own, so that only this test's files are counted.
    const mine = mkdtempSync(join(tmpdir(), 'own-tmp-'));
    const saved = process.env.TMPDIR;
    process.env.TMPDIR = mine;
    try {
      const chats = new OperatorChats({ base: triglav.url, key: 'k', bin: join(mine, 'no-such-claude-binary'), cwd: mine, logs: mine, model: 'claude-sonnet-5-5', effort: 'medium', log: () => {} });
      chats.handle(send('hello'));
      await until(() => triglav.posts.some((p) => p.endsWith('/events')));
      await until(() => readdirSync(mine).filter((f) => f.startsWith(PRIVATE_DIR_PREFIX)).length === 0);
      // The dead process is not kept: the dashboard is told it stopped, and the next message starts a new attempt instead of writing to it.
      await until(() => triglav.bodies.some((b) => b.includes('"stopped"')));
      expect(triglav.tokens).toHaveLength(1);
      chats.handle(send('again'));
      await until(() => triglav.tokens.length === 2);
    } finally {
      if (saved === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = saved;
    }
  });

  // Images in the Architect's message (design v4, D9): the image blocks come before the text block, in one user message.
  const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), Buffer.from('rest')]);
  const pngData = PNG.toString('base64');
  /** The stream-json user messages the fake claude read on its stdin, parsed. */
  const userMessages = (received: () => { text: string }[]) =>
    received()
      .map((r) => r.text)
      .join('')
      .split('\n')
      .filter((l) => l.includes('"type":"user"'))
      .map((l) => JSON.parse(l) as { message: { content: Record<string, unknown>[] } });

  it('writes the images as image blocks before the text block of the same user message, and no text block when the text is empty', async () => {
    const triglav = await fakeTriglav();
    const { bin, runs, received } = fakeClaude();
    const chats = new OperatorChats({ base: triglav.url, key: 'k', bin, cwd: tmpdir(), logs: tmpdir(), model: 'claude-sonnet-5-5', effort: 'medium', log: () => {} });
    const image = { media_type: 'image/png' as const, data: pngData };
    chats.handle({ ...send('what is wrong here?'), images: [image, image] });
    await until(() => runs().length === 1 && userMessages(received).length === 1);
    const [message] = userMessages(received);
    expect(message!.message.content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: pngData } },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: pngData } },
      { type: 'text', text: 'what is wrong here?' },
    ]);
    chats.handle({ ...send(''), images: [image] });
    await until(() => userMessages(received).length === 2);
    expect(userMessages(received)[1]!.message.content).toEqual([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: pngData } }]);
    chats.stop(CHAT);
  });

  it('refuses images that are not valid, tells the room why without the data, and starts no process', async () => {
    const triglav = await fakeTriglav();
    const { bin, runs } = fakeClaude();
    const logged: string[] = [];
    const chats = new OperatorChats({ base: triglav.url, key: 'k', bin, cwd: tmpdir(), logs: tmpdir(), model: 'claude-sonnet-5-5', effort: 'medium', log: (...a: unknown[]) => logged.push(a.map(String).join(' ')) });
    // One byte over 5 MB, and a text that is not a picture: both refused, each with its own reason.
    const big = Buffer.alloc(5 * 1024 * 1024 + 1, 0x41).toString('base64');
    chats.handle({ ...send('look'), images: [{ media_type: 'image/png', data: big }] });
    chats.handle({ ...send('look'), images: [{ media_type: 'image/png', data: Buffer.from('<html>').toString('base64') }] });
    await until(() => triglav.bodies.filter((b) => b.includes('did not get your message')).length === 2);
    await new Promise((r) => setTimeout(r, 100));
    expect(runs()).toHaveLength(0);
    const posted = triglav.bodies.join('\n');
    expect(posted).toContain('Each image is at most 5 MB.');
    expect(posted).toContain('Only png, jpeg, webp and gif images can be sent.');
    // Neither the posted events nor the runner's log holds the data of the image.
    expect(posted).not.toContain(big.slice(0, 64));
    expect(logged.join('\n')).not.toContain(big.slice(0, 64));
  });
});
