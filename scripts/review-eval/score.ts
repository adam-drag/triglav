/**
 * The scorer of the review evaluation harness. Pure: fixtures, stored runs and judgments in, numbers out. No process, no
 * clock, no file, so a test can feed it anything and a live run costs nothing to score again.
 *
 * It follows section 7.4 of docs/plans/review-panel-parity.md. Per PR and in total:
 * - R1 recall: Copilot's round 1 findings that a panel finding catches, over all round 1 findings.
 * - ceiling recall: the same over round 1 plus the later findings that were already true at the round 1 head.
 * - valid extras: findings Copilot did not make that a scorer read as real defects.
 * - noise: findings a scorer read as invalid. A floor, because of the next column.
 * - unjudged: findings nobody judged, or judged `unsure`. Never counted as noise or as valid, always printed beside them.
 * - dup: findings that repeat another finding of the run (the same defect), listed once and not counted as extras.
 * - findings, tokens (cached apart), seconds, Claude cost.
 */
import type { CopilotFinding, Fixture, Judgment, Judgments, Run, SeatRun } from './data.ts';

export interface Score {
  id: string;
  r1Total: number;
  r1Caught: number;
  r1Recall: number | null;
  ceilingTotal: number;
  ceilingCaught: number;
  ceilingRecall: number | null;
  /** Copilot findings of a later round that the panel caught and that are not in the ceiling set (the fix introduced them). */
  caughtLater: number;
  /** Copilot findings with a related but different panel finding and no catch. Counted apart, never as caught. */
  partial: number;
  validExtras: number;
  noise: number;
  unjudged: number;
  dup: number;
  /** Findings of the seats that ran, duplicates included. */
  findings: number;
  failedSeats: number;
  /** Input tokens including the cached ones, the cached ones alone, and the output tokens. */
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  /** A seat that reported no usage adds nothing; this says how many. */
  seatsWithoutUsage: number;
  /** Seats run in parallel, so a review takes as long as its slowest seat. */
  wallSecs: number;
  seatSecs: number;
  /** Claude's reported cost; Codex reports none, so null when no seat reported one. */
  costUsd: number | null;
  /** Round 1 Copilot findings nothing caught. */
  missedR1: string[];
  /** `seat#index title` of each unjudged finding, so a scorer knows what is left to read. */
  unjudgedFindings: string[];
}

export interface ArmScore {
  arm: string;
  fixtures: Score[];
  total: Score;
  /** The same numbers per seat, over all fixtures. */
  seats: Record<string, Score>;
}

const ratio = (a: number, b: number) => (b === 0 ? null : a / b);

/**
 * Input tokens of one seat as `{input, cached}`. Codex reports `input_tokens` with its cached part inside it. Claude's input
 * is the fresh input plus the cache writes, and its cache reads come on top (see `parseReviewerOutput` in
 * src/code-review.ts), so for Claude the cached tokens are added to get the same meaning.
 */
export function seatInput(s: Pick<SeatRun, 'runtime' | 'usage'>): { input: number; cached: number } | null {
  const u = s.usage;
  if (u.tokensIn === null && u.tokensCached === null) return null;
  const cached = u.tokensCached ?? 0;
  const input = (u.tokensIn ?? 0) + (s.runtime === 'claude-code' ? cached : 0);
  return { input, cached };
}

const key = (j: { seat: string; index: number }) => `${j.seat}#${j.index}`;

