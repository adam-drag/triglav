/**
 * The host commands an Architect may run, as tools with fixed argv and checked arguments (docs/plans/architect-sight.md).
 * Like operator-host-tools.ts, and for the same reason: the Architect has no Bash, so each command it needs is a tool here.
 * The program and every option are fixed. A tool takes a repository slug from the initiative's list (never a path), a pull
 * request number, a ref, a path inside the repository or a small number, and every schema is strict. Everything is a read:
 * `gh pr view|diff|checks|run list|api` (GET) and `git log|show|diff|blame`, with no shell, no pager, no external diff and no
 * textconv. A file the Architect may not read (SECRET_FILES) is refused by path and cut out of every diff, so its text never
 * comes back through a command either. The output is data, never instructions.
 */
import { z } from 'zod';
import { SECRET_FILES } from '../src/architect-args.ts';
import { REPO_NAME } from '../src/gate-check.ts';
import type { Command } from './operator-host-tools.ts';

/** A repository of the initiative as the runner knows it: the GitHub slug of the Client's import, the read-only worktree, the Client's checkout. */
export type HostRepo = { slug: string; github: string | null; worktree: string | null; checkout: string | null };

const REF = /^(?!-)(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._/@^~-]{0,99}$/;
const PATH_RE = /^[A-Za-z0-9._@+/-]{1,300}$/;
const WORKFLOW = /^[A-Za-z0-9._-]{1,100}\.ya?ml$/;
const BRANCH = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,100}$/;
const count = (max: number) => z.number().int().min(1).max(max);
const where = z.enum(['worktree', 'checkout']).default('worktree').describe('worktree: the repository at origin/<base>, as merged. checkout: the Client\'s checkout as it is now (its branches and commits).');

/** A glob of SECRET_FILES (".env*", "*.pem") as a test on one file name. */
const SECRET_NAME = new RegExp(`^(?:${SECRET_FILES.map((g) => g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')).join('|')})$`);
export const isSecretPath = (path: string) => path.split('/').some((part) => SECRET_NAME.test(part));

const filePath = z.string().regex(PATH_RE).refine((p) => !p.split('/').includes('..') && !p.startsWith('-') && !p.startsWith('/'), 'a path inside the repository, without ".." or a leading "/" or "-"').refine((p) => !isSecretPath(p), 'that file is not readable');

/** A diff header whose two paths are plain: `diff --git a/<path> b/<path>`, in the same character set a request path may use. */
const PLAIN_HEADER = /^diff --git a\/([A-Za-z0-9._@+/-]+) b\/([A-Za-z0-9._@+/-]+)$/;
/**
 * The diff sections of a secret file are cut out: a diff of a PR or a commit can hold a file the Architect may not read. It
 * fails closed: a section whose header is not a plain `diff --git a/<path> b/<path>` (a quoted name, no prefix, a merge's
 * `diff --cc`) is left out too, since its path cannot be checked. The git commands pass --src-prefix and --dst-prefix, so a
 * `diff.noprefix` setting of the repository cannot change the header.
 */
export function dropSecretSections(text: string): string {
  const parts = text.split(/^(?=diff --(?:git|cc|combined) )/m);
  return parts
    .map((p) => {
      if (!p.startsWith('diff --')) return p;
      const m = PLAIN_HEADER.exec(p.split('\n', 1)[0]!);
      if (!m) return '[a diff section left out: its file name could not be checked]\n';
      return isSecretPath(m[1]!) || isSecretPath(m[2]!) ? `[diff of ${m[2]} left out: that file is not readable]\n` : p;
    })
    .join('');
}

type Tool<S extends z.ZodObject<any>> = { description: string; schema: S; okCodes?: number[]; filter?: (out: string) => string; command: (a: z.infer<S>, repos: HostRepo[]) => Command };
const tool = <S extends z.ZodObject<any>>(t: Tool<S>) => t;

