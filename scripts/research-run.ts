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
 *
 * A server that a plugin provides (such as `cua_repl` from the computer-use plugin) is not in config.toml, so a bare `enabled=false`
 * creates a table with no command or url, and Codex refuses to load the config ("invalid transport", seen on 0.162.0). Every
 * override therefore also carries a stub transport of the server's own type, which is never started because the server is off.
 */
export function codexMcpDisableArgs(list: unknown, orchestratorUrl: string): string[] {
  if (!Array.isArray(list)) throw new Error('codex mcp list --json did not return a list');
  const args: string[] = [];
  let orchestrator = false;
  for (const server of list) {
    const name = (server as { name?: unknown } | null)?.name;
    if (typeof name !== 'string' || !name || name.length > 100) throw new Error('codex mcp list --json returned a server without a usable name');
    if (name === 'orchestrator') {
      // The name alone proves nothing: a user's or a repository's config can define any server under it. It is kept only if it is Triglav's own endpoint.
      if (!isOrchestratorEndpoint(server, orchestratorUrl)) throw new Error('The "orchestrator" MCP server of Codex is not Triglav\'s endpoint (an enabled streamable HTTP server at ' + orchestratorUrl + '). A research run would not be read-only, so it did not start. Check ~/.codex/config.toml and the repository\'s .codex/config.toml.');
      orchestrator = true;
      continue;
    }
    if ((server as { enabled?: unknown }).enabled === false) continue;
    // A TOML bare key allows letters, digits, "_" and "-". Anything else is quoted, and the quotes keep it one key.
    const key = `mcp_servers.${/^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name)}`;
    args.push('-c', `${key}.enabled=false`);
    const type = (server as { transport?: { type?: unknown } }).transport?.type;
    if (type === 'stdio') args.push('-c', `${key}.command="/bin/false"`);
    else if (type === 'streamable_http') args.push('-c', `${key}.url="http://127.0.0.1:9/"`);
  }
  if (!orchestrator) throw new Error('Codex has no "orchestrator" MCP server, so a research run could not reach Triglav. See the README.');
  return args;
}

/**
 * Whether a server of `codex mcp list --json` is Triglav's MCP endpoint: enabled, streamable HTTP, a loopback host
 * (`localhost`, `127.0.0.1` or `[::1]`, as the README tells the user to configure it), the same port as `orchestratorUrl`
 * and the path /mcp.
 */
export function isOrchestratorEndpoint(server: unknown, orchestratorUrl: string): boolean {
  const s = server as { enabled?: unknown; transport?: { type?: unknown; url?: unknown } } | null;
  if (s?.enabled === false || s?.transport?.type !== 'streamable_http' || typeof s.transport.url !== 'string') return false;
  try {
    const url = new URL(s.transport.url);
    const want = new URL(orchestratorUrl);
    const loopback = (h: string) => h === 'localhost' || h === '127.0.0.1' || h === '[::1]';
    return url.protocol === 'http:' && loopback(url.hostname) && url.port === want.port && url.pathname.replace(/\/$/, '') === '/mcp' && !url.username && !url.password && !url.search;
  } catch {
    return false;
  }
}
