import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loopbackBase } from '../scripts/loopback.ts';
import { OperatorChats } from '../scripts/operator.ts';
import { DeployedOutputSchema, deployCompareArgs, deployRunListArgs, deployRunViewArgs, prViewArgs, provesDeployed } from '../src/gate-check.ts';

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
    const fake = `#!/bin/sh\nif [ "$1" = agents ]; then echo '[]'; exit 0; fi\nif [ "$1" = mcp ]; then printf '[{"name":"orchestrator","enabled":true,"transport":{"type":"streamable_http","url":"http://localhost:%s/mcp"}},{"name":"linear-server","enabled":true},{"name":"off","enabled":false}]' "$FAKE_MCP_PORT"; exit 0; fi\nif [ "$1" = -p ] && [ "$2" = --model ]; then prev=; for a in "$@"; do if [ "$prev" = --mcp-config ]; then cp "$a" "$CFG_DIR/research-mcp.json"; stat -c %a "$a" > "$CFG_DIR/research-mcp.mode"; echo "$a" > "$CFG_DIR/research-mcp.path"; fi; prev=$a; done; fi\nif [ "$1" = --bg ]; then prev=; for a in "$@"; do if [ "$prev" = --mcp-config ]; then cp "$a" "$CFG_DIR/staff-mcp-$$.json"; stat -c %a "$a" > "$CFG_DIR/staff-mcp-$$.mode"; echo "$a" > "$CFG_DIR/staff-mcp-$$.path"; fi; prev=$a; done; fi\n{ echo "ARGS: $*"; env; } > "$DUMP_DIR/$(basename "$0")-$$.txt"\ncase "$*" in *staff-req_00000000000000fe*) echo "start failed" >&2; exit 3;; esac\n[ "$(basename "$0")" = claude ] && [ "$1" = --bg ] && echo started\nexit 0\n`;
    for (const name of ['claude', 'codex']) {
      writeFileSync(join(bins, name), fake);
      chmodSync(join(bins, name), 0o755);
    }
    const session = '1b85d8aa-ea20-41ef-baa6-1de0d08eb630';
    const launches = [
      { id: 'lch_0000000000000001', kind: 'resume', runtime: 'claude-code', session_id: session, cwd: repo, prompt: 'go on' },
      { id: 'lch_0000000000000002', kind: 'research_run', runtime: 'claude-code', model: 'claude-opus-5-5', effort: 'high', cwd: repo, prompt: 'research', persona: 'persona-test', trees: [] },
      { id: 'lch_0000000000000003', kind: 'research_run', runtime: 'codex', model: 'gpt-6.1-sol', effort: 'high', cwd: repo, prompt: 'research' },
      { id: 'lch_0000000000000004', kind: 'resume', role: 'staff', runtime: 'codex', session_id: session, cwd: repo, prompt: 'go on' },
      { id: 'lch_0000000000000005', kind: 'staff_start', runtime: 'claude-code', request_id: 'req_0123456789abcdef', model: 'claude-opus-5-5', effort: 'high', cwd: repo },
      // The read-only Staff of a research job: a start with web sources, and a resume of another session without them.
      { id: 'lch_0000000000000006', kind: 'staff_start', runtime: 'claude-code', request_id: 'req_00000000000000ab', model: 'claude-opus-5-5', effort: 'high', cwd: repo, access: 'document', web: true, report_key: 'req_00000000000000ab' },
      { id: 'lch_0000000000000007', kind: 'resume', role: 'staff', runtime: 'claude-code', session_id: '2c85d8aa-ea20-41ef-baa6-1de0d08eb631', cwd: repo, prompt: 'go on', access: 'document', web: false, report_key: 'req_00000000000000ab' },
      { id: 'lch_0000000000000008', kind: 'switch', role: 'staff', runtime: 'claude-code', session_id: '3d85d8aa-ea20-41ef-baa6-1de0d08eb632', cwd: repo, model: 'claude-sonnet-5-5', effort: 'low', prompt: 'go on', access: 'document', web: false, report_key: 'req_00000000000000ab' },
      // A start that fails after the runner wrote the config file: the file must still go.
      { id: 'lch_0000000000000009', kind: 'staff_start', runtime: 'claude-code', request_id: 'req_00000000000000fe', model: 'claude-opus-5-5', effort: 'high', cwd: repo, access: 'document', web: false, report_key: 'req_00000000000000fe' },
    ];
    // A reports folder an earlier runner left open to other users is tightened again.
    mkdirSync(join(home, '.local', 'state', 'triglav', 'reports', 'req_00000000000000ab'), { recursive: true, mode: 0o755 });
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
    const wanted = ['--bg --settings', '-p --model', 'exec --skip-git-repo-check -s read-only', 'exec resume', '--bg -n staff-req_0123456789abcdef', '-p --input-format stream-json', '--bg -n staff-req_00000000000000ab', '--bg --settings {"autoCompactWindow":300000,"hooks"', '--bg -n staff-req_00000000000000fe'];
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
    // A research job's Staff: no Bash or Edit, no other MCP server or browser, writes only in its reports folder, and gets
    // the prompt after `--`. Its config file holds the key and the long MCP timeout, is private, and is gone once `claude --bg` returned.
    const reports = join(home, '.local', 'state', 'triglav', 'reports', 'req_00000000000000ab');
    const docStart = all.find((d) => d.startsWith('ARGS: --bg -n staff-req_00000000000000ab'))!.split('\n')[0]!;
    const docResume = all.find((d) => d.startsWith('ARGS: --bg --settings') && d.includes('--resume 2c85d8aa'))!.split('\n')[0]!;
    const docSwitch = all.find((d) => d.startsWith('ARGS: --bg --settings') && d.includes('--resume 3d85d8aa'))!.split('\n')[0]!;
    // Triglav's own Stop hook replaces the user's, which is not loaded.
    const settings = `--settings {"autoCompactWindow":300000,"hooks":{"Stop":[{"matcher":"*","hooks":[{"type":"command","command":"'${join(REPO, 'scripts', 'stop-hook.sh')}'","timeout":10}]}]}}`;
    for (const args of [docStart, docResume, docSwitch]) {
      expect(args).toContain(settings);
      // `$*` joins the empty --setting-sources value with two spaces.
      expect(args).toContain('--setting-sources  --permission-mode dontAsk --no-chrome --tools Read,Grep,Glob,ToolSearch,Artifact,Write');
      expect(args).toContain(`Read(/${repo}/**) Read(/${reports}/**) Edit(/${reports}/**)`);
      expect(args).toContain('--strict-mcp-config --mcp-config ');
      expect(args).not.toMatch(/Bash| Read | Grep | Glob /);
      expect(args).toContain(`Your reports folder is ${reports}.`);
    }
    expect(docSwitch).toContain('--model claude-sonnet-5-5 --effort low --resume 3d85d8aa');
    expect(docStart).toContain('Write,WebSearch,WebFetch --allowedTools');
    expect(docStart).toMatch(/ -- Load the orchestrator's tools first/);
    expect(docResume).not.toContain('WebSearch');
    expect(docResume).toMatch(/ -- go on Your reports folder is /);
    expect(statSync(reports).mode & 0o777).toBe(0o700);
    const staffCfgs = readdirSync(cfgs).filter((f) => /^staff-mcp-\d+\.json$/.test(f));
    expect(staffCfgs).toHaveLength(4);
    for (const f of staffCfgs) {
      expect(JSON.parse(readFileSync(join(cfgs, f), 'utf8'))).toEqual({ mcpServers: { orchestrator: { type: 'http', url: `${orch.url}/mcp`, headers: { Authorization: `Bearer ${SECRETS.ORCH_ENROLLMENT_KEY}` }, timeout: 3_500_000 } } });
      expect(readFileSync(join(cfgs, f.replace('.json', '.mode')), 'utf8').trim()).toBe('600');
      const path = readFileSync(join(cfgs, f.replace('.json', '.path')), 'utf8').trim();
      const until = Date.now() + 5000;
      while (existsSync(path) && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
      expect(existsSync(path), 'the Staff config file is removed once claude --bg returned').toBe(false);
    }
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

  it('removes a finished job worktree only when it is clean and pushed, and keeps one with unpushed work', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'home-')));
    const env = { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
    const git = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, env, encoding: 'utf8' });
    git(home, 'init', '-q', '--bare', '-b', 'main', join(home, 'remote.git'));
    const repo = join(home, 'repo');
    git(home, 'clone', '-q', join(home, 'remote.git'), repo);
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
    git(repo, 'push', '-q', 'origin', 'main');
    const clean = join(home, 'repo-job_a');
    const unpushed = join(home, 'repo-job_b');
    git(repo, 'worktree', 'add', '-q', '-b', 'a', clean, 'main');
    git(repo, 'worktree', 'add', '-q', '-b', 'b', unpushed, 'main');
    git(unpushed, 'commit', '-q', '--allow-empty', '-m', 'local only');
    const launches = [
      { id: 'lch_7777777777777777', kind: 'reap_worktree', runtime: 'git', cwd: clean },
      { id: 'lch_8888888888888888', kind: 'reap_worktree', runtime: 'git', cwd: unpushed },
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
      env: { PATH: process.env.PATH!, HOME: home, GIT_CONFIG_NOSYSTEM: '1', ORCH_URL: orch.url, ORCH_RUNNER_KEY: RUNNER_KEY, ORCH_RUNNER_POLL_MS: '100' },
      stdio: 'ignore',
    });
    const deadline = Date.now() + 10_000;
    while (done.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    expect(done.find((d) => d.id === 'lch_7777777777777777')?.result).toBe(`ok: removed ${clean}`);
    expect(done.find((d) => d.id === 'lch_8888888888888888')?.result).toMatch(/^failed: kept: 1 commit\(s\) are on no remote branch/);
    expect(existsSync(clean)).toBe(false);
    expect(existsSync(unpushed)).toBe(true);
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
  // Runs scripts/runner.ts once on a gate_check launch with the given stub gh on PATH, and returns the output it posted.
  async function runGateCheck(gh: (dir: string) => string, launch: Record<string, unknown> = { id: 'lch_00000000000000a1', kind: 'gate_check', pr_number: 75, repo_slug: 'adam-drag/triglav' }) {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'home-')));
    const bins = mkdtempSync(join(tmpdir(), 'bins-'));
    writeFileSync(join(bins, 'gh'), gh(bins));
    chmodSync(join(bins, 'gh'), 0o755);
    const launches = [launch];
    const posted: { path: string; body: string }[] = [];
    const orch = await listen((req, body, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/runner/next') return void res.end(JSON.stringify({ launch: launches.shift() ?? null }));
      if (req.url?.startsWith('/api/runner/')) posted.push({ path: req.url, body });
      res.end('{}');
    });
    runner = spawn('node', ['scripts/runner.ts'], {
      cwd: REPO,
      env: { PATH: `${bins}:${process.env.PATH}`, HOME: home, ORCH_URL: orch.url, ORCH_RUNNER_KEY: RUNNER_KEY, ORCH_RUNNER_POLL_MS: '100', ...SECRETS },
      stdio: 'ignore',
    });
    const deadline = Date.now() + 20_000;
    while (!posted.some((p) => p.path.endsWith('/gate-output')) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    const out = posted.find((p) => p.path === '/api/runner/lch_00000000000000a1/gate-output');
    return { out: out ? (JSON.parse(out.body) as { code: number | null; stdout: string; stderr: string }) : undefined, bins };
  }

  it('runs a merged check with the fixed gh argv on PATH, without the orchestrator secrets, and posts its output', async () => {
    const { out, bins } = await runGateCheck((dir) => `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/argv.txt"\nenv > "${dir}/env.txt"\nprintf '{"state":"MERGED","mergedAt":"2026-11-17T00:00:00Z"}'\n`);
    expect(out, 'the gate output is posted for the launch').toBeDefined();
    expect(readFileSync(join(bins, 'argv.txt'), 'utf8').trim().split('\n')).toEqual(prViewArgs(75, 'adam-drag/triglav'));
    expect(out).toMatchObject({ code: 0, stderr: '' });
    expect(out!.stdout).toContain('"state":"MERGED"');
    // gh runs with staffStartEnv: no ORCH_*, MYSQL_*, DATABASE_URL or LINEAR_API_KEY, and none of the secret values.
    const env = readFileSync(join(bins, 'env.txt'), 'utf8');
    for (const name of env.split('\n').map((l) => l.split('=')[0]!)) expect(name, env).not.toMatch(/^(ORCH_|MYSQL_)|^(DATABASE_URL|LINEAR_API_KEY)$/);
    for (const value of Object.values(SECRETS)) expect(env).not.toContain(value);
  }, 30_000);

  it('runs a quote check with git show at the cited commit and posts the file, and refuses a path that escapes the repository before git runs', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'home-')));
    const repo = join(home, 'repo');
    mkdirSync(repo);
    const git = (...args: string[]) => spawnSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8' });
    git('init', '-q');
    writeFileSync(join(repo, 'a.ts'), 'export const limit = 5;\n');
    git('add', 'a.ts');
    git('commit', '-q', '-m', 'one');
    const sha = git('rev-parse', 'HEAD').stdout.trim();
    // The cited commit is not HEAD, and the file changes after it: the check must read the cited commit's contents.
    writeFileSync(join(repo, 'a.ts'), 'export const limit = 9;\n');
    git('add', 'a.ts');
    git('commit', '-q', '-m', 'two');
    writeFileSync(join(repo, 'a.ts'), 'uncommitted\n');
    const bad = { id: 'lch_00000000000000b2', kind: 'quote_check', sha, path: '../etc/passwd', cwd: repo };
    const good = { id: 'lch_00000000000000b1', kind: 'quote_check', sha, path: 'a.ts', cwd: repo };
    const launches = [bad, good];
    const posted: { path: string; body: string }[] = [];
    const orch = await listen((req, body, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/runner/next') return void res.end(JSON.stringify({ launch: launches.shift() ?? null }));
      if (req.url?.startsWith('/api/runner/')) posted.push({ path: req.url, body });
      res.end('{}');
    });
    // A git on the runner's PATH logs each call and then runs the real git, so any launch that reaches git is visible.
    const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
    const bin = join(home, 'bin');
    mkdirSync(bin);
    const gitLog = join(home, 'git.log');
    writeFileSync(join(bin, 'git'), `#!/bin/sh\necho "$@" >> "${gitLog}"\nexec "${realGit}" "$@"\n`, { mode: 0o755 });
    runner = spawn('node', ['scripts/runner.ts'], {
      cwd: REPO,
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, ORCH_URL: orch.url, ORCH_RUNNER_KEY: RUNNER_KEY, ORCH_RUNNER_POLL_MS: '100', ...SECRETS },
      stdio: 'ignore',
    });
    const deadline = Date.now() + 20_000;
    while (!posted.some((p) => p.path.endsWith('/quote-output')) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    const out = posted.find((p) => p.path === '/api/runner/lch_00000000000000b1/quote-output');
    expect(out, 'the file is posted for the good launch').toBeDefined();
    expect(JSON.parse(out!.body)).toMatchObject({ code: 0, stdout: 'export const limit = 5;\n', stderr: '' });
    expect(posted.some((p) => p.path === '/api/runner/lch_00000000000000b2/quote-output'), 'no output for a path outside the repository').toBe(false);
    // The traversal path never reached git, and the good launch ran git show at the cited commit (the runner makes other git calls too).
    const calls = readFileSync(gitLog, 'utf8').trim().split('\n');
    expect(calls.some((c) => c.includes('../etc/passwd')), calls.join('\n')).toBe(false);
    expect(calls.filter((c) => c.includes(' show '))).toEqual([`-C ${repo} show ${sha}:a.ts`]);
  }, 30_000);

  it('posts a failed check with its exit code and stderr, so the server can record it as evidence', async () => {
    const { out } = await runGateCheck(() => `#!/bin/sh\necho "no pull request found" >&2\nexit 1\n`);
    expect(out, 'the gate output is posted for the launch').toBeDefined();
    expect(out).toMatchObject({ code: 1, stdout: '' });
    expect(out!.stderr).toContain('no pull request found');
  }, 30_000);

  const HEAD = 'c'.repeat(40);
  const MERGE = 'b'.repeat(40);
  const deployLaunch = { id: 'lch_00000000000000a1', kind: 'gate_check', check: 'deployed', repo_slug: 'adam-drag/triglav', workflow: 'deploy.yml', base: 'main', job: 'deploy-prod', step: 'Deploy CDK stack', merge_sha: MERGE, same_repo: true };

  it('runs a deployed check with the fixed gh argv, posts the run, its view and the comparison, and the server proves the deploy from them', async () => {
    const { out, bins } = await runGateCheck(
      (dir) => `#!/bin/sh
printf '%s\\n' "$*" >> "${dir}/calls.txt"
case "$1 $2" in
  "run list") printf '%s' '[{"databaseId":9,"headSha":"${HEAD}","status":"completed","conclusion":"success","createdAt":"2026-11-17T12:00:00Z","headBranch":"main","event":"push"}]' ;;
  "run view") printf '%s' '{"databaseId":9,"headBranch":"main","headSha":"${HEAD}","status":"completed","conclusion":"success","createdAt":"2026-11-17T12:00:00Z","jobs":[{"name":"deploy-prod","conclusion":"success","steps":[{"name":"Deploy CDK stack","conclusion":"success"}]}]}' ;;
  "api repos/adam-drag/triglav/compare/${MERGE}...${HEAD}") printf '%s' '{"status":"ahead"}' ;;
  *) echo "unexpected $*" >&2; exit 2 ;;
esac
`,
      deployLaunch,
    );
    expect(out, 'the gate output is posted for the launch').toBeDefined();
    expect(out).toMatchObject({ code: 0, stderr: '' });
    // The three calls are the argv builders of src/gate-check.ts, in order: run list, run view, then the comparison.
    expect(readFileSync(join(bins, 'calls.txt'), 'utf8').trim().split('\n')).toEqual([
      deployRunListArgs('adam-drag/triglav', 'deploy.yml', 'main').join(' '),
      deployRunViewArgs('adam-drag/triglav', 9).join(' '),
      deployCompareArgs('adam-drag/triglav', MERGE, HEAD).join(' '),
    ]);
    const verdict = provesDeployed(DeployedOutputSchema.parse(JSON.parse(out!.stdout)), { job: 'deploy-prod', step: 'Deploy CDK stack', base: 'main', sameRepo: true, mergedAt: null });
    expect(verdict).toMatchObject({ ok: true, run_id: 9, head_sha: HEAD, compare_status: 'ahead' });
  }, 30_000);

  it('posts no run when a run view cannot be read, so the newest run is not passed over for an older success', async () => {
    const { out } = await runGateCheck(
      () => `#!/bin/sh
case "$1 $2" in
  "run list") printf '%s' '[{"databaseId":10,"headSha":"${HEAD}","status":"completed","conclusion":"success","createdAt":"2026-11-17T13:00:00Z","headBranch":"main","event":"push"},{"databaseId":9,"headSha":"${HEAD}","status":"completed","conclusion":"success","createdAt":"2026-11-17T12:00:00Z","headBranch":"main","event":"push"}]' ;;
  "run view") if [ "$3" = "10" ]; then printf 'not json'; else printf '%s' '{"databaseId":9,"headBranch":"main","headSha":"${HEAD}","status":"completed","conclusion":"success","createdAt":"2026-11-17T12:00:00Z","jobs":[{"name":"deploy-prod","conclusion":"success","steps":[{"name":"Deploy CDK stack","conclusion":"success"}]}]}'; fi ;;
  *) echo "unexpected $*" >&2; exit 2 ;;
esac
`,
      deployLaunch,
    );
    expect(out).toMatchObject({ code: 0, stderr: '' });
    expect(JSON.parse(out!.stdout)).toEqual({ runs: [], error: 'GitHub answered a run view in an unexpected shape.' });
  }, 30_000);

  it('posts a failed deployed check at the first call that fails, with its exit code and stderr', async () => {
    const { out } = await runGateCheck(() => `#!/bin/sh\necho "HTTP 404: Not Found" >&2\nexit 1\n`, deployLaunch);
    expect(out).toMatchObject({ code: 1, stdout: '' });
    expect(out!.stderr).toContain('HTTP 404');
  }, 30_000);
});

