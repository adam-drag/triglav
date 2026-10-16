/**
 * The review evaluation harness, by hand: `node scripts/review-eval/cli.ts <command>`. See the README ("Evaluating the
 * review panel") and docs of the triglav-code-review skill.
 *
 *   list                              the fixtures
 *   score [--runs DIR] [--judgments FILE] [--arm NAME] [--unjudged]
 *                                     score stored runs (default: the committed baseline) and print the table
 *   merge [--runs DIR]                what the production mergeFindings makes of the stored runs
 *   run --arm NAME --yes [--prompt production|lean] [--fixtures a,b] [--seats a,b] [--worktrees DIR] [--out DIR]
 *                                     run the panel on fixtures. Costs real tokens: never in CI, never in the Docker image.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_PANEL } from '../../src/code-review.ts';
import { checkJudgments, DATA_DIR, loadFixtures, loadJudgments, loadRuns, parseRun, type Fixture } from './data.ts';
import { PROMPT_VARIANTS, type PromptVariant } from './lean-prompt.ts';
import { mergeRun } from './merge.ts';
import { ensureWorktree, evalEnv, listCodexMcp, runFixture } from './run.ts';
import { formatScores, scoreArm } from './score.ts';

const REPO = resolve(import.meta.dirname, '..', '..');
const BASELINE_RUNS = join(DATA_DIR, 'runs', 'baseline');
const BASELINE_JUDGMENTS = join(DATA_DIR, 'judgments', 'baseline.json');

/** A live run costs tokens and starts reviewers, so a CI environment is refused whatever the flags say. */
export function refuseInCi(env: NodeJS.ProcessEnv): void {
  if (env.CI || env.GITHUB_ACTIONS) throw new Error('refusing to run the review panel in CI: a live run costs real tokens and is by hand only');
}

/** The seats of the default panel named in `--seats` (all of them when it is absent). Every name must exist: a misspelt one would start a smaller paid run and save it as the arm's result. */
export function pickSeats(names: string | undefined): typeof DEFAULT_PANEL {
  const have = DEFAULT_PANEL.map((s) => s.seat).join(', ');
  const wanted = names?.split(',').map((s) => s.trim());
  for (const name of wanted ?? []) if (!DEFAULT_PANEL.some((s) => s.seat === name)) throw new Error(`unknown seat "${name}" in --seats (have ${have})`);
  const panel = DEFAULT_PANEL.filter((s) => !wanted || wanted.includes(s.seat));
  if (!panel.length) throw new Error(`--seats names no seat (have ${have})`);
  return panel;
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
 * a prompt used production), or one arm would mix two prompts and the scorer would take it for one. Checked before anything starts.
 */
export function checkResumedPrompt(fixtures: Pick<Fixture, 'id'>[], out: string, prompt: PromptVariant): void {
  for (const fx of fixtures) {
    const file = join(out, `${fx.id}.json`);
    if (!existsSync(file)) continue;
    const used = parseRun(readFileSync(file, 'utf8'), file).prompt ?? 'production';
    if (used !== prompt) throw new Error(`${file} was run with the ${used} prompt, not ${prompt}: use a new --arm name, or pass --prompt ${used} to finish this arm`);
  }
}

function pickFixtures(all: Fixture[], names: string | undefined): Fixture[] {
  if (!names) return all;
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
    },
  });
  const fixtures = loadFixtures();
  if (command === 'list') {
    for (const f of fixtures) console.log(`${f.id}  PR ${f.pr}  head ${f.head.slice(0, 12)}  ${f.copilot_findings.filter((c) => c.round === 1).length} round 1 + ${f.copilot_findings.filter((c) => c.round > 1).length} later Copilot findings  ${f.url}`);
    return;
  }
  if (command === 'score' || command === 'merge') {
    const dir = values.runs ? resolve(values.runs) : BASELINE_RUNS;
    const runs = loadRuns(dir);
    if (command === 'merge') {
      for (const run of runs) {
        const { raw, merged } = mergeRun(run);
        console.log(`== ${run.fixture}: ${raw} raw -> ${merged.length} merged`);
        for (const m of merged) console.log(`  [${m.severity}] x${m.reviewer_count} ${m.reviewers.join('+')} :: ${m.title.slice(0, 100)}`);
      }
      return;
    }
    const jfile = values.judgments ? resolve(values.judgments) : values.runs ? null : BASELINE_JUDGMENTS;
    const judgments = jfile ? loadJudgments(jfile) : null;
    if (judgments) checkJudgments(fixtures, runs, judgments);
    const score = scoreArm(values.arm ?? judgments?.arm ?? runs[0]?.arm ?? 'unnamed', fixtures, runs, judgments);
    console.log(formatScores(score));
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
    const out = resolve(values.out ?? join(REPO, 'review-eval-out', values.arm));
    const trees = resolve(values.worktrees ?? join(REPO, 'review-eval-out', 'worktrees'));
    checkResumedPrompt(picked, out, prompt);
    console.log(`run ${values.arm} (prompt ${prompt}): ${picked.length} fixture(s) x ${panel.length} seat(s) = ${picked.length * panel.length} reviewer process(es), output in ${out}`);
    console.log(`a strong seat uses about 0.6M to 1.4M input tokens on a PR of this size (plan section 3.2); the plan limits of Codex and Claude are not checked here`);
    if (!values.yes) throw new Error('pass --yes to start the reviewers');
    const env = evalEnv();
    mkdirSync(join(out, 'raw'), { recursive: true });
    mkdirSync(trees, { recursive: true });
    for (const fx of picked) {
      const file = join(out, `${fx.id}.json`);
      // A finished fixture of this arm is kept: a rerun never pays for it twice. Use a new --arm name to run again.
      if (existsSync(file)) {
        console.log(fx.id, 'already has a result in', out, '- skipped');
        continue;
      }
      const cwd = join(trees, fx.id);
      ensureWorktree(REPO, cwd, fx.head, env);
      const { run, outputs } = await runFixture(fx, panel, cwd, values.arm, { env, prompt, listMcp: (dir) => listCodexMcp(dir, env) });
      for (const o of outputs) {
        writeFileSync(join(out, 'raw', `${fx.id}.${o.seat.seat}.out`), o.stdout);
        writeFileSync(join(out, 'raw', `${fx.id}.${o.seat.seat}.err`), o.stderr);
      }
      writeFileSync(file, `${JSON.stringify(run, null, 2)}\n`);
      for (const s of run.seats) console.log(fx.id, s.seat, 'code', s.code, `${s.secs}s`, s.error ? `FAILED ${s.error}` : `${s.findings.length} finding(s)`);
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
