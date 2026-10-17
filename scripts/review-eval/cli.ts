/**
 * The review evaluation harness, by hand: `node scripts/review-eval/cli.ts <command>`. See the README ("Evaluating the
 * review panel") and docs of the triglav-code-review skill.
 *
 *   list                              the fixtures
 *   score [--runs DIR] [--judgments FILE] [--arm NAME] [--unjudged]
 *                                     score stored runs (default: the committed baseline) and print the table
 *   merge [--runs DIR] [--judgments FILE]
 *                                     what the production mergeFindings makes of the stored runs, and with judgments how many
 *                                     judged duplicates it still keeps apart
 *   run --arm NAME --yes [--prompt production|lean] [--mode fixed|production] [--repeat N] [--budget-tokens N]
 *       [--concurrency N] [--retries N] [--requester codex|claude-code] [--codex-used PERCENT]
 *       [--fixtures a,b] [--seats a,b] [--worktrees DIR] [--out DIR]
 *                                     run the panel on the dev fixtures, or on the ones --fixtures names (held-out ones only
 *                                     that way). Costs real tokens: never in CI, never in the Docker image.
 *                                     The scripts/review-eval/README.md explains each option.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { configOf, DEFAULT_PANEL, MAX_STRONG_COUNT, panelSeats, type PanelSeat, type RuntimeId } from '../../src/code-review.ts';
import { detectRuntimes, type Found } from '../runtimes.ts';
import { checkJudgments, DATA_DIR, loadFixtures, loadJudgments, loadRuns, parseRun, RUN_MODES, type Fixture, type RunMode } from './data.ts';
import { PROMPT_VARIANTS, type PromptVariant } from './lean-prompt.ts';
import { duplicatesAfterMerge, mergeRun } from './merge.ts';
import { ensureWorktree, evalEnv, fixedSeats, listCodexMcp, productionSeats, runArm, type ArmSeat } from './run.ts';
import { formatScores, scoreArm } from './score.ts';

const REPO = resolve(import.meta.dirname, '..', '..');
const BASELINE_RUNS = join(DATA_DIR, 'runs', 'baseline');
const BASELINE_JUDGMENTS = join(DATA_DIR, 'judgments', 'baseline.json');

/** A live run costs tokens and starts reviewers, so a CI environment is refused whatever the flags say. */
export function refuseInCi(env: NodeJS.ProcessEnv): void {
  if (env.CI || env.GITHUB_ACTIONS) throw new Error('refusing to run the review panel in CI: a live run costs real tokens and is by hand only');
}

/**
 * The seats of the default panel named in `--seats` (all of them when it is absent). The names are the ones a review uses
 * (`panelSeats`), and the strong seat's repeat members `strong-2` to `strong-${MAX_STRONG_COUNT}` can be named too, so an
 * arm can run the strong seat more than once the way a panel with a count would. Every name must exist: a misspelt one would
 * start a smaller paid run and save it as the arm's result.
 */
export function pickSeats(names: string | undefined): typeof DEFAULT_PANEL {
  if (names === undefined) return DEFAULT_PANEL;
  const base = configOf(DEFAULT_PANEL);
  const known = panelSeats({ ...base, strong: { ...base.strong, count: MAX_STRONG_COUNT } });
  const have = known.map((s) => s.seat).join(', ');
  const wanted = names.split(',').map((s) => s.trim());
  for (const name of wanted) if (!known.some((s) => s.seat === name)) throw new Error(`unknown seat "${name}" in --seats (have ${have})`);
  // Members of a repeated strong seat are meant to be identical, so no `group` is carried into the arm.
  return known.filter((s) => wanted.includes(s.seat)).map(({ group: _g, ...s }) => s);
}

/** The review prompt of an arm: the production one unless `--prompt` names another. A misspelt name would pay for a run of the wrong arm, so it is refused. */
export function pickPrompt(name: string | undefined): PromptVariant {
  if (name === undefined) return 'production';
  const found = PROMPT_VARIANTS.find((v) => v === name);
  if (!found) throw new Error(`unknown prompt "${name}" in --prompt (have ${PROMPT_VARIANTS.join(', ')})`);
  return found;
}

/**
 * A rerun of an arm keeps the fixtures it already finished. They must have used the prompt of this run (a run stored without
 * a prompt used production), or one arm would mix two prompts and the scorer would take it for one. With `manifest`, the
 * mode and the repeat must match too (a run stored without a manifest is fixed mode, repeat 1). Checked before anything starts.
 */
