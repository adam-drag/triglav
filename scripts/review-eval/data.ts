/**
 * The data of the review evaluation harness: fixtures (a Triglav PR and what Copilot found in it), stored runs (what the
 * seats of a panel answered) and judgments (which panel finding is which Copilot finding). Each is a JSON file, parsed and
 * checked here, so a typo in a fixture fails a test instead of skewing a score.
 *
 * Dev only. The Docker image copies `src` and `web`, never `scripts` or `test`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

const SHA = /^[0-9a-f]{40}$/;
const sha = z.string().regex(SHA, 'a full 40-character sha');

/** Copilot's own three levels, read from the severity badge of each finding. Our panel uses P0 to P3, so the two are never mixed. */
export const COPILOT_SEVERITIES = ['high', 'medium', 'low'] as const;

const CopilotFinding = z
  .object({
    id: z.string().regex(/^[a-z0-9]+-r\d+-[a-z]$/),
    round: z.number().int().min(1).max(20),
    severity: z.enum(COPILOT_SEVERITIES),
    file: z.string().min(1),
    line: z.number().int().min(0),
    /** A short label in our own words. Never Copilot's text. */
    label: z.string().min(5).max(200),
    /** Round 2 and later only: the finding was already true at the round 1 head, so a first-round review could have found it. */
    ceiling: z.boolean().optional(),
    ceiling_basis: z.string().min(5).max(300).optional(),
  })
  .superRefine((f, ctx) => {
    if (f.round === 1 && (f.ceiling !== undefined || f.ceiling_basis !== undefined)) ctx.addIssue({ code: 'custom', message: `${f.id}: a round 1 finding has no ceiling field` });
    if (f.round > 1 && (f.ceiling === undefined || !f.ceiling_basis)) ctx.addIssue({ code: 'custom', message: `${f.id}: a later round needs ceiling and ceiling_basis` });
    if (!f.id.includes(`-r${f.round}-`)) ctx.addIssue({ code: 'custom', message: `${f.id}: the id does not name round ${f.round}` });
  });
export type CopilotFinding = z.infer<typeof CopilotFinding>;

const Fixture = z
  .object({
    id: z.string().regex(/^[a-z0-9]+$/),
    repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
    pr: z.number().int().positive(),
    url: z.string().url(),
    base: sha,
    head: sha,
    head_note: z.string(),
    diff_chars: z.number().int().positive(),
    /** The PR title, used as the ticket title of the prompt. */
    title: z.string().min(1).max(300),
    notes_basis: z.string(),
    /** The PR description the prompt gets as the author's claims, cut to what existed before the first review. */
    notes: z.string().max(4000),
    copilot_findings: z.array(CopilotFinding).min(1),
  })
  .superRefine((f, ctx) => {
    const ids = f.copilot_findings.map((c) => c.id);
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: `${f.id}: duplicate finding id` });
    if (!f.copilot_findings.some((c) => c.round === 1)) ctx.addIssue({ code: 'custom', message: `${f.id}: no round 1 finding` });
    for (const c of f.copilot_findings) if (!c.id.startsWith(`${f.id}-`)) ctx.addIssue({ code: 'custom', message: `${c.id}: the id does not start with the fixture id ${f.id}` });
  });
export type Fixture = z.infer<typeof Fixture>;

const Usage = z.object({ tokensIn: z.number().nullable(), tokensCached: z.number().nullable(), tokensOut: z.number().nullable(), costUsd: z.number().nullable() });
const Finding = z.object({
  severity: z.enum(['P0', 'P1', 'P2', 'P3']),
  title: z.string(),
  body: z.string(),
  sites: z.array(z.object({ file: z.string(), line: z.number() })),
});

const SeatRun = z.object({
  seat: z.string().min(1),
  runtime: z.enum(['codex', 'claude-code']),
  model: z.string(),
  effort: z.string(),
  /** The exit code of the reviewer process, or null when it did not start. */
  code: z.number().nullable(),
  secs: z.number().min(0),
  prompt_chars: z.number().int().min(0),
  diff_chars: z.number().int().min(0),
  rejected: z.number().int().min(0),
  usage: Usage,
  /** Set when the seat failed (non-zero exit, no answer, unparseable answer); a failed seat has no findings and is never a pass. */
  error: z.string().optional(),
  findings: z.array(Finding),
});
export type SeatRun = z.infer<typeof SeatRun>;

const Run = z.object({ arm: z.string().min(1), fixture: z.string().min(1), base: sha, head: sha, seats: z.array(SeatRun).min(1) });
export type Run = z.infer<typeof Run>;

