import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildReviewPrompt, DEFAULT_PANEL, parseReviewerOutput } from '../src/code-review.ts';
import { claudeReviewArgs, codexReviewArgs, reviewPrompt, type ReviewerResult } from '../scripts/code-review-run.ts';
import { staffStartEnv } from '../scripts/staff-start.ts';
import { refuseInCi } from '../scripts/review-eval/cli.ts';
import { checkJudgments, DATA_DIR, loadFixtures, loadJudgments, loadRuns, parseFixture, parseJudgments, parseRun, type Fixture, type Judgments, type Run, type SeatRun } from '../scripts/review-eval/data.ts';
import { mergeRun } from '../scripts/review-eval/merge.ts';
import { REVIEW_STDOUT_MAX, REVIEW_TIMEOUT_MS, runFixture, runSeat, seatCommand, seatPrompt } from '../scripts/review-eval/run.ts';
import { formatScores, scoreArm, scoreRun, seatInput, sumScores } from '../scripts/review-eval/score.ts';

const root = join(import.meta.dirname, '..');
const read = (...p: string[]) => readFileSync(join(root, ...p), 'utf8');

// ---------------------------------------------------------------- builders for the scorer tests

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

function fixture(over: Partial<Fixture> = {}): Fixture {
  return {
    id: 'x1',
    repo: 'o/r',
    pr: 1,
    url: 'https://example.com/pr/1',
    base: SHA_A,
    head: SHA_B,
    head_note: '',
    diff_chars: 100,
    title: 'A change',
    notes_basis: '',
    notes: 'It does a thing.',
    copilot_findings: [
      { id: 'x1-r1-a', round: 1, severity: 'high', file: 'a.ts', line: 1, label: 'first round one' },
      { id: 'x1-r1-b', round: 1, severity: 'medium', file: 'a.ts', line: 2, label: 'first round two' },
      { id: 'x1-r2-a', round: 2, severity: 'medium', file: 'a.ts', line: 3, label: 'later, already true', ceiling: true, ceiling_basis: 'read at the first head' },
      { id: 'x1-r3-a', round: 3, severity: 'low', file: 'a.ts', line: 4, label: 'later, caused by a fix', ceiling: false, ceiling_basis: 'the fix added the code' },
    ],
    ...over,
  };
}

const usage = (tokensIn: number | null, tokensCached: number | null, tokensOut: number | null, costUsd: number | null) => ({ tokensIn, tokensCached, tokensOut, costUsd });
const finding = (title: string) => ({ severity: 'P2' as const, title, body: `${title} body`, sites: [{ file: 'a.ts', line: 1 }] });

function seat(name: string, titles: string[], over: Partial<SeatRun> = {}): SeatRun {
  return { seat: name, runtime: name === 'strong' ? 'codex' : 'claude-code', model: 'm', effort: 'low', code: 0, secs: 10, prompt_chars: 1, diff_chars: 1, rejected: 0, usage: usage(null, null, null, null), findings: titles.map(finding), ...over };
}
const run = (seats: SeatRun[]): Run => ({ arm: 't', fixture: 'x1', base: SHA_A, head: SHA_B, seats });
const judgments = (list: Judgments['fixtures'][string]): Judgments => ({ arm: 't', judged_by: 'a test', note: '', fixtures: { x1: list } });
const J = (seatName: string, index: number, title: string, kind: Judgments['fixtures'][string][number]['kind'], extra: { copilot?: string; dup_of?: string } = {}) => ({ seat: seatName, index, title, kind, ...extra });

