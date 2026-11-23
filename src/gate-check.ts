import { z } from 'zod';

/**
 * The GitHub side of a merged gate (docs/plans/initiative-room.md, phase 2). The runner runs the argv this module builds,
 * with no shell, and the server reads the JSON back. The PR number and the repository come from the server's database
 * (the source job's delivery and the initiative's repository settings), never from model text. Pure, so the runner and
 * the tests share one definition; scripts/runner.ts imports it.
 */

/** GitHub owner and repository names, as GitHub allows them. A leading dash would read as an option, so it is refused. */
export const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;
// A trailing slash, a query or a fragment names the same pull request; a subpath such as /files does not.
const PR_URL = /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_][A-Za-z0-9._-]{0,99})\/pull\/([1-9][0-9]{0,8})\/?(?:\?[^#\s]*)?(?:#\S*)?$/;

/** The only fields the check reads. Keep in step with GateOutputSchema. */
export const PR_VIEW_FIELDS = 'state,mergedAt,mergeCommit,url';

/** The argv of the check: `gh pr view <number> -R <owner/repo> --json <fields>`. Throws for a value outside its shape. */
export function prViewArgs(pr: number, slug: string): string[] {
  if (!Number.isInteger(pr) || pr < 1 || pr > 999_999_999) throw new Error('The PR number is not a positive integer.');
  if (!REPO_NAME.test(slug)) throw new Error('The repository is not an owner/name slug.');
  return ['pr', 'view', String(pr), '-R', slug, '--json', PR_VIEW_FIELDS];
}

/** The repository and number of a GitHub pull request URL, or null when the URL is not one. */
export function parsePrUrl(url: string): { slug: string; number: number } | null {
  const m = PR_URL.exec(url);
  if (!m) return null;
  return { slug: m[1]!, number: Number(m[2]) };
}

export const GateOutputSchema = z.object({
  state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
  mergedAt: z.string().max(40).nullable(),
  mergeCommit: z.object({ oid: z.string().regex(/^[0-9a-f]{40}$/) }).nullable(),
  url: z.string().max(300),
});
export type GateOutput = z.infer<typeof GateOutputSchema>;

/** The JSON the check printed, or null when it is not that shape. The text is GitHub's, so it is parsed, never run. */
export function parseGateOutput(stdout: string): GateOutput | null {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return null;
  }
  const parsed = GateOutputSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** A gate is met only when GitHub says the PR is merged and names the merge commit. */
export function provesMerged(out: GateOutput): boolean {
  return out.state === 'MERGED' && out.mergedAt !== null && out.mergeCommit !== null;
}

// ---------------------------------------------------------------- deployed gates (phase 4)

/**
 * The GitHub side of a deployed gate (docs/plans/initiative-room.md, phase 4). Three read-only calls, each argv built here
 * with no shell: the newest runs of the deploy workflow on the base branch, the jobs of the chosen run, and a comparison
 * of the merge commit with the run's head. The workflow, the branch, the slug and the commits come from the server, never
 * from model text. The server reads the JSON back and decides (provesDeployed).
 */

/** A workflow file name, as `gh run list --workflow` takes it. A leading dash would read as an option, so it is refused. */
export const WORKFLOW_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.ya?ml$/;
/** A branch name, as the initiative's repository settings allow it (initiatives.ts BRANCH). */
export const DEPLOY_BRANCH = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,100}$/;
const FULL_SHA = /^[0-9a-f]{40}$/;
export const RUN_LIST_FIELDS = 'databaseId,headSha,status,conclusion,createdAt,headBranch,event';
export const RUN_VIEW_FIELDS = 'databaseId,headBranch,headSha,status,conclusion,createdAt,jobs';
export const PR_BODY_FIELDS = 'body,files,state,mergedAt,mergeCommit';

/** The newest runs of the workflow on the branch, newest first: `gh run list`. */
export function deployRunListArgs(slug: string, workflow: string, branch: string): string[] {
  if (!REPO_NAME.test(slug)) throw new Error('The repository is not an owner/name slug.');
  if (!WORKFLOW_FILE.test(workflow)) throw new Error('The workflow is not a workflow file name.');
  if (!DEPLOY_BRANCH.test(branch)) throw new Error('The branch is not a branch name.');
  return ['run', 'list', '-R', slug, '--workflow', workflow, '--branch', branch, '--limit', '10', '--json', RUN_LIST_FIELDS];
}

/** One run with its jobs and steps: `gh run view <id>`. */
export function deployRunViewArgs(slug: string, runId: number): string[] {
  if (!REPO_NAME.test(slug)) throw new Error('The repository is not an owner/name slug.');
  if (!Number.isInteger(runId) || runId < 1 || runId > 999_999_999_999) throw new Error('The run id is not a positive integer.');
  return ['run', 'view', String(runId), '-R', slug, '--json', RUN_VIEW_FIELDS];
}

/**
 * Whether the run's head contains the merge commit: `gh api repos/<o>/<r>/compare/<merge>...<head>`. GitHub's answer lists up to
 * 250 commits and 300 files with patches, so the runner keeps only the status (readCompare) and gives this call a larger output
 * cap. The argv has no flag: AGENTS.md lists it.
 */
export function deployCompareArgs(slug: string, mergeSha: string, headSha: string): string[] {
  if (!REPO_NAME.test(slug)) throw new Error('The repository is not an owner/name slug.');
  if (!FULL_SHA.test(mergeSha) || !FULL_SHA.test(headSha)) throw new Error('A commit is not a full sha.');
  return ['api', `repos/${slug}/compare/${mergeSha}...${headSha}`];
}

/** The argv of `gh pr ready` for an Architect's mark_pr_ready, confirmed by the Client or run in auto mode: the number and the repository only. */
export function prReadyArgs(pr: number, slug: string): string[] {
  if (!Number.isInteger(pr) || pr < 1 || pr > 999_999_999) throw new Error('The PR number is not a positive integer.');
  if (!REPO_NAME.test(slug)) throw new Error('The repository is not an owner/name slug.');
  return ['pr', 'ready', String(pr), '-R', slug];
}

/** The argv that reads a merged pull request's body and files for the Architect (src/architect-wake.ts). */
export function prBodyArgs(pr: number, slug: string): string[] {
  if (!Number.isInteger(pr) || pr < 1 || pr > 999_999_999) throw new Error('The PR number is not a positive integer.');
  if (!REPO_NAME.test(slug)) throw new Error('The repository is not an owner/name slug.');
  return ['pr', 'view', String(pr), '-R', slug, '--json', PR_BODY_FIELDS];
}

const RunItem = z.object({
  databaseId: z.number().int().positive(),
  headSha: z.string().regex(FULL_SHA),
  status: z.string().max(40),
  conclusion: z.string().max(40).nullable(),
  createdAt: z.string().max(40),
  headBranch: z.string().max(200),
  event: z.string().max(40),
});
export type RunItem = z.infer<typeof RunItem>;
const StepItem = z.object({ name: z.string().max(300), conclusion: z.string().max(40).nullable() });
const JobItem = z.object({ name: z.string().max(300), conclusion: z.string().max(40).nullable(), steps: z.array(StepItem).max(200).optional() });
const RunView = z.object({
  databaseId: z.number().int().positive(),
  headSha: z.string().regex(FULL_SHA),
  headBranch: z.string().max(200),
  status: z.string().max(40),
  conclusion: z.string().max(40).nullable(),
  createdAt: z.string().max(40),
  jobs: z.array(JobItem).max(200),
});
const CompareItem = z.object({ status: z.enum(['ahead', 'identical', 'behind', 'diverged']) });
const RunList = z.array(RunItem).max(10);

/** The runs `gh run list` printed, newest first, or null when they are not that shape. */
export function parseRunList(stdout: string): RunItem[] | null {
  const parsed = RunList.safeParse(parseJsonOrNull(stdout));
  return parsed.success ? parsed.data : null;
}

/** The run view with only the fields the server reads (zod drops the rest), or null when it is not that shape. */
export function readRunView(stdout: string): z.infer<typeof RunView> | null {
  const parsed = RunView.safeParse(parseJsonOrNull(stdout));
  return parsed.success ? parsed.data : null;
}

/** The status of a comparison answer, or null when it is not that shape. */
export function readCompare(stdout: string): z.infer<typeof CompareItem> | null {
  const parsed = CompareItem.safeParse(parseJsonOrNull(stdout));
  return parsed.success ? parsed.data : null;
}

/** A listed run always has its view: a run whose view cannot be read refuses the check, so an older run cannot decide for it. */
const DeployedRunEntry = z.object({ run: RunItem, view: RunView, compare: CompareItem.nullable() });
export type DeployedRunEntry = z.infer<typeof DeployedRunEntry>;

/**
 * What the runner posts for a deployed check: each run `gh run list` named (newest first, at most 10), with its view and, for
 * a deploy from the same repository, its comparison with the merge commit. The server picks the run (decidingRun).
 */
export const DeployedOutputSchema = z.object({
  runs: z.array(DeployedRunEntry).max(10),
  error: z.string().max(500).nullable(),
});
export type DeployedOutput = z.infer<typeof DeployedOutputSchema>;

/**
 * The run that decides the gate: the newest push or workflow_dispatch run in which the named job has completed (its conclusion is
 * set), whatever the run's own status or its other jobs. A run whose job still waits is skipped, and a newer run whose job failed
 * wins over an older success.
 */
export function decidingRun(out: DeployedOutput, job: string): DeployedRunEntry | null {
  // GitHub prints an unfinished job with an empty conclusion (""), and null in some answers: both mean the job has not completed.
  return out.runs.find((e) => (e.run.event === 'push' || e.run.event === 'workflow_dispatch') && e.view.jobs.some((j) => j.name === job && !!j.conclusion)) ?? null;
}

/** The run's job and step, when they concluded success. */
export function jobSucceeded(view: z.infer<typeof RunView>, job: string, step: string | null): boolean {
  const j = view.jobs.find((x) => x.name === job);
  if (!j || j.conclusion !== 'success') return false;
  if (step === null) return true;
  return (j.steps ?? []).some((s) => s.name === step && s.conclusion === 'success');
}

/**
 * Whether GitHub proves a deploy of the merge. The decisive run is the one decidingRun picks: its view must be the run listed, on
 * the base branch, with the named job (and step) green. A deploy from the same repository must contain the merge commit (compare
 * ahead or identical). A deploy from another repository cannot be compared, so its run must start after the merge of the source
 * job (the rule in the plan doc).
 */
export function provesDeployed(
  out: DeployedOutput,
  want: { job: string; step: string | null; base: string; sameRepo: boolean; mergedAt: string | null },
): { ok: true; run_id: number; head_sha: string; compare_status: string | null } | { ok: false; reason: string } {
  if (out.error) return { ok: false, reason: out.error };
  if (out.runs.length === 0) return { ok: false, reason: 'GitHub listed no run of the workflow on the base branch. Older runs are not checked.' };
  const entry = decidingRun(out, want.job);
  if (!entry) return { ok: false, reason: `None of the newest ${out.runs.length} push or workflow_dispatch runs has completed job ${want.job}. Older runs are not checked.` };
  const run = entry.run;
  const view = entry.view;
  if (view.databaseId !== run.databaseId || view.headSha !== run.headSha) return { ok: false, reason: 'The run shown is not the run listed.' };
  if (view.headBranch !== want.base) return { ok: false, reason: `The run is on ${view.headBranch}, not on ${want.base}.` };
  if (!jobSucceeded(view, want.job, want.step)) return { ok: false, reason: `The newest run that completed job ${want.job} did not conclude success for ${want.step ? `step ${want.step} of ` : ''}that job.` };
  if (want.sameRepo) {
    if (!entry.compare) return { ok: false, reason: 'The run head was not compared with the merge commit.' };
    if (entry.compare.status !== 'ahead' && entry.compare.status !== 'identical') return { ok: false, reason: `The run head does not contain the merge commit (${entry.compare.status}).` };
    return { ok: true, run_id: run.databaseId, head_sha: run.headSha, compare_status: entry.compare.status };
  }
  if (!want.mergedAt) return { ok: false, reason: 'The merge of the source job is not recorded.' };
  if (!(Date.parse(run.createdAt) > Date.parse(want.mergedAt))) return { ok: false, reason: 'The run started before the merge of the source job.' };
  return { ok: true, run_id: run.databaseId, head_sha: run.headSha, compare_status: null };
}

/** The longest one call of the deployed check may run (scripts/runner.ts). */
export const GH_CALL_MS = 60_000;

/**
 * The timeout of one call of the deployed check: at most GH_CALL_MS, and never past the check's deadline. Null when the deadline has
 * passed, so the call does not start. The calls of one check share that deadline.
 */
export function callTimeoutMs(deadline: number, now: number, cap = GH_CALL_MS): number | null {
  const left = deadline - now;
  return left > 0 ? Math.min(cap, left) : null;
}

/** The JSON of one runner call, or null when it is not JSON. */
export function parseJsonOrNull(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
