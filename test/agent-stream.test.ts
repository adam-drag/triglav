import { describe, expect, it } from 'vitest';
import { describeTool, entriesOf, MAX_ENTRY_CHARS, nowOf, type StreamEntry } from '../src/agent-stream.ts';

const at = '2026-10-17T01:00:00.000Z';

describe('entriesOf', () => {
  it('reads thinking, text and tool calls of a Claude assistant line, and counts thinking without text', () => {
    const r = entriesOf({
      type: 'assistant',
      timestamp: at,
      message: {
        content: [
          { type: 'thinking', thinking: '', signature: 'abc' },
          { type: 'thinking', thinking: 'I should read the file first.' },
          { type: 'text', text: 'Reading it.' },
          { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a/b.ts' } },
        ],
      },
    });
    expect(r.hidden).toBe(1);
    expect(r.entries.map((e) => [e.kind, e.tool ?? '', e.text])).toEqual([
      ['thinking', '', 'I should read the file first.'],
      ['text', '', 'Reading it.'],
      ['tool', 'Read', '{"file_path":"/a/b.ts"}'],
    ]);
  });

  it('reads tool results and prompts of a Claude user line', () => {
    expect(
      entriesOf({ type: 'user', timestamp: at, message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'done' }] }] } }).entries,
    ).toEqual([{ at, kind: 'result', text: 'done' }]);
    expect(entriesOf({ type: 'user', timestamp: at, message: { content: 'Go.' } }).entries).toEqual([{ at, kind: 'user', text: 'Go.' }]);
  });

  it('reads an API error line as an error', () => {
    expect(entriesOf({ type: 'assistant', timestamp: at, isApiErrorMessage: true, message: { content: [{ type: 'text', text: 'API Error: Connection lost' }] } }).entries).toEqual([
      { at, kind: 'error', text: 'API Error: Connection lost' },
    ]);
  });

  it('reads Codex response items and ignores the event_msg copies', () => {
    const msg = { type: 'response_item', timestamp: at, payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hello' }] } };
    expect(entriesOf(msg).entries).toEqual([{ at, kind: 'text', text: 'Hello' }]);
    expect(entriesOf({ type: 'event_msg', timestamp: at, payload: { type: 'agent_message', message: 'Hello' } }).entries).toEqual([]);
    expect(entriesOf({ type: 'response_item', timestamp: at, payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Plan' }] } }).entries).toEqual([
      { at, kind: 'thinking', text: 'Plan' },
    ]);
    expect(entriesOf({ type: 'response_item', timestamp: at, payload: { type: 'function_call', name: 'shell', call_id: 'c1', arguments: '{"cmd":"ls"}' } }).entries).toEqual([
      { at, kind: 'tool', tool: 'shell', text: '{"cmd":"ls"}' },
    ]);
  });

  it('redacts credentials and cuts long text', () => {
    const token = `orch_tok_${'a'.repeat(30)}`;
    const r = entriesOf({ type: 'assistant', timestamp: at, message: { content: [{ type: 'text', text: `token ${token} ${'x'.repeat(MAX_ENTRY_CHARS)}` }] } });
    expect(r.entries[0]!.text).not.toContain(token);
    expect(r.entries[0]!.text).toContain('[redacted]');
    expect(r.entries[0]!.cut).toBe(true);
    expect(r.entries[0]!.text.length).toBeLessThanOrEqual(MAX_ENTRY_CHARS + 20);
  });

  it('skips bookkeeping lines and lines without a time', () => {
    expect(entriesOf({ type: 'queue-operation', timestamp: at }).entries).toEqual([]);
    expect(entriesOf({ type: 'assistant', message: { content: [{ type: 'text', text: 'x' }] } }).entries).toEqual([]);
  });
});

describe('describeTool', () => {
  it('puts common tool calls in a few words', () => {
    expect(describeTool('Edit', '{"file_path":"/w/src/jobs.ts"}')).toBe('Editing jobs.ts');
    expect(describeTool('Bash', '{"command":"pnpm test","description":"Run unit tests"}')).toBe('Run unit tests');
    expect(describeTool('Bash', '{"command":"cd /w && pnpm lint"}')).toBe('Running pnpm lint');
    expect(describeTool('mcp__orchestrator__wait_for_events', '{}')).toBe('Waiting for events');
    expect(describeTool('Agent', '{"description":"Review the diff"}')).toBe('Delegated: Review the diff');
    expect(describeTool('TodoWrite', '{"todos":[{"status":"completed","content":"a"},{"status":"in_progress","content":"Fix it","activeForm":"Fixing the lease test"}]}')).toBe('Fixing the lease test');
  });

  it('reads a sleep loop as waiting, even with a description', () => {
    expect(describeTool('Bash', '{"command":"timeout 115 tail -f /dev/null; true","description":"Wait"}')).toBe('Waiting');
    expect(describeTool('Bash', '{"command":"sleep 30"}')).toBe('Waiting');
  });

  it('reads a sleep followed by real work as that work', () => {
    expect(describeTool('Bash', '{"command":"sleep 1 && pnpm test","description":"Run unit tests"}')).toBe('Run unit tests');
  });

  it('survives input cut at MAX_ENTRY_CHARS', () => {
    expect(describeTool('Read', '{"file_path":"/a')).toBe('Reading ');
  });
});

