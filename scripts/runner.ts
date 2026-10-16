/**
 * Host runner: carries out the launches the Client clicks in the dashboard.
 *
 * Triglav runs in Docker and cannot start processes on this machine, so this small loop runs on the host,
 * asks Triglav for the next launch and starts it. It never runs a command string from the server: it builds
 * the command shape for each runtime itself (`claude --bg --resume`, `claude --bg` or `codex exec` for a new Staff, or `codex exec resume`), after checking every field.
 *
 *   node scripts/runner.ts            # reads ORCH_RUNNER_KEY from .env, Triglav at http://127.0.0.1:7400
 *
 * It also reads ORCH_ENROLLMENT_KEY from .env, for one purpose: the MCP config file of a Claude research run (see research-run.ts).
 * That key never goes into a child's environment, arguments or log. Only the runner key is used to talk to Triglav's runner API.
 */
import { execFile, spawn } from 'node:child_process';
import { mkdirSync, openSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { lineageOf, liveForkIds, runningFork } from './forks.ts';
import { DEFAULT_ORCH_URL, loopbackBase, loopbackFetch } from './loopback.ts';
import { OperatorChats } from './operator.ts';
import { cleanStalePrivateDirs, type PrivateFile, removeAllPrivateFiles, writePrivateFile } from './private-file.ts';
import { baseChecks, claudeReviewArgs, codexKeepLine, codexReviewArgs, reviewSchemaJson, reviewerReport, reviewPrompt, runReviewer, SHA, worktreeDiff } from './code-review-run.ts';
import { claudeResearchArgs, codexMcpDisableArgs, researchMcpConfig } from './research-run.ts';
import { codexRoleArgs } from '../src/codex-args.ts';
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

// Config files that hold a bearer token are removed when the runner ends (a restart sends SIGTERM), and the ones a runner
// that was killed left behind are removed now.
process.on('exit', removeAllPrivateFiles);
// The Operator processes are stopped first, so their tokens are revoked; a second signal ends the runner at once.
let shutdown: () => Promise<void> = async () => {};
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.once(signal, () => void shutdown().finally(() => process.exit(0)));
cleanStalePrivateDirs();

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

type Launch = { id: string; kind: string; base_sha?: string; head_sha?: string; base_branch?: string | null; expect_merge_base?: boolean; expect_ancestor?: boolean; answers_resolved?: boolean; runtime: string; session_id?: string; request_id?: string; cwd: string; prompt: string; model?: string | null; effort?: string | null; role?: string | null };

function resume(l: Launch): Promise<string> {
  // A new Staff for a job request: the command and the prompt are built in staff-start.ts from the validated request id.
  if (l.kind === 'staff_start') return startStaff(l);
  if (l.kind === 'staff_replace') return replaceStaff(l);
  if (l.kind === 'switch') return switchStaff(l);
  if (l.kind === 'code_review') return codeReviewRun(l, checkedCwd(l.cwd));
  if (l.kind !== 'resume' && l.kind !== 'research_run') return Promise.reject(new Error(`unknown launch kind ${JSON.stringify(l.kind).slice(0, 40)}`));
  if (l.kind === 'research_run') return researchRun(l, checkedCwd(l.cwd));
  const session = l.session_id ?? '';
  if (!SESSION.test(session)) return Promise.reject(new Error(`bad session id ${session}`));
  const cwd = checkedCwd(l.cwd);
  if (l.runtime === 'codex') return resumeCodex({ ...l, session_id: session }, cwd);
  if (l.runtime !== 'claude-code') return Promise.reject(new Error(`unsupported runtime ${l.runtime}`));
  const running = runningFork(HOME, session, cwd);
  if (running) return Promise.resolve(`skipped: this session already runs as background session ${running}`);
  return stopIdleForks(session, cwd).then(() => run('claude', ['--bg', '--settings', STAFF_CLAUDE_SETTINGS, '--resume', session, l.prompt], cwd));
}

/**
 * A fork that is alive but idle (it hit an API error and ended its turn) will not do anything again, yet it still holds the
 * session. Stop it, its conversation is kept, so the resume that follows is the only live copy.
 */
async function stopIdleForks(session: string, cwd: string) {
  let ids: string[];
  try {
    ids = liveForkIds(HOME, session, cwd);
  } catch (e) {
    console.error('claude agents --json failed, resuming anyway:', (e as Error).message);
    return;
  }
  for (const id of ids) await run('claude', ['stop', id], cwd);
}

async function replaceStaff(l: Launch): Promise<string> {
  const session = l.session_id ?? '';
  if (!SESSION.test(session)) throw new Error('bad previous Staff session id');
  const cwd = checkedCwd(l.cwd);
  if (!lineageOf(HOME, cwd, session)) throw new Error('previous Staff session lineage could not be verified');
  const forks = liveForkIds(HOME, session, cwd);
  for (const id of forks) await run('claude', ['stop', id], cwd);
  if (liveForkIds(HOME, session, cwd).length) throw new Error('previous Staff background session did not stop');
  return startStaff(l);
}

/** Claude Code cannot change a live session's model: stop it, then resume the same conversation with the new model and effort. */
async function switchStaff(l: Launch): Promise<string> {
  const session = l.session_id ?? '';
  if (!SESSION.test(session)) throw new Error(`bad session id ${session}`);
  if (l.runtime !== 'claude-code') throw new Error(`unsupported runtime ${l.runtime}`);
  if (!l.model || !MODEL.test(l.model)) throw new Error(`bad model ${JSON.stringify(String(l.model)).slice(0, 60)}`);
  if (!l.effort || !EFFORT.test(l.effort)) throw new Error(`bad effort ${JSON.stringify(String(l.effort)).slice(0, 60)}`);
  const cwd = checkedCwd(l.cwd);
  for (const id of liveForkIds(HOME, session, cwd)) await run('claude', ['stop', id], cwd);
  // A fork that is still alive after the stop would give two Staff with one token.
  const left = runningFork(HOME, session, cwd);
  if (left) throw new Error(`session ${left} did not stop`);
  return run('claude', ['--bg', '--settings', STAFF_CLAUDE_SETTINGS, '--model', l.model, '--effort', l.effort, '--resume', session, l.prompt], cwd);
}

const run = (cmd: string, args: string[], cwd: string) =>
  new Promise<string>((resolve, reject) => {
    execFile(cmd, args, { cwd, env: staffStartEnv(process.env), timeout: 60_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${err.message}\n${stderr}`.trim()));
      else resolve(stdout.trim().split('\n')[0] || 'started');
    });
  });

async function startStaff(l: Launch): Promise<string> {
  if (l.runtime === 'codex') return runCodexStaffStart(l, checkedCwd(l.cwd), LOGS);
  if (l.runtime !== 'claude-code') throw new Error(`unsupported runtime ${l.runtime}`);
  return runStaffStart(l, checkedCwd(l.cwd), STAFF_CLAUDE_SETTINGS);
}

/** Codex has no background mode: start it detached, with its output in a log file, and let it run. */
async function resumeCodex(l: Launch & { session_id: string }, cwd: string): Promise<string> {
  if (l.model && !MODEL.test(l.model)) throw new Error(`bad model ${l.model}`);
  if (l.effort && !EFFORT.test(l.effort)) throw new Error(`bad effort ${l.effort}`);
  // The role comes from the server's launch record and picks a fixed set of settings; an unknown role throws.
  const args = ['exec', 'resume', '--skip-git-repo-check', ...codexRoleArgs(l.role)];
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

/** A short research run that handles its inbox items and exits: `codex exec`, or `claude -p` when Codex is not on the machine. */
async function researchRun(l: Launch, cwd: string): Promise<string> {
  if (l.model && !MODEL.test(l.model)) throw new Error(`bad model ${l.model}`);
  if (l.effort && !EFFORT.test(l.effort)) throw new Error(`bad effort ${l.effort}`);
  if (l.runtime === 'claude-code') {
    if (!l.model || !l.effort) throw new Error('a Claude research run needs a model and an effort');
    // The run reads code and talks to the orchestrator, nothing else (see research-run.ts). It connects with the agents'
    // enrollment key, which the runner otherwise never uses: the key goes only into a private file that is removed when
    // the run exits, never into the child's environment, its arguments or a log.
    const enrollmentKey = process.env.ORCH_ENROLLMENT_KEY ?? envFile().ORCH_ENROLLMENT_KEY;
    if (!enrollmentKey) throw new Error('ORCH_ENROLLMENT_KEY is not set and not found in .env. A Claude research run needs it to connect to the orchestrator: see .env.example.');
    const config = writePrivateFile('research-mcp.json', researchMcpConfig({ mcpUrl: `${base}/mcp`, key: enrollmentKey }));
    try {
      const args = claudeResearchArgs(l, config.path);
      // The prompt goes on stdin: --allowedTools and --mcp-config take several values and would swallow a trailing prompt argument.
      return await watchedRun(l, 'claude', args, cwd, 'research', l.prompt, { ENABLE_CLAUDEAI_MCP_SERVERS: 'false' }, config);
    } catch (e) {
      config.remove();
      throw e;
    }
  }
  if (l.runtime !== 'codex') throw new Error(`unsupported runtime ${l.runtime}`);
  // `-s read-only` does not stop MCP tools, so every MCP server but the orchestrator is switched off (see research-run.ts).
  // If the list cannot be read, the run does not start: its items go back to the inbox.
  const listed = await new Promise<string>((resolve, reject) =>
    execFile('codex', ['mcp', 'list', '--json'], { cwd, env: staffStartEnv(process.env), timeout: 30_000 }, (err, stdout) => (err ? reject(new Error(`could not list the MCP servers of Codex: ${err.message.split('\n')[0]}`)) : resolve(stdout))),
  );
  const args = ['exec', '--skip-git-repo-check', '-s', 'read-only', '-c', 'approval_policy="never"', ...codexMcpDisableArgs(JSON.parse(listed), `${base}/mcp`), '-C', cwd];
  if (l.model) args.push('-m', l.model);
  if (l.effort) args.push('-c', `model_reasoning_effort="${l.effort}"`);
  args.push(l.prompt);
  return watchedRun(l, 'codex', args, cwd, 'research');
}

/**
 * Starts a short run and tells Triglav when it exits, so a run that crashed or hit the usage limit is closed at once
 * (a research run's items go back to the inbox).
 */
async function watchedRun(l: Launch, cmd: string, args: string[], cwd: string, label: string, stdin?: string, env?: Record<string, string>, privateFile?: PrivateFile): Promise<string> {
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
    privateFile?.remove();
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

/** The most characters of a reviewer's answer that are kept (for Codex only the answer and usage lines count); a longer one fails the seat. */
const REVIEW_STDOUT_MAX = 500_000;
const REVIEW_TIMEOUT_MS = 20 * 60_000;

/**
 * A code review seat: one read-only reviewer process (`codex exec` or `claude -p`, see code-review-run.ts) on a diff.
 * The runner computes the diff itself from the shas, so the server never sends a command or a diff. The process's output
 * goes to Triglav as data (`/review-output`) when it closes; nothing in it is run here.
 */
async function codeReviewRun(l: Launch, cwd: string): Promise<string> {
  if (!SHA.test(l.base_sha ?? '') || !SHA.test(l.head_sha ?? '')) throw new Error('bad base or head sha');
  if (!l.model || !MODEL.test(l.model) || !l.effort || !EFFORT.test(l.effort)) throw new Error('bad model or effort');
  const env = staffStartEnv(process.env);
  // The first review of a piece of work must start at the merge base with the job's base branch (the server says so in expect_merge_base).
  // A piece that starts at the job's last passing head must descend from it (expect_ancestor).
  if (l.answers_resolved !== undefined && typeof l.answers_resolved !== 'boolean') throw new Error('bad answers_resolved');
  const { diff, ranges } = await worktreeDiff({ cwd, base: l.base_sha!, head: l.head_sha!, env, ...baseChecks(l) });
  const stdin = reviewPrompt(l.prompt, l.base_sha!, l.head_sha!, diff);
  let cmd: string;
  let args: string[];
  let childEnv: Record<string, string> = {};
  let schema: PrivateFile | undefined;
  if (l.runtime === 'codex') {
    // `-s read-only` does not stop MCP tools: every server of the list is switched off, the orchestrator too.
    const listed = await new Promise<string>((resolve, reject) =>
      execFile('codex', ['mcp', 'list', '--json'], { cwd, env, timeout: 30_000 }, (err, stdout) => (err ? reject(new Error(`could not list the MCP servers of Codex: ${err.message.split('\n')[0]}`)) : resolve(stdout))),
    );
    schema = writePrivateFile('review-schema.json', reviewSchemaJson('codex', l.answers_resolved === true));
    try {
      args = codexReviewArgs(l, cwd, JSON.parse(listed), schema.path);
    } catch (e) {
      schema.remove();
      throw e;
    }
    cmd = 'codex';
  } else if (l.runtime === 'claude-code') {
    args = claudeReviewArgs(l);
    cmd = 'claude';
    childEnv = { ENABLE_CLAUDEAI_MCP_SERVERS: 'false' };
  } else {
    throw new Error(`unsupported runtime ${l.runtime}`);
  }
  // Runs in the background; the launch is acknowledged now and the output is posted when the process closes.
  void runReviewer({ cmd, args, cwd, env: { ...env, ...childEnv }, stdin, maxStdout: REVIEW_STDOUT_MAX, timeoutMs: REVIEW_TIMEOUT_MS, keepLine: l.runtime === 'codex' ? codexKeepLine : undefined })
    .then((r) => reviewerReport(r, ranges), (e: Error) => ({ code: 1, stdout: '', stderr: `could not start the reviewer: ${e.message.split('\n')[0]}`, secs: 0 }))
    .then((body) => {
      schema?.remove();
      console.log(new Date().toISOString(), 'code review run', l.id, 'finished', body.code);
      const send = (n: number): Promise<unknown> => call(`/api/runner/${l.id}/review-output`, body).catch(async (e) => {
        console.error('report review output:', (e as Error).message);
        if (n > 0) {
          await new Promise((r) => setTimeout(r, 5000));
          await send(n - 1);
        }
      });
      return send(3);
    });
  return 'started code review run';
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
const operatorChats = new OperatorChats({
  base,
  key,
  bin: process.env.ORCH_CLAUDE_BIN ?? 'claude',
  cwd: join(import.meta.dirname, '..'),
  logs: LOGS,
  model: process.env.ORCH_OPERATOR_MODEL ?? 'claude-sonnet-5-5',
  effort: process.env.ORCH_OPERATOR_EFFORT ?? 'medium',
});
shutdown = () => operatorChats.shutdown();
void operatorChats.run();

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