export function checkResumedPrompt(fixtures: Pick<Fixture, 'id'>[], out: string, prompt: PromptVariant, manifest?: { mode: RunMode; repeat: number }): void {
  for (const fx of fixtures) {
    const file = join(out, `${fx.id}.json`);
    if (!existsSync(file)) continue;
    const stored = parseRun(readFileSync(file, 'utf8'), file);
    const used = stored.prompt ?? 'production';
    if (used !== prompt) throw new Error(`${file} was run with the ${used} prompt, not ${prompt}: use a new --arm name, or pass --prompt ${used} to finish this arm`);
    if (!manifest) continue;
    const mode = stored.manifest?.mode ?? 'fixed';
    const repeat = stored.manifest?.repeat ?? 1;
    if (mode !== manifest.mode || repeat !== manifest.repeat) throw new Error(`${file} is ${mode} mode, repeat ${repeat}, not ${manifest.mode} mode, repeat ${manifest.repeat}: use a new --arm name for another mode or repeat`);
  }
}

/** The run options that change what is paid for, checked before anything starts. */
export interface RunOptions {
  mode: RunMode;
  repeat: number;
  budgetTokens: number | null;
  concurrency: number | null;
  retries: number;
  requester: RuntimeId | null;
  codexUsed: number;
}

export function runOptions(v: { mode?: string; repeat?: string; 'budget-tokens'?: string; concurrency?: string; retries?: string; requester?: string; 'codex-used'?: string }): RunOptions {
  const int = (name: string, raw: string | undefined, min: number, max: number): number | null => {
    if (raw === undefined) return null;
    if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) throw new Error(`--${name} must be a whole number from ${min} to ${max}`);
    return Number(raw);
  };
  const mode = (v.mode ?? 'fixed') as RunMode;
  if (!RUN_MODES.includes(mode)) throw new Error(`unknown mode "${v.mode}" in --mode (have ${RUN_MODES.join(', ')})`);
  if (v.requester !== undefined && v.requester !== 'codex' && v.requester !== 'claude-code') throw new Error('--requester must be codex or claude-code');
  if (mode === 'fixed' && (v.requester !== undefined || v['codex-used'] !== undefined)) throw new Error('--requester and --codex-used only apply to --mode production');
  return {
    mode,
    repeat: int('repeat', v.repeat, 1, 99) ?? 1,
    budgetTokens: int('budget-tokens', v['budget-tokens'], 1, 1e10),
    concurrency: int('concurrency', v.concurrency, 1, 16),
    retries: int('retries', v.retries, 0, 3) ?? 0,
    requester: (v.requester as RuntimeId | undefined) ?? null,
    codexUsed: int('codex-used', v['codex-used'], 0, 100) ?? 0,
  };
}

/**
 * The seats an arm runs. Fixed mode: the picked seats as they are. Production mode: resolveSeats on what `found` (the
 * runner's own runtime detection) reports, the requester's family and the Codex window given on the command line; the
 * harness has no database, so the Client's saved panel and the live Codex window are not read.
 */
export function armSeats(mode: RunMode, panel: PanelSeat[], found: Found, o: Pick<RunOptions, 'requester' | 'codexUsed'>): { seats: ArmSeat[]; dropped: { seat: string; reason: string }[] } {
  if (mode === 'fixed') return { seats: fixedSeats(panel), dropped: [] };
  const r = productionSeats(panel, {
    available: { codex: found.codex !== null, 'claude-code': found['claude-code'] !== null },
    models: { codex: found.codex?.models.map((m) => m.id), 'claude-code': found['claude-code']?.models.map((m) => m.id) },
    codexUsed: o.codexUsed,
    requesterRuntime: o.requester,
  });
  if (!r.ok) throw new Error(`production mode: ${r.reason}`);
  return { seats: r.seats, dropped: r.dropped };
}

/** The Triglav checkout's revision and whether it has uncommitted changes to tracked files, for the run manifest. */
function harnessRev(env: NodeJS.ProcessEnv): { rev: string | null; dirty: boolean | null } {
  try {
    const rev = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8', env }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: REPO, encoding: 'utf8', env }).trim() !== '';
    return { rev, dirty };
  } catch {
    return { rev: null, dirty: null };
  }
}

