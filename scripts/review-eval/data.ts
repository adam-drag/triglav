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
export const PANEL_SEVERITIES = ['P0', 'P1', 'P2', 'P3'] as const;
export const SPLITS = ['dev', 'held-out'] as const;

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
    /**
     * dev: may be used to tune prompts, thresholds or panels. held-out: kept for checking a frozen candidate; never tune on it.
     * Every fixture has one, set before any run on it.
     */
    split: z.enum(SPLITS),
    /** Which Copilot findings the fixture records, when it is not every round (for example round 1 only). */
    findings_basis: z.string().min(5).max(500).optional(),
    /** Empty for a PR where Copilot found nothing: the panel's findings there are all extras, judged like any other. */
    copilot_findings: z.array(CopilotFinding),
  })
  .superRefine((f, ctx) => {
    const ids = f.copilot_findings.map((c) => c.id);
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: `${f.id}: duplicate finding id` });
    if (f.copilot_findings.length > 0 && !f.copilot_findings.some((c) => c.round === 1)) ctx.addIssue({ code: 'custom', message: `${f.id}: findings of later rounds but no round 1 finding` });
    for (const c of f.copilot_findings) if (!c.id.startsWith(`${f.id}-`)) ctx.addIssue({ code: 'custom', message: `${c.id}: the id does not start with the fixture id ${f.id}` });
  });
export type Fixture = z.infer<typeof Fixture>;

const Usage = z.object({ tokensIn: z.number().nullable(), tokensCached: z.number().nullable(), tokensOut: z.number().nullable(), costUsd: z.number().nullable() });
const Finding = z.object({
  severity: z.enum(PANEL_SEVERITIES),
  title: z.string(),
  body: z.string(),
  sites: z.array(z.object({ file: z.string(), line: z.number() })),
});

const SeatConfig = z.object({ runtime: z.enum(['codex', 'claude-code']), model: z.string().min(1), effort: z.string().min(1) });
export type SeatConfig = z.infer<typeof SeatConfig>;

/** One reviewer process of a seat. A retried seat has several; every one of them counts in the usage. */
const Attempt = z.object({
  attempt: z.number().int().min(1),
  code: z.number().nullable(),
  secs: z.number().min(0),
  usage: Usage,
  /** Tokens this attempt was charged against the budget: its reported usage, the estimate when it reported none, 0 when no process started. */
  charged: z.number().min(0),
  /** False when no process started. A started attempt with no usage may still have spent tokens: its usage is unknown, not zero. */
  started: z.boolean(),
  /** True when the output went over the cap: the usage is what was read before the cut, a lower bound, and the charge is at least the estimate. */
  cut: z.boolean().optional(),
  error: z.string().nullable(),
});

/**
 * What a seat ran with, so a stored run can be reconstructed and checked. Runs stored before the manifest existed (the
 * baseline) have none. `requested` is what the arm asked for; `effective` is what ran. When they differ (production mode
 * with a fallback), the scorer does not count the seat under the arm's name.
 */
const SeatManifest = z.object({
  /** `--version` of the CLI that ran the seat, or null when it could not be read. */
  cli_version: z.string().max(100).nullable(),
  requested: SeatConfig,
  effective: SeatConfig,
  /** Why the effective seat differs from the requested one (resolveSeats' note), or null. */
  fallback_reason: z.string().max(1000).nullable(),
  /** SHA-256 of the whole text the seat got on stdin (server prompt and diff). */
  prompt_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** Which repeat of the arm this run is (`run --repeat`). */
  repeat: z.number().int().min(1),
  /** The seed of the seat's file order (`<seat>` newline `<head>`, as diffForSeat uses it), or null when the seat reads the diff in git's order. */
  shuffle_seed: z.string().max(100).nullable(),
  rejected: z.number().int().min(0),
  /** Accepted findings with no valid site left after parsing. */
  zero_site: z.number().int().min(0),
  /** The reason the seat failed, or null. */
  failure: z.string().nullable(),
  attempts: z.array(Attempt).min(1),
});
export type SeatManifest = z.infer<typeof SeatManifest>;

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
  /** A lens seat's lens and whether it ran as a shadow seat, as stored when it ran. Runs stored before lens seats have neither. */
  lens: z.string().optional(),
  shadow: z.boolean().optional(),
  /** Set when the seat failed (non-zero exit, no answer, unparseable answer); a failed seat has no findings and is never a pass. */
  error: z.string().optional(),
  findings: z.array(Finding),
  manifest: SeatManifest.optional(),
}).superRefine((s, ctx) => {
  // The runner never keeps findings of a seat that failed, so a stored one is edited or corrupt and would inflate a score.
  if ((s.code !== 0 || s.error !== undefined) && s.findings.length > 0) ctx.addIssue({ code: 'custom', message: `${s.seat}: a failed seat (exit code ${s.code}${s.error !== undefined ? ', with an error' : ''}) has no findings` });
});
export type SeatRun = z.infer<typeof SeatRun>;