describe('nowOf', () => {
  const tool = (at: string, tool: string, input: object): StreamEntry => ({ at, kind: 'tool', tool, text: JSON.stringify(input) });
  const result = (at: string): StreamEntry => ({ at, kind: 'result', text: 'ok' });

  it('folds a wait loop into one action that counts from its first call', () => {
    const wait = { command: 'timeout 115 tail -f /dev/null; true' };
    const n = nowOf([
      tool('2026-11-19T10:00:00Z', 'Read', { file_path: '/a.ts' }),
      result('2026-11-19T10:00:01Z'),
      { at: '2026-11-19T10:00:02Z', kind: 'text', text: 'Waiting on the Senior.' },
      tool('2026-11-19T10:00:03Z', 'Bash', wait),
      result('2026-11-19T10:02:00Z'),
      tool('2026-11-19T10:02:01Z', 'Bash', wait),
    ])!;
    expect(n.doing).toEqual({ text: 'Waiting', since: '2026-11-19T10:00:03Z', running: true });
    expect(n.said).toEqual({ text: 'Waiting on the Senior.', at: '2026-11-19T10:00:02Z' });
    expect(n.recent).toEqual([{ text: 'Reading a.ts', at: '2026-11-19T10:00:00Z' }]);
    expect(n.at).toBe('2026-11-19T10:02:01Z');
  });

  it('folds a sleep loop into the wait call before it', () => {
    const n = nowOf([
      tool('2026-11-19T10:00:00Z', 'mcp__orchestrator__wait_for_events', {}),
      result('2026-11-19T10:02:00Z'),
      tool('2026-11-19T10:02:01Z', 'Bash', { command: 'timeout 115 tail -f /dev/null; true' }),
    ])!;
    expect(n.doing).toEqual({ text: 'Waiting for events', since: '2026-11-19T10:00:00Z', running: true });
  });

  it('marks the last action as finished once its result arrived', () => {
    expect(nowOf([tool('2026-11-19T10:00:00Z', 'Edit', { file_path: '/b.ts' }), result('2026-11-19T10:00:01Z')])!.doing?.running).toBe(false);
  });

  it('returns null for an empty tail', () => {
    expect(nowOf([])).toBeNull();
  });

  it('reads a call whose result was empty as finished', () => {
    const rows = [
      { type: 'assistant', timestamp: '2026-11-19T10:00:00Z', message: { content: [{ type: 'tool_use', id: 'w', name: 'Bash', input: { command: 'sleep 60' } }] } },
      { type: 'user', timestamp: '2026-11-19T10:01:00Z', message: { content: [{ type: 'tool_result', tool_use_id: 'w', content: '' }] } },
    ];
    expect(nowOf(rows.flatMap((r) => entriesOf(r, { markers: true }).entries))!.doing?.running).toBe(false);
  });

  it('does not let the result of a parallel call finish a wait that is still running', () => {
    const rows = [
      {
        type: 'assistant',
        timestamp: '2026-11-19T10:00:00Z',
        message: { content: [{ type: 'tool_use', id: 'r', name: 'Read', input: { file_path: '/a.ts' } }, { type: 'tool_use', id: 'w', name: 'mcp__orchestrator__wait_for_events', input: {} }] },
      },
      { type: 'user', timestamp: '2026-11-19T10:00:01Z', message: { content: [{ type: 'tool_result', tool_use_id: 'r', content: 'file text' }] } },
    ];
    expect(nowOf(rows.flatMap((r) => entriesOf(r, { markers: true }).entries))!.doing).toMatchObject({ text: 'Waiting for events', running: true });
  });

  const call = (at: string, id: string, name: string, input: object) => ({ type: 'assistant', timestamp: at, message: { content: [{ type: 'tool_use', id, name, input }] } });
  const answer = (at: string, id: string) => ({ type: 'user', timestamp: at, message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
  const nowOfRows = (rows: object[]) => nowOf(rows.flatMap((r) => entriesOf(r, { markers: true }).entries))!;

  it('shows a wait still running even when a later call of its batch returned', () => {
    const n = nowOfRows([
      call('2026-11-19T10:00:00Z', 'w', 'mcp__orchestrator__wait_for_events', {}),
      call('2026-11-19T10:00:00Z', 'r', 'Read', { file_path: '/a.ts' }),
      answer('2026-11-19T10:00:01Z', 'r'),
    ]);
    expect(n.doing).toMatchObject({ text: 'Waiting for events', running: true });
    expect(n.recent.map((r) => r.text)).toEqual(['Reading a.ts']);
  });

  it('does not let an interrupted call without a result hold the status', () => {
    const n = nowOfRows([
      call('2026-11-19T10:00:00Z', 'a', 'Bash', { command: 'pnpm build', description: 'Build' }),
      { type: 'user', timestamp: '2026-11-19T10:01:00Z', message: { content: 'stop, do something else' } },
      call('2026-11-19T10:01:05Z', 'b', 'Read', { file_path: '/b.ts' }),
      answer('2026-11-19T10:01:06Z', 'b'),
    ]);
    expect(n.doing).toMatchObject({ text: 'Reading b.ts', running: false });
  });

  it('keeps empty results out of the Stream panel', () => {
    expect(entriesOf({ type: 'user', timestamp: at, message: { content: [{ type: 'tool_result', tool_use_id: 'w', content: '' }] } }).entries).toEqual([]);
  });

  it('takes the heartbeat from lastAt when it is newer than the last entry, or when there is no entry', () => {
    const later = Date.parse('2026-11-19T10:05:00Z');
    expect(nowOf([tool('2026-11-19T10:00:00Z', 'Read', { file_path: '/a.ts' })], later)!.at).toBe('2026-11-19T10:05:00.000Z');
    expect(nowOf([], later)).toEqual({ at: '2026-11-19T10:05:00.000Z', recent: [] });
  });
});