describe('the hooks send nothing unless ORCH_URL is a loopback URL', () => {
  // A fake curl records every call, so nothing leaves the machine.
  function setup() {
    const dir = mkdtempSync(join(tmpdir(), 'hook-'));
    const log = join(dir, 'curl.log');
    const body = join(dir, 'curl.body');
    writeFileSync(join(dir, 'curl'), `#!/bin/sh\necho "$*" >> "${log}"\ncat >> "${body}"\necho >> "${body}"\nprintf '{"open_work":"You own an open job."}'\n`);
    chmodSync(join(dir, 'curl'), 0o755);
    const transcript = join(dir, 'transcript.jsonl');
    writeFileSync(transcript, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__orchestrator__get_job', input: { session_token: 'orch_tok_aaaaaaaaaaaaaaaaaaaaaaaa' } }] } }) + '\n');
    const run = (script: string, input: string, url: string | undefined) => {
      const env: Record<string, string> = { PATH: `${dir}:${process.env.PATH}` };
      if (url !== undefined) env.ORCH_URL = url;
      return spawnSync('bash', [join(REPO, 'scripts', script)], { input, env, encoding: 'utf8', timeout: 10_000 });
    };
    const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []);
    // The request bodies the fake curl received on stdin (the session token goes there, not in argv).
    const bodies = () => (existsSync(body) ? readFileSync(body, 'utf8') : '');
    return { run, calls, bodies, transcript };
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

  it('stop-hook.sh tells the agent to leave max_wait_sec out', () => {
    const { run, transcript } = setup();
    const r = run('stop-hook.sh', JSON.stringify({ transcript_path: transcript }), undefined);
    const reason = JSON.parse(r.stdout).reason as string;
    expect(reason).not.toContain('max_wait_sec 240');
    expect(reason).toContain('leave max_wait_sec out');
  });

  it('stop-hook.sh as a SubagentStop hook reads the token from agent_transcript_path and blocks', () => {
    const { run, calls, bodies, transcript } = setup();
    const parent = join(dirname(transcript), 'parent.jsonl');
    writeFileSync(parent, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__orchestrator__get_job', input: { session_token: 'orch_tok_staffstaffstaffstaffstaff' } }] } }) + '\n');
    const input = JSON.stringify({ hook_event_name: 'SubagentStop', transcript_path: parent, agent_transcript_path: transcript });
    const r = run('stop-hook.sh', input, 'http://127.0.0.1:7400');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('"decision"');
    expect(calls()).toHaveLength(1);
    expect(calls()[0]).toContain('/api/hooks/stop');
    // The subagent's token is sent, never the parent's.
    expect(bodies()).toContain('orch_tok_aaaaaaaaaaaaaaaaaaaaaaaa');
    expect(bodies()).not.toContain('orch_tok_staffstaffstaffstaffstaff');
  });

  it('stop-hook.sh as a SubagentStop hook never falls back to transcript_path', () => {
    const { run, calls, transcript } = setup();
    const missing = join(dirname(transcript), 'nope.jsonl');
    // transcript_path (the parent's) holds a token; the subagent's own transcript is absent, missing or not a file.
    // A child transcript that exists but holds no orchestrator call also lets the subagent stop.
    const noToken = join(dirname(transcript), 'child-empty.jsonl');
    writeFileSync(noToken, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }) + '\n');
    for (const extra of [{}, { agent_transcript_path: '' }, { agent_transcript_path: missing }, { agent_transcript_path: dirname(transcript) }, { agent_transcript_path: noToken }]) {
      const r = run('stop-hook.sh', JSON.stringify({ hook_event_name: 'SubagentStop', transcript_path: transcript, ...extra }), 'http://127.0.0.1:7400');
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
    }
    expect(calls()).toEqual([]);
  });

  it('stop-hook.sh as a Stop hook ignores agent_transcript_path', () => {
    const { run, calls, transcript } = setup();
    const r = run('stop-hook.sh', JSON.stringify({ hook_event_name: 'Stop', transcript_path: transcript, agent_transcript_path: join(dirname(transcript), 'nope.jsonl') }), 'http://127.0.0.1:7400');
    expect(r.stdout).toContain('"decision"');
    expect(calls()).toHaveLength(1);
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
