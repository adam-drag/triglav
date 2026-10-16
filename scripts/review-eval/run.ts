/**
 * Runs the seats of a panel on a fixture exactly as the host runner runs a code review seat: the diff from `worktreeDiff`,
 * the prompt from `buildReviewPrompt` and `reviewPrompt`, the command from `claudeReviewArgs` or `codexReviewArgs`, the
 * process from `runReviewer`, the report from `reviewerReport`, the answer from `parseReviewerOutput`, and the environment
 * from `staffStartEnv`. This file builds no command line of its own: a reviewer here has the same access as a
 * production one, and no Triglav secret.
 *
 * A live run costs real tokens, so nothing here starts on its own: `cli.ts` runs it by hand only (see its `run` command).
 * It is not part of the Docker image (the Dockerfile copies `src` and `web`) and CI does not call it.
 */
import { execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { buildReviewPrompt, parseReviewerOutput, type PanelSeat } from '../../src/code-review.ts';
import { claudeReviewArgs, codexKeepLine, codexReviewArgs, REVIEW_SCHEMA_JSON, reviewerReport, reviewPrompt, runReviewer, worktreeDiff } from '../code-review-run.ts';
import { writePrivateFile } from '../private-file.ts';
import { staffStartEnv } from '../staff-start.ts';
import type { Fixture, Run, SeatRun } from './data.ts';

/** The runner's limits for a seat. Keep in step with REVIEW_STDOUT_MAX and REVIEW_TIMEOUT_MS in scripts/runner.ts (a test checks it). */
export const REVIEW_STDOUT_MAX = 500_000;
export const REVIEW_TIMEOUT_MS = 20 * 60_000;

/** The text a seat gets on stdin: the production server prompt for the fixture's ticket and notes, then the diff. */
export function seatPrompt(fixture: Fixture, seat: Pick<PanelSeat, 'seat' | 'runtime'>, diff: string): string {
  const server = buildReviewPrompt({
    seat: seat.seat,
    runtime: seat.runtime,
    ticket: { identifier: null, title: fixture.title, description: '', criteria: '' },
    notes: fixture.notes || null,
  });
  return reviewPrompt(server, fixture.base, fixture.head, diff);
}

/** The command of a seat, from the production builders. `mcpList` is the parsed output of `codex mcp list --json`. */
export function seatCommand(seat: PanelSeat, cwd: string, mcpList: unknown, schemaPath: string): { cmd: string; args: string[]; childEnv: Record<string, string> } {
  if (seat.runtime === 'codex') return { cmd: 'codex', args: codexReviewArgs(seat, cwd, mcpList, schemaPath), childEnv: {} };
  if (seat.runtime === 'claude-code') return { cmd: 'claude', args: claudeReviewArgs(seat), childEnv: { ENABLE_CLAUDEAI_MCP_SERVERS: 'false' } };
  throw new Error(`unsupported runtime ${String((seat as { runtime: unknown }).runtime)}`);
}

export interface SeatOutput {
  seat: SeatRun;
  stdout: string;
  stderr: string;
}

export interface RunDeps {
  /** The process runner; a test passes a fake so nothing starts. */
  run?: typeof runReviewer;
  env: NodeJS.ProcessEnv;
  mcpList: unknown;
}

/** Runs one seat on a prepared diff and returns what it found. A seat that fails is reported as failed, never as an empty pass. */
export async function runSeat(fixture: Fixture, seat: PanelSeat, cwd: string, diff: string, deps: RunDeps): Promise<SeatOutput> {
  const stdin = seatPrompt(fixture, seat, diff);
  const schema = seat.runtime === 'codex' ? writePrivateFile('review-schema.json', REVIEW_SCHEMA_JSON) : undefined;
  try {
    const { cmd, args, childEnv } = seatCommand(seat, cwd, deps.mcpList, schema?.path ?? '');
    const result = await (deps.run ?? runReviewer)({
      cmd,
      args,
      cwd,
      env: { ...deps.env, ...childEnv },
      stdin,
      maxStdout: REVIEW_STDOUT_MAX,
      timeoutMs: REVIEW_TIMEOUT_MS,
      keepLine: seat.runtime === 'codex' ? codexKeepLine : undefined,
    }).then(reviewerReport, (e: Error) => ({ code: 1 as number | null, stdout: '', stderr: `could not start the reviewer: ${e.message.split('\n')[0]}`, secs: 0 }));
    const parsed = result.code === 0 ? parseReviewerOutput(seat.runtime, result.stdout, cwd) : null;
    const error = result.code !== 0 ? `exit ${result.code}: ${result.stderr.slice(-300)}` : parsed && !parsed.ok ? parsed.error : undefined;
    const base = { seat: seat.seat, runtime: seat.runtime, model: seat.model, effort: seat.effort, code: result.code, secs: Math.round(result.secs * 10) / 10, prompt_chars: stdin.length, diff_chars: diff.length };
    const usage = parsed?.usage ?? { tokensIn: null, tokensCached: null, tokensOut: null, costUsd: null };
    return {
      seat: { ...base, rejected: parsed?.ok ? parsed.rejected : 0, usage, ...(error ? { error } : {}), findings: parsed?.ok ? parsed.findings : [] },
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } finally {
    schema?.remove();
  }
}

/** Runs the seats of a panel on one fixture, in parallel like a real review, in a worktree that is at the fixture's head. */
export async function runFixture(fixture: Fixture, panel: PanelSeat[], cwd: string, arm: string, deps: RunDeps): Promise<{ run: Run; outputs: SeatOutput[] }> {
  // The same diff check as the runner: the worktree is at the head and clean, and a diff over the limit is refused, never cut.
  const { diff } = await worktreeDiff({ cwd, base: fixture.base, head: fixture.head, env: deps.env });
  const outputs = await Promise.all(panel.map((seat) => runSeat(fixture, seat, cwd, diff, deps)));
  return { run: { arm, fixture: fixture.id, base: fixture.base, head: fixture.head, seats: outputs.map((o) => o.seat) }, outputs };
}

/** The environment every process here gets: this one's, without the orchestrator's secrets. */
export const evalEnv = (env: NodeJS.ProcessEnv = process.env) => staffStartEnv(env);

/** What `codex mcp list --json` prints, parsed, so every MCP server of the user's Codex can be switched off for a seat. */
export function listCodexMcp(cwd: string, env: NodeJS.ProcessEnv): Promise<unknown> {
  return new Promise((resolve, reject) =>
    execFile('codex', ['mcp', 'list', '--json'], { cwd, env, timeout: 30_000 }, (err, stdout) => {
      if (err) return reject(new Error(`could not list the MCP servers of Codex: ${err.message.split('\n')[0]}`));
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error('the MCP server list of Codex is not JSON'));
      }
    }),
  );
}

/**
 * A detached worktree of `repo` at `head`, made when `dir` does not exist yet. An existing directory must already be at the
 * head; it is never changed or removed here.
 */
export function ensureWorktree(repo: string, dir: string, head: string): void {
  if (existsSync(dir)) {
    const at = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
    if (at !== head) throw new Error(`${dir} is at ${at.slice(0, 12)}, not at ${head.slice(0, 12)}`);
    return;
  }
  execFileSync('git', ['worktree', 'add', '--detach', dir, head], { cwd: repo, stdio: 'ignore' });
}