export const RUN_MODES = ['fixed', 'production'] as const;
export type RunMode = (typeof RUN_MODES)[number];

/** What the whole run of a fixture ran with. Optional: the baseline was stored before it existed. */
const RunManifest = z.object({
  /** fixed: the seats exactly as the arm names them. production: the arm's seats resolved by resolveSeats, as a real review would. */
  mode: z.enum(RUN_MODES),
  repeat: z.number().int().min(1),
  /** `git rev-parse HEAD` of the Triglav checkout that ran the harness, and whether it had uncommitted changes. */
  harness_rev: z.string().max(60).nullable(),
  harness_dirty: z.boolean().nullable(),
  /** SHA-256 of the diff as git printed it (before any seat's own file order). */
  diff_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** Production mode: the runtime of the Senior a real review would come from, and the Codex window used, as given on the command line. */
  requester_runtime: z.string().max(40).nullable(),
  codex_used: z.number().min(0).max(100).nullable(),
  /** Seats the arm asked for that resolveSeats dropped, with its reason. */
  dropped: z.array(z.object({ seat: z.string(), reason: z.string() })),
  started_at: z.string(),
  finished_at: z.string(),
});
export type RunManifest = z.infer<typeof RunManifest>;

/** `prompt` names the review prompt the arm used; a run stored before it existed has none and used the production prompt. */
const Run = z.object({ arm: z.string().min(1), fixture: z.string().min(1), base: sha, head: sha, prompt: z.enum(['production', 'lean']).optional(), manifest: RunManifest.optional(), seats: z.array(SeatRun).min(1) });
export type Run = z.infer<typeof Run>;

/** Attempts of a seat that started and reported no usage: their tokens are unknown, and the budget charged their estimate. */
export const attemptsWithoutUsage = (s: Pick<SeatRun, 'manifest'>): number =>
  (s.manifest?.attempts ?? []).filter((a) => a.started && a.usage.tokensIn === null && a.usage.tokensCached === null && a.usage.tokensOut === null).length;

/** Attempts whose output went over the cap: their usage is a lower bound. */
export const attemptsCut = (s: Pick<SeatRun, 'manifest'>): number => (s.manifest?.attempts ?? []).filter((a) => a.cut === true).length;

/** True when the seat ran something else than the arm asked for (a production-mode fallback). Such a seat is never scored under the arm's name. */
export const substituted = (s: Pick<SeatRun, 'manifest'>): boolean => {
  const m = s.manifest;
  return !!m && (m.requested.runtime !== m.effective.runtime || m.requested.model !== m.effective.model || m.requested.effort !== m.effective.effort);
};

/** Why a seat's output is incomplete, or null: it failed, the parser rejected findings, or a finding kept no valid site. */
export function incompleteReason(s: SeatRun): string | null {
  const parts: string[] = [];
  if (s.error !== undefined || s.code !== 0) parts.push(`failed${s.error ? `: ${s.error.slice(0, 120)}` : ''}`);
  if (s.rejected > 0) parts.push(`${s.rejected} finding(s) rejected by the parser`);
  const zero = s.findings.filter((f) => f.sites.length === 0).length;
  if (zero > 0) parts.push(`${zero} finding(s) with no valid site`);
  return parts.length ? parts.join('; ') : null;
}

export const JUDGMENT_KINDS = ['catch', 'partial', 'valid', 'invalid', 'unsure'] as const;
export type JudgmentKind = (typeof JUDGMENT_KINDS)[number];
export const VALIDITIES = ['valid', 'invalid', 'unsure'] as const;
export type Validity = (typeof VALIDITIES)[number];
/** Why a defect was missed (companion spec section 5). unknown when the trace does not show a cause: never invent one. */
export const MISS_CAUSES = ['context', 'retrieval', 'reasoning', 'scope', 'output_loss', 'aggregation', 'unknown'] as const;

/**
 * The evidence of a judgment read from the code. A file:line alone is not enough: the trigger, the expected and the actual
 * behaviour and the reasoning say why. `reviewers` is `single` until a second reader judged it apart.
 */
const Evidence = z.object({
  reviewed_sha: sha,
  site: z.string().min(3).max(300),
  trigger: z.string().min(5).max(1000),
  expected: z.string().min(5).max(1000),
  actual: z.string().min(5).max(1000),
  reasoning: z.string().min(5).max(3000),
  reviewers: z.enum(['single', 'two']),
});

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
  dup_of: z.string().regex(/^[^#]+#(?:0|[1-9]\d*)$/, 'must be seat#index with no leading zero').optional(),
  note: z.string().optional(),
  /**
   * Is the defect real, apart from whether it matches Copilot. Optional: when absent, catch and valid count as valid, invalid
   * as invalid, and partial and unsure as not judged. It must agree with valid, invalid and unsure.
   */
  validity: z.enum(VALIDITIES).optional(),
  /** The severity the reader gives the defect (P0 to P3), apart from the seat's own. */
  severity: z.enum(PANEL_SEVERITIES).optional(),
  evidence: Evidence.optional(),
}).superRefine((j, ctx) => {
  const fixed: Partial<Record<JudgmentKind, Validity>> = { valid: 'valid', invalid: 'invalid', unsure: 'unsure' };
  const want = fixed[j.kind];
  if (want && j.validity !== undefined && j.validity !== want) ctx.addIssue({ code: 'custom', message: `${j.seat}#${j.index}: a ${j.kind} judgment cannot have validity ${j.validity}` });
});
export type Judgment = z.infer<typeof Judgment>;

