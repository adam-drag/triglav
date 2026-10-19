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
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { parseReviewerOutput, resolveSeats, type PanelSeat, type RuntimeId, type Usage } from '../../src/code-review.ts';
import { claudeReviewArgs, codexKeepLine, codexReviewArgs, diffForSeat, REPEAT_MEMBER, REVIEW_SCHEMA_JSON, reviewerReport, reviewPrompt, runReviewer, worktreeDiff, type ReviewerResult } from '../code-review-run.ts';
import { writePrivateFile } from '../private-file.ts';
import { staffStartEnv } from '../staff-start.ts';
import type { Fixture, Run, RunMode, SeatConfig, SeatManifest, SeatRun } from './data.ts';
import { variantPrompt, type PromptVariant } from './lean-prompt.ts';
import { repositoryRulesAt } from '../review-rules.ts';
import { seatInput } from './score.ts';

/** The runner's limits for a seat. Keep in step with REVIEW_STDOUT_MAX and REVIEW_TIMEOUT_MS in scripts/runner.ts (a test checks it). */
export const REVIEW_STDOUT_MAX = 500_000;
export const REVIEW_TIMEOUT_MS = 20 * 60_000;

/**
 * The text a seat gets on stdin: the server prompt (production unless the arm picks another) for the fixture's ticket and
 * notes, the repository rules section (from `repositoryRulesAt`, the runner's own reader), then the diff.
 */
export function seatPrompt(fixture: Fixture, seat: Pick<PanelSeat, 'seat' | 'runtime'>, diff: string, prompt: PromptVariant = 'production', rules: string | null = null): string {
  const server = variantPrompt(prompt, {
    seat: seat.seat,
    runtime: seat.runtime,
    ticket: { identifier: null, title: fixture.title, description: '', criteria: '' },
    notes: fixture.notes || null,
  });
  // The runner's own function: a repeat member of the strong seat (strong-2 and later) reads the files in its seeded order.
  return reviewPrompt(server, fixture.base, fixture.head, diffForSeat(diff, seat.seat, fixture.head), rules);
}

/** The command of a seat, from the production builders. `mcpList` is the parsed output of `codex mcp list --json`. */
export function seatCommand(seat: PanelSeat, cwd: string, mcpList: unknown, schemaPath: string): { cmd: string; args: string[]; childEnv: Record<string, string> } {
  if (seat.runtime === 'codex') return { cmd: 'codex', args: codexReviewArgs(seat, cwd, mcpList, schemaPath), childEnv: {} };
  if (seat.runtime === 'claude-code') return { cmd: 'claude', args: claudeReviewArgs(seat), childEnv: { ENABLE_CLAUDEAI_MCP_SERVERS: 'false' } };
  throw new Error(`unsupported runtime ${String((seat as { runtime: unknown }).runtime)}`);
}

/**
 * A seat of an arm: what runs (the PanelSeat fields), what the arm asked for, and why the two differ. In fixed mode they are
 * the same; in production mode resolveSeats may move a seat to another CLI or model, and `note` says why.
 */
export type ArmSeat = PanelSeat & { requested?: SeatConfig; note?: string | null };

const configOfSeat = (s: Pick<PanelSeat, 'runtime' | 'model' | 'effort'>): SeatConfig => ({ runtime: s.runtime, model: s.model, effort: s.effort });

/** Fixed mode: every seat runs exactly as the arm names it. A CLI or model that is missing makes the seat fail; nothing falls back. */
export const fixedSeats = (panel: PanelSeat[]): ArmSeat[] => panel.map((s) => ({ ...s, requested: configOfSeat(s), note: null }));

/**
 * Production mode: the arm's seats resolved the way a real review resolves them (resolveSeats, the same function), from
 * what this machine has. The members of a repeated strong seat get their group back, so resolveSeats keeps them as it does
 * for a panel with a count. A seat that resolveSeats moves keeps its name and carries what the arm asked for, so the scorer
 * can tell it apart.
 */