describe('the scorer', () => {
  it('counts a Copilot finding once, however many panel findings catch it', () => {
    const r = run([seat('strong', ['s one', 's two']), seat('cheap', ['c one'])]);
    const s = scoreRun(fixture(), r, judgments([J('strong', 0, 's one', 'catch', { copilot: 'x1-r1-a' }), J('strong', 1, 's two', 'catch', { copilot: 'x1-r1-b' }), J('cheap', 0, 'c one', 'catch', { copilot: 'x1-r1-a' })]));
    expect(s.r1Caught).toBe(2);
    expect(s.r1Total).toBe(2);
    expect(s.r1Recall).toBe(1);
    expect(s.missedR1).toEqual([]);
  });

  it('puts a later finding in the ceiling only when it was already true at the round 1 head', () => {
    const r = run([seat('strong', ['a', 'b'])]);
    const s = scoreRun(fixture(), r, judgments([J('strong', 0, 'a', 'catch', { copilot: 'x1-r2-a' }), J('strong', 1, 'b', 'catch', { copilot: 'x1-r3-a' })]));
    expect(s.r1Caught).toBe(0);
    expect(s.ceilingTotal).toBe(3);
    expect(s.ceilingCaught).toBe(1);
    expect(s.ceilingRecall).toBeCloseTo(1 / 3);
    expect(s.caughtLater).toBe(1);
    // A catch is a catch, not an extra: the later catches add no valid, noise or unjudged finding.
    expect([s.validExtras, s.noise, s.unjudged]).toEqual([0, 0, 0]);
  });

  it('counts a related finding as partial and not as caught', () => {
    const r = run([seat('strong', ['a'])]);
    const s = scoreRun(fixture(), r, judgments([J('strong', 0, 'a', 'partial', { copilot: 'x1-r1-a' })]));
    expect(s.r1Caught).toBe(0);
    expect(s.partial).toBe(1);
    expect(s.missedR1).toEqual(['x1-r1-a', 'x1-r1-b']);
  });

  it('keeps valid extras, noise and unjudged apart, and counts a finding nobody judged as unjudged', () => {
    const r = run([seat('strong', ['v', 'n', 'u', 'nobody'])]);
    const s = scoreRun(fixture(), r, judgments([J('strong', 0, 'v', 'valid'), J('strong', 1, 'n', 'invalid'), J('strong', 2, 'u', 'unsure')]));
    expect([s.validExtras, s.noise, s.unjudged]).toEqual([1, 1, 2]);
    expect(s.unjudgedFindings).toEqual(['strong#2 u', 'strong#3 nobody']);
    expect(s.findings).toBe(4);
  });

  it('lists a repeat of a defect as a duplicate and does not count it as an extra', () => {
    const r = run([seat('strong', ['same defect']), seat('cheap', ['same defect again', 'its own extra'])]);
    const list = [J('strong', 0, 'same defect', 'valid'), J('cheap', 0, 'same defect again', 'valid', { dup_of: 'strong#0' }), J('cheap', 1, 'its own extra', 'valid')];
    const both = scoreRun(fixture(), r, judgments(list));
    expect([both.dup, both.validExtras, both.findings]).toEqual([1, 2, 3]);
    // Seen alone, the cheap seat has no earlier finding to repeat, so nothing is a duplicate there.
    const alone = scoreRun(fixture(), r, judgments(list), ['cheap']);
    expect([alone.dup, alone.validExtras]).toEqual([0, 2]);
  });

  it('counts a failed seat and gives it no findings', () => {
    const r = run([seat('strong', ['a']), seat('cheap', [], { code: 1, error: 'exit 1' })]);
    const s = scoreRun(fixture(), r, judgments([J('strong', 0, 'a', 'valid')]));
    expect(s.failedSeats).toBe(1);
    expect(s.findings).toBe(1);
    expect(formatScores(scoreArm('t', [fixture()], [r], judgments([J('strong', 0, 'a', 'valid')])))).toMatch(/1 seat\(s\) failed/);
  });

  it('reads tokens the way each runtime reports them, with the cached ones apart', () => {
    // Codex: the cached tokens are inside input_tokens. Claude: they come on top of the fresh input.
    expect(seatInput({ runtime: 'codex', usage: usage(1000, 800, 50, null) })).toEqual({ input: 1000, cached: 800 });
    expect(seatInput({ runtime: 'claude-code', usage: usage(100, 900, 50, 0.1) })).toEqual({ input: 1000, cached: 900 });
    expect(seatInput({ runtime: 'codex', usage: usage(null, null, null, null) })).toBeNull();
    const r = run([seat('strong', [], { usage: usage(1000, 800, 50, null) }), seat('cheap', [], { usage: usage(100, 900, 20, 0.25) }), seat('other', [], { runtime: 'codex' })]);
    const s = scoreRun(fixture(), r, null);
    expect([s.inputTokens, s.cachedTokens, s.outputTokens, s.seatsWithoutUsage]).toEqual([2000, 1700, 70, 1]);
  });

  it('adds cost only for seats that report one, and says n/a when none does', () => {
    expect(scoreRun(fixture(), run([seat('strong', [])]), null).costUsd).toBeNull();
    expect(scoreRun(fixture(), run([seat('strong', [], { usage: usage(1, 0, 1, 0.5) }), seat('cheap', [], { usage: usage(1, 0, 1, 0.25) })]), null).costUsd).toBeCloseTo(0.75);
  });

  it('reports the slowest seat as the wall time and the sum as seat time', () => {
    const s = scoreRun(fixture(), run([seat('strong', [], { secs: 100 }), seat('cheap', [], { secs: 20 })]), null);
    expect([s.wallSecs, s.seatSecs]).toEqual([100, 120]);
  });

  it('sums fixtures from the counts, not by averaging ratios', () => {
    const f1 = fixture();
    const f2 = fixture({ id: 'x2', copilot_findings: [{ id: 'x2-r1-a', round: 1, severity: 'low', file: 'a.ts', line: 1, label: 'only one finding' }] });
    const r1 = run([seat('strong', ['a'])]);
    const r2: Run = { ...run([seat('strong', ['b'])]), fixture: 'x2' };
    const j: Judgments = { arm: 't', judged_by: 'a test', note: '', fixtures: { x1: [J('strong', 0, 'a', 'catch', { copilot: 'x1-r1-a' })], x2: [J('strong', 0, 'b', 'catch', { copilot: 'x2-r1-a' })] } };
    const arm = scoreArm('t', [f1, f2], [r1, r2], j);
    // 1 of 2 and 1 of 1: the total is 2 of 3, not the mean of 50% and 100%.
    expect([arm.total.r1Caught, arm.total.r1Total]).toEqual([2, 3]);
    expect(arm.total.r1Recall).toBeCloseTo(2 / 3);
    expect(arm.seats.strong!.r1Caught).toBe(2);
    expect(sumScores('none', []).r1Recall).toBeNull();
  });

  it('refuses a run that has no fixture or is on another head', () => {
    expect(() => scoreArm('t', [], [run([seat('strong', [])])], null)).toThrow(/no fixture/);
    expect(() => scoreArm('t', [fixture({ head: SHA_A })], [run([seat('strong', [])])], null)).toThrow(/base and head/);
  });

  it('prints the table with its caveats', () => {
    const out = formatScores(scoreArm('t', [fixture()], [run([seat('strong', ['u'])])], null));
    expect(out).toContain('R1 recall');
    expect(out).toContain('0/2 (0%)');
    expect(out).toMatch(/1 finding\(s\) unjudged: noise \(0\) is a floor/);
  });
});

