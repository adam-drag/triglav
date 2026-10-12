import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loopbackBase } from '../scripts/loopback.ts';
import { OperatorChats } from '../scripts/operator.ts';

const REPO = resolve(import.meta.dirname, '..');
const RUNNER_KEY = 'runner-key-for-this-test-000000';
const SECRETS = { ORCH_ENROLLMENT_KEY: 'enrollment-secret-value-00000000', ORCH_CLIENT_PASSWORD_HASH: 'scrypt:hash', MYSQL_ROOT_PASSWORD: 'mysql-secret', MYSQL_PASSWORD: 'mysql-secret-2', DATABASE_URL: 'mysql://u:p@h/d', LINEAR_API_KEY: 'lin_api_secret' };

describe('ORCH_URL must be an http loopback URL', () => {
  it('accepts localhost, 127.0.0.1 and [::1] over http, with or without a port', () => {
    expect(loopbackBase('http://127.0.0.1:7400')).toBe('http://127.0.0.1:7400');
    expect(loopbackBase('http://localhost:7401/')).toBe('http://localhost:7401');
    expect(loopbackBase('http://localhost')).toBe('http://localhost');
    expect(loopbackBase('http://[::1]:7400')).toBe('http://[::1]:7400');
  });

  it('refuses other hosts, https, credentials, look-alike hosts and non-URLs', () => {
    for (const bad of ['http://evil.example:7400', 'https://127.0.0.1:7400', 'http://127.0.0.1.evil.example', 'http://localhost.evil.example', 'http://127.0.0.1:80@evil.example', 'http://user:pw@127.0.0.1:7400', 'http://0.0.0.0:7400', 'http://192.168.1.5:7400', 'ftp://127.0.0.1', 'localhost:7400', '', 'not a url']) {
      expect(() => loopbackBase(bad), bad).toThrow(/ORCH_URL/);
    }
  });

  it('is applied by the Operator side of the runner too', () => {
    const o = { bin: 'claude', key: 'k', cwd: '/', logs: '/', model: 'm', effort: 'low' };
    expect(() => new OperatorChats({ ...o, base: 'http://evil.example' })).toThrow(/ORCH_URL/);
    expect(() => new OperatorChats({ ...o, base: 'http://127.0.0.1:7400' })).not.toThrow();
  });
});

