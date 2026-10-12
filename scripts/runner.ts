/**
 * Host runner: carries out the launches the Client clicks in the dashboard.
 *
 * Triglav runs in Docker and cannot start processes on this machine, so this small loop runs on the host,
 * asks Triglav for the next launch and starts it. It never runs a command string from the server: it builds
 * the command shape for each runtime itself (`claude --bg --resume`, `claude --bg` or `codex exec` for a new Staff, or `codex exec resume`), after checking every field.
 *
 *   node scripts/runner.ts            # reads ORCH_RUNNER_KEY from .env, Triglav at http://127.0.0.1:7400
 */
import { execFile, spawn } from 'node:child_process';
import { mkdirSync, openSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { runningFork } from './forks.ts';
import { DEFAULT_ORCH_URL, loopbackBase, loopbackFetch } from './loopback.ts';
import { OperatorChats } from './operator.ts';
import { detectRuntimes } from './runtimes.ts';
import { checkLaunchId, MODEL as SAFE_MODEL, runCodexStaffStart, runStaffStart, staffStartEnv } from './staff-start.ts';

// The key goes to this URL, so it must be a loopback one. Checked before anything else.
let base: string;
try {
  base = loopbackBase(process.env.ORCH_URL ?? DEFAULT_ORCH_URL);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
const key = process.env.ORCH_RUNNER_KEY ?? envFile().ORCH_RUNNER_KEY;
if (!key) {
  console.error('ORCH_RUNNER_KEY is not set and not found in .env. It is not the agents\' ORCH_ENROLLMENT_KEY: see .env.example.');
  process.exit(1);
}

// ORCH_RUNNER_POLL_MS is for tests: how long to wait between two polls for a launch.
const POLL_MS = Number(process.env.ORCH_RUNNER_POLL_MS) || 5000;

const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HOME = realpathSync(homedir());

function envFile(): Record<string, string> {
  try {
    const text = readFileSync(join(import.meta.dirname, '..', '.env'), 'utf8');
    return Object.fromEntries(
      text.split('\n').flatMap((l) => {
        const m = /^\s*([A-Z0-9_]+)=(.*)$/.exec(l);
        return m ? [[m[1], m[2].trim()]] : [];
      }),
    );
  } catch {
    return {};
  }
}

async function call(path: string, body: unknown) {
  const res = await loopbackFetch(`${base}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    timeoutMs: 10_000,
  });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

/** The directory must be an existing directory inside the home directory, after resolving symlinks. */
function checkedCwd(cwd: string): string {
  const real = realpathSync(cwd);
  if (!(real === HOME || real.startsWith(HOME + '/'))) throw new Error(`cwd ${cwd} is outside ${HOME}`);
  if (!statSync(real).isDirectory()) throw new Error(`cwd ${cwd} is not a directory`);
  return real;
}

// See STAFF_CLAUDE_SETTINGS in src/telemetry.ts: Staff compacts at about 280k tokens.
const STAFF_CLAUDE_SETTINGS = '{"autoCompactWindow":300000}';

// A value must start with a letter or digit, so it can never be read as an option.
const MODEL = SAFE_MODEL;
const EFFORT = /^[a-z]{1,20}$/;
const LOGS = join(HOME, '.local', 'state', 'triglav');

type Launch = { id: string; kind: string; runtime: string; session_id?: string; request_id?: string; cwd: string; prompt: string; model?: string | null; effort?: string | null };

function resume(l: Launch): Promise<string> {
  // A new Staff for a job request: the command and the prompt are built in staff-start.ts from the validated request id.
  if (l.kind === 'staff_start') return startStaff(l);
  if (l.kind !== 'resume' && l.kind !== 'research_run') return Promise.reject(new Error(`unknown launch kind ${JSON.stringify(l.kind).slice(0, 40)}`));
  if (l.kind === 'research_run') return researchRun(l, checkedCwd(l.cwd));
  const session = l.session_id ?? '';
  if (!SESSION.test(session)) return Promise.reject(new Error(`bad session id ${session}`));
  const cwd = checkedCwd(l.cwd);
  if (l.runtime === 'codex') return resumeCodex({ ...l, session_id: session }, cwd);
  if (l.runtime !== 'claude-code') return Promise.reject(new Error(`unsupported runtime ${l.runtime}`));
  const running = runningFork(HOME, session, cwd);
  if (running) return Promise.resolve(`skipped: this session already runs as background session ${running}`);
  return new Promise((resolve, reject) => {
    execFile('claude', ['--bg', '--settings', STAFF_CLAUDE_SETTINGS, '--resume', session, l.prompt], { cwd, env: staffStartEnv(process.env), timeout: 60_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${err.message}\n${stderr}`.trim()));
      else resolve(stdout.trim().split('\n')[0] || 'started');
    });
  });
}