describe('fixture, run and judgment files', () => {
  it('rejects a short sha, a later round without a ceiling basis, and an id of another round', () => {
    const f = fixture();
    expect(() => parseFixture(JSON.stringify({ ...f, head: 'abc123' }))).toThrow(/head/);
    const noBasis = { ...f, copilot_findings: [...f.copilot_findings.slice(0, 2), { id: 'x1-r2-b', round: 2, severity: 'low', file: 'a.ts', line: 1, label: 'a later one' }] };
    expect(() => parseFixture(JSON.stringify(noBasis))).toThrow(/ceiling/);
    const wrongId = { ...f, copilot_findings: [{ ...f.copilot_findings[0]!, id: 'x1-r2-a' }] };
    expect(() => parseFixture(JSON.stringify(wrongId))).toThrow(/round/);
    expect(() => parseFixture('{')).toThrow(/not JSON/);
    expect(() => parseRun(JSON.stringify({ arm: 'a', fixture: 'x1', base: SHA_A, head: SHA_B, seats: [] }))).toThrow();
    expect(() => parseJudgments(JSON.stringify({ arm: 'a', judged_by: 'x', note: '', fixtures: { x1: [{ seat: 's', index: 0, title: 't', kind: 'maybe' }] } }))).toThrow(/kind/);
  });

  it('checks that a judgment points at a real finding with the same title and a real Copilot finding', () => {
    const r = run([seat('strong', ['a', 'b'])]);
    const ok = judgments([J('strong', 0, 'a', 'catch', { copilot: 'x1-r1-a' })]);
    expect(() => checkJudgments([fixture()], [r], ok)).not.toThrow();
    expect(() => checkJudgments([fixture()], [r], judgments([J('strong', 0, 'changed', 'valid')]))).toThrow(/title differs/);
    expect(() => checkJudgments([fixture()], [r], judgments([J('strong', 5, 'a', 'valid')]))).toThrow(/no such finding/);
    expect(() => checkJudgments([fixture()], [r], judgments([J('strong', 0, 'a', 'catch', { copilot: 'x1-r9-z' })]))).toThrow(/no Copilot finding/);
    expect(() => checkJudgments([fixture()], [r], judgments([J('strong', 0, 'a', 'catch')]))).toThrow(/must/);
    expect(() => checkJudgments([fixture()], [r], judgments([J('strong', 0, 'a', 'valid', { copilot: 'x1-r1-a' })]))).toThrow(/must/);
    expect(() => checkJudgments([fixture()], [r], judgments([J('strong', 0, 'a', 'valid'), J('strong', 0, 'a', 'invalid')]))).toThrow(/twice/);
    expect(() => checkJudgments([fixture()], [r], judgments([J('strong', 0, 'a', 'valid', { dup_of: 'strong#0' })]))).toThrow(/repeat itself/);
    expect(() => checkJudgments([fixture()], [r], judgments([J('strong', 0, 'a', 'valid', { dup_of: 'strong#9' })]))).toThrow(/dup_of/);
  });
});

