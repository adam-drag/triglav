// The Claude Code arguments of an Architect process (docs/plans/initiative-room.md). Pure (no Node imports), like
// claude-args.ts, so the runner builds them and the tests pin them from this one file.

/** The built-in tools an Architect has at all. No Bash, no Write or Edit, no web, no ToolSearch. */
export const ARCHITECT_TOOLS = ['Read', 'Grep', 'Glob'];
/** Its one MCP server: the initiative tools at /architect/mcp, scoped by the chat's token. */
export const ARCHITECT_MCP_SERVER = 'initiative';

const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const EFFORT = /^[a-z]{1,20}$/;
const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** An absolute path a permission rule may hold: plain characters only, no "..". */
const SAFE_PATH = /^\/[A-Za-z0-9._@+/-]*$/;
function checked(path: string, what: string): string {
  if (!SAFE_PATH.test(path) || path.split('/').includes('..')) throw new Error(`bad ${what} path`);
  return path.replace(/\/+$/, '');
}

/**
 * The arguments that restrict an Architect, probed on Claude Code 2.1.304 under `-p` stream-json (2026-11-17, see the
 * triglav-initiatives skill):
 * - `--setting-sources ""` loads no settings file: the user's `Read(//home/...)` rules, a repository's allow rules and its
 *   hooks never apply. Not operatorArgs, which loads them and allows bare Read, Grep and Glob.
 * - `--tools Read,Grep,Glob` decides which built-ins exist; the MCP tools are then not deferred, so no ToolSearch.
 * - `--permission-mode dontAsk` refuses what `--allowedTools` does not allow. The only Read rules are the initiative's
 *   worktrees; a Read rule also decides Grep and Glob. A symlink inside a worktree that points outside is refused.
 * - `--strict-mcp-config` drops every other MCP server and the claude.ai connectors; `--no-chrome` the browser tools. With
 *   both, the probe's tool list had none of them (the skill says what was not tested).
 * - No `--add-dir`: it would widen what the process may read.
 * Every worktree must be inside `root` (the runner's ~/.local/state/triglav/initiatives/<key>).
 */
export function architectArgs(o: { model: string; effort: string; sessionId: string | null; mcpConfigPath: string; root: string; worktrees: string[]; systemPrompt: string }): string[] {
  if (!MODEL.test(o.model)) throw new Error(`bad model ${o.model}`);
  if (!EFFORT.test(o.effort)) throw new Error(`bad effort ${o.effort}`);
  if (o.sessionId && !SESSION.test(o.sessionId)) throw new Error(`bad session ${o.sessionId}`);
  const root = checked(o.root, 'initiative');
  const trees = o.worktrees.map((w) => {
    const p = checked(w, 'worktree');
    if (!p.startsWith(`${root}/`) || p.slice(root.length + 1).includes('/')) throw new Error('a worktree must be a direct child of the initiative folder');
    return p;
  });
  return [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--model',
    o.model,
    '--effort',
    o.effort,
    '--setting-sources',
    '',
    '--permission-mode',
    'dontAsk',
    '--no-chrome',
    '--tools',
    ARCHITECT_TOOLS.join(','),
    '--allowedTools',
    `mcp__${ARCHITECT_MCP_SERVER}`,
    ...trees.map((t) => `Read(/${t}/**)`),
    '--strict-mcp-config',
    '--mcp-config',
    checked(o.mcpConfigPath, 'MCP config'),
    '--append-system-prompt',
    o.systemPrompt,
    ...(o.sessionId ? ['--resume', o.sessionId] : []),
  ];
}

/** The per-process part of the system prompt: which initiative, and where its code is. The card (src/guide/architect.md) comes first. */
export function architectPrompt(card: string, a: { key: string; title: string }, trees: { slug: string; base: string; path: string; sha: string | null; note: string | null }[]): string {
  const code = trees.length
    ? trees.map((t) => `- ${t.slug}: ${t.path} (origin/${t.base}${t.sha ? ` at ${t.sha.slice(0, 12)}` : ''})${t.note ? `. ${t.note}` : ''}`).join('\n')
    : '- none could be prepared; you cannot read code this time.';
  return `${card.trim()}\n\nYour initiative: ${a.key} (${a.title}).\nRead-only code:\n${code}`;
}
