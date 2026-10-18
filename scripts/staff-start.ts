/**
 * Starts a Staff agent for a job request the Client made in the dashboard.
 *
 * The launch carries only a request id, a directory, a model and an effort. This module checks each of them and builds
 * the whole command and the start prompt itself: the Client's ticket URL and prompt text stay on the server and Staff
 * reads them over MCP. Kept apart from runner.ts, which has a top-level loop, so the tests can import it.
 */
import { execFile, spawn } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import { codexRoleArgs } from '../src/codex-args.ts';

/** Keep in step with REQUEST_ID in src/job-requests.ts. */
export const REQUEST_ID = /^req_[0-9a-f]{16}$/;
// The first character must not be "-", so a value can never be read as an option.
export const MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
// The levels `claude --help` lists for --effort (Claude Code 2.1.292).
export const EFFORT = /^(low|medium|high|xhigh|max)$/;

/** A launch id as the server makes it (newId('lch')). The runner puts it in a log file name and in a URL, so it checks it first. */
export const LAUNCH_ID = /^lch_[0-9a-f]{16}$/;
export function checkLaunchId(id: unknown): string {
  if (typeof id !== 'string' || !LAUNCH_ID.test(id)) throw new Error(`bad launch id ${JSON.stringify(String(id)).slice(0, 60)}`);
  return id;
}

export type StaffStart = { request_id?: string | null; model?: string | null; effort?: string | null };

/**
 * The fixed start prompt for Claude Code. The guide's Staff card explains what "Start job request" means.
 *
 * `claude --bg` starts the first model turn before the MCP servers connect, which took 3.5 to 13.7 s in transcripts (seen 2026-10-15: a
 * session said "there's no get_guide tool" and ended its turn, then idled for ever). Telling the model to call the tool by its full
 * name anyway was never reliable: 8 of the 32 starts with that prompt (2026-10-15 to 2026-10-18) ended that way, and a probe told to
 * call it blind refused too. The session runs in a pre-started `claude bg-spare` process, so an environment variable set by the runner does not
 * reach it. A first turn that waits in Bash does get the tools (all 39 after 25 s), so the prompt makes the wait the first step.
 */
export const staffStartPrompt = (requestId: string) =>
  `The MCP servers connect a few seconds after this turn starts. First run this Bash command to give them time: timeout 20 tail -f /dev/null; true. If mcp__orchestrator__get_guide is still not among your tools, run it again, up to 3 times. Then call mcp__orchestrator__get_guide with role staff and follow it. Never end your first turn without calling it. Start job request ${requestId}.`;

/** The start prompt for Codex, which names MCP tools differently. Unchanged from before the Claude prompt was reworded. */
export const codexStaffStartPrompt = (requestId: string) => `Call get_guide with role staff and follow it. Start job request ${requestId}.`;

/** Arguments for `claude`. `settings` is the runner's STAFF_CLAUDE_SETTINGS. Throws on a field that does not match. */
export function staffStartArgs(l: StaffStart, settings: string): string[] {
  const id = l.request_id ?? '';
  if (!REQUEST_ID.test(id)) throw new Error(`bad job request id ${JSON.stringify(String(id)).slice(0, 60)}`);
  if (!l.model || !MODEL.test(l.model)) throw new Error(`bad model ${JSON.stringify(String(l.model)).slice(0, 60)}`);
  if (!l.effort || !EFFORT.test(l.effort)) throw new Error(`bad effort ${JSON.stringify(String(l.effort)).slice(0, 60)}`);
  return ['--bg', '-n', `staff-${id}`, '--settings', settings, '--model', l.model, '--effort', l.effort, staffStartPrompt(id)];
}

/** Codex accepts more effort levels than Claude Code (`codex debug models` lists up to "ultra"); the model list decides which, so this only keeps the value a plain word. */
export const CODEX_EFFORT = /^[a-z]{1,20}$/;

