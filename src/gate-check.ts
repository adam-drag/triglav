import { z } from 'zod';

/**
 * The GitHub side of a merged gate (docs/plans/initiative-room.md, phase 2). The runner runs the argv this module builds,
 * with no shell, and the server reads the JSON back. The PR number and the repository come from the server's database
 * (the source job's delivery and the initiative's repository settings), never from model text. Pure, so the runner and
 * the tests share one definition; scripts/runner.ts imports it.
 */

/** GitHub owner and repository names, as GitHub allows them. A leading dash would read as an option, so it is refused. */
export const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;
const PR_URL = /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_][A-Za-z0-9._-]{0,99})\/pull\/([1-9][0-9]{0,8})$/;

/** The only fields the check reads. Keep in step with GateOutputSchema. */
export const PR_VIEW_FIELDS = 'state,mergedAt,mergeCommit,url,headRefOid';

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
  headRefOid: z.string().regex(/^[0-9a-f]{40}$/),
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
