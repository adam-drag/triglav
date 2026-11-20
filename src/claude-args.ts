// The Claude Code access of a Staff launch. Pure (no Node imports), like codex-args.ts, so the server and the host runner
// agree on it from this one file.

/**
 * full: today's Staff (the user's tools and MCP servers, auto mode from the user's settings).
 * document: the Staff of a research job. It reads, talks to the orchestrator, writes only in its job's reports folder and
 * publishes artifacts. No Bash, no Edit outside that folder, no other MCP server, no browser.
 */
export const STAFF_ACCESS = ['full', 'document'] as const;
export type StaffAccess = (typeof STAFF_ACCESS)[number];

/** The built-in tools of a document Staff. Write is there for the reports folder only (the Edit rule below decides where). */
export const DOCUMENT_TOOLS = ['Read', 'Grep', 'Glob', 'ToolSearch', 'Artifact', 'Write'];
/** Added when the Client allowed web sources for the job. */
export const WEB_TOOLS = ['WebSearch', 'WebFetch'];

/** An absolute path a permission rule or a hook command may hold: plain characters only, no "..". */
const SAFE_PATH = /^\/[A-Za-z0-9._@+ \/-]*$/;
function checkedDir(path: string | undefined, what: string): string {
  if (!path || !SAFE_PATH.test(path) || path.split('/').includes('..')) throw new Error(`a document Staff needs the absolute path of its ${what}`);
  return path.replace(/\/+$/, '');
}

/**
 * The arguments that restrict a Claude Staff, verified on Claude Code 2.1.304 (2026-11-02):
 * - `--setting-sources ""` loads no settings file. The user's allow rules (`Read(//home/**)` and the like) would otherwise
 *   merge with ours, and the repository's own `.claude/settings.json` could add allow rules and hooks that run commands:
 *   with the user and project sources a session read a file outside the repository, wrote outside its reports folder by a
 *   project rule and ran a project SessionStart hook; without them all three were refused. The login still works.
 * - `--tools` decides which built-ins exist. ToolSearch must be there: the orchestrator's tools are deferred, and without
 *   Bash the first turn cannot wait for the MCP connection any other way.
 * - `--permission-mode dontAsk` refuses what `--allowedTools` does not allow. Read rules also decide Grep and Glob, so
 *   reads and searches stay in the repository and the reports folder. File writes are matched by Edit rules: a
 *   `Write(...)` rule did not allow a write, `Edit(//abs/**)` did.
 * - `--strict-mcp-config` drops every other MCP server, the claude.ai connectors included; `--no-chrome` drops the
 *   browser tools, which it does not. The Artifact tool refuses a delete without the user's confirmation.
 * - `--tools`, `--allowedTools` and `--mcp-config` take several values, so the caller puts `--` before the prompt.
 * A background session keeps these options: a resume without flags wakes it with them, and one with flags starts a copy.
 * `full` adds nothing. The settings of a document Staff come from documentStaffSettings.
 */
export function claudeStaffArgs(access: string | null | undefined, o: { web?: boolean; mcpConfig?: string; reportsDir?: string; repoDir?: string } = {}): string[] {
  if (access === 'full' || access == null) return [];
  if (access !== 'document') throw new Error(`no Claude Staff access ${JSON.stringify(String(access)).slice(0, 40)}`);
  const mcpConfig = checkedDir(o.mcpConfig, 'MCP config');
  const reports = checkedDir(o.reportsDir, 'reports folder');
  const repo = checkedDir(o.repoDir, 'repository');
  const tools = [...DOCUMENT_TOOLS, ...(o.web ? WEB_TOOLS : [])];
  const allowed = ['mcp__orchestrator', 'ToolSearch', 'Artifact', ...(o.web ? WEB_TOOLS : []), `Read(/${repo}/**)`, `Read(/${reports}/**)`, `Edit(/${reports}/**)`];
  return ['--setting-sources', '', '--permission-mode', 'dontAsk', '--no-chrome', '--tools', tools.join(','), '--allowedTools', ...allowed, '--strict-mcp-config', '--mcp-config', mcpConfig];
}

/**
 * The `--settings` of a document Staff: the Staff settings plus Triglav's Stop hook, which keeps it from ending its turn with
 * open work. With no settings file loaded, the user's own Stop hook is gone; a hook given here still runs (verified
 * 2026-11-02). `stopHook` is the runner's own scripts/stop-hook.sh, quoted for the shell that runs it.
 */
export function documentStaffSettings(base: string, stopHook: string): string {
  const hook = checkedDir(stopHook, 'Stop hook');
  return JSON.stringify({ ...JSON.parse(base), hooks: { Stop: [{ matcher: '*', hooks: [{ type: 'command', command: `'${hook}'`, timeout: 10 }] }] } });
}

/** The first prompt of a document Staff. Without Bash it waits for the orchestrator's tools through ToolSearch, which found them on the first call in all 9 starts probed on 2026-11-02. */
export const documentStaffStartPrompt = (requestId: string, reportsDir: string) =>
  `Load the orchestrator's tools first: call ToolSearch with query select:mcp__orchestrator__get_guide. If it does not return the tool, call it again, up to 5 times. Then call mcp__orchestrator__get_guide with role staff_document and follow it. Never end your first turn without calling it. Start job request ${requestId}. ${reportsFolderNote(reportsDir)}`;

/** Only the runner knows the folder's path on the host, so it adds this to the start and resume prompts. */
export const reportsFolderNote = (reportsDir: string) => `Your reports folder is ${reportsDir}.`;

/** The resume prompt of a document Staff: its own guide role, and the tool loaded the same way. */
export const DOCUMENT_RESUME_PROMPT =
  'Triglav or this session was restarted (reboot or usage limit). Load the orchestrator\'s tools with ToolSearch (query select:mcp__orchestrator__get_guide, again if it returns nothing), call get_guide with role staff_document again (the guide may have changed), keep your session token, and continue your research job. Ask the Client only through blockers or ask_question.';