export const JUDGMENT_KINDS = ['catch', 'partial', 'valid', 'invalid', 'unsure'] as const;
export type JudgmentKind = (typeof JUDGMENT_KINDS)[number];

const Judgment = z.object({
  seat: z.string(),
  index: z.number().int().min(0),
  /** The finding's title, repeated so a run that was regenerated cannot be scored against the old judgments by accident. */
  title: z.string(),
  /**
   * catch: the same root cause and the same fix as a Copilot finding. partial: a related symptom, not counted as caught.
   * valid, invalid, unsure: a finding Copilot did not make, judged by reading the code. invalid is noise; unsure is unjudged.
   */
  kind: z.enum(JUDGMENT_KINDS),
  copilot: z.string().optional(),
  /** `seat#index` of the finding this one repeats (the same defect). It is listed as a duplicate and not counted again. */
  dup_of: z.string().regex(/^[^#]+#\d+$/).optional(),
  note: z.string().optional(),
});
export type Judgment = z.infer<typeof Judgment>;

const Judgments = z.object({ arm: z.string().min(1), judged_by: z.string().min(5), note: z.string(), fixtures: z.record(z.string(), z.array(Judgment)) });
export type Judgments = z.infer<typeof Judgments>;

function parse<T>(schema: z.ZodType<T>, text: string, what: string): T {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`${what}: not JSON (${(e as Error).message})`);
  }
  const r = schema.safeParse(json);
  if (!r.success) throw new Error(`${what}: ${r.error.issues.map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}`);
  return r.data;
}

export const parseFixture = (text: string, what = 'fixture') => parse(Fixture, text, what);
export const parseRun = (text: string, what = 'run') => parse(Run, text, what);
export const parseJudgments = (text: string, what = 'judgments') => parse(Judgments, text, what);

/** The directory of the committed data: fixtures, the stored baseline run and its judgments. */
export const DATA_DIR = join(import.meta.dirname, '..', '..', 'test', 'fixtures', 'review-eval');

export function loadFixtures(dir = join(DATA_DIR, 'prs')): Fixture[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => {
      const fx = parseFixture(readFileSync(join(dir, f), 'utf8'), `${f}`);
      if (`${fx.id}.json` !== f) throw new Error(`${f}: the file name must be the fixture id ${fx.id}`);
      return fx;
    });
}

export function loadRuns(dir: string): Run[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => parseRun(readFileSync(join(dir, f), 'utf8'), f));
}

export const loadJudgments = (file: string) => parseJudgments(readFileSync(file, 'utf8'), file);

/**
 * Checks that every judgment points at a real panel finding and a real Copilot finding, and says the same title as the stored
 * run. Throws on the first problem, so a stale judgment never scores quietly.
 */
export function checkJudgments(fixtures: Fixture[], runs: Run[], judgments: Judgments): void {
  for (const [fid, list] of Object.entries(judgments.fixtures)) {
    const fx = fixtures.find((f) => f.id === fid);
    const run = runs.find((r) => r.fixture === fid);
    if (!fx) throw new Error(`judgments: no fixture ${fid}`);
    if (!run) throw new Error(`judgments: no stored run for ${fid}`);
    const seen = new Set<string>();
    for (const j of list) {
      const where = `judgments ${fid} ${j.seat}#${j.index}`;
      const f = run.seats.find((s) => s.seat === j.seat)?.findings[j.index];
      if (!f) throw new Error(`${where}: the run has no such finding`);
      if (f.title !== j.title) throw new Error(`${where}: the title differs from the stored finding`);
      if (seen.has(`${j.seat}#${j.index}`)) throw new Error(`${where}: judged twice`);
      seen.add(`${j.seat}#${j.index}`);
      if ((j.kind === 'catch' || j.kind === 'partial') !== (j.copilot !== undefined)) throw new Error(`${where}: only catch and partial name a Copilot finding, and both must`);
      if (j.copilot && !fx.copilot_findings.some((c) => c.id === j.copilot)) throw new Error(`${where}: no Copilot finding ${j.copilot}`);
      if (j.dup_of) {
        const [s, i] = j.dup_of.split('#') as [string, string];
        if (!run.seats.find((x) => x.seat === s)?.findings[Number(i)]) throw new Error(`${where}: dup_of ${j.dup_of} is not a finding of the run`);
        if (j.dup_of === `${j.seat}#${j.index}`) throw new Error(`${where}: a finding cannot repeat itself`);
      }
    }
  }
}
