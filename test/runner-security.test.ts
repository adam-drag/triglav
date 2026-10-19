import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, utimesSync, writeFileSync } from 'node:fs';
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
    // An empty ORCH_RUNNER_KEY keeps the runner from reading the key of a real .env in this checkout.
    const r = spawnSync('node', ['scripts/runner.ts'], { cwd: REPO, env: { PATH: process.env.PATH!, HOME: mkdtempSync(join(tmpdir(), 'home-')), ORCH_URL: 'http://127.0.0.1:1', ORCH_RUNNER_KEY: '', ORCH_ENROLLMENT_KEY: 'enrollment-key-0000000000000000' }, encoding: 'utf8', timeout: 20_000 });
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
    expect(log.join('')).toMatch(/redirect refused/);
    expect(other).toEqual([]);
  });

  it('starts research runs, resumes, Staff starts and the Operator without the orchestrator keys in their environment', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'home-')));
    const repo = join(home, 'repo');
    mkdirSync(repo);
    const bins = mkdtempSync(join(tmpdir(), 'bins-'));
    const dumps = mkdtempSync(join(tmpdir(), 'dumps-'));
    const cfgs = mkdtempSync(join(tmpdir(), 'cfgs-'));
    // A stand-in for both CLIs: it records its arguments and its environment, and exits.
    // `codex mcp list --json` answers with three servers; the config file of a Claude research run is copied to CFG_DIR (it is removed when the run exits).
    const fake = `#!/bin/sh\nif [ "$1" = agents ]; then echo '[]'; exit 0; fi\nif [ "$1" = mcp ]; then printf '[{"name":"orchestrator","enabled":true,"transport":{"type":"streamable_http","url":"http://localhost:%s/mcp"}},{"name":"linear-server","enabled":true},{"name":"off","enabled":false}]' "$FAKE_MCP_PORT"; exit 0; fi\nif [ "$1" = -p ] && [ "$2" = --model ]; then prev=; for a in "$@"; do if [ "$prev" = --mcp-config ]; then cp "$a" "$CFG_DIR/research-mcp.json"; stat -c %a "$a" > "$CFG_DIR/research-mcp.mode"; echo "$a" > "$CFG_DIR/research-mcp.path"; fi; prev=$a; done; fi\n{ echo "ARGS: $*"; env; } > "$DUMP_DIR/$(basename "$0")-$$.txt"\n[ "$(basename "$0")" = claude ] && [ "$1" = --bg ] && echo started\nexit 0\n`;
    for (const name of ['claude', 'codex']) {
      writeFileSync(join(bins, name), fake);
      chmodSync(join(bins, name), 0o755);
    }
    const session = '1b85d8aa-ea20-41ef-baa6-1de0d08eb630';
    const launches = [
      { id: 'lch_0000000000000001', kind: 'resume', runtime: 'claude-code', session_id: session, cwd: repo, prompt: 'go on' },
      { id: 'lch_0000000000000002', kind: 'research_run', runtime: 'claude-code', model: 'claude-opus-5-5', effort: 'high', cwd: repo, prompt: 'research' },
      { id: 'lch_0000000000000003', kind: 'research_run', runtime: 'codex', model: 'gpt-6.1-sol', effort: 'high', cwd: repo, prompt: 'research' },
      { id: 'lch_0000000000000004', kind: 'resume', role: 'staff', runtime: 'codex', session_id: session, cwd: repo, prompt: 'go on' },
      { id: 'lch_0000000000000005', kind: 'staff_start', runtime: 'claude-code', request_id: 'req_0123456789abcdef', model: 'claude-opus-5-5', effort: 'high', cwd: repo },
    ];
    let chatSent = false;
    const calls: { path: string; auth: string }[] = [];
    const orch = await listen((req, _body, res) => {
      calls.push({ path: req.url!, auth: String(req.headers.authorization) });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/runner/next') return void res.end(JSON.stringify({ launch: launches.shift() ?? null }));
      if (/^\/api\/runner\/chat\/cht_[0-9a-f]{16}\/token$/.test(req.url!)) return void res.end(JSON.stringify({ token: `orch_chat_${'c'.repeat(32)}` }));
      if (req.url === '/api/runner/chat/next') {
        if (chatSent) return void setTimeout(() => res.end(JSON.stringify({ command: null })), 500);
        chatSent = true;
        return void res.end(JSON.stringify({ command: { kind: 'send', chat_id: 'cht_0123456789abcdef', text: 'hello', session_id: null } }));
      }
      res.end('{}');
    });
    runner = spawn('node', ['scripts/runner.ts'], {
      cwd: REPO,
      env: { PATH: `${bins}:${process.env.PATH}`, HOME: home, DUMP_DIR: dumps, CFG_DIR: cfgs, FAKE_MCP_PORT: new URL(orch.url).port, ANTHROPIC_API_KEY: 'keep-me', GITHUB_TOKEN: 'gh-token-value', ORCH_URL: orch.url, ORCH_RUNNER_KEY: RUNNER_KEY, ORCH_RUNNER_POLL_MS: '100', ...SECRETS },
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
      // The GitHub token reaches the child through its environment (Codex narrows it again), never through its arguments.
      expect(dump.split('\n')[0]).not.toContain('gh-token-value');
    }
    // A Claude research run has no Bash, Edit or Write, loads no MCP server of the repository or the user, and connects with a config file
    // that only this user can read, which is gone once the run has exited. The key is in that file and nowhere else.
    const research = all.find((d) => d.startsWith('ARGS: -p --model'))!;
    const researchArgs = research.split('\n')[0]!;
    expect(researchArgs).toContain('--tools Read,Grep,Glob');
    expect(researchArgs).toContain('--strict-mcp-config');
    expect(researchArgs).not.toMatch(/Bash|Edit|Write/);
    expect(researchArgs).not.toContain('enrollment-secret-value');
    expect(JSON.parse(readFileSync(join(cfgs, 'research-mcp.json'), 'utf8'))).toEqual({ mcpServers: { orchestrator: { type: 'http', url: `${orch.url}/mcp`, headers: { Authorization: `Bearer ${SECRETS.ORCH_ENROLLMENT_KEY}` } } } });
    expect(readFileSync(join(cfgs, 'research-mcp.mode'), 'utf8').trim()).toBe('600');
    const cfgPath = readFileSync(join(cfgs, 'research-mcp.path'), 'utf8').trim();
    const gone = Date.now() + 5000;
    while (existsSync(cfgPath) && Date.now() < gone) await new Promise((r) => setTimeout(r, 100));
    expect(existsSync(cfgPath), 'the research config file is removed when the run exits').toBe(false);
    // A Codex research run keeps every MCP server but the orchestrator off, because `-s read-only` does not stop MCP tools.
    const codexResearch = all.find((d) => d.startsWith('ARGS: exec --skip-git-repo-check -s read-only'))!.split('\n')[0]!;
    expect(codexResearch).toContain('-c mcp_servers.linear-server.enabled=false');
    expect(codexResearch).not.toContain('mcp_servers.orchestrator');
    expect(codexResearch).not.toContain('mcp_servers.off');
    // A Codex Staff resume gets the Staff settings of src/codex-args.ts (the role came from the launch), and no sandbox flag.
    const staffResume = all.find((d) => d.startsWith('ARGS: exec resume'))!.split('\n')[0]!;
    expect(staffResume).toContain('-c approvals_reviewer="auto_review" -c approval_policy="on-request" -c sandbox_mode="workspace-write"');
    expect(staffResume).toContain('shell_environment_policy.include_only=["PATH"');
    expect(staffResume).not.toContain('read-only');
    // Everything the runner sent to Triglav carried the runner key.
    expect(calls.length).toBeGreaterThan(5);
    for (const c of calls) expect(c.auth, c.path).toBe(`Bearer ${RUNNER_KEY}`);
  }, 40_000);

  it('reaps every live fork of an abandoned session\'s lineage, not just its exact id, and is idempotent once none are left', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'home-')));
    const repo = join(home, 'repo');
    mkdirSync(repo);
    const bins = mkdtempSync(join(tmpdir(), 'bins-'));
    const dumps = mkdtempSync(join(tmpdir(), 'dumps-'));
    const projectDir = join(home, '.claude', 'projects', repo.replace(/[^A-Za-z0-9-]/g, '-'));
    mkdirSync(projectDir, { recursive: true });
    const transcript = (id: string, lineage: string) => writeFileSync(join(projectDir, `${id}.jsonl`), `${JSON.stringify({ type: 'user', uuid: lineage })}\n`);
    const session = '2c6f8f1a-5d3b-4e29-9a6f-7b6a1c2d3e4f'; // the id the scheduler recorded
    const fork = '3c6f8f1a-5d3b-4e29-9a6f-7b6a1c2d3e4f'; // continued under a new id after a usage limit
    const otherSession = '9999999a-5d3b-4e29-9a6f-7b6a1c2d3e4f'; // its own lineage, genuinely gone (no live fork of it)
    transcript(session, 'lineage-1');
    transcript(fork, 'lineage-1');
    transcript(otherSession, 'lineage-2');
    // `claude agents --json` lists the fork, not the recorded id, as the live background session of that lineage.
    const fake = `#!/bin/sh\nif [ "$1" = agents ]; then echo '[{"id":"abcd1234","sessionId":"${fork}","kind":"background","pid":321,"status":"idle"}]'; exit 0; fi\n{ echo "ARGS: $*"; } > "$DUMP_DIR/$(basename "$0")-$$.txt"\nexit 0\n`;
    writeFileSync(join(bins, 'claude'), fake);
    chmodSync(join(bins, 'claude'), 0o755);
    const launches = [
      { id: 'lch_1111111111111111', kind: 'reap_session', runtime: 'claude-code', session_id: session, cwd: repo },
      { id: 'lch_2222222222222222', kind: 'reap_session', runtime: 'claude-code', session_id: otherSession, cwd: repo },
    ];
    const done: { id: string; result: string }[] = [];
    const orch = await listen((req, body, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/runner/next') return void res.end(JSON.stringify({ launch: launches.shift() ?? null }));
      const m = /^\/api\/runner\/(lch_\w+)\/done$/.exec(req.url ?? '');
      if (m) done.push({ id: m[1]!, result: JSON.parse(body).result });
      res.end('{}');
    });
    runner = spawn('node', ['scripts/runner.ts'], {
      cwd: REPO,
      env: { PATH: `${bins}:${process.env.PATH}`, HOME: home, DUMP_DIR: dumps, ORCH_URL: orch.url, ORCH_RUNNER_KEY: RUNNER_KEY, ORCH_RUNNER_POLL_MS: '100' },
      stdio: 'ignore',
    });
    const deadline = Date.now() + 10_000;
    while (done.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    expect(done.find((d) => d.id === 'lch_1111111111111111')?.result).toBe('ok: stopped abcd1234');
    expect(done.find((d) => d.id === 'lch_2222222222222222')?.result).toBe('ok: already gone');
    const stopArgs = readdirSync(dumps)
      .map((f) => readFileSync(join(dumps, f), 'utf8'))
      .filter((d) => d.startsWith('ARGS: stop'));
    expect(stopArgs).toEqual([`ARGS: stop abcd1234\n`]);
  }, 20_000);

  it('fails a reap whose session listing could not be read, instead of reporting it as already gone', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'home-')));
    const repo = join(home, 'repo');
    mkdirSync(repo);
    const bins = mkdtempSync(join(tmpdir(), 'bins-'));
    const projectDir = join(home, '.claude', 'projects', repo.replace(/[^A-Za-z0-9-]/g, '-'));
    mkdirSync(projectDir, { recursive: true });
    const session = '4c6f8f1a-5d3b-4e29-9a6f-7b6a1c2d3e4f';
    writeFileSync(join(projectDir, `${session}.jsonl`), `${JSON.stringify({ type: 'user', uuid: 'lineage-2' })}\n`);
    // `claude agents --json` fails outright (the daemon is unreachable): must not be read as "nothing listed".
    writeFileSync(join(bins, 'claude'), `#!/bin/sh\nif [ "$1" = agents ]; then echo "daemon unreachable" >&2; exit 1; fi\nexit 0\n`);
    chmodSync(join(bins, 'claude'), 0o755);
    const launches = [{ id: 'lch_3333333333333333', kind: 'reap_session', runtime: 'claude-code', session_id: session, cwd: repo }];
    const done: { id: string; result: string }[] = [];
    const orch = await listen((req, body, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/runner/next') return void res.end(JSON.stringify({ launch: launches.shift() ?? null }));
      const m = /^\/api\/runner\/(lch_\w+)\/done$/.exec(req.url ?? '');
      if (m) done.push({ id: m[1]!, result: JSON.parse(body).result });
      res.end('{}');
    });
    runner = spawn('node', ['scripts/runner.ts'], {
      cwd: REPO,
      env: { PATH: `${bins}:${process.env.PATH}`, HOME: home, ORCH_URL: orch.url, ORCH_RUNNER_KEY: RUNNER_KEY, ORCH_RUNNER_POLL_MS: '100' },
      stdio: 'ignore',
    });
    const deadline = Date.now() + 10_000;
    while (done.length < 1 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    expect(done[0]?.result.startsWith('failed:')).toBe(true);
    expect(done[0]?.result).not.toContain('already gone');
  }, 20_000);

  it('fails a reap whose session transcript is missing, instead of reporting it as already gone', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'home-')));
    const repo = join(home, 'repo');
    mkdirSync(repo);
    const bins = mkdtempSync(join(tmpdir(), 'bins-'));
    // No transcript file for this session anywhere under home/.claude/projects: its lineage cannot be determined, so
    // an empty listing is not proof the process is gone (`claude agents --json` is never even consulted here).
    const session = '5c6f8f1a-5d3b-4e29-9a6f-7b6a1c2d3e4f';
    writeFileSync(join(bins, 'claude'), `#!/bin/sh\nif [ "$1" = agents ]; then echo '[]'; exit 0; fi\nexit 0\n`);
    chmodSync(join(bins, 'claude'), 0o755);
    const launches = [{ id: 'lch_4444444444444444', kind: 'reap_session', runtime: 'claude-code', session_id: session, cwd: repo }];
    const done: { id: string; result: string }[] = [];
    const orch = await listen((req, body, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/runner/next') return void res.end(JSON.stringify({ launch: launches.shift() ?? null }));
      const m = /^\/api\/runner\/(lch_\w+)\/done$/.exec(req.url ?? '');
      if (m) done.push({ id: m[1]!, result: JSON.parse(body).result });
      res.end('{}');
    });
    runner = spawn('node', ['scripts/runner.ts'], {
      cwd: REPO,
      env: { PATH: `${bins}:${process.env.PATH}`, HOME: home, ORCH_URL: orch.url, ORCH_RUNNER_KEY: RUNNER_KEY, ORCH_RUNNER_POLL_MS: '100' },
      stdio: 'ignore',
    });
    const deadline = Date.now() + 10_000;
    while (done.length < 1 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    expect(done[0]?.result.startsWith('failed:')).toBe(true);
    expect(done[0]?.result).not.toContain('already gone');
  }, 20_000);

  it('never stops a fork the listing reports busy, even when another fork of the same lineage is idle', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'home-')));
    const repo = join(home, 'repo');
    mkdirSync(repo);
    const bins = mkdtempSync(join(tmpdir(), 'bins-'));
    const dumps = mkdtempSync(join(tmpdir(), 'dumps-'));
    const projectDir = join(home, '.claude', 'projects', repo.replace(/[^A-Za-z0-9-]/g, '-'));
    mkdirSync(projectDir, { recursive: true });
    const transcript = (id: string, lineage: string) => writeFileSync(join(projectDir, `${id}.jsonl`), `${JSON.stringify({ type: 'user', uuid: lineage })}\n`);
    const session = '6c6f8f1a-5d3b-4e29-9a6f-7b6a1c2d3e4f'; // the recorded, now-abandoned registration
    const fork = '7c6f8f1a-5d3b-4e29-9a6f-7b6a1c2d3e4f'; // a re-registration of the same conversation, actively working
    transcript(session, 'lineage-3');
    transcript(fork, 'lineage-3');
    // The database's own sibling check cannot see this (different transcript_session per agent row): this is the
    // host-side backstop, so a busy fork of the lineage is decisive regardless of what the database decided.
    const fake = `#!/bin/sh\nif [ "$1" = agents ]; then echo '[{"id":"abcd1234","sessionId":"${fork}","kind":"background","pid":321,"status":"busy"}]'; exit 0; fi\n{ echo "ARGS: $*"; } > "$DUMP_DIR/$(basename "$0")-$$.txt"\nexit 0\n`;
    writeFileSync(join(bins, 'claude'), fake);
    chmodSync(join(bins, 'claude'), 0o755);
    const launches = [{ id: 'lch_5555555555555555', kind: 'reap_session', runtime: 'claude-code', session_id: session, cwd: repo }];
    const done: { id: string; result: string }[] = [];
    const orch = await listen((req, body, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/runner/next') return void res.end(JSON.stringify({ launch: launches.shift() ?? null }));
      const m = /^\/api\/runner\/(lch_\w+)\/done$/.exec(req.url ?? '');
      if (m) done.push({ id: m[1]!, result: JSON.parse(body).result });
      res.end('{}');
    });
    runner = spawn('node', ['scripts/runner.ts'], {
      cwd: REPO,
      env: { PATH: `${bins}:${process.env.PATH}`, HOME: home, DUMP_DIR: dumps, ORCH_URL: orch.url, ORCH_RUNNER_KEY: RUNNER_KEY, ORCH_RUNNER_POLL_MS: '100' },
      stdio: 'ignore',
    });
    const deadline = Date.now() + 10_000;
    while (done.length < 1 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    expect(done[0]?.result.startsWith('failed:')).toBe(true);
    expect(done[0]?.result).not.toContain('already gone');
    const stopArgs = readdirSync(dumps)
      .map((f) => readFileSync(join(dumps, f), 'utf8'))
      .filter((d) => d.startsWith('ARGS: stop'));
    expect(stopArgs).toEqual([]);
  }, 20_000);

  it('removes the config file of a running Operator process when the runner is stopped, and sweeps old directories at start', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'runner-tmp-'));
    const stale = join(tmp, 'triglav-run-stale1');
    mkdirSync(stale);
    writeFileSync(join(stale, 'operator-mcp.json'), 'old credential');
    const old = new Date(Date.now() - 2 * 3600_000);
    utimesSync(stale, old, old);
    const seen = join(tmp, 'config-path.txt');
    const bin = join(tmp, 'claude');
    writeFileSync(bin, `#!${process.execPath}\nconst a = process.argv.slice(2);\nrequire('node:fs').writeFileSync(${JSON.stringify(seen)}, a[a.indexOf('--mcp-config') + 1]);\nprocess.stdin.resume();\n`);
    chmodSync(bin, 0o755);
    let sent = false;
    const revoked: string[] = [];
    const orch = await listen((req, body, res) => {
      res.setHeader('content-type', 'application/json');
      if (/\/token\/revoke$/.test(req.url!)) revoked.push(body);
      if (req.url === '/api/runner/chat/next') {
        if (sent) return void setTimeout(() => res.end(JSON.stringify({ command: null })), 500);
        sent = true;
        return void res.end(JSON.stringify({ command: { kind: 'send', chat_id: 'cht_0123456789abcdef', text: 'hello', session_id: null } }));
      }
      if (/\/token$/.test(req.url!)) return void res.end(JSON.stringify({ token: `orch_chat_${'d'.repeat(32)}` }));
      res.end('{}');
    });
    runner = spawn('node', ['scripts/runner.ts'], { cwd: REPO, env: { PATH: process.env.PATH!, HOME: tmp, TMPDIR: tmp, ORCH_URL: orch.url, ORCH_RUNNER_KEY: RUNNER_KEY, ORCH_CLAUDE_BIN: bin, ORCH_RUNNER_CHAT_ONLY: '1' }, stdio: 'ignore' });
    const exited = new Promise<void>((resolve) => runner!.once('exit', () => resolve()));
    const until = async (cond: () => boolean) => {
      for (let i = 0; i < 150 && !cond(); i++) await new Promise((r) => setTimeout(r, 100));
      expect(cond()).toBe(true);
    };
    await until(() => existsSync(seen));
    const path = readFileSync(seen, 'utf8');
    expect(existsSync(path)).toBe(true);
    expect(existsSync(stale), 'a directory older than an hour is removed when the runner starts').toBe(false);
    // `pkill` (SIGTERM) is how the README restarts the runner: nothing with a bearer token may stay behind.
    runner.kill('SIGTERM');
    await exited;
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(tmp).filter((f) => f.startsWith('triglav-run-'))).toEqual([]);
    // The process was stopped with the runner and its token was revoked before the runner exited.
    expect(revoked).toHaveLength(1);
    expect(revoked[0]).toContain(`orch_chat_${'d'.repeat(32)}`);
  }, 30_000);
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

  it('with the real curl, ignores proxy settings in the environment and ~/.curlrc', async () => {
    const { transcript } = setup();
    const hits = { target: 0, proxy: 0 };
    const listen = (key: 'target' | 'proxy') =>
      new Promise<Server>((ok) => {
        const srv = createServer((req, res) => {
          hits[key]++;
          req.resume();
          res.setHeader('content-type', 'application/json');
          res.end('{"open_work":"You own an open job."}');
        }).listen(0, '127.0.0.1', () => ok(srv));
      });
    const target = await listen('target');
    const proxy = await listen('proxy');
    const home = mkdtempSync(join(tmpdir(), 'curlrc-'));
    writeFileSync(join(home, '.curlrc'), `proxy = "http://127.0.0.1:${(proxy.address() as AddressInfo).port}"\n`);
    const proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
    const env = { PATH: process.env.PATH!, HOME: home, http_proxy: proxyUrl, HTTP_PROXY: proxyUrl, ALL_PROXY: proxyUrl, all_proxy: proxyUrl, ORCH_URL: `http://localhost:${(target.address() as AddressInfo).port}` };
    // Async: the servers live in this process, so a blocking spawnSync would starve them.
    const runAsync = (script: string, input: string) =>
      new Promise<string>((done) => {
        const child = spawn('bash', [join(REPO, 'scripts', script)], { env, stdio: ['pipe', 'pipe', 'ignore'] });
        let out = '';
        child.stdout.on('data', (d) => (out += d));
        child.on('close', () => done(out));
        child.stdin.end(input);
      });
    expect(await runAsync('stop-hook.sh', JSON.stringify({ transcript_path: transcript }))).toContain('"decision"');
    await runAsync('claude-statusline.sh', JSON.stringify({ rate_limits: { five_hour: { used_percentage: 12, resets_at: 1 } }, workspace: { current_dir: '/home/me/repo' } }));
    await new Promise((r) => setTimeout(r, 800));
    target.close();
    proxy.close();
    expect(hits.proxy).toBe(0);
    expect(hits.target).toBe(2);
  });
});

