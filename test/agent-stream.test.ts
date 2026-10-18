import { describe, expect, it } from 'vitest';
import { entriesOf, MAX_ENTRY_CHARS } from '../src/agent-stream.ts';

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