export function productionSeats(panel: PanelSeat[], o: { available: Record<RuntimeId, boolean>; models?: Partial<Record<RuntimeId, string[]>>; codexUsed: number; requesterRuntime: string | null }): { ok: true; seats: ArmSeat[]; dropped: { seat: string; reason: string }[] } | { ok: false; reason: string } {
  const strongs = panel.filter((s) => s.kind === 'strong').length;
  const grouped = panel.map((s) => (s.kind === 'strong' && strongs > 1 ? { ...s, group: 'strong' } : s));
  const r = resolveSeats({ panel: grouped, available: o.available, models: o.models, codexUsed: o.codexUsed, requesterRuntime: o.requesterRuntime });
  if (!r.ok) return r;
  const seats = r.seats.map(({ family: _f, note, ...s }): ArmSeat => ({ ...s, requested: configOfSeat(panel.find((p) => p.seat === s.seat)!), note }));
  return { ok: true, seats, dropped: r.dropped };
}

/**
 * The token estimate of one seat on a diff of `diffChars` characters: input (cached included) plus output. Fitted above the
 * three stored baseline runs (strong 0.60M to 1.38M, the cheap Claude seat 0.10M to 0.41M on diffs of 12k to 125k
 * characters), so it is an upper guess for the default panel's models, not a prediction for other models.
 */
export const SEAT_ESTIMATE = { strong: { base: 600_000, perDiffChar: 8 }, cheap: { base: 100_000, perDiffChar: 3 } } as const;
export const estimateSeatTokens = (kind: PanelSeat['kind'], diffChars: number): number => SEAT_ESTIMATE[kind].base + SEAT_ESTIMATE[kind].perDiffChar * diffChars;

/**
 * Admission budget of a run, in tokens (input with the cached ones, plus output). Work is admitted only while the estimate
 * fits in what is left beside what is already reserved. It is an admission stop, not a live cap: a seat that is running is
 * never stopped, so the real use can go over the limit by as much as the running seats use above their estimates.
 */
export class Budget {
  used = 0;
  reserved = 0;
  readonly limit: number | null;
  constructor(limit: number | null) {
    this.limit = limit;
  }
  left(): number {
    return this.limit === null ? Infinity : this.limit - this.used - this.reserved;
  }
  /** Reserves `n` tokens when they fit, and says whether they did. */
  tryReserve(n: number): boolean {
    if (this.limit !== null && this.used + this.reserved + n > this.limit) return false;
    this.reserved += n;
    return true;
  }
  /** An attempt ended: its reservation is released and what it was charged is used. */
  settle(reserved: number, charged: number): void {
    this.reserved = Math.max(0, this.reserved - reserved);
    this.used += charged;
  }
}

/**
 * What an attempt costs against the budget: its reported tokens (input with the cached ones, plus output); the estimate when
 * a process ran and reported no usage (it may still have spent tokens); 0 when no process started.
 */
export function chargedTokens(runtime: RuntimeId, usage: Usage, started: boolean, estimate: number, cut = false): number {
  if (!started) return 0;
  const input = seatInput({ runtime, usage });
  if (!input && usage.tokensOut === null) return estimate;
  const reported = (input?.input ?? 0) + (usage.tokensOut ?? 0);
  // A run over the output cap may have printed usage lines after the cut that were never read: what was read is a lower bound.
  return cut ? Math.max(reported, estimate) : reported;
}

/** Runs at most `n` tasks at a time; the others wait their turn in order. */
export function limiter(n: number): <T>(task: () => Promise<T>) => Promise<T> {
  if (!Number.isInteger(n) || n < 1) throw new Error('concurrency must be a whole number of at least 1');
  let active = 0;
  const queue: (() => void)[] = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= n) await new Promise<void>((go) => queue.push(go));
    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      queue.shift()?.();
    }
  };
}

const sumUsage = (a: Usage, b: Usage): Usage => {
  const add = (x: number | null, y: number | null) => (x === null && y === null ? null : (x ?? 0) + (y ?? 0));
  return { tokensIn: add(a.tokensIn, b.tokensIn), tokensCached: add(a.tokensCached, b.tokensCached), tokensOut: add(a.tokensOut, b.tokensOut), costUsd: add(a.costUsd, b.costUsd) };
};
const NO_USAGE: Usage = { tokensIn: null, tokensCached: null, tokensOut: null, costUsd: null };
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

export interface SeatOutput {
  seat: SeatRun;
  /** Output of the last attempt. */
  stdout: string;
  stderr: string;
  /** Output of every attempt, in order (the last one is `stdout` and `stderr` again). */
  attempts: { stdout: string; stderr: string }[];
}