describe('the Triglav fixtures (Set T)', () => {
  const fixtures = loadFixtures();
  const runs = loadRuns(join(DATA_DIR, 'runs', 'baseline'));
  const judged = loadJudgments(join(DATA_DIR, 'judgments', 'baseline.json'));

  it('has PRs 3, 6 and 8, each with full shas and Copilot findings by round', () => {
    expect(fixtures.map((f) => [f.id, f.pr])).toEqual([['tg3', 3], ['tg6', 6], ['tg8', 8]]);
    for (const f of fixtures) {
      expect(f.repo).toBe('adam-drag/triglav');
      expect(f.url).toBe(`https://github.com/adam-drag/triglav/pull/${f.pr}`);
      expect(f.copilot_findings.filter((c) => c.round === 1).length).toBeGreaterThan(0);
    }
    expect(fixtures.map((f) => f.copilot_findings.filter((c) => c.round === 1).length)).toEqual([3, 4, 5]);
    expect(fixtures.find((f) => f.id === 'tg8')!.head).toBe('f9829945c01a6f71a8c4c615be674b663c8aebf9');
  });

  it('holds our own short labels, never a copy of a long Copilot comment', () => {
    for (const f of fixtures) for (const c of f.copilot_findings) expect(c.label.length).toBeLessThanOrEqual(200);
  });

  it('gives the prompt notes that stop before the review: no mention of Copilot or of fixes to review findings', () => {
    for (const f of fixtures) {
      expect(f.notes, f.id).not.toMatch(/copilot/i);
      expect(f.notes, f.id).not.toMatch(/changes after review/i);
    }
  });

  it('keeps private data out: nothing from a private repository is in the harness or its data', () => {
    const files = [...readdirSync(join(root, 'scripts', 'review-eval')).map((f) => join(root, 'scripts', 'review-eval', f)), ...(['prs', 'judgments', 'runs/baseline'] as const).flatMap((d) => readdirSync(join(DATA_DIR, d)).map((f) => join(DATA_DIR, d, f)))];
    expect(files.length).toBeGreaterThan(8);
    for (const f of files) expect(readFileSync(f, 'utf8'), f).not.toMatch(/calctree/i);
  });

  it('stores runs on the fixtures bases and heads, with judgments that match them', () => {
    expect(runs.map((r) => r.fixture)).toEqual(['tg3', 'tg6', 'tg8']);
    for (const r of runs) {
      const f = fixtures.find((x) => x.id === r.fixture)!;
      expect([r.base, r.head]).toEqual([f.base, f.head]);
    }
    expect(() => checkJudgments(fixtures, runs, judged)).not.toThrow();
  });

  it('scores the stored baseline: 7 of 12 round 1 findings, none shown to be noise, the rest unjudged', () => {
    const a = scoreArm('baseline', fixtures, runs, judged);
    expect(a.fixtures.map((s) => [s.id, s.r1Caught, s.r1Total])).toEqual([['tg3', 1, 3], ['tg6', 2, 4], ['tg8', 4, 5]]);
    expect([a.total.r1Caught, a.total.r1Total]).toEqual([7, 12]);
    expect([a.total.ceilingCaught, a.total.ceilingTotal]).toEqual([10, 17]);
    expect(a.total.noise).toBe(0);
    expect(a.total.validExtras).toBe(3);
    expect(a.total.unjudged).toBe(3);
    expect(a.total.dup).toBe(2);
    expect(a.total.partial).toBe(1);
    expect(a.total.findings).toBe(20);
    expect(a.seats.strong).toMatchObject({ r1Caught: 7, findings: 16, costUsd: null });
    expect(a.seats['cheap-claude']).toMatchObject({ r1Caught: 3, findings: 4 });
    expect(a.total.costUsd).toBeCloseTo(0.612, 3);
    // The seats' tokens as the plan measured them: 2,678,736 in (2,355,456 cached) for Codex, 656,905 for Claude.
    expect([a.seats.strong!.inputTokens, a.seats.strong!.cachedTokens]).toEqual([2678736, 2355456]);
    expect(a.seats['cheap-claude']!.inputTokens).toBe(656905);
  });
});

