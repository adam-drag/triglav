import { describe, expect, it } from 'vitest';
import { claudeResearchArgs, codexMcpDisableArgs, isOrchestratorEndpoint, RESEARCH_BUILTIN_TOOLS, RESEARCH_TOOLS, researchMcpConfig } from '../scripts/research-run.ts';

const KEY = 'enrollment-key-for-this-test-0000';
const run = { model: 'claude-opus-5-5', effort: 'high' };

describe('the command of a Claude research run', () => {
  const args = claudeResearchArgs(run, '/tmp/triglav-abc/research-mcp.json');
  const after = (flag: string) => args[args.indexOf(flag) + 1];

  it('has only Read, Grep and Glob as built-in tools, so no setting of the user or the repository can give it Bash, Edit or Write', () => {
    expect(after('--tools')).toBe('Read,Grep,Glob');
    expect(RESEARCH_BUILTIN_TOOLS).toEqual(['Read', 'Grep', 'Glob']);
    expect(after('--permission-mode')).toBe('dontAsk');
    expect(after('--allowedTools')).toBe(RESEARCH_TOOLS.join(','));
    for (const tool of RESEARCH_TOOLS) expect(tool).not.toMatch(/^(Bash|Edit|Write|NotebookEdit)/);
    expect(args).not.toContain('--dangerously-skip-permissions');
  });

  it('loads only the MCP config it is given, so the repository .mcp.json and the user servers stay out', () => {
    expect(args).toContain('--strict-mcp-config');
    expect(after('--mcp-config')).toBe('/tmp/triglav-abc/research-mcp.json');
    expect(args.filter((a) => a === '--mcp-config')).toHaveLength(1);
  });

  it('refuses a model or effort that could be read as an option', () => {
    expect(() => claudeResearchArgs({ model: '--dangerously-skip-permissions', effort: 'high' }, '/x')).toThrow(/bad model/);
    expect(() => claudeResearchArgs({ model: 'claude-opus-5-5', effort: '--x' }, '/x')).toThrow(/bad effort/);
    expect(() => claudeResearchArgs({ model: null, effort: 'high' }, '/x')).toThrow(/bad model/);
  });

  it('keeps the enrollment key out of the arguments: it is in the config file only, which names the orchestrator and nothing else', () => {
    expect(JSON.stringify(args)).not.toContain(KEY);
    const config = JSON.parse(researchMcpConfig({ mcpUrl: 'http://127.0.0.1:7400/mcp', key: KEY }));
    expect(Object.keys(config.mcpServers)).toEqual(['orchestrator']);
    expect(config.mcpServers.orchestrator).toEqual({ type: 'http', url: 'http://127.0.0.1:7400/mcp', headers: { Authorization: `Bearer ${KEY}` } });
  });
});

describe('Codex research runs and MCP servers', () => {
  const URL = 'http://127.0.0.1:7400/mcp';
  const orchestrator = (url = 'http://localhost:7400/mcp', extra: object = {}) => ({ name: 'orchestrator', enabled: true, transport: { type: 'streamable_http', url }, ...extra });

  it('switches off every enabled server but the orchestrator', () => {
    const list = [orchestrator(), { name: 'linear-server', enabled: true }, { name: 'posthog', enabled: true }, { name: 'code-review', enabled: false }];
    expect(codexMcpDisableArgs(list, URL)).toEqual(['-c', 'mcp_servers.linear-server.enabled=false', '-c', 'mcp_servers.posthog.enabled=false']);
    expect(codexMcpDisableArgs([orchestrator()], URL)).toEqual([]);
  });

  it('quotes a server name that is not a plain TOML key, so it stays one key', () => {
    expect(codexMcpDisableArgs([orchestrator(), { name: 'a.b c', enabled: true }], URL)).toEqual(['-c', 'mcp_servers."a.b c".enabled=false']);
  });

  it('refuses output it cannot read, so the run does not start with servers it could not turn off', () => {
    expect(() => codexMcpDisableArgs({}, URL)).toThrow(/did not return a list/);
    expect(() => codexMcpDisableArgs([{ enabled: true }], URL)).toThrow(/usable name/);
    expect(() => codexMcpDisableArgs([null], URL)).toThrow(/usable name/);
  });

  it('keeps the name "orchestrator" only for Triglav\'s own endpoint, and fails closed otherwise', () => {
    // Any user or repository config can define a server under that name: a writable stdio server, or a remote URL.
    const stdio = { name: 'orchestrator', enabled: true, transport: { type: 'stdio', command: '/bin/sh', args: ['-c', 'echo'] } };
    for (const bad of [stdio, orchestrator('https://evil.example/mcp'), orchestrator('http://localhost:9999/mcp'), orchestrator('http://localhost:7400/other'), orchestrator('http://localhost.evil.example:7400/mcp'), orchestrator('http://u:p@localhost:7400/mcp'), orchestrator('http://localhost:7400/mcp', { enabled: false })]) {
      expect(() => codexMcpDisableArgs([bad], URL), JSON.stringify(bad)).toThrow(/orchestrator/);
    }
    expect(() => codexMcpDisableArgs([{ name: 'linear-server', enabled: true }], URL)).toThrow(/no "orchestrator" MCP server/);
    for (const good of ['http://localhost:7400/mcp', 'http://127.0.0.1:7400/mcp', 'http://[::1]:7400/mcp', 'http://localhost:7400/mcp/']) expect(isOrchestratorEndpoint(orchestrator(good), URL), good).toBe(true);
  });
});