export interface SeatDeps {
  /** The process runner; a test passes a fake so nothing starts. */
  run?: typeof runReviewer;
  /** Which review prompt the arm uses (default production). */
  prompt?: PromptVariant;
  /** The repository rules section of the fixture (runFixture reads it once); none when a test leaves it out. */
  rules?: string | null;
  env: NodeJS.ProcessEnv;
  mcpList: unknown;
  /** The repeat of the arm, for the manifest (default 1). */
  repeat?: number;
  /** `--version` of each CLI, for the manifest. */
  cliVersions?: Partial<Record<RuntimeId, string | null>>;
  /** How many times a failed attempt is run again (default 0). Every attempt's usage counts. */
  retries?: number;
  /** The budget of the run. The caller has reserved `estimate` for the first attempt; a retry reserves its own and is not run when it does not fit. */
  budget?: Budget;
  estimate?: number;
  /** Bounds how many reviewer processes run at once. */
  limit?: <T>(task: () => Promise<T>) => Promise<T>;
  /** Writes the Codex output schema file (default `writePrivateFile`); a test passes one whose cleanup fails. */
  writeSchema?: typeof writePrivateFile;
}

export interface FixtureDeps {
  run?: typeof runReviewer;
  /** Which review prompt the arm uses (default production). */
  prompt?: PromptVariant;
  env: NodeJS.ProcessEnv;
  /** `codex mcp list --json` parsed, asked in the worktree the reviewers start in, as the runner does: a project's own Codex config can add servers. */
  listMcp: (cwd: string) => Promise<unknown>;
  /** The diff of base..head; worktreeDiff (the runner's own checks) unless a test passes another. */
  diff?: (o: { cwd: string; base: string; head: string; env: NodeJS.ProcessEnv }) => Promise<{ diff: string }>;
  /** The repository rules section; the runner's reader at the fixture's base (its PR merge base) unless a test passes another. */
  rules?: (o: { cwd: string; commit: string; head: string; env: NodeJS.ProcessEnv }) => Promise<{ section: string }>;
  mode?: RunMode;
  repeat?: number;
  cliVersions?: Partial<Record<RuntimeId, string | null>>;
  retries?: number;
  budget?: Budget;
  limit?: <T>(task: () => Promise<T>) => Promise<T>;
  /** Production mode: what was resolved, for the run manifest. */
  dropped?: { seat: string; reason: string }[];
  requesterRuntime?: string | null;
  codexUsed?: number | null;
  harness?: { rev: string | null; dirty: boolean | null };
  now?: () => Date;
}

interface Attempted {
  code: number | null;
  secs: number;
  stdout: string;
  stderr: string;
  started: boolean;
  /** The output went over the cap, so the usage read is a lower bound. */
  cut: boolean;
  usage: Usage;
  ok: boolean;
  error: string | undefined;
  rejected: number;
  findings: SeatRun['findings'];
}

/** One reviewer process of a seat. */
async function attemptSeat(seat: ArmSeat, cwd: string, stdin: string, deps: SeatDeps): Promise<Attempted> {
  const schema = seat.runtime === 'codex' ? (deps.writeSchema ?? writePrivateFile)('review-schema.json', REVIEW_SCHEMA_JSON) : undefined;
  try {
    const { cmd, args, childEnv } = seatCommand(seat, cwd, deps.mcpList, schema?.path ?? '');
    let started = true;
    let raw: ReviewerResult | null = null;
    const result = await (deps.run ?? runReviewer)({
      cmd,
      args,
      cwd,
      env: { ...deps.env, ...childEnv },
      stdin,
      maxStdout: REVIEW_STDOUT_MAX,
      timeoutMs: REVIEW_TIMEOUT_MS,
      keepLine: seat.runtime === 'codex' ? codexKeepLine : undefined,
    }).then((r) => ((raw = r), reviewerReport(r)), (e: Error) => ((started = false), { code: 1 as number | null, stdout: '', stderr: `could not start the reviewer: ${e.message.split('\n')[0]}`, secs: 0 }));
    // A failed run can still have spent tokens (a Claude error envelope carries its usage), so the output is always parsed for usage.
    // Its findings are kept only when the process exited 0: a failed seat has no findings.
    const parsed = result.stdout.trim() ? parseReviewerOutput(seat.runtime, result.stdout, cwd) : null;
    // reviewerReport empties the output of a killed or cut process, as the runner does; the usage it printed before that
    // (Codex prints one line per turn) still counts, so it is read from the process's own output.
    // runReviewer itself drops the output of a run over the cap and keeps what fit before the cap in `cutStdout`.
    const kept = raw as ReviewerResult | null;
    const printed = kept ? kept.stdout || kept.cutStdout || '' : '';
    const rawUsage = !parsed && printed.trim() ? parseReviewerOutput(seat.runtime, printed, cwd).usage : null;
    const ok = result.code === 0 && parsed?.ok === true;
    const error = result.code !== 0 ? `exit ${result.code}: ${result.stderr.slice(-300)}` : parsed?.ok === false ? parsed.error : parsed ? undefined : 'the reviewer printed nothing';
    return { code: result.code, secs: result.secs, stdout: printed || result.stdout, stderr: result.stderr, started, cut: kept?.overflow === true, usage: parsed?.usage ?? rawUsage ?? NO_USAGE, ok, error, rejected: ok ? parsed.rejected : 0, findings: ok ? parsed.findings : [] };
  } finally {
    // A cleanup error must not lose the attempt's result and usage; the runner's exit removes what is left.
    try {
      schema?.remove();
    } catch {}
  }
}

