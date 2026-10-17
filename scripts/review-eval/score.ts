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
 * - precision among the judged unique findings (duplicates left out): valid over valid plus invalid, and its bounds when
 *   every finding whose validity is not judged turns out invalid (pessimistic) or valid (optimistic).
 * - findings, tokens (cached apart), seconds, Claude cost.
 * - incomplete seats (failed, findings rejected by the parser, or findings with no valid site) in their own list. They stay
 *   in every number above; the list says that those numbers are not a clean review.
 * - seats that ran another configuration than the arm (production mode with a fallback) are scored apart, under a label
 *   that names what ran, never under the arm.
 */
import { assertOneRunPerFixture, attemptsWithoutUsage, incompleteReason, substituted, validityOf, type CopilotFinding, type Fixture, type Judgment, type Judgments, type Run, type SeatRun } from './data.ts';

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
  /** Unique findings (duplicates left out) by their validity: judged valid, judged invalid, and not judged. */
  validFindings: number;
  invalidFindings: number;
  unknownValidity: number;
  /** valid / (valid + invalid), null when nothing is judged. */
  precision: number | null;
  /** valid / unique (every unknown invalid) and (valid + unknown) / unique (every unknown valid); null with no unique finding. */
  precisionLow: number | null;
  precisionHigh: number | null;
  /** Copilot findings no panel finding caught, counted by the reader's miss cause; `unassigned` when no cause was written. */
  missCauses: Record<string, number>;
  /** `seat: reason` of every seat whose output is incomplete. */
  incomplete: string[];
  failedSeats: number;
  /** Input tokens including the cached ones, the cached ones alone, and the output tokens. */
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  /** A seat that reported no usage adds nothing; this says how many. */
  seatsWithoutUsage: number;
  /** Attempts that started and reported no usage (a retried seat can have one and still report usage): their tokens are unknown. */
  attemptsWithoutUsage: number;
  /** The fixture's elapsed time from its run manifest; without one, the slowest seat (seats run in parallel unless --concurrency holds them back). */
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
  /** Seats that ran another configuration than the arm asked for, scored apart under `<seat> as <runtime> <model> <effort>`. Never part of the arm's numbers. */
  substituted: Record<string, Score>;
  /** `fixture seat: reason` of every incomplete seat of the arm, substituted ones included. */
  incomplete: string[];
  /** Fixtures where every seat was substituted: nothing ran as the arm asked, so they are not in the arm's rows or totals. */
  unscored: string[];
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

/** The findings a repeat points at, from the one it names to the root of the chain (a finding that repeats nothing, or is not judged). Bounded, so a cycle that was never checked cannot loop. */
function repeatChain(judged: Map<string, Judgment>, first: string): string[] {
  const chain = [first];
  for (let n = 0; n <= judged.size; n += 1) {
    const next = judged.get(chain[chain.length - 1]!)?.dup_of;
    if (!next) break;
    chain.push(next);
  }
  return chain;
}