describe('the host runner', () => {
  let runner: ChildProcess | undefined;
  const servers: Server[] = [];
  afterEach(() => {
    runner?.kill();
    runner = undefined;
    for (const s of servers.splice(0)) s.close();
  });

  const listen = (handler: (req: IncomingMessage, body: string, res: import('node:http').ServerResponse) => void) =>
    new Promise<{ url: string }>((done) => {
      const s = createServer((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => handler(req, body, res));
      });
      servers.push(s);
      s.listen(0, '127.0.0.1', () => done({ url: `http://127.0.0.1:${(s.address() as AddressInfo).port}` }));
    });

  it('refuses to start when ORCH_URL is not an http loopback URL, before it sends the key anywhere', () => {
    for (const url of ['http://evil.example:7400', 'https://127.0.0.1:7400', 'http://127.0.0.1:80@evil.example']) {
      const r = spawnSync('node', ['scripts/runner.ts'], { cwd: REPO, env: { PATH: process.env.PATH!, ORCH_URL: url, ORCH_RUNNER_KEY: RUNNER_KEY }, encoding: 'utf8', timeout: 20_000 });
      expect(r.status, url).toBe(1);
      expect(r.stderr).toMatch(/ORCH_URL must be an http URL to localhost/);
    }
  });

  it('does not use the enrollment key as its key', () => {
    const r = spawnSync('node', ['scripts/runner.ts'], { cwd: REPO, env: { PATH: process.env.PATH!, HOME: mkdtempSync(join(tmpdir(), 'home-')), ORCH_URL: 'http://127.0.0.1:1', ORCH_ENROLLMENT_KEY: 'enrollment-key-0000000000000000' }, encoding: 'utf8', timeout: 20_000 });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/ORCH_RUNNER_KEY is not set/);
  });

  it('does not follow a redirect, so the key never reaches another host', async () => {
    const other: string[] = [];
    const b = await listen((req, _body, res) => {
      other.push(`${req.method} ${req.url} auth=${req.headers.authorization ?? ''}`);
      res.end('{}');
    });
    let hits = 0;
    const a = await listen((_req, _body, res) => {
      hits++;
      res.writeHead(307, { location: `${b.url}/stolen` }).end();
    });
    const home = mkdtempSync(join(tmpdir(), 'home-'));
    const log: string[] = [];
    runner = spawn('node', ['scripts/runner.ts'], { cwd: REPO, env: { PATH: process.env.PATH!, HOME: home, ORCH_URL: a.url, ORCH_RUNNER_KEY: RUNNER_KEY, ORCH_RUNNER_POLL_MS: '100' }, stdio: ['ignore', 'pipe', 'pipe'] });
    runner.stderr!.on('data', (d) => log.push(String(d)));
    runner.stdout!.on('data', (d) => log.push(String(d)));
    const deadline = Date.now() + 10_000;
    while (hits < 3 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 300));
    // The runner asked, got the redirect, treated it as an error and went on polling; nothing reached the other host.
    expect(hits).toBeGreaterThanOrEqual(3);
    expect(log.join('')).toMatch(/fetch failed/);
    expect(other).toEqual([]);
  });

  it('starts research runs, resumes, Staff starts and the Operator without the orchestrator keys in their environment', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'home-')));
    const repo = join(home, 'repo');
    mkdirSync(repo);
    const bins = mkdtempSync(join(tmpdir(), 'bins-'));
    const dumps = mkdtempSync(join(tmpdir(), 'dumps-'));
    // A stand-in for both CLIs: it records its arguments and its environment, and exits.
    const fake = `#!/bin/sh\nif [ "$1" = agents ]; then echo '[]'; exit 0; fi\n{ echo "ARGS: $*"; env; } > "$DUMP_DIR/$(basename "$0")-$$.txt"\n[ "$(basename "$0")" = claude ] && [ "$1" = --bg ] && echo started\nexit 0\n`;
    for (const name of ['claude', 'codex']) {
      writeFileSync(join(bins, name), fake);
      chmodSync(join(bins, name), 0o755);
    }
    const session = '1b85d8aa-ea20-41ef-baa6-1de0d08eb630';
    const launches = [
      { id: 'lch_0000000000000001', kind: 'resume', runtime: 'claude-code', session_id: session, cwd: repo, prompt: 'go on' },
      { id: 'lch_0000000000000002', kind: 'research_run', runtime: 'claude-code', model: 'claude-opus-5-5', effort: 'high', cwd: repo, prompt: 'research' },
      { id: 'lch_0000000000000003', kind: 'research_run', runtime: 'codex', model: 'gpt-6.1-sol', effort: 'high', cwd: repo, prompt: 'research' },
      { id: 'lch_0000000000000004', kind: 'resume', runtime: 'codex', session_id: session, cwd: repo, prompt: 'go on' },
      { id: 'lch_0000000000000005', kind: 'staff_start', runtime: 'claude-code', request_id: 'req_0123456789abcdef', model: 'claude-opus-5-5', effort: 'high', cwd: repo },
    ];
    let chatSent = false;
    const calls: { path: string; auth: string }[] = [];
    const orch = await listen((req, _body, res) => {
      calls.push({ path: req.url!, auth: String(req.headers.authorization) });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/runner/next') return void res.end(JSON.stringify({ launch: launches.shift() ?? null }));
      if (req.url === '/api/runner/chat/next') {
        if (chatSent) return void setTimeout(() => res.end(JSON.stringify({ command: null })), 500);
        chatSent = true;
        return void res.end(JSON.stringify({ command: { kind: 'send', chat_id: 'cht_0123456789abcdef', text: 'hello', token: `orch_chat_${'a'.repeat(32)}`, session_id: null } }));
      }
      res.end('{}');
    });
    runner = spawn('node', ['scripts/runner.ts'], {
      cwd: REPO,
      env: { PATH: `${bins}:${process.env.PATH}`, HOME: home, DUMP_DIR: dumps, ANTHROPIC_API_KEY: 'keep-me', ORCH_URL: orch.url, ORCH_RUNNER_KEY: RUNNER_KEY, ORCH_RUNNER_POLL_MS: '100', ...SECRETS },
      stdio: 'ignore',
    });
    const wanted = ['--bg --settings', '-p --model', 'exec --skip-git-repo-check -s read-only', 'exec resume', '--bg -n staff-req_0123456789abcdef', '-p --input-format stream-json'];
    const read = () => readdirSync(dumps).map((f) => readFileSync(join(dumps, f), 'utf8'));
    const deadline = Date.now() + 20_000;
    while (!wanted.every((w) => read().some((d) => d.startsWith(`ARGS: ${w}`))) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
    const all = read();
    for (const w of wanted) expect(all.some((d) => d.startsWith(`ARGS: ${w}`)), `a process started with ${w}`).toBe(true);
    for (const dump of all) {
      const env = dump.split('\n').slice(1).map((l) => l.split('=')[0]!);
      for (const name of env) expect(name, dump.split('\n')[0]).not.toMatch(/^(ORCH_|MYSQL_)|^(DATABASE_URL|LINEAR_API_KEY)$/);
      expect(dump).not.toContain('enrollment-secret-value');
      expect(dump).not.toContain(RUNNER_KEY);
      expect(dump).toContain('ANTHROPIC_API_KEY=keep-me');
    }
    // Everything the runner sent to Triglav carried the runner key.
    expect(calls.length).toBeGreaterThan(5);
    for (const c of calls) expect(c.auth, c.path).toBe(`Bearer ${RUNNER_KEY}`);
  }, 40_000);
});