async function startStaff(l: Launch): Promise<string> {
  if (l.runtime === 'codex') return runCodexStaffStart(l, checkedCwd(l.cwd), LOGS);
  if (l.runtime !== 'claude-code') throw new Error(`unsupported runtime ${l.runtime}`);
  return runStaffStart(l, checkedCwd(l.cwd), STAFF_CLAUDE_SETTINGS);
}

/** Codex has no background mode: start it detached, with its output in a log file, and let it run. */
async function resumeCodex(l: Launch & { session_id: string }, cwd: string): Promise<string> {
  if (l.model && !MODEL.test(l.model)) throw new Error(`bad model ${l.model}`);
  if (l.effort && !EFFORT.test(l.effort)) throw new Error(`bad effort ${l.effort}`);
  const args = ['exec', 'resume', '--skip-git-repo-check', '-c', 'sandbox_mode="read-only"', '-c', 'approval_policy="never"'];
  if (l.model) args.push('-m', l.model);
  if (l.effort) args.push('-c', `model_reasoning_effort="${l.effort}"`);
  args.push(l.session_id, l.prompt);
  mkdirSync(LOGS, { recursive: true });
  const log = join(LOGS, `codex-${l.session_id}.log`);
  const fd = openSync(log, 'a');
  const child = spawn('codex', args, { cwd, env: staffStartEnv(process.env), detached: true, stdio: ['ignore', fd, fd] });
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  child.unref();
  return `started codex pid ${child.pid}, log ${log}`;
}

// A Claude research run may use only the orchestrator's tools and read code. In print mode every other tool is refused.
const RESEARCH_TOOLS = ['mcp__orchestrator', 'Read', 'Grep', 'Glob'];

/** A short research run that handles its inbox items and exits: `codex exec`, or `claude -p` when Codex is not on the machine. */
async function researchRun(l: Launch, cwd: string): Promise<string> {
  if (l.model && !MODEL.test(l.model)) throw new Error(`bad model ${l.model}`);
  if (l.effort && !EFFORT.test(l.effort)) throw new Error(`bad effort ${l.effort}`);
  if (l.runtime === 'claude-code') {
    if (!l.model || !l.effort) throw new Error('a Claude research run needs a model and an effort');
    // The prompt goes on stdin: --allowedTools takes several values and would swallow a trailing prompt argument.
    const args = ['-p', '--model', l.model, '--effort', l.effort, '--permission-mode', 'dontAsk', '--allowedTools', RESEARCH_TOOLS.join(',')];
    return watchedRun(l, 'claude', args, cwd, 'research', l.prompt, { ENABLE_CLAUDEAI_MCP_SERVERS: 'false' });
  }
  if (l.runtime !== 'codex') throw new Error(`unsupported runtime ${l.runtime}`);
  const args = ['exec', '--skip-git-repo-check', '-s', 'read-only', '-c', 'approval_policy="never"', '-C', cwd];
  if (l.model) args.push('-m', l.model);
  if (l.effort) args.push('-c', `model_reasoning_effort="${l.effort}"`);
  args.push(l.prompt);
  return watchedRun(l, 'codex', args, cwd, 'research');
}