/** Scores one run against its fixture. `seatNames` limits it to some seats (the whole panel when null). */
export function scoreRun(fixture: Fixture, run: Run, judgments: Judgments | null, seatNames: string[] | null = null): Score {
  const seats = run.seats.filter((s) => !seatNames || seatNames.includes(s.seat));
  const judged = new Map<string, Judgment>();
  for (const j of judgments?.fixtures[fixture.id] ?? []) judged.set(key(j), j);
  const included = new Set(seats.map((s) => s.seat));
  const caught = new Set<string>();
  const partial = new Set<string>();
  const groups = new Set<string>();
  let validExtras = 0, noise = 0, unjudged = 0, dup = 0, findings = 0, failedSeats = 0;
  let validFindings = 0, invalidFindings = 0, unknownValidity = 0;
  const incomplete: string[] = [];
  let inputTokens = 0, cachedTokens = 0, outputTokens = 0, seatsWithoutUsage = 0, attemptsMissing = 0, wallSecs = 0, seatSecs = 0;
  let cost: number | null = null;
  const unjudgedFindings: string[] = [];
  for (const s of seats) {
    if (s.error || s.code !== 0) failedSeats += 1;
    const why = incompleteReason(s);
    if (why) incomplete.push(`${s.seat}: ${why}`);
    const inp = seatInput(s);
    if (inp) {
      inputTokens += inp.input;
      cachedTokens += inp.cached;
    } else seatsWithoutUsage += 1;
    attemptsMissing += attemptsWithoutUsage(s);
    outputTokens += s.usage.tokensOut ?? 0;
    wallSecs = Math.max(wallSecs, s.secs);
    seatSecs += s.secs;
    if (s.usage.costUsd !== null) cost = (cost ?? 0) + s.usage.costUsd;
    s.findings.forEach((f, index) => {
      findings += 1;
      const j = judged.get(key({ seat: s.seat, index }));
      if (j?.kind === 'catch') caught.add(j.copilot!);
      if (j?.kind === 'partial') partial.add(j.copilot!);
      // A repeat of a finding that is in the scored set, directly or down the chain of repeats, is listed as a duplicate and
      // counts nowhere else. When no finding of the chain is in the scored set (a seat scored alone), the repeats of one defect
      // still form a group by the root of their chain: the first one is its representative and counts by its own judgment,
      // the others are duplicates.
      if (j?.dup_of) {
        const chain = repeatChain(judged, j.dup_of);
        if (chain.some((c) => included.has(c.split('#')[0]!)) || groups.has(chain[chain.length - 1]!)) {
          dup += 1;
          return;
        }
        groups.add(chain[chain.length - 1]!);
      }
      const validity = validityOf(j);
      if (validity === 'valid') validFindings += 1;
      else if (validity === 'invalid') invalidFindings += 1;
      else unknownValidity += 1;
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
  const missCauses: Record<string, number> = {};
  const causes = new Map((judgments?.misses?.[fixture.id] ?? []).map((m) => [m.copilot, m.cause]));
  for (const c of ceiling.filter((x) => !isCaught(x))) {
    const cause = causes.get(c.id) ?? 'unassigned';
    missCauses[cause] = (missCauses[cause] ?? 0) + 1;
  }
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
    ...precisionOf(validFindings, invalidFindings, unknownValidity),
    missCauses,
    incomplete,
    failedSeats,
    inputTokens,
    cachedTokens,
    outputTokens,
    seatsWithoutUsage,
    attemptsWithoutUsage: attemptsMissing,
    wallSecs,
    seatSecs,
    costUsd: cost,
    missedR1: r1.filter((c) => !isCaught(c)).map((c) => c.id),
    unjudgedFindings,
  };
}

function precisionOf(valid: number, invalid: number, unknown: number) {
  const unique = valid + invalid + unknown;
  return { validFindings: valid, invalidFindings: invalid, unknownValidity: unknown, precision: ratio(valid, valid + invalid), precisionLow: ratio(valid, unique), precisionHigh: ratio(valid + unknown, unique) };
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
    ...precisionOf(n((s) => s.validFindings), n((s) => s.invalidFindings), n((s) => s.unknownValidity)),
    missCauses: list.reduce<Record<string, number>>((acc, s) => {
      for (const [c, k] of Object.entries(s.missCauses)) acc[c] = (acc[c] ?? 0) + k;
      return acc;
    }, {}),
    incomplete: list.flatMap((s) => s.incomplete.map((x) => `${s.id} ${x}`)),
    failedSeats: n((s) => s.failedSeats),
    inputTokens: n((s) => s.inputTokens),
    cachedTokens: n((s) => s.cachedTokens),
    outputTokens: n((s) => s.outputTokens),
    seatsWithoutUsage: n((s) => s.seatsWithoutUsage),
    attemptsWithoutUsage: n((s) => s.attemptsWithoutUsage),
    wallSecs: n((s) => s.wallSecs),
    seatSecs: n((s) => s.seatSecs),
    costUsd: costs.length ? costs.reduce((a, c) => a + c, 0) : null,
    missedR1: list.flatMap((s) => s.missedR1),
    unjudgedFindings: list.flatMap((s) => s.unjudgedFindings.map((f) => `${s.id} ${f}`)),
  };
}

/** The label a substituted seat is scored under: its name and what actually ran. */
export const substitutedLabel = (s: SeatRun) => `${s.seat} as ${s.runtime} ${s.model} ${s.effort}`;

/**
 * Scores an arm: every run that has a fixture, per fixture, in total, and per seat. A run with no fixture, or of another
 * arm, is an error. A seat that ran another configuration than the arm asked for is left out of the arm's numbers and
 * scored on its own under a label naming what ran.
 */
export function scoreArm(arm: string, fixtures: Fixture[], runs: Run[], judgments: Judgments | null): ArmScore {
  assertOneRunPerFixture(runs);
  const perFixture: Score[] = [];
  const bySeat = new Map<string, Score[]>();
  const bySubstitute = new Map<string, Score[]>();
  const incomplete: string[] = [];
  const unscored: string[] = [];
  for (const run of [...runs].sort((a, b) => a.fixture.localeCompare(b.fixture))) {
    const fixture = fixtures.find((f) => f.id === run.fixture);
    if (!fixture) throw new Error(`the run of ${run.fixture} has no fixture`);
    if (run.arm !== arm) throw new Error(`the run of ${run.fixture} is arm ${run.arm}, not ${arm}: one score is one arm, so runs of different arms must not be mixed`);
    if (run.base !== fixture.base || run.head !== fixture.head) throw new Error(`the run of ${run.fixture} is not on the fixture's base and head`);
    const own = run.seats.filter((s) => !substituted(s)).map((s) => s.seat);
    // With limited concurrency the seats of a fixture wait for each other, so its elapsed time is the manifest's, not the slowest seat.
    const elapsed = run.manifest ? Math.max(0, (Date.parse(run.manifest.finished_at) - Date.parse(run.manifest.started_at)) / 1000) : null;
    if (own.length) perFixture.push({ ...scoreRun(fixture, run, judgments, own), ...(elapsed !== null ? { wallSecs: elapsed } : {}) });
    else unscored.push(run.fixture);
    for (const s of run.seats) {
      const why = incompleteReason(s);
      if (why) incomplete.push(`${run.fixture} ${substituted(s) ? substitutedLabel(s) : s.seat}: ${why}`);
      const into = substituted(s) ? bySubstitute : bySeat;
      const label = substituted(s) ? substitutedLabel(s) : s.seat;
      into.set(label, [...(into.get(label) ?? []), scoreRun(fixture, run, judgments, [s.seat])]);
    }
  }
  return {
    arm,
    fixtures: perFixture,
    total: sumScores('total', perFixture),
    seats: Object.fromEntries([...bySeat].map(([seat, list]) => [seat, sumScores(seat, list)])),
    substituted: Object.fromEntries([...bySubstitute].map(([label, list]) => [label, sumScores(label, list)])),
    incomplete,
    unscored,
  };
}

const pct = (a: number, b: number) => (b === 0 ? 'n/a' : `${a}/${b} (${Math.round((a / b) * 100)}%)`);
const pc = (r: number | null) => (r === null ? 'n/a' : `${Math.round(r * 100)}%`);
const k = (n: number) => (n >= 10000 ? `${(n / 1e6).toFixed(2)}M` : String(n));

/** A fixed-width table of an arm, the way the CLI prints it. Cost is `n/a` when no seat reported one. */
export function formatScores(a: ArmScore): string {
  const cols = ['', 'R1 recall', 'ceiling', 'valid', 'noise', 'unjudged', 'dup', 'partial', 'findings', 'precision', 'bounds', 'in (cached)', 'out', 'wall s', 'cost $'];
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
    s.precision === null ? 'n/a' : `${s.validFindings}/${s.validFindings + s.invalidFindings} (${pc(s.precision)})`,
    s.precisionLow === null ? 'n/a' : `${pc(s.precisionLow)}-${pc(s.precisionHigh)}`,
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
  const subs = Object.values(a.substituted);
  if (subs.length) {
    out.push(`seats that ran another configuration than arm ${a.arm} asked for (not scored under the arm):`);
    for (const s of subs) out.push(fmt(row({ ...s, id: `  ${s.id}` })));
  }
  if (a.unscored.length) out.push(`not in the arm's rows, because no seat ran as arm ${a.arm} asked: ${a.unscored.join(', ')}`);
  if (a.incomplete.length) out.push(`incomplete seats (counted above, but not a clean review: failed, findings rejected, or findings with no valid site):`, ...a.incomplete.map((x) => `  ${x}`));
  if (a.total.failedSeats) out.push(`${a.total.failedSeats} seat(s) failed: a failed seat has no findings and is not a pass.`);
  const causes = Object.entries(a.total.missCauses);
  if (causes.length) out.push(`missed Copilot findings (round 1 and ceiling) by cause: ${causes.map(([c, k]) => `${c} ${k}`).join(', ')}`);
  out.push('precision is valid over valid plus invalid among unique findings; bounds take every finding not judged for validity as invalid, then as valid.');
  if (a.total.unjudged) out.push(`${a.total.unjudged} finding(s) unjudged: noise (${a.total.noise}) is a floor until they are read.`);
  if (a.total.seatsWithoutUsage) out.push(`${a.total.seatsWithoutUsage} seat(s) reported no token usage.`);
  if (a.total.attemptsWithoutUsage) out.push(`${a.total.attemptsWithoutUsage} attempt(s) ran and reported no token usage: their tokens are unknown, not zero, and the budget charged their estimate.`);
  return out.join('\n');
}
