/**
 * The command of a Claude research run, built from checked fields. Kept apart from runner.ts, which has a top-level
 * loop, so the tests can import it.
 *
 * A research run reads code and talks to the orchestrator, nothing else. `--tools` decides which built-in tools exist at
 * all: with only Read, Grep and Glob there is no Bash, Edit or Write, even when the user's or the repository's settings
 * allow them (`--allowedTools` and the permission mode only decide what is permitted, not what exists). `--strict-mcp-config`
 * keeps every MCP server but the orchestrator out, so a repository's `.mcp.json` cannot add tools that change things.
 */
import { EFFORT, MODEL } from './staff-start.ts';

/** The built-in tools a research run has. */
export const RESEARCH_BUILTIN_TOOLS = ['Read', 'Grep', 'Glob'];

/** What a research run may use without asking. In print mode every other tool is refused. */
export const RESEARCH_TOOLS = ['mcp__orchestrator', ...RESEARCH_BUILTIN_TOOLS];

/** The `--mcp-config` content: the orchestrator and nothing else. It holds the enrollment key, so it goes in a private file. */
export function researchMcpConfig(o: { mcpUrl: string; key: string }): string {
  return JSON.stringify({ mcpServers: { orchestrator: { type: 'http', url: o.mcpUrl, headers: { Authorization: `Bearer ${o.key}` } } } });
}

/** Arguments for `claude -p`. The prompt goes on stdin: `--allowedTools` and `--mcp-config` take several values and would swallow a trailing prompt argument. */
export function claudeResearchArgs(l: { model?: string | null; effort?: string | null }, mcpConfigPath: string): string[] {
  if (!l.model || !MODEL.test(l.model)) throw new Error(`bad model ${JSON.stringify(String(l.model)).slice(0, 60)}`);
  if (!l.effort || !EFFORT.test(l.effort)) throw new Error(`bad effort ${JSON.stringify(String(l.effort)).slice(0, 60)}`);
  return [
    '-p',
    '--model',
    l.model,
    '--effort',
    l.effort,
    '--permission-mode',
    'dontAsk',
    '--tools',
    RESEARCH_BUILTIN_TOOLS.join(','),
    '--allowedTools',
    RESEARCH_TOOLS.join(','),
    '--strict-mcp-config',
    '--mcp-config',
    mcpConfigPath,
  ];
}

/**
 * `-c` overrides that switch off every MCP server of Codex except the orchestrator, from the output of `codex mcp list --json`.
 *
 * `-s read-only` limits only the shell commands Codex runs. An MCP tool runs in its own process, outside that sandbox,
 * and Codex runs one without asking when it is not marked destructive (checked on codex-cli 0.162.0: with `-s read-only` and
 * `approval_policy="never"`, a tool with `destructiveHint: false` wrote a file, with and without `default_tools_approval_mode = "auto"`;
 * an unannotated tool was refused). So a Linear or Slack server in the user's config could change things from a research run.
 * Codex has no strict mode like Claude's `--strict-mcp-config`, but `mcp_servers.<name>.enabled=false` turns a server off.
 * A server that this list does not show (one added after it) stays as configured: see the README.
 */
export function codexMcpDisableArgs(list: unknown): string[] {
  if (!Array.isArray(list)) throw new Error('codex mcp list --json did not return a list');
  const args: string[] = [];
  for (const server of list) {
    const name = (server as { name?: unknown } | null)?.name;
    if (typeof name !== 'string' || !name || name.length > 100) throw new Error('codex mcp list --json returned a server without a usable name');
    if (name === 'orchestrator' || (server as { enabled?: unknown }).enabled === false) continue;
    // A TOML bare key allows letters, digits, "_" and "-". Anything else is quoted, and the quotes keep it one key.
    args.push('-c', `mcp_servers.${/^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name)}.enabled=false`);
  }
  return args;
}