const repoOf = (repos: HostRepo[], slug: string): HostRepo => {
  const r = repos.find((x) => x.slug === slug);
  if (!r) throw new Error(`Unknown repository ${JSON.stringify(slug.slice(0, 60))}. Yours: ${repos.map((x) => x.slug).join(', ') || 'none'}.`);
  return r;
};
const github = (repos: HostRepo[], slug: string): string => {
  const g = repoOf(repos, slug).github;
  if (!g || !REPO_NAME.test(g)) throw new Error(`Repository ${slug} has no GitHub slug in the initiative settings, so GitHub cannot be read for it.`);
  return g;
};
const gitIn = (repos: HostRepo[], slug: string, w: 'worktree' | 'checkout'): string[] => {
  const r = repoOf(repos, slug);
  const dir = w === 'worktree' ? r.worktree : r.checkout;
  if (!dir) throw new Error(`Repository ${slug} has no ${w} this time.`);
  return ['--no-pager', '-C', dir, '-c', 'core.fsmonitor=false', '-c', 'core.pager=cat'];
};
const GIT_SAFE = ['--no-color', '--no-ext-diff', '--no-textconv'];
/** For commands that print a diff: the header prefixes are fixed, whatever the repository's config says. */
const DIFF_SAFE = [...GIT_SAFE, '--src-prefix=a/', '--dst-prefix=b/'];
/** A ref is read as a commit: a blob or tree SHA would print an object without a path, which the secret check cannot see. */
const commit = (ref: string) => `${ref}^{commit}`;
const pr = z.object({ repo: z.string().max(64), number: z.number().int().min(1).max(999_999_999) }).strict();
const PR_FIELDS = 'number,title,state,isDraft,url,author,headRefName,headRefOid,baseRefName,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,additions,deletions,changedFiles,files,labels,createdAt,updatedAt,mergedAt,mergeCommit,body';

export const ARCHITECT_HOST_TOOLS = {
  pr_view: tool({
    description: 'A pull request of one of your repositories: state, draft, head sha, base, review decision, mergeability, the check rollup, changed files, body. `gh pr view`.',
    schema: pr,
    command: (a, repos) => ({ bin: 'gh', args: ['pr', 'view', String(a.number), '-R', github(repos, a.repo), '--json', PR_FIELDS] }),
  }),
  pr_checks: tool({
    description: 'The CI checks of a pull request: name, workflow, state, bucket (pass, fail, pending, skipping, cancel), link. `gh pr checks`.',
    schema: pr,
    okCodes: [0, 1, 8],
    command: (a, repos) => ({ bin: 'gh', args: ['pr', 'checks', String(a.number), '-R', github(repos, a.repo), '--json', 'name,workflow,state,bucket,link,startedAt,completedAt'] }),
  }),
  pr_diff: tool({
    description: 'The diff of a pull request, patch format. Files you may not read are left out. Long output is cut: use git_diff on a path for the rest. `gh pr diff`.',
    schema: pr,
    filter: dropSecretSections,
    command: (a, repos) => ({ bin: 'gh', args: ['pr', 'diff', String(a.number), '-R', github(repos, a.repo), '--color', 'never', '--patch', ...SECRET_FILES.flatMap((f) => ['--exclude', `**/${f}`, '--exclude', f])] }),
  }),
  pr_comments: tool({
    description: 'The conversation of a pull request: issue comments and reviews (author, state, body), as GitHub shows them. `gh pr view --json comments,reviews`. Inline review comments are in pr_review_comments.',
    schema: pr,
    command: (a, repos) => ({ bin: 'gh', args: ['pr', 'view', String(a.number), '-R', github(repos, a.repo), '--json', 'comments,reviews'] }),
  }),
  pr_review_comments: tool({
    description: 'The inline review comments of a pull request (Copilot and people): id, path, line, author, body, time, the reply they belong to. The first 100. `gh api` GET.',
    schema: pr,
    command: (a, repos) => ({ bin: 'gh', args: ['api', `repos/${github(repos, a.repo)}/pulls/${a.number}/comments?per_page=100`, '--jq', '[.[] | {id, path, line, original_line, commit_id, user: .user.login, in_reply_to_id, created_at, body}]'] }),
  }),
  run_list: tool({
    description: 'Recent GitHub Actions runs of a repository, newest first: run id, workflow, branch, head sha, event, status, conclusion. Narrow with a workflow file or a branch. `gh run list`.',
    schema: z.object({ repo: z.string().max(64), workflow: z.string().regex(WORKFLOW).optional(), branch: z.string().regex(BRANCH).optional(), limit: count(30).default(10) }).strict(),
    command: (a, repos) => ({
      bin: 'gh',
      args: ['run', 'list', '-R', github(repos, a.repo), ...(a.workflow ? ['--workflow', a.workflow] : []), ...(a.branch ? ['--branch', a.branch] : []), '--limit', String(a.limit), '--json', 'databaseId,workflowName,displayTitle,headBranch,headSha,event,status,conclusion,createdAt,url'],
    }),
  }),
  git_log: tool({
    description: 'Commits of a repository, one line each: `git log -n N [ref] [-- path]`.',
    schema: z.object({ repo: z.string().max(64), where, ref: z.string().regex(REF).optional(), path: filePath.optional(), n: count(200).default(30) }).strict(),
    command: (a, repos) => ({ bin: 'git', args: [...gitIn(repos, a.repo, a.where), 'log', ...GIT_SAFE, '-n', String(a.n), '--date=short', '--format=%h %ad %an %s', ...(a.ref ? [commit(a.ref)] : []), '--', ...(a.path ? [a.path] : [])] }),
  }),
  git_show: tool({
    description: 'One commit: message, stat and patch. `git show <ref> [-- path]`. Files you may not read are left out.',
    schema: z.object({ repo: z.string().max(64), where, ref: z.string().regex(REF), path: filePath.optional() }).strict(),
    filter: dropSecretSections,
    command: (a, repos) => ({ bin: 'git', args: [...gitIn(repos, a.repo, a.where), 'show', ...DIFF_SAFE, '--stat', '--patch', commit(a.ref), '--', ...(a.path ? [a.path] : [])] }),
  }),
  git_diff: tool({
    description: 'The change from base to head (three dots: since head left base), optionally one path, or the stat only. `git diff base...head`. Files you may not read are left out.',
    schema: z.object({ repo: z.string().max(64), where, base: z.string().regex(REF), head: z.string().regex(REF), path: filePath.optional(), stat: z.boolean().default(false) }).strict(),
    filter: dropSecretSections,
    command: (a, repos) => ({ bin: 'git', args: [...gitIn(repos, a.repo, a.where), 'diff', ...DIFF_SAFE, ...(a.stat ? ['--stat'] : []), `${commit(a.base)}...${commit(a.head)}`, '--', ...(a.path ? [a.path] : [])] }),
  }),
  git_file: tool({
    description: 'A file as it is at a commit or branch: `git show <ref>:<path>`. For a file at a commit that is not on disk, for example a PR head you fetched in the checkout.',
    schema: z.object({ repo: z.string().max(64), where, ref: z.string().regex(REF).default('HEAD'), path: filePath }).strict(),
    command: (a, repos) => ({ bin: 'git', args: [...gitIn(repos, a.repo, a.where), 'show', ...GIT_SAFE, `${a.ref}:${a.path}`] }),
  }),
  git_blame: tool({
    description: 'Who last changed each line of a range of a file: `git blame -L start,end [ref] -- path`. At most 200 lines.',
    schema: z.object({ repo: z.string().max(64), where, path: filePath, start: z.number().int().min(1).max(10_000_000), end: z.number().int().min(1).max(10_000_000), ref: z.string().regex(REF).optional() }).strict(),
    command: (a, repos) => {
      if (a.end < a.start || a.end - a.start >= 200) throw new Error('end is at least start, and the range is at most 200 lines.');
      return { bin: 'git', args: [...gitIn(repos, a.repo, a.where), 'blame', '--date=short', '-L', `${a.start},${a.end}`, ...(a.ref ? [commit(a.ref)] : []), '--', a.path] };
    },
  }),
};