/**
 * Runs one seat on a prepared diff and returns what it found, with its manifest. A seat that fails is reported as failed,
 * never as an empty pass. With `retries`, a failed attempt runs again while the budget admits it; the findings are those of
 * the last attempt, and the usage is the sum of every attempt.
 */
export async function runSeat(fixture: Fixture, seat: ArmSeat, cwd: string, diff: string, deps: SeatDeps): Promise<SeatOutput> {
  const stdin = seatPrompt(fixture, seat, diff, deps.prompt, deps.rules ?? null);
  const estimate = deps.estimate ?? 0;
  const limit = deps.limit ?? ((task) => task());
  const attempts: SeatManifest['attempts'] = [];
  const raw: { stdout: string; stderr: string }[] = [];
  let last: Attempted | null = null;
  let retryRefused = false;
  let prepFailed = false;
  for (let n = 1; n <= 1 + (deps.retries ?? 0); n += 1) {
    if (n > 1 && deps.budget && !deps.budget.tryReserve(estimate)) {
      retryRefused = true;
      break;
    }
    let a: Attempted;
    try {
      a = await limit(() => attemptSeat(seat, cwd, stdin, deps));
    } catch (e) {
      // The command could not be prepared (a list the builder rejects, a file that cannot be written). No process started,
      // so nothing is charged; earlier attempts keep their usage and output, and the seat ends here.
      const error = `could not prepare the reviewer: ${(e as Error).message.split('\n')[0]}`;
      a = { code: null, secs: 0, stdout: '', stderr: error, started: false, cut: false, usage: NO_USAGE, ok: false, error, rejected: 0, findings: [] };
      prepFailed = true;
    }
    const charged = chargedTokens(seat.runtime, a.usage, a.started, estimate, a.cut);
    deps.budget?.settle(estimate, charged);
    attempts.push({ attempt: n, code: a.code, secs: Math.round(a.secs * 10) / 10, usage: a.usage, charged, started: a.started, ...(a.cut ? { cut: true } : {}), error: a.error ?? null });
    raw.push({ stdout: a.stdout, stderr: a.stderr });
    last = a;
    if (a.ok || prepFailed) break;
  }
  const a = last!;
  const error = a.error !== undefined && retryRefused ? `${a.error} (a retry was not admitted: the budget has no room for its estimate)` : a.error;
  const usage = attempts.map((x) => x.usage).reduce(sumUsage, NO_USAGE);
  const secs = Math.round(attempts.reduce((t, x) => t + x.secs, 0) * 10) / 10;
  const manifest = seatManifest(fixture, seat, stdin, deps, { rejected: a.rejected, findings: a.findings, failure: error ?? null, attempts });
  return {
    seat: { seat: seat.seat, runtime: seat.runtime, model: seat.model, effort: seat.effort, code: a.code, secs, prompt_chars: stdin.length, diff_chars: diff.length, rejected: a.rejected, usage, ...(error ? { error } : {}), findings: a.findings, manifest },
    stdout: a.stdout,
    stderr: a.stderr,
    attempts: raw,
  };
}

function seatManifest(fixture: Fixture, seat: ArmSeat, stdin: string, deps: Pick<SeatDeps, 'repeat' | 'cliVersions'>, o: { rejected: number; findings: SeatRun['findings']; failure: string | null; attempts: SeatManifest['attempts'] }): SeatManifest {
  return {
    cli_version: deps.cliVersions?.[seat.runtime] ?? null,
    requested: seat.requested ?? configOfSeat(seat),
    effective: configOfSeat(seat),
    fallback_reason: seat.note ?? null,
    prompt_sha256: sha256(stdin),
    repeat: deps.repeat ?? 1,
    // The same rule as diffForSeat: only a repeat member of the strong seat reads the files in a seeded order.
    shuffle_seed: REPEAT_MEMBER.test(seat.seat) ? `${seat.seat}\n${fixture.head}` : null,
    rejected: o.rejected,
    zero_site: o.findings.filter((f) => f.sites.length === 0).length,
    failure: o.failure,
    attempts: o.attempts,
  };
}

