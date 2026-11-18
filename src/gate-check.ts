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

/** Whether the run's head contains the merge commit: `gh api repos/<o>/<r>/compare/<merge>...<head>`. */
export function deployCompareArgs(slug: string, mergeSha: string, headSha: string): string[] {
  if (!REPO_NAME.test(slug)) throw new Error('The repository is not an owner/name slug.');
  if (!FULL_SHA.test(mergeSha) || !FULL_SHA.test(headSha)) throw new Error('A commit is not a full sha.');
  return ['api', `repos/${slug}/compare/${mergeSha}...${headSha}`];
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

/** What the runner posts for a deployed check: the chosen run, its view and the comparison, each as GitHub printed it. */
export const DeployedOutputSchema = z.object({
  run: RunItem.nullable(),
  view: RunView.nullable(),
  compare: CompareItem.nullable(),
  error: z.string().max(500).nullable(),
});
export type DeployedOutput = z.infer<typeof DeployedOutputSchema>;

/**
 * The newest run that has finished, whatever its conclusion: a failed latest deploy must not be read as an older success.
 * Only a push or a workflow_dispatch run counts; a pull_request run of the workflow is not a deploy of the base branch.
 */
export function latestCompletedRun(list: unknown): RunItem | null {
  const parsed = z.array(RunItem).safeParse(list);
  if (!parsed.success) return null;
  return parsed.data.find((r) => r.status === 'completed' && (r.event === 'push' || r.event === 'workflow_dispatch')) ?? null;
}

/** The run's job and step, when they concluded success. */
export function jobSucceeded(view: z.infer<typeof RunView>, job: string, step: string | null): boolean {
  const j = view.jobs.find((x) => x.name === job);
  if (!j || j.conclusion !== 'success') return false;
  if (step === null) return true;
  return (j.steps ?? []).some((s) => s.name === step && s.conclusion === 'success');
}

/**
 * Whether GitHub proves a deploy of the merge. The run must be the one the list named, on the base branch, with the job (and
 * step) green. A deploy from the same repository must contain the merge commit (compare ahead or identical). A deploy from
 * another repository cannot be compared, so its run must start after the merge of the source job (the rule in the plan doc).
 */
export function provesDeployed(
  out: DeployedOutput,
  want: { job: string; step: string | null; base: string; sameRepo: boolean; mergedAt: string | null },
): { ok: true; run_id: number; head_sha: string; compare_status: string | null } | { ok: false; reason: string } {
  if (out.error) return { ok: false, reason: out.error };
  if (!out.run) return { ok: false, reason: 'No finished push or workflow_dispatch run of the workflow on the base branch in the newest 10 runs. Older runs are not checked.' };
  if (!out.view) return { ok: false, reason: 'GitHub did not show the run.' };
  const run = out.run;
  const view = out.view;
  if (view.databaseId !== run.databaseId || view.headSha !== run.headSha) return { ok: false, reason: 'The run shown is not the run listed.' };
  if (view.headBranch !== want.base) return { ok: false, reason: `The run is on ${view.headBranch}, not on ${want.base}.` };
  if (!jobSucceeded(view, want.job, want.step)) return { ok: false, reason: `The latest run did not conclude success for ${want.step ? `step ${want.step} of ` : ''}job ${want.job}.` };
  if (want.sameRepo) {
    if (!out.compare) return { ok: false, reason: 'The run head was not compared with the merge commit.' };
    if (out.compare.status !== 'ahead' && out.compare.status !== 'identical') return { ok: false, reason: `The run head does not contain the merge commit (${out.compare.status}).` };
    return { ok: true, run_id: run.databaseId, head_sha: run.headSha, compare_status: out.compare.status };
  }
  if (!want.mergedAt) return { ok: false, reason: 'The merge of the source job is not recorded.' };
  if (!(Date.parse(run.createdAt) > Date.parse(want.mergedAt))) return { ok: false, reason: 'The run started before the merge of the source job.' };
  return { ok: true, run_id: run.databaseId, head_sha: run.headSha, compare_status: null };
}

/** The JSON of one runner call, or null when it is not JSON. */
export function parseJsonOrNull(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