/** Scores one run against its fixture. `seatNames` limits it to some seats (the whole panel when null). */
export function scoreRun(fixture: Fixture, run: Run, judgments: Judgments | null, seatNames: string[] | null = null): Score {
  const seats = run.seats.filter((s) => !seatNames || seatNames.includes(s.seat));
  const judged = new Map<string, Judgment>();
  for (const j of judgments?.fixtures[fixture.id] ?? []) judged.set(key(j), j);
  const included = new Set(seats.map((s) => s.seat));
  const caught = new Set<string>();
  const partial = new Set<string>();
  let validExtras = 0, noise = 0, unjudged = 0, dup = 0, findings = 0, failedSeats = 0;
  let inputTokens = 0, cachedTokens = 0, outputTokens = 0, seatsWithoutUsage = 0, wallSecs = 0, seatSecs = 0;
  let cost: number | null = null;
  const unjudgedFindings: string[] = [];
  for (const s of seats) {
    if (s.error || s.code !== 0) failedSeats += 1;
    const inp = seatInput(s);
    if (inp) {
      inputTokens += inp.input;
      cachedTokens += inp.cached;
    } else seatsWithoutUsage += 1;
    outputTokens += s.usage.tokensOut ?? 0;
    wallSecs = Math.max(wallSecs, s.secs);
    seatSecs += s.secs;
    if (s.usage.costUsd !== null) cost = (cost ?? 0) + s.usage.costUsd;
    s.findings.forEach((f, index) => {
      findings += 1;
      const j = judged.get(key({ seat: s.seat, index }));
      if (j?.kind === 'catch') caught.add(j.copilot!);
      if (j?.kind === 'partial') partial.add(j.copilot!);
      // A repeat of a finding that is in the scored set is listed as a duplicate and counts nowhere else.
      if (j?.dup_of && included.has(j.dup_of.split('#')[0]!)) {
        dup += 1;
        return;
      }
      if (!j || j.kind === 'unsure') {
        unjudged += 1;
        unjudgedFindings.push(`${key({ seat: s.seat, index })} ${f.title}`);
      } else if (j.kind === 'valid') validExtras += 1;
      else if (j.kind === 'invalid') noise += 1;
    });
  }
  const all = fixture.copilot_findings;
  const r1 = all.filter((c) => c.round === 1);
  const ceiling = all.filter((c) => c.round === 1 || c.ceiling === true);
  const isCaught = (c: CopilotFinding) => caught.has(c.id);
  const ceilingIds = new Set(ceiling.map((c) => c.id));
  return {
    id: fixture.id,
    r1Total: r1.length,
    r1Caught: r1.filter(isCaught).length,
    r1Recall: ratio(r1.filter(isCaught).length, r1.length),
    ceilingTotal: ceiling.length,
    ceilingCaught: ceiling.filter(isCaught).length,
    ceilingRecall: ratio(ceiling.filter(isCaught).length, ceiling.length),
    caughtLater: all.filter((c) => !ceilingIds.has(c.id) && isCaught(c)).length,
    partial: [...partial].filter((id) => !caught.has(id)).length,
    validExtras,
    noise,
    unjudged,
    dup,
    findings,
    failedSeats,
    inputTokens,
    cachedTokens,
    outputTokens,
    seatsWithoutUsage,
    wallSecs,
    seatSecs,
    costUsd: cost,
    missedR1: r1.filter((c) => !isCaught(c)).map((c) => c.id),
    unjudgedFindings,
  };
}

/** Adds the scores of several fixtures; the recalls come from the summed counts, never from averaging ratios. */
export function sumScores(id: string, list: Score[]): Score {
  const n = (f: (s: Score) => number) => list.reduce((a, s) => a + f(s), 0);
  const r1Total = n((s) => s.r1Total), r1Caught = n((s) => s.r1Caught);
  const ceilingTotal = n((s) => s.ceilingTotal), ceilingCaught = n((s) => s.ceilingCaught);
  const costs = list.map((s) => s.costUsd).filter((c): c is number => c !== null);
  return {
    id,
    r1Total,
    r1Caught,
    r1Recall: ratio(r1Caught, r1Total),
    ceilingTotal,
    ceilingCaught,
    ceilingRecall: ratio(ceilingCaught, ceilingTotal),
    caughtLater: n((s) => s.caughtLater),
    partial: n((s) => s.partial),
    validExtras: n((s) => s.validExtras),
    noise: n((s) => s.noise),
    unjudged: n((s) => s.unjudged),
    dup: n((s) => s.dup),
    findings: n((s) => s.findings),
    failedSeats: n((s) => s.failedSeats),
    inputTokens: n((s) => s.inputTokens),
    cachedTokens: n((s) => s.cachedTokens),
    outputTokens: n((s) => s.outputTokens),
    seatsWithoutUsage: n((s) => s.seatsWithoutUsage),
    wallSecs: n((s) => s.wallSecs),
    seatSecs: n((s) => s.seatSecs),
    costUsd: costs.length ? costs.reduce((a, c) => a + c, 0) : null,
    missedR1: list.flatMap((s) => s.missedR1),
    unjudgedFindings: list.flatMap((s) => s.unjudgedFindings.map((f) => `${s.id} ${f}`)),
  };
}