describe('loopbackFetch', () => {
  const countingServer = (hits: { n: number; auth: string[]; connects: number }, handler?: (res: import('node:http').ServerResponse) => void) =>
    new Promise<Server>((ok) => {
      const srv = createServer((req, res) => {
        hits.n++;
        hits.auth.push(String(req.headers.authorization ?? ''));
        req.resume();
        if (handler) handler(res);
        else res.setHeader('content-type', 'application/json').end('{"hello":"world"}');
      });
      srv.on('connect', (_req, socket) => {
        hits.connects++;
        socket.destroy();
      });
      srv.listen(0, '127.0.0.1', () => ok(srv));
    });
  const urlOf = (s: Server) => `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  // A child process, because Node reads NODE_USE_ENV_PROXY and the proxy variables once, at start.
  const run = (target: string, proxy: string) =>
    new Promise<{ out: string; code: number | null }>((done) => {
      const code = `import { loopbackFetch } from ${JSON.stringify(join(REPO, 'scripts', 'loopback.ts'))};
        loopbackFetch(${JSON.stringify(`${target}/x`)}, { method: 'POST', headers: { authorization: 'Bearer the-key' }, body: '{}', timeoutMs: 4000 })
          .then(async (r) => console.log(JSON.stringify({ ok: r.ok, status: r.status, body: await r.json() })), (e) => { console.log('ERROR ' + e.message); process.exit(1); });`;
      const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
        env: { PATH: process.env.PATH!, NODE_USE_ENV_PROXY: '1', HTTP_PROXY: proxy, http_proxy: proxy, ALL_PROXY: proxy },
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      const timer = setTimeout(() => child.kill(), 8000);
      child.on('close', (c) => {
        clearTimeout(timer);
        done({ out: out.trim(), code: c });
      });
    });

  it('reaches the loopback server directly and never uses a proxy from the environment', async () => {
    const t = { n: 0, auth: [] as string[], connects: 0 };
    const p = { n: 0, auth: [] as string[], connects: 0 };
    const target = await countingServer(t);
    const proxy = await countingServer(p);
    const r = await run(urlOf(target), urlOf(proxy));
    target.close();
    proxy.close();
    expect(r.out).toBe('{"ok":true,"status":200,"body":{"hello":"world"}}');
    expect(t.auth).toEqual(['Bearer the-key']);
    expect(p.n + p.connects).toBe(0);
  });

  it('treats a redirect as an error and does not contact the other server', async () => {
    const other = { n: 0, auth: [] as string[], connects: 0 };
    const proxy = { n: 0, auth: [] as string[], connects: 0 };
    const b = await countingServer(other);
    const a = await countingServer({ n: 0, auth: [], connects: 0 }, (res) => res.writeHead(307, { location: `${urlOf(b)}/stolen` }).end());
    const pr = await countingServer(proxy);
    const r = await run(urlOf(a), urlOf(pr));
    a.close();
    b.close();
    pr.close();
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/^ERROR .*redirect/);
    expect(other.n).toBe(0);
    expect(proxy.n + proxy.connects).toBe(0);
  });
});