/**
 * Starts a short run and tells Triglav when it exits, so a run that crashed or hit the usage limit is closed at once
 * (a research run's items go back to the inbox).
 */
async function watchedRun(l: Launch, cmd: string, args: string[], cwd: string, label: string, stdin?: string, env?: Record<string, string>): Promise<string> {
  mkdirSync(LOGS, { recursive: true });
  const log = join(LOGS, `${label}-${l.id}.log`);
  const fd = openSync(log, 'a');
  const child = spawn(cmd, args, { cwd, env: { ...staffStartEnv(process.env), ...env }, stdio: [stdin === undefined ? 'ignore' : 'pipe', fd, fd] });
  if (stdin !== undefined) child.stdin?.end(stdin);
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  child.once('exit', (code) => {
    const tail = (() => {
      try {
        return readFileSync(log, 'utf8').split('\n').slice(-15).join('\n');
      } catch {
        return '';
      }
    })();
    console.log(new Date().toISOString(), label, 'run', l.id, 'exited', code);
    call(`/api/runner/${l.id}/exited`, { code, tail }).catch((e) => console.error('report exit:', (e as Error).message));
  });
  return `started ${label} run pid ${child.pid}, log ${log}`;
}

async function tick() {
  const { launch } = await call('/api/runner/next', {});
  if (!launch) return;
  // The id goes into a log file name and a URL below, so a malformed one stops here. The server expires the launch.
  try {
    checkLaunchId(launch.id);
  } catch (e) {
    console.error(new Date().toISOString(), 'refused a launch:', (e as Error).message);
    return;
  }
  console.log(new Date().toISOString(), launch.kind === 'resume' ? 'resuming' : launch.kind, launch.session_id ?? launch.request_id ?? launch.id, 'in', launch.cwd);
  let result: string;
  try {
    result = `ok: ${await resume(launch)}`;
  } catch (e) {
    result = `failed: ${(e as Error).message}`;
  }
  console.log(new Date().toISOString(), result.split('\n')[0]);
  await call(`/api/runner/${launch.id}/done`, { result });
}

// The Operator chats: one long poll of its own, apart from the launches below. ORCH_CLAUDE_BIN is for tests.
mkdirSync(LOGS, { recursive: true });
void new OperatorChats({
  base,
  key,
  bin: process.env.ORCH_CLAUDE_BIN ?? 'claude',
  cwd: join(import.meta.dirname, '..'),
  logs: LOGS,
  model: process.env.ORCH_OPERATOR_MODEL ?? 'claude-sonnet-5-5',
  effort: process.env.ORCH_OPERATOR_EFFORT ?? 'medium',
}).run();

// ORCH_RUNNER_CHAT_ONLY is for tests: serve the Operator and leave the launches alone, so a test never starts a real agent.
if (process.env.ORCH_RUNNER_CHAT_ONLY) await new Promise(() => {});

// Tells Triglav which agent CLIs are on this machine, now and every five minutes (it trusts a report for fifteen).
async function reportRuntimes() {
  try {
    const found = await detectRuntimes();
    await call('/api/runner/runtimes', found);
    console.log(new Date().toISOString(), 'runtimes:', Object.entries(found).map(([k, v]) => `${k} ${v ? `${v.version} (${v.models.length} models)` : 'missing'}`).join(', '));
  } catch (e) {
    console.error(new Date().toISOString(), 'report runtimes:', (e as Error).message);
  }
}
void reportRuntimes();
setInterval(reportRuntimes, 5 * 60_000).unref();

console.log(`Triglav runner polling ${base}`);
for (;;) {
  try {
    await tick();
  } catch (e) {
    console.error(new Date().toISOString(), (e as Error).message);
  }
  await new Promise((r) => setTimeout(r, POLL_MS));
}
