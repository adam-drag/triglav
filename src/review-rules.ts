/**
 * The summary of the repository rules a code review seat was given, as the runner reports it and the server stores it.
 *
 * The runner reads the rule files with git at the base of the change (`scripts/review-rules.ts`), puts them in the seat's
 * prompt as data, and posts this summary next to the reviewer's output. The server checks it again (`parseRulesSummary`):
 * all or nothing, so one bad entry or a cap drops the whole summary, and a dropped summary never fails a run that has valid
 * findings. No dependency on the database or a library, so the runner can import it.
 *
 * Paths come from the reviewed repository and are untrusted: the job page shows them as plain text only.
 */

/**
 * Where the rules commit came from: merge base with origin/<base branch>, with the local <base branch>, or the round's base
 * sha. `given` is a commit the caller chose (the evaluation harness); the runner never reports it.
 */
export const RULES_SOURCES = ['origin', 'local', 'base_sha', 'given'] as const;
export type RulesSource = (typeof RULES_SOURCES)[number];
/** Root rule file, nearest rule file of a changed path, path-scoped instruction file, skill catalog entry. */
export const RULE_KINDS = ['root', 'nearest', 'path_scoped', 'catalog'] as const;
export type RuleKind = (typeof RULE_KINDS)[number];

export interface RuleFileSummary {
  path: string;
  kind: RuleKind;
  /** Characters of the file (or catalog line) that went into the prompt. */
  chars: number;
  /** The file was cut at the budget; the prompt shows a marker where. */
  cut: boolean;
  /** Same content as an earlier file in the list, so it was not sent twice. */
  same_as: string | null;
}

export interface RulesSummary {
  commit: string;
  source: RulesSource;
  files: RuleFileSummary[];
  /** Rule files found but left out: the budget was used up, or the file is over 1 MB. */
  omitted: string[];
  /** More omitted files than the list holds. */
  omitted_more: number;
  /** Rule files that the change (rules commit..head) adds, edits or deletes. */
  changed: string[];
  /** More changed rule files than the list holds. */
  changed_more: number;
}

/** The budget of the rule text in one seat's prompt, apart from the server prompt cap (MAX_SERVER_PROMPT_CHARS). */
export const RULES_BUDGET = 40_000;
export const MAX_RULE_LIST = 300;
export const MAX_RULE_PATH = 300;
export const MAX_RULES_BYTES = 120_000;

const SHA = /^[0-9a-f]{40}$/;
/** A path the summary may hold. The runner leaves out a rule file whose path fails it, so its summary always passes. */
export const goodPath = (p: unknown): p is string => typeof p === 'string' && p.length > 0 && p.length <= MAX_RULE_PATH && !p.startsWith('/') && !/[\0-\x1f\x7f\u2028\u2029]/.test(p) && !/(^|\/)\.\.(\/|$)/.test(p);
const count = (n: unknown, max: number): n is number => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= max;
const pathList = (v: unknown): v is string[] => Array.isArray(v) && v.length <= MAX_RULE_LIST && v.every(goodPath);
const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const only = (o: Record<string, unknown>, keys: string[]) => Object.keys(o).every((k) => keys.includes(k));

/** The summary as the server stores it, or null when anything in it is wrong or over a cap. */
export function parseRulesSummary(value: unknown): RulesSummary | null {
  if (!plain(value) || !only(value, ['commit', 'source', 'files', 'omitted', 'omitted_more', 'changed', 'changed_more'])) return null;
  const { commit, source, files, omitted, omitted_more, changed, changed_more } = value;
  if (typeof commit !== 'string' || !SHA.test(commit)) return null;
  if (!RULES_SOURCES.includes(source as RulesSource)) return null;
  if (!Array.isArray(files) || files.length > MAX_RULE_LIST) return null;
  const out: RuleFileSummary[] = [];
  for (const f of files) {
    if (!plain(f) || !only(f, ['path', 'kind', 'chars', 'cut', 'same_as'])) return null;
    if (!goodPath(f.path) || !RULE_KINDS.includes(f.kind as RuleKind) || !count(f.chars, RULES_BUDGET) || typeof f.cut !== 'boolean') return null;
    if (f.same_as !== null && !goodPath(f.same_as)) return null;
    out.push({ path: f.path, kind: f.kind as RuleKind, chars: f.chars, cut: f.cut, same_as: f.same_as as string | null });
  }
  if (out.reduce((a, f) => a + f.chars, 0) > RULES_BUDGET) return null;
  if (!pathList(omitted) || !pathList(changed) || !count(omitted_more, 1e6) || !count(changed_more, 1e6)) return null;
  const summary: RulesSummary = { commit, source: source as RulesSource, files: out, omitted: [...omitted], omitted_more, changed: [...changed], changed_more };
  if (Buffer.byteLength(JSON.stringify(summary)) > MAX_RULES_BYTES) return null;
  return summary;
}

/** True for a path the rules reader treats as a rule file (any of the kinds above), so an edit to it gets the "rule file changed" note. */
export function isRulePath(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1);
  if (name === 'AGENTS.md' || name === 'CLAUDE.md' || name === 'AGENT.md') return true;
  if (path === '.github/copilot-instructions.md') return true;
  if (path.startsWith('.github/instructions/') && path.endsWith('.instructions.md')) return true;
  return /^\.(?:claude|agents)\/skills\/[^/]+\/SKILL\.md$/.test(path);
}