/** A Copilot finding no panel finding caught, and the reader's view of why. */
const Miss = z.object({ copilot: z.string(), cause: z.enum(MISS_CAUSES), note: z.string().optional() });
export type Miss = z.infer<typeof Miss>;

const Judgments = z.object({
  arm: z.string().min(1),
  judged_by: z.string().min(5),
  note: z.string(),
  fixtures: z.record(z.string(), z.array(Judgment)),
  misses: z.record(z.string(), z.array(Miss)).optional(),
});
export type Judgments = z.infer<typeof Judgments>;

/** The validity a judgment stands for: its own field, else what its kind implies (catch and valid: valid; invalid: invalid; partial and unsure: unsure). */
export function validityOf(j: Judgment | undefined): Validity {
  if (!j) return 'unsure';
  if (j.validity) return j.validity;
  return j.kind === 'catch' || j.kind === 'valid' ? 'valid' : j.kind === 'invalid' ? 'invalid' : 'unsure';
}

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
  const runs = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => parseRun(readFileSync(join(dir, f), 'utf8'), f));
  assertOneRunPerFixture(runs);
  return runs;
}

/** A second run of a fixture would be counted twice and judged against only the first, so it is refused. */
export function assertOneRunPerFixture(runs: Run[]): void {
  const seen = new Set<string>();
  for (const r of runs) {
    if (seen.has(r.fixture)) throw new Error(`more than one run of fixture ${r.fixture}: one arm has one run per fixture`);
    seen.add(r.fixture);
  }
}

export const loadJudgments = (file: string) => parseJudgments(readFileSync(file, 'utf8'), file);

/**
 * Checks that every judgment points at a real panel finding and a real Copilot finding, and says the same title as the stored
 * run. Throws on the first problem, so a stale judgment never scores quietly.
 */
export function checkJudgments(fixtures: Fixture[], runs: Run[], judgments: Judgments): void {
  assertOneRunPerFixture(runs);
  for (const [fid, list] of Object.entries(judgments.fixtures)) {
    const fx = fixtures.find((f) => f.id === fid);
    const run = runs.find((r) => r.fixture === fid);
    if (!fx) throw new Error(`judgments: no fixture ${fid}`);
    if (!run) throw new Error(`judgments: no stored run for ${fid}`);
    if (run.arm !== judgments.arm) throw new Error(`judgments ${fid}: the judgments are for arm ${judgments.arm}, the run is arm ${run.arm}`);
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
    for (const j of list) if (j.evidence && j.evidence.reviewed_sha !== run.head) throw new Error(`judgments ${fid} ${j.seat}#${j.index}: the evidence was read at ${j.evidence.reviewed_sha.slice(0, 12)}, not at the run's head`);
    // A chain of repeats must end at a finding that repeats nothing: a cycle would drop every representative of the defect.
    const next = new Map(list.filter((j) => j.dup_of).map((j) => [`${j.seat}#${j.index}`, j.dup_of!]));
    for (const start of next.keys()) {
      let at = start;
      for (let steps = 0; next.has(at); steps += 1) {
        at = next.get(at)!;
        if (at === start || steps > next.size) throw new Error(`judgments ${fid} ${start}: dup_of leads back to itself (${start} repeats a finding that repeats it)`);
      }
    }
  }
  for (const [fid, misses] of Object.entries(judgments.misses ?? {})) {
    const fx = fixtures.find((f) => f.id === fid);
    if (!fx) throw new Error(`judgments misses: no fixture ${fid}`);
    const caught = new Set((judgments.fixtures[fid] ?? []).filter((j) => j.kind === 'catch').map((j) => j.copilot));
    const seen = new Set<string>();
    for (const m of misses) {
      if (!fx.copilot_findings.some((c) => c.id === m.copilot)) throw new Error(`judgments misses ${fid}: no Copilot finding ${m.copilot}`);
      if (caught.has(m.copilot)) throw new Error(`judgments misses ${fid}: ${m.copilot} is caught, so it has no miss cause`);
      if (seen.has(m.copilot)) throw new Error(`judgments misses ${fid}: ${m.copilot} is listed twice`);
      seen.add(m.copilot);
    }
  }
}