/** A seat that could not start: no process ran, no tokens were spent, and it has no findings. */
function failedSeat(fixture: Fixture, seat: ArmSeat, diff: string, reason: string, deps: Pick<SeatDeps, 'prompt' | 'repeat' | 'cliVersions' | 'rules'>): SeatOutput {
  const stdin = seatPrompt(fixture, seat, diff, deps.prompt, deps.rules ?? null);
  const attempts = [{ attempt: 1, code: null, secs: 0, usage: NO_USAGE, charged: 0, started: false, error: reason }];
  return {
    seat: { seat: seat.seat, runtime: seat.runtime, model: seat.model, effort: seat.effort, code: null, secs: 0, prompt_chars: stdin.length, diff_chars: diff.length, rejected: 0, usage: NO_USAGE, error: reason, findings: [], manifest: seatManifest(fixture, seat, stdin, deps, { rejected: 0, findings: [], failure: reason, attempts }) },
    stdout: '',
    stderr: reason,
    attempts: [{ stdout: '', stderr: reason }],
  };
}

/**
 * Runs the seats of a panel on one fixture, in parallel like a real review (at most `limit` processes at once), in a
 * worktree that is at the fixture's head. With a budget, the caller has reserved `estimateSeatTokens` for each seat.
 */
export async function runFixture(fixture: Fixture, panel: ArmSeat[], cwd: string, arm: string, deps: FixtureDeps): Promise<{ run: Run; outputs: SeatOutput[] }> {
  const now = deps.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const estimateOf = (s: ArmSeat) => (deps.budget ? estimateSeatTokens(s.kind, fixture.diff_chars) : 0);
  // The same diff check as the runner: the worktree is at the head and clean, and a diff over the limit is refused, never cut.
  let diff: string;
  try {
    ({ diff } = await (deps.diff ?? worktreeDiff)({ cwd, base: fixture.base, head: fixture.head, env: deps.env }));
  } catch (e) {
    for (const s of panel) deps.budget?.settle(estimateOf(s), 0);
    throw e;
  }
  // The rules as a production seat gets them, read by the runner's reader with git at the fixture's base (the PR's merge base;
  // the merge base with origin/main would be the head itself once the PR is merged). A fixture whose rules cannot be read fails, like a seat.
  let rules: string;
  try {
    ({ section: rules } = await (deps.rules ?? repositoryRulesAt)({ cwd, commit: fixture.base, head: fixture.head, env: deps.env }));
  } catch (e) {
    for (const s of panel) deps.budget?.settle(estimateOf(s), 0);
    throw e;
  }
  const seatDeps = { prompt: deps.prompt, repeat: deps.repeat, cliVersions: deps.cliVersions, rules };
  // When the Codex servers cannot be listed, a Codex seat must not start (with no list every configured server would stay on).
  // It is recorded as failed and the other seats and fixtures go on.
  let mcpList: unknown = [];
  let mcpError: string | null = null;
  if (panel.some((s) => s.runtime === 'codex')) {
    try {
      mcpList = await deps.listMcp(cwd);
    } catch (e) {
      mcpError = (e as Error).message.split('\n')[0]!;
    }
  }
  const outputs = await Promise.all(
    panel.map((seat): Promise<SeatOutput> => {
      const failed = (reason: string) => (deps.budget?.settle(estimateOf(seat), 0), failedSeat(fixture, seat, diff, reason, seatDeps));
      if (seat.runtime === 'codex' && mcpError !== null) return Promise.resolve(failed(mcpError));
      // A seat whose command cannot be built (a list the builder rejects, a file that cannot be written) fails alone: the other seats finish and the run is saved.
      return runSeat(fixture, seat, cwd, diff, { ...seatDeps, run: deps.run, env: deps.env, mcpList, retries: deps.retries, budget: deps.budget, estimate: estimateOf(seat), limit: deps.limit }).catch((e: Error) =>
        failedSeat(fixture, seat, diff, `could not prepare the reviewer: ${e.message.split('\n')[0]}`, seatDeps),
      );
    }),
  );
  const manifest = {
    mode: deps.mode ?? 'fixed',
    repeat: deps.repeat ?? 1,
    harness_rev: deps.harness?.rev ?? null,
    harness_dirty: deps.harness?.dirty ?? null,
    diff_sha256: sha256(diff),
    requester_runtime: deps.requesterRuntime ?? null,
    codex_used: deps.codexUsed ?? null,
    dropped: deps.dropped ?? [],
    started_at: startedAt,
    finished_at: now().toISOString(),
  };
  return { run: { arm, fixture: fixture.id, base: fixture.base, head: fixture.head, prompt: deps.prompt ?? 'production', manifest, seats: outputs.map((o) => o.seat) }, outputs };
}

