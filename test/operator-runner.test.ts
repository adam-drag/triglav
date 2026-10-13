import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
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
    new Promise<{ url: string; tokens: string[]; posts: string[] }>((done) => {
      const tokens: string[] = [];
      const posts: string[] = [];
      const s = createServer((req, res) => {
        req.resume();
        req.on('end', () => {
          posts.push(req.url!);
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
      s.listen(0, '127.0.0.1', () => done({ url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, tokens, posts }));
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
    } finally {
      if (saved === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = saved;
    }
  });
});