/** Scores an arm: every run that has a fixture, per fixture, in total, and per seat. A run with no fixture is an error. */
export function scoreArm(arm: string, fixtures: Fixture[], runs: Run[], judgments: Judgments | null): ArmScore {
  const perFixture: Score[] = [];
  const bySeat = new Map<string, Score[]>();
  for (const run of [...runs].sort((a, b) => a.fixture.localeCompare(b.fixture))) {
    const fixture = fixtures.find((f) => f.id === run.fixture);
    if (!fixture) throw new Error(`the run of ${run.fixture} has no fixture`);
    if (run.base !== fixture.base || run.head !== fixture.head) throw new Error(`the run of ${run.fixture} is not on the fixture's base and head`);
    perFixture.push(scoreRun(fixture, run, judgments));
    for (const s of run.seats) bySeat.set(s.seat, [...(bySeat.get(s.seat) ?? []), scoreRun(fixture, run, judgments, [s.seat])]);
  }
  return {
    arm,
    fixtures: perFixture,
    total: sumScores('total', perFixture),
    seats: Object.fromEntries([...bySeat].map(([seat, list]) => [seat, sumScores(seat, list)])),
  };
}

const pct = (a: number, b: number) => (b === 0 ? 'n/a' : `${a}/${b} (${Math.round((a / b) * 100)}%)`);
const k = (n: number) => (n >= 10000 ? `${(n / 1e6).toFixed(2)}M` : String(n));

/** A fixed-width table of an arm, the way the CLI prints it. Cost is `n/a` when no seat reported one. */
export function formatScores(a: ArmScore): string {
  const cols = ['', 'R1 recall', 'ceiling', 'valid', 'noise', 'unjudged', 'dup', 'partial', 'findings', 'in (cached)', 'out', 'wall s', 'cost $'];
  const row = (s: Score) => [
    s.id,
    pct(s.r1Caught, s.r1Total),
    pct(s.ceilingCaught, s.ceilingTotal),
    String(s.validExtras),
    String(s.noise),
    String(s.unjudged),
    String(s.dup),
    String(s.partial),
    String(s.findings),
    `${k(s.inputTokens)} (${k(s.cachedTokens)})`,
    k(s.outputTokens),
    s.wallSecs.toFixed(0),
    s.costUsd === null ? 'n/a' : s.costUsd.toFixed(3),
  ];
  const lines = [[...cols], ...a.fixtures.map(row), row(a.total), ...Object.values(a.seats).map((s) => row({ ...s, id: `  ${s.id}` }))];
  const w = cols.map((_, i) => Math.max(...lines.map((l) => l[i]!.length)));
  const fmt = (l: string[]) => l.map((c, i) => (i === 0 ? c.padEnd(w[i]!) : c.padStart(w[i]!))).join('  ');
  const out = [`arm ${a.arm}`, fmt(lines[0]!), ...lines.slice(1, 1 + a.fixtures.length).map(fmt), fmt(lines[1 + a.fixtures.length]!)];
  const seatLines = lines.slice(2 + a.fixtures.length);
  if (seatLines.length) out.push('per seat:', ...seatLines.map(fmt));
  if (a.total.failedSeats) out.push(`${a.total.failedSeats} seat(s) failed: a failed seat has no findings and is not a pass.`);
  if (a.total.unjudged) out.push(`${a.total.unjudged} finding(s) unjudged: noise (${a.total.noise}) is a floor until they are read.`);
  if (a.total.seatsWithoutUsage) out.push(`${a.total.seatsWithoutUsage} seat(s) reported no token usage.`);
  return out.join('\n');
}