/** What runArm needs besides the fixtures and seats: how to prepare a worktree, what is already stored, and where to store a result. */
export interface ArmDeps extends Omit<FixtureDeps, 'budget' | 'limit'> {
  /** A worktree at the fixture's head (ensureWorktree in the CLI). */
  prepare: (fixture: Fixture) => string;
  /** True when the arm already has a result for the fixture: it is kept and never paid for twice. */
  done: (fixture: Fixture) => boolean;
  store: (fixture: Fixture, out: { run: Run; outputs: SeatOutput[] }) => void;
  log?: (line: string) => void;
  /** Admission budget in tokens; null for none. */
  budgetTokens?: number | null;
  /** Reviewer processes at once (default: every seat of a fixture). */
  concurrency?: number;
}

export interface ArmResult {
  ran: string[];
  skipped: string[];
  /** The fixture that was not admitted, its estimate and what was left, and the fixtures after it that were not started. */
  stopped: { fixture: string; estimate: number; left: number; notStarted: string[] } | null;
  used: number;
}

/**
 * Runs an arm fixture by fixture. Before each fixture it checks the budget: when the fixture's estimate (every seat, from
 * its diff size) does not fit in what is left, it admits nothing more and says so. Seats run at most `concurrency` at a time.
 */
export async function runArm(fixtures: Fixture[], seats: ArmSeat[], arm: string, deps: ArmDeps): Promise<ArmResult> {
  const log = deps.log ?? (() => {});
  const budget = new Budget(deps.budgetTokens ?? null);
  const limit = limiter(deps.concurrency ?? Math.max(1, seats.length));
  const result: ArmResult = { ran: [], skipped: [], stopped: null, used: 0 };
  for (const [i, fx] of fixtures.entries()) {
    if (deps.done(fx)) {
      result.skipped.push(fx.id);
      log(`${fx.id} already has a result - skipped`);
      continue;
    }
    const estimate = seats.reduce((t, s) => t + estimateSeatTokens(s.kind, fx.diff_chars), 0);
    if (!budget.tryReserve(estimate)) {
      const notStarted = fixtures.slice(i + 1).filter((f) => !deps.done(f)).map((f) => f.id);
      result.stopped = { fixture: fx.id, estimate, left: budget.left(), notStarted };
      log(`admission stop: ${fx.id} is estimated at ${estimate} tokens and ${budget.left()} are left of ${budget.limit}; not started: ${[fx.id, ...notStarted].join(', ')}`);
      break;
    }
    const cwd = deps.prepare(fx);
    const out = await runFixture(fx, seats, cwd, arm, { ...deps, budget, limit });
    deps.store(fx, out);
    result.ran.push(fx.id);
    for (const s of out.run.seats) log(`${fx.id} ${s.seat} code ${s.code} ${s.secs}s ${s.error ? `FAILED ${s.error}` : `${s.findings.length} finding(s)`}${s.manifest && s.manifest.attempts.length > 1 ? ` after ${s.manifest.attempts.length} attempts` : ''}`);
  }
  result.used = budget.used;
  return result;
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
 * head; it is never changed or removed here. `env` is the scrubbed environment: a post-checkout hook of the repository runs with it.
 */
export function ensureWorktree(repo: string, dir: string, head: string, env: NodeJS.ProcessEnv): void {
  if (existsSync(dir)) {
    const at = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8', env }).trim();
    if (at !== head) throw new Error(`${dir} is at ${at.slice(0, 12)}, not at ${head.slice(0, 12)}`);
    return;
  }
  execFileSync('git', ['worktree', 'add', '--detach', dir, head], { cwd: repo, stdio: 'ignore', env });
}