/** The fixtures a run covers. Without `--fixtures`, only the dev split: held-out fixtures run only when named. */
export function pickFixtures(all: Fixture[], names: string | undefined): Fixture[] {
  if (!names) return all.filter((f) => f.split === 'dev');
  const want = names.split(',').map((s) => s.trim()).filter(Boolean);
  const bad = want.filter((n) => !all.some((f) => f.id === n));
  if (bad.length) throw new Error(`no such fixture: ${bad.join(', ')} (have ${all.map((f) => f.id).join(', ')})`);
  return all.filter((f) => want.includes(f.id));
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      runs: { type: 'string' },
      judgments: { type: 'string' },
      arm: { type: 'string' },
      unjudged: { type: 'boolean' },
      yes: { type: 'boolean' },
      fixtures: { type: 'string' },
      seats: { type: 'string' },
      prompt: { type: 'string' },
      worktrees: { type: 'string' },
      out: { type: 'string' },
      mode: { type: 'string' },
      repeat: { type: 'string' },
      'budget-tokens': { type: 'string' },
      concurrency: { type: 'string' },
      retries: { type: 'string' },
      requester: { type: 'string' },
      'codex-used': { type: 'string' },
    },
  });
  const fixtures = loadFixtures();
  if (command === 'list') {
    for (const f of fixtures) console.log(`${f.id}  PR ${f.pr}  ${f.split}  head ${f.head.slice(0, 12)}  ${f.copilot_findings.filter((c) => c.round === 1).length} round 1 + ${f.copilot_findings.filter((c) => c.round > 1).length} later Copilot findings  ${f.url}`);
    return;
  }
  if (command === 'score' || command === 'merge') {
    const dir = values.runs ? resolve(values.runs) : BASELINE_RUNS;
    const runs = loadRuns(dir);
    if (command === 'merge') {
      const mfile = values.judgments ? resolve(values.judgments) : values.runs ? null : BASELINE_JUDGMENTS;
      const mjudged = mfile ? loadJudgments(mfile) : null;
      if (mjudged) checkJudgments(fixtures, runs, mjudged);
      let dups = 0, dupsLeft = 0;
      for (const run of runs) {
        const { raw, merged } = mergeRun(run);
        console.log(`== ${run.fixture}: ${raw} raw -> ${merged.length} merged`);
        for (const m of merged) console.log(`  [${m.severity}] x${m.reviewer_count} ${m.reviewers.join('+')} :: ${m.title.slice(0, 100)}`);
        if (mjudged) {
          const d = duplicatesAfterMerge(run, mjudged);
          dups += d.total;
          dupsLeft += d.left;
        }
      }
      if (mjudged) console.log(`judged duplicates: ${dups}, still two findings after the merge: ${dupsLeft}`);
      else console.log('no judgments given: pass --judgments to count the judged duplicates the merge keeps apart.');
      return;
    }
    const jfile = values.judgments ? resolve(values.judgments) : values.runs ? null : BASELINE_JUDGMENTS;
    const judgments = jfile ? loadJudgments(jfile) : null;
    if (judgments) checkJudgments(fixtures, runs, judgments);
    const score = scoreArm(values.arm ?? judgments?.arm ?? runs[0]?.arm ?? 'unnamed', fixtures, runs, judgments);
    console.log(formatScores(score));
    if (judgments) {
      const d = runs.map((r) => duplicatesAfterMerge(r, judgments));
      console.log(`dup counts the judged repeats among the seats' raw findings. After the production merge, ${d.reduce((n, x) => n + x.left, 0)} of ${d.reduce((n, x) => n + x.total, 0)} judged duplicates are still two findings.`);
    }
    if (!judgments) console.log('no judgments given: every finding is unjudged. Write a judgments file (see test/fixtures/review-eval/judgments) and pass --judgments.');
    if (values.unjudged) for (const f of score.total.unjudgedFindings) console.log(`unjudged: ${f}`);
    return;
  }
  if (command === 'run') {
    refuseInCi(process.env);
    if (!values.arm || !/^[\w.-]{1,60}$/.test(values.arm)) throw new Error('run needs --arm NAME (letters, digits, dot, dash, underscore)');
    const picked = pickFixtures(fixtures, values.fixtures);
    const panel = pickSeats(values.seats);
    const prompt = pickPrompt(values.prompt);
    const opts = runOptions(values);
    const out = resolve(values.out ?? join(REPO, 'review-eval-out', values.arm));
    const trees = resolve(values.worktrees ?? join(REPO, 'review-eval-out', 'worktrees'));
    // Every fixture of the arm, not only the picked ones: two runs with disjoint --fixtures still make one arm.
    checkResumedPrompt(fixtures, out, prompt, { mode: opts.mode, repeat: opts.repeat });
    const env = evalEnv();
    // The runner's own detection: `--version` and the model list of each CLI. It starts no model.
    const found = await detectRuntimes();
    const { seats, dropped } = armSeats(opts.mode, panel, found, opts);
    for (const d of dropped) console.log(`dropped by resolveSeats: ${d.seat}: ${d.reason}`);
    for (const s of seats) if (s.note) console.log(`${s.seat} runs ${s.runtime} ${s.model} ${s.effort} instead of what the arm asked for: ${s.note}. It is scored apart, not under ${values.arm}.`);
    console.log(`run ${values.arm} (prompt ${prompt}, ${opts.mode} mode, repeat ${opts.repeat}): ${picked.length} fixture(s) x ${seats.length} seat(s), output in ${out}`);
    console.log(opts.budgetTokens === null ? 'no --budget-tokens: every picked fixture is admitted' : `admission budget ${opts.budgetTokens} tokens (input with cached, plus output): a fixture starts only when its estimate fits in what is left. This is an admission stop, not a live cap: running seats are not stopped.`);
    console.log('the plan limits of Codex and Claude are not checked here');
    if (!values.yes) throw new Error('pass --yes to start the reviewers');
    mkdirSync(join(out, 'raw'), { recursive: true });
    mkdirSync(trees, { recursive: true });
    const cliVersions = { codex: found.codex?.version ?? null, 'claude-code': found['claude-code']?.version ?? null };
    const result = await runArm(picked, seats, values.arm, {
      env,
      prompt,
      listMcp: (dir) => listCodexMcp(dir, env),
      mode: opts.mode,
      repeat: opts.repeat,
      cliVersions,
      retries: opts.retries,
      budgetTokens: opts.budgetTokens,
      concurrency: opts.concurrency ?? undefined,
      dropped,
      requesterRuntime: opts.mode === 'production' ? opts.requester : null,
      codexUsed: opts.mode === 'production' ? opts.codexUsed : null,
      harness: harnessRev(env),
      // A finished fixture of this arm is kept: a rerun never pays for it twice. Use a new --arm name to run again.
      done: (fx) => existsSync(join(out, `${fx.id}.json`)),
      prepare: (fx) => {
        const cwd = join(trees, fx.id);
        ensureWorktree(REPO, cwd, fx.head, env);
        return cwd;
      },
      store: (fx, { run, outputs }) => {
        for (const o of outputs) {
          writeFileSync(join(out, 'raw', `${fx.id}.${o.seat.seat}.out`), o.stdout);
          writeFileSync(join(out, 'raw', `${fx.id}.${o.seat.seat}.err`), o.stderr);
          // Earlier attempts of a retried seat are kept too: their tokens count, so their output must be inspectable.
          if (o.attempts.length > 1)
            o.attempts.slice(0, -1).forEach((a, i) => {
              writeFileSync(join(out, 'raw', `${fx.id}.${o.seat.seat}.attempt${i + 1}.out`), a.stdout);
              writeFileSync(join(out, 'raw', `${fx.id}.${o.seat.seat}.attempt${i + 1}.err`), a.stderr);
            });
        }
        writeFileSync(join(out, `${fx.id}.json`), `${JSON.stringify(run, null, 2)}\n`);
      },
      log: (line) => console.log(line),
    });
    console.log(`tokens charged in this run: ${result.used} (failed and retried attempts included)`);
    if (result.stopped) {
      console.log(`admission stop at ${result.stopped.fixture}: not started ${[result.stopped.fixture, ...result.stopped.notStarted].join(', ')}`);
      process.exitCode = 2;
    }
    console.log(`done. Score it: node scripts/review-eval/cli.ts score --runs ${out} --judgments <file>`);
    return;
  }
  throw new Error('commands: list, score, merge, run (see the top of scripts/review-eval/cli.ts)');
}

if (import.meta.filename === process.argv[1]) {
  main(process.argv.slice(2)).catch((e: Error) => {
    console.error(e.message);
    process.exitCode = 1;
  });
}