// ---------------------------------------------------------------- the merge, today and as PR B wants it

describe('mergeFindings on the stored baseline', () => {
  const runs = loadRuns(join(DATA_DIR, 'runs', 'baseline'));
  const byId = (id: string) => runs.find((r) => r.fixture === id)!;

  // Today's behaviour, measured 2026-10-16 (plan section 3.4). These stay green until the merge changes on purpose.
  it('merges nothing across seats today: 8 to 8, 8 to 8 and 4 to 4, every finding from one seat', () => {
    expect([mergeRun(byId('tg8')).raw, mergeRun(byId('tg8')).merged.length]).toEqual([8, 8]);
    expect([mergeRun(byId('tg6')).raw, mergeRun(byId('tg6')).merged.length]).toEqual([8, 8]);
    expect([mergeRun(byId('tg3')).raw, mergeRun(byId('tg3')).merged.length]).toEqual([4, 4]);
    for (const r of runs) expect(mergeRun(r).merged.every((m) => m.reviewer_count === 1)).toBe(true);
  });
});

describe('the PR 8 duplicate pairs', () => {
  const runs = loadRuns(join(DATA_DIR, 'runs', 'baseline'));
  const judged = loadJudgments(join(DATA_DIR, 'judgments', 'baseline.json'));
  const tg8 = runs.find((r) => r.fixture === 'tg8')!;
  const pairs = (judged.fixtures.tg8 ?? []).filter((j) => j.dup_of).map((j) => ({ later: j, first: judged.fixtures.tg8!.find((x) => `${x.seat}#${x.index}` === j.dup_of)! }));
  const finding = (s: { seat: string; index: number }) => tg8.seats.find((x) => x.seat === s.seat)!.findings[s.index]!;

  it('are recorded: the late-Staff registration finding (P1) and the failure-writes-no-event finding (P2), in both seats', () => {
    expect(pairs.map((p) => [p.first.seat, p.later.seat, p.first.copilot, p.later.copilot, finding(p.first).severity, finding(p.later).severity])).toEqual([
      ['strong', 'cheap-claude', 'tg8-r1-a', 'tg8-r1-a', 'P1', 'P1'],
      ['strong', 'cheap-claude', 'tg8-r1-c', 'tg8-r1-c', 'P2', 'P2'],
    ]);
  });

  // PR B turns these on. They state the merge the Client wants: one finding per defect, both seats named, the union of sites,
  // the highest severity. Until then they are skipped, because today's mergeFindings keeps each seat's copy.
  it.skip('PR B: merges the late-Staff registration finding of both seats into one P1 with both seats and the sites of both', () => {
    const { merged } = mergeRun(tg8);
    const [a, b] = [finding(pairs[0]!.first), finding(pairs[0]!.later)];
    const m = merged.filter((x) => x.reviewers.includes('strong') && x.reviewers.includes('cheap-claude') && a.sites.every((s) => x.sites.some((y) => y.file === s.file && y.line === s.line)) && b.sites.every((s) => x.sites.some((y) => y.file === s.file && y.line === s.line)));
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ severity: 'P1', reviewer_count: 2 });
  });

  it.skip('PR B: merges the failure-writes-no-event finding of both seats into one P2 with both seats', () => {
    const { merged } = mergeRun(tg8);
    const m = merged.filter((x) => x.reviewers.includes('strong') && x.reviewers.includes('cheap-claude') && x.sites.some((s) => s.line === 257) && x.severity === 'P2');
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ reviewer_count: 2 });
  });

  it.skip('PR B: leaves 6 findings of the 8, one per defect, and merges nothing else', () => {
    const { raw, merged } = mergeRun(tg8);
    expect(raw - pairs.length).toBe(6);
    expect(merged).toHaveLength(6);
    expect(merged.filter((m) => m.reviewer_count === 2)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------- the live path, with a fake process

describe('running a seat', () => {
  const [strong, cheap] = DEFAULT_PANEL;
  const fx = (): Fixture => parseFixture(readFileSync(join(DATA_DIR, 'prs', 'tg3.json'), 'utf8'));
  const claudeAnswer = JSON.stringify({ result: '', structured_output: { findings: [{ severity: 'P2', title: 'A finding', body: 'It breaks.', sites: [{ file: 'src/a.ts', line: 3 }] }] }, usage: { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 100, output_tokens: 7 }, total_cost_usd: 0.05 });
  const codexAnswer = [
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ findings: [] }) } }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 900, output_tokens: 20 } }),
  ].join('\n');
  const result = (over: Partial<ReviewerResult>): ReviewerResult => ({ code: 0, signal: null, stdout: '', stderr: '', overflow: false, secs: 3.04, ...over });
  const dirty = { PATH: process.env.PATH!, HOME: tmpdir(), ORCH_RUNNER_KEY: 'secret-runner-key', MYSQL_PASSWORD: 'x', DATABASE_URL: 'mysql://x', LINEAR_API_KEY: 'lin' };

  it('builds the command with the production builders, and gives the process no orchestrator secret', async () => {
    const calls: Parameters<typeof import('../scripts/code-review-run.ts').runReviewer>[0][] = [];
    const deps = { env: staffStartEnv(dirty), mcpList: [], run: async (o: (typeof calls)[number]) => (calls.push(o), result({ stdout: claudeAnswer })) };
    const out = await runSeat(fx(), cheap!, '/w', 'DIFF TEXT', deps);
    const c = calls[0]!;
    expect(c.cmd).toBe('claude');
    expect(c.args).toEqual(claudeReviewArgs(cheap!));
    expect(c.cwd).toBe('/w');
    expect(c.maxStdout).toBe(REVIEW_STDOUT_MAX);
    expect(c.timeoutMs).toBe(REVIEW_TIMEOUT_MS);
    expect(c.env.ENABLE_CLAUDEAI_MCP_SERVERS).toBe('false');
    for (const k of ['ORCH_RUNNER_KEY', 'MYSQL_PASSWORD', 'DATABASE_URL', 'LINEAR_API_KEY']) expect(c.env, k).not.toHaveProperty(k);
    expect(c.stdin).toBe(seatPrompt(fx(), cheap!, 'DIFF TEXT'));
    expect(out.seat).toMatchObject({ seat: 'cheap-claude', code: 0, secs: 3, rejected: 0, usage: { tokensIn: 15, tokensCached: 100, tokensOut: 7, costUsd: 0.05 } });
    expect(out.seat.findings).toHaveLength(1);
    expect(out.seat.error).toBeUndefined();
  });

  it('builds the Codex command with every MCP server of the list switched off, the same as the runner', async () => {
    const mcp = [{ name: 'orchestrator' }, { name: 'other' }];
    const calls: { args: string[]; cmd: string }[] = [];
    const deps = { env: {}, mcpList: mcp, run: async (o: { args: string[]; cmd: string }) => (calls.push(o), result({ stdout: codexAnswer })) };
    const out = await runSeat(fx(), strong!, '/w', 'DIFF', deps);
    expect(calls[0]!.cmd).toBe('codex');
    // The schema path is a private file that is gone after the run, so compare everything but that argument.
    const expected = codexReviewArgs(strong!, '/w', mcp, 'SCHEMA');
    const got = calls[0]!.args;
    expect(got).toHaveLength(expected.length);
    expect(got.filter((a, i) => a !== expected[i])).toHaveLength(1);
    expect(got.join(' ')).toMatch(/mcp_servers\.orchestrator\.enabled=false/);
    expect(out.seat.usage).toEqual({ tokensIn: 1000, tokensCached: 900, tokensOut: 20, costUsd: null });
    expect(out.seat.findings).toEqual([]);
    expect(out.seat.error).toBeUndefined();
  });

  it('reports a seat that exited non-zero, was not parseable, or could not start as failed, never as an empty pass', async () => {
    const exit1 = await runSeat(fx(), cheap!, '/w', 'D', { env: {}, mcpList: [], run: async () => result({ code: 1, stderr: 'boom' }) });
    expect(exit1.seat.error).toMatch(/exit 1: boom/);
    expect(exit1.seat.findings).toEqual([]);
    const garbage = await runSeat(fx(), cheap!, '/w', 'D', { env: {}, mcpList: [], run: async () => result({ stdout: 'not json' }) });
    expect(garbage.seat.error).toMatch(/not JSON/);
    const noStart = await runSeat(fx(), cheap!, '/w', 'D', { env: {}, mcpList: [], run: async () => Promise.reject(new Error('spawn claude ENOENT')) });
    expect(noStart.seat.error).toMatch(/could not start the reviewer/);
    expect(noStart.seat.code).toBe(1);
    const cut = await runSeat(fx(), cheap!, '/w', 'D', { env: {}, mcpList: [], run: async () => result({ overflow: true, stdout: 'x'.repeat(10) }) });
    expect(cut.seat.error).toBeTruthy();
    // And the scorer counts every one of them as a failed seat.
    const failed: Run = { arm: 'a', fixture: 'tg3', base: fx().base, head: fx().head, seats: [exit1.seat, garbage.seat, noStart.seat, cut.seat] };
    expect(scoreRun(fx(), failed, null).failedSeats).toBe(4);
  });

  it('uses the same prompt as a production seat for the same ticket, notes and diff', () => {
    const f = fx();
    const prod = reviewPrompt(buildReviewPrompt({ seat: 'strong', runtime: 'codex', ticket: { identifier: null, title: f.title, description: '', criteria: '' }, notes: f.notes }), f.base, f.head, 'DIFF');
    expect(seatPrompt(f, strong!, 'DIFF')).toBe(prod);
    expect(seatPrompt(f, strong!, 'DIFF')).toContain(f.notes.slice(0, 40));
  });

  it('exposes the same command as the production builders and builds no flag of its own', () => {
    expect(seatCommand(cheap!, '/w', [], '').args).toEqual(claudeReviewArgs(cheap!));
    expect(seatCommand(strong!, '/w', [], '/s').args).toEqual(codexReviewArgs(strong!, '/w', [], '/s'));
    expect(() => seatCommand({ ...cheap!, runtime: 'other' as never }, '/w', [], '')).toThrow(/unsupported/);
    const src = read('scripts', 'review-eval', 'run.ts');
    for (const word of ['--tools', '--allowedTools', '--permission-mode', 'read-only', '--sandbox', 'approval_policy', 'dangerously', '--strict-mcp-config']) expect(src, word).not.toContain(word);
  });

  it('runs the panel on a worktree at the fixture head and returns one run with a seat each', async () => {
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { PATH: process.env.PATH!, HOME: cwd, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
    const dir = mkdtempSync(join(tmpdir(), 'review-eval-'));
    git(dir, 'init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    git(dir, 'add', 'a.txt');
    git(dir, 'commit', '-q', '-m', 'one');
    const base = git(dir, 'rev-parse', 'HEAD');
    writeFileSync(join(dir, 'b.txt'), 'two\n');
    git(dir, 'add', 'b.txt');
    git(dir, 'commit', '-q', '-m', 'two');
    const head = git(dir, 'rev-parse', 'HEAD');
    const f = { ...fx(), base, head };
    const stdins: string[] = [];
    const run = async (o: { stdin: string; cmd: string }) => (stdins.push(o.stdin), result({ stdout: o.cmd === 'claude' ? claudeAnswer : codexAnswer }));
    const out = await runFixture(f, DEFAULT_PANEL, dir, 'arm1', { env: {}, mcpList: [], run });
    expect(out.run).toMatchObject({ arm: 'arm1', fixture: 'tg3', base, head });
    expect(out.run.seats.map((s) => s.seat)).toEqual(['strong', 'cheap-claude']);
    // Both seats got the diff of exactly base..head from worktreeDiff.
    for (const s of stdins) {
      expect(s).toContain('+++ b/b.txt');
      expect(s).not.toContain('a.txt');
    }
    // A worktree that is not at the head is refused, like the runner does.
    await expect(runFixture({ ...f, head: base, base: head }, DEFAULT_PANEL, dir, 'arm1', { env: {}, mcpList: [], run })).rejects.toThrow(/not at the head sha/);
    // What it stored parses back as a run.
    expect(() => parseRun(JSON.stringify(out.run))).not.toThrow();
    expect(parseReviewerOutput('claude-code', claudeAnswer).ok).toBe(true);
  });
});