/**
 * Arguments for `codex exec`, the way the Models page launch command starts a Codex Staff: it may write in the repository,
 * and an automatic reviewer decides what needs more (see codexRoleArgs). Codex has no background mode, so the runner keeps it running detached. Throws on a field that does not match.
 */
export function codexStaffStartArgs(l: StaffStart): string[] {
  const id = l.request_id ?? '';
  if (!REQUEST_ID.test(id)) throw new Error(`bad job request id ${JSON.stringify(String(id)).slice(0, 60)}`);
  if (!l.model || !MODEL.test(l.model)) throw new Error(`bad model ${JSON.stringify(String(l.model)).slice(0, 60)}`);
  if (!l.effort || !CODEX_EFFORT.test(l.effort)) throw new Error(`bad effort ${JSON.stringify(String(l.effort)).slice(0, 60)}`);
  return ['exec', '--skip-git-repo-check', ...codexRoleArgs('staff'), '-m', l.model, '-c', `model_reasoning_effort="${l.effort}"`, codexStaffStartPrompt(id)];
}

/** Starts `codex exec` detached in the (already checked) directory, with its output in `logDir`, and returns what it started. */
export async function runCodexStaffStart(l: StaffStart, cwd: string, logDir: string, opts: { bin?: string; env?: NodeJS.ProcessEnv } = {}): Promise<string> {
  const args = codexStaffStartArgs(l);
  mkdirSync(logDir, { recursive: true });
  const log = `${logDir}/codex-staff-${l.request_id}.log`;
  const fd = openSync(log, 'a');
  const child = spawn(opts.bin ?? 'codex', args, { cwd, env: staffStartEnv(opts.env ?? process.env), detached: true, stdio: ['ignore', fd, fd] });
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', (err) => {
      const hint = startFailureHint({ code: (err as NodeJS.ErrnoException).code, text: err.message }, 'codex', cwd);
      reject(new Error(hint ? `${hint}\n${err.message}` : err.message));
    });
  });
  child.unref();
  return `started codex staff pid ${child.pid}, log ${log}`;
}

/** The environment of a process the runner starts (Staff, resumes, research runs, the Operator) without the orchestrator's own settings and secrets. */
export function staffStartEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !/^(ORCH_|MYSQL_)/.test(k) && k !== 'DATABASE_URL' && k !== 'LINEAR_API_KEY'));
}

/**
 * One plain sentence for a start failure the Client can act on, or null when the failure is not one we know. The raw
 * text follows it in the result, so nothing is hidden. `bin` is the command that was started.
 */
export function startFailureHint(failure: { code?: unknown; killed?: boolean; text: string }, bin: string, cwd: string): string | null {
  if (/Workspace not trusted/i.test(failure.text)) return `${bin === 'codex' ? 'Codex' : 'Claude Code'} does not trust ${cwd} yet. Run "cd ${cwd} && ${bin}" once, accept the trust prompt, then retry.`;
  if (failure.code === 'ENOENT') return `The command "${bin}" was not found on the runner's PATH. Install it, or start the runner from a shell where it works.`;
  if (failure.killed) return `"${bin}" did not finish starting in time and was stopped.`;
  return null;
}

/** Runs `claude --bg` in the (already checked) directory and returns its first output line, for example the session id. */
export function runStaffStart(l: StaffStart, cwd: string, settings: string, opts: { bin?: string; env?: NodeJS.ProcessEnv } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = staffStartArgs(l, settings);
    const bin = opts.bin ?? 'claude';
    execFile(bin, args, { cwd, env: staffStartEnv(opts.env ?? process.env), timeout: 60_000, killSignal: 'SIGKILL' }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout.trim().split('\n')[0] || 'started');
      const raw = `${err.message}\n${stderr}`.trim();
      const hint = startFailureHint({ code: (err as NodeJS.ErrnoException).code, killed: err.killed, text: raw }, bin.split('/').pop() ?? bin, cwd);
      reject(new Error(hint ? `${hint}\n${raw}` : raw));
    });
  });
}