export type ArchitectHostToolName = keyof typeof ARCHITECT_HOST_TOOLS;

/** Checks the arguments and builds the command. Throws on an unknown tool or property, a value out of range, or a repository that is not the initiative's. */
export function buildArchitectCommand(name: string, args: unknown, repos: HostRepo[]): { command: Command; okCodes: number[]; filter: (out: string) => string } {
  if (!Object.hasOwn(ARCHITECT_HOST_TOOLS, name)) throw new Error(`Unknown host tool ${JSON.stringify(name.slice(0, 40))}.`);
  const t = ARCHITECT_HOST_TOOLS[name as ArchitectHostToolName] as Tool<z.ZodObject<any>>;
  const parsed = t.schema.safeParse(args ?? {});
  if (!parsed.success) throw new Error(`Bad arguments for ${name}: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`).join('; ')}`);
  return { command: t.command(parsed.data, repos), okCodes: t.okCodes ?? [0], filter: t.filter ?? ((o) => o) };
}

/** The repositories the host server was started with (the runner writes them into its MCP config), checked: a bad entry is dropped. */
export function parseHostRepos(raw: string | undefined): HostRepo[] {
  try {
    const list = JSON.parse(raw ?? '[]') as unknown;
    if (!Array.isArray(list)) return [];
    const dir = (v: unknown) => (typeof v === 'string' && v.startsWith('/') && !v.split('/').includes('..') ? v : null);
    return list.flatMap((r: any) => (typeof r?.slug === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(r.slug) ? [{ slug: r.slug, github: typeof r.github === 'string' && REPO_NAME.test(r.github) ? r.github : null, worktree: dir(r.worktree), checkout: dir(r.checkout) }] : []));
  } catch {
    return [];
  }
}