// ---------------------------------------------------------------- never in CI, never in the image

describe('the harness stays out of CI and the Docker image', () => {
  it('copies only src and web into the image', () => {
    const copies = read('Dockerfile').split('\n').filter((l) => /^\s*COPY\b/.test(l));
    expect(copies.length).toBeGreaterThan(0);
    for (const l of copies) {
      expect(l).not.toMatch(/\bscripts\b|\btest\b|review-eval/);
    }
    expect(copies.join('\n')).toMatch(/COPY src \.\/src/);
  });

  it('is not called by a workflow, a compose file or a package script', () => {
    const files = [...readdirSync(join(root, '.github', 'workflows')).map((f) => join('.github', 'workflows', f)), ...readdirSync(root).filter((f) => /^docker-compose.*\.ya?ml$/.test(f)), 'package.json'];
    for (const f of files) expect(read(f), f).not.toContain('review-eval');
  });

  it('refuses to start reviewers when CI is set', () => {
    expect(() => refuseInCi({ CI: 'true' })).toThrow(/CI/);
    expect(() => refuseInCi({ GITHUB_ACTIONS: 'true' })).toThrow(/CI/);
    expect(() => refuseInCi({})).not.toThrow();
  });

  it('keeps the runner limits of a seat in step with scripts/runner.ts', () => {
    const runner = read('scripts', 'runner.ts');
    expect(REVIEW_STDOUT_MAX).toBe(500_000);
    expect(REVIEW_TIMEOUT_MS).toBe(20 * 60_000);
    expect(runner).toContain('const REVIEW_STDOUT_MAX = 500_000;');
    expect(runner).toContain('const REVIEW_TIMEOUT_MS = 20 * 60_000;');
  });
});