describe('the hooks send nothing unless ORCH_URL is a loopback URL', () => {
  // A fake curl records every call, so nothing leaves the machine.
  function setup() {
    const dir = mkdtempSync(join(tmpdir(), 'hook-'));
    const log = join(dir, 'curl.log');
    writeFileSync(join(dir, 'curl'), `#!/bin/sh\necho "$*" >> "${log}"\nprintf '{"open_work":"You own an open job."}'\n`);
    chmodSync(join(dir, 'curl'), 0o755);
    const transcript = join(dir, 'transcript.jsonl');
    writeFileSync(transcript, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__orchestrator__get_job', input: { session_token: 'orch_tok_aaaaaaaaaaaaaaaaaaaaaaaa' } }] } }) + '\n');
    const run = (script: string, input: string, url: string | undefined) => {
      const env: Record<string, string> = { PATH: `${dir}:${process.env.PATH}` };
      if (url !== undefined) env.ORCH_URL = url;
      return spawnSync('bash', [join(REPO, 'scripts', script)], { input, env, encoding: 'utf8', timeout: 10_000 });
    };
    const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []);
    return { run, calls, transcript };
  }
  const bad = ['http://evil.example:7400', 'https://127.0.0.1:7400', 'http://127.0.0.1:80@evil.example', 'http://localhost.evil.example', 'http://127.0.0.1.evil.example', 'http://user:pw@localhost:7400', 'http://10.0.0.5:7400', 'file:///etc/passwd', 'http://[::1]x@evil.example', ''];
  const good = ['http://127.0.0.1:7400', 'http://localhost:7401', 'http://[::1]:7400', undefined];

  it('stop-hook.sh posts the session token only to a loopback URL', () => {
    const { run, calls, transcript } = setup();
    const input = JSON.stringify({ transcript_path: transcript });
    for (const url of bad) {
      const r = run('stop-hook.sh', input, url);
      expect(r.status, url).toBe(0);
      expect(r.stdout, url).toBe('');
    }
    expect(calls()).toEqual([]);
    for (const url of good) {
      const r = run('stop-hook.sh', input, url);
      expect(r.stdout, String(url)).toContain('"decision"');
    }
    expect(calls()).toHaveLength(good.length);
    expect(calls().every((c) => /--proto =http/.test(c) && /--max-redirs 0/.test(c) && /http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\/api\/hooks\/stop/.test(c))).toBe(true);
  });

  it('claude-statusline.sh reports plan usage only to a loopback URL, and still prints the status line', async () => {
    const { run, calls } = setup();
    const input = JSON.stringify({ rate_limits: { five_hour: { used_percentage: 12, resets_at: 1 } }, workspace: { current_dir: '/home/me/repo' } });
    for (const url of bad) {
      const r = run('claude-statusline.sh', input, url);
      expect(r.stdout, url).toContain('repo');
    }
    await new Promise((r) => setTimeout(r, 300));
    expect(calls()).toEqual([]);
    for (const url of good) expect(run('claude-statusline.sh', input, url).stdout).toContain('repo');
    await new Promise((r) => setTimeout(r, 500));
    expect(calls()).toHaveLength(good.length);
    expect(calls().every((c) => /--proto =http/.test(c) && /--max-redirs 0/.test(c))).toBe(true);
  });
});
