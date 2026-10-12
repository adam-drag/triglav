import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { HOST_MCP_SCRIPT, operatorArgs, OPERATOR_TOOLS, translate } from '../scripts/operator.ts';

const TOKEN = 'orch_chat_' + 'a'.repeat(32);
const base = { model: 'claude-sonnet-5-5', effort: 'medium', sessionId: null, mcpUrl: 'http://127.0.0.1:7400/operator/mcp', token: TOKEN, logs: '/home/me/.local/state/triglav' };

describe('the Operator command the runner builds', () => {
  it('can read but never write: denies what it was not allowed, and sees only its own MCP server', () => {
    const args = operatorArgs(base);
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('dontAsk');
    expect(args).toContain('--strict-mcp-config');
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(args).not.toContain('--allow-dangerously-skip-permissions');
    const allowed = args[args.indexOf('--allowedTools') + 1]!.split(',');
    expect(allowed).toEqual(OPERATOR_TOOLS);
    for (const tool of allowed) expect(tool).not.toMatch(/^(Write|Edit|NotebookEdit)\b/);
    // No Bash at all: a prefix rule such as `git log:*` still lets `--output=FILE` write. The built-in tools are limited as well.
    for (const tool of allowed) expect(tool).not.toMatch(/^Bash/);
    expect(args[args.indexOf('--tools') + 1]).toBe('Read,Grep,Glob');
    const mcp = JSON.parse(args[args.indexOf('--mcp-config') + 1]!);
    expect(mcp.mcpServers.triglav).toEqual({ type: 'http', url: base.mcpUrl, headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(mcp.mcpServers.host).toEqual({ type: 'stdio', command: process.execPath, args: [HOST_MCP_SCRIPT] });
    expect(existsSync(HOST_MCP_SCRIPT)).toBe(true);
    expect(Object.keys(mcp.mcpServers)).toEqual(['triglav', 'host']);
  });

  it('resumes the conversation of a chat that had a process before', () => {
    const session = '1b85d8aa-ea20-41ef-baa6-1de0d08eb630';
    const args = operatorArgs({ ...base, sessionId: session });
    expect(args.slice(-2)).toEqual(['--resume', session]);
    expect(operatorArgs(base)).not.toContain('--resume');
  });

  it('refuses a value that could be read as an option or that does not look right', () => {
    expect(() => operatorArgs({ ...base, model: '--dangerously-skip-permissions' })).toThrow(/bad model/);
    expect(() => operatorArgs({ ...base, effort: 'enormous' })).toThrow(/bad effort/);
    expect(() => operatorArgs({ ...base, token: 'Bearer x' })).toThrow(/bad chat token/);
    expect(() => operatorArgs({ ...base, sessionId: '--resume' })).toThrow(/bad session/);
  });
});

describe('what the Claude stream means for the dashboard', () => {
  it('reports the session, streamed text and the final reply', () => {
    expect(translate({ type: 'system', subtype: 'init', session_id: 's1' })).toEqual([{ type: 'session', session_id: 's1' }]);
    expect(translate({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } } })).toEqual([{ type: 'delta', text: 'Hel' }]);
    expect(translate({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hmm' } } })).toEqual([]);
    expect(translate({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }] } })).toEqual([{ type: 'message', role: 'operator', text: 'Hello' }]);
    expect(translate({ type: 'assistant', message: { content: [{ type: 'text', text: '  ' }] } })).toEqual([]);
  });

  it('shows what the Operator looked at, without the tool name noise', () => {
    const events = translate({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'mcp__triglav__list_agents', input: {} },
          { type: 'tool_use', name: 'Read', input: { file_path: '/home/me/.local/state/triglav/runner.log' } },
          { type: 'tool_use', name: 'mcp__host__compose_logs', input: { service: 'orchestrator', tail: 50 } },
        ],
      },
    });
    expect(events.map((e: any) => e.text)).toEqual(['list_agents', 'Read /home/me/.local/state/triglav/runner.log', 'compose_logs {"service":"orchestrator","tail":50}']);
  });

  it('marks the end of a reply, with its error if it failed', () => {
    expect(translate({ type: 'result', subtype: 'success', is_error: false })).toEqual([{ type: 'turn_end', error: null }]);
    expect(translate({ type: 'result', subtype: 'error', is_error: true, result: 'usage limit reached' })).toEqual([{ type: 'turn_end', error: 'usage limit reached' }]);
  });

  it('turns the plan usage in the stream into percentages and ignores what it cannot read', () => {
    const e = translate({ type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.22, resetsAt: 1791716400 }, seven_day: { utilization: 0.33, resetsAt: 1792126800 }, junk: {} } } });
    expect(e).toHaveLength(1);
    const usage: any = e[0];
    expect(usage.windows.map((w: any) => [w.window, Math.round(w.used), w.resets_at])).toEqual([
      ['five_hour', 22, 1791716400],
      ['seven_day', 33, 1792126800],
    ]);
    expect(translate({ type: 'rate_limit_event', rate_limit_info: {} })).toEqual([]);
    expect(translate({ type: 'unknown' })).toEqual([]);
    expect(translate(null)).toEqual([]);
  });
});
