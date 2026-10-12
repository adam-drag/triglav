import { describe, expect, it } from 'vitest';
import { artifactsFrom } from '../src/telemetry.ts';
import { presenceOf } from '../src/agents.ts';

describe('artifactsFrom', () => {
  it('reads new branches, pushes and PR links from git and gh output', () => {
    const at = new Date('2026-10-08T00:00:00Z');
    const out = artifactsFrom(
      [
        'To github.com:example-org/example-engine.git',
        ' * [new branch]      feature/x -> feature/x',
        '   335b948..d194e29  feature/x -> feature/x',
        'https://github.com/example-org/example-engine/pull/177',
      ].join('\n'),
      at,
    );
    expect(out.map((a) => [a.kind, a.url])).toEqual([
      ['branch', 'https://github.com/example-org/example-engine/tree/feature/x'],
      ['push', 'https://github.com/example-org/example-engine/compare/335b948...d194e29'],
      ['pr', 'https://github.com/example-org/example-engine/pull/177'],
    ]);
  });

  it('ignores push lines without a remote, PR sub-paths and PR links inside other text', () => {
    expect(artifactsFrom('   335b948..d194e29  a -> a\nhttps://github.com/o/r/pull/12/files\nSee https://github.com/o/r/pull/3 for context', new Date())).toEqual([]);
  });
});

import { artifactsIn } from '../src/telemetry.ts';

describe('artifactsIn', () => {
  const call = (id: string, command: string) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, input: { command } }] } });
  const result = (id: string, content: string) => ({ type: 'user', timestamp: '2026-10-08T01:00:00Z', message: { content: [{ type: 'tool_result', tool_use_id: id, content }] } });
  it('counts PRs only from gh pr create and pushes only from git push', () => {
    const rows = [
      call('a', 'gh pr view 10 --json url -q .url'),
      result('a', 'https://github.com/example-org/example-tools/pull/10'),
      call('b', 'gh pr create --draft --title x'),
      result('b', 'https://github.com/example-org/example-engine/pull/177'),
      call('c', 'git -C /w push origin feature/x'),
      result('c', 'To github.com:example-org/example-engine.git\n   335b948..d194e29  feature/x -> feature/x'),
      call('d', 'git log --oneline'),
      result('d', 'To github.com:o/r.git\n   1111111..2222222  main -> main'),
    ];
    expect(artifactsIn(rows).map((a) => a.label)).toEqual(['example-org/example-engine#177', 'example-org/example-engine: feature/x at d194e29']);
  });
});

import { ownTokens } from '../src/telemetry.ts';

describe('ownTokens', () => {
  it('trusts tokens passed to orchestrator tools, not tokens printed in output', () => {
    const rows = [
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'echo orch_tok_PRINTED' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: '{"session_token":"orch_tok_OTHER"}' }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__orchestrator__wait_for_events', input: { session_token: 'orch_tok_MINE' } }] } },
      { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', input: 'await tools.mcp__orchestrator__wait_for_events({session_token:"orch_tok_CODEX"})' } },
      { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'r1', input: 'const r=await tools.mcp__orchestrator__register_agent({role:"researcher"}); store("t", r.session_token)' } },
      { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'r1', output: '{"session_token":"orch_tok_REG"}' } },
    ];
    expect(ownTokens(rows)).toEqual(['orch_tok_MINE', 'orch_tok_CODEX', 'orch_tok_REG']);
  });
});

import { copilotLoop } from '../src/telemetry.ts';

describe('copilotLoop', () => {
  const call = (ts: string, command: string, name = 'Bash') => ({ type: 'assistant', timestamp: ts, message: { content: [{ type: 'tool_use', id: ts, name, input: { command } }] } });

  it('finds the last Copilot review request and the last read of a review, from the commands of the delivery loop card', () => {
    const rows = [
      call('2026-10-08T01:00:00Z', 'gh api repos/o/r/pulls/7/reviews/123 --jq .body'),
      call('2026-10-08T01:05:00Z', 'gh pr edit 7 --add-reviewer "@copilot"'),
      call('2026-10-08T01:06:00Z', 'git status'),
    ];
    expect(copilotLoop(rows)).toEqual({ awaitAt: new Date('2026-10-08T01:05:00Z'), harvestAt: new Date('2026-10-08T01:00:00Z') });
  });

  it('does not count polling the review list as a read, or other reviewers as Copilot', () => {
    const rows = [
      call('2026-10-08T01:05:00Z', "gh pr edit 7 --add-reviewer '@copilot'"),
      call('2026-10-08T01:07:00Z', "gh api repos/o/r/pulls/7/reviews --paginate --jq '.[] | .id'"),
      call('2026-10-08T01:08:00Z', 'gh pr edit 7 --add-reviewer someone'),
    ];
    expect(copilotLoop(rows)).toEqual({ awaitAt: new Date('2026-10-08T01:05:00Z'), harvestAt: null });
  });
});

describe('presenceOf', () => {
  const now = new Date('2026-10-08T12:00:00Z');
  const ctx = { clock: { now: () => now } } as any;
  const ago = (sec: number) => new Date(now.getTime() - sec * 1000);

  it('shows an agent busy off the board as working, not stale', () => {
    expect(presenceOf(ctx, { last_seen_at: ago(300), waiting_until: null, ended_at: null, transcript_at: ago(30) })).toBe('working');
  });

  it('is stale when neither the orchestrator nor the transcript moved', () => {
    expect(presenceOf(ctx, { last_seen_at: ago(300), waiting_until: null, ended_at: null, transcript_at: ago(600) })).toBe('stale');
  });
});

import { lastActivityAt } from '../src/telemetry.ts';

describe('lastActivityAt', () => {
  it('ignores bookkeeping lines a stopped session keeps appending', () => {
    const rows = [
      { type: 'assistant', timestamp: '2026-10-09T03:58:15Z' },
      { type: 'queue-operation', timestamp: '2026-10-09T04:05:52Z' },
    ];
    expect(lastActivityAt(rows)).toBe(new Date('2026-10-09T03:58:15Z').getTime());
  });
});
