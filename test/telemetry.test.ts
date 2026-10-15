import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

describe('copilotLoop and the delivery loop card', () => {
  const card = readFileSync(join(import.meta.dirname, '../src/guide/deliver.md'), 'utf8');
  const fill = (cmd: string) => cmd.replaceAll('<pr>', '7').replaceAll('<repo>', 'o/r').replaceAll('<id>', '123');
  const call = (ts: string, command: string) => ({ type: 'assistant', timestamp: ts, message: { content: [{ type: 'tool_use', id: ts, name: 'Bash', input: { command } }] } });

  it('recognises the gh commands that src/guide/deliver.md tells the Senior to run', () => {
    const request = card.match(/`(gh pr edit <pr> --add-reviewer "@copilot")`/)?.[1];
    const read = card.match(/`(gh api repos\/<repo>\/pulls\/<pr>\/reviews\/<id> --jq \.body)`/)?.[1];
    expect(request, 'the request command is on the card').toBeDefined();
    expect(read, 'the review read command is on the card').toBeDefined();
    const rows = [call('2026-10-08T01:00:00Z', fill(request!)), call('2026-10-08T01:10:00Z', fill(read!))];
    expect(copilotLoop(rows)).toEqual({ awaitAt: new Date('2026-10-08T01:00:00Z'), harvestAt: new Date('2026-10-08T01:10:00Z') });
  });

  it('does not take the polling command of the card for a read of a review', () => {
    const list = card.match(/`(gh api repos\/<repo>\/pulls\/<pr>\/reviews --paginate[^`]*)`/)?.[1];
    expect(list).toBeDefined();
    expect(copilotLoop([call('2026-10-08T01:00:00Z', fill(list!))])).toEqual({ awaitAt: null, harvestAt: null });
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

import { lastTranscriptError } from '../src/telemetry.ts';
import { resumeStep } from '../web/src/resume-step.ts';

const apiError = { type: 'assistant', timestamp: '2026-10-14T20:55:13.587Z', isApiErrorMessage: true, message: { content: [{ type: 'text', text: 'API Error: Connection lost mid-response.  The response above may be incomplete.' }] } };

describe('a transcript that ends in an API error', () => {
  it('is not activity, and is reported as the reason the session is idle', () => {
    const rows = [{ type: 'assistant', timestamp: '2026-10-14T12:27:12Z' }, { type: 'queue-operation', timestamp: '2026-10-14T20:56:00Z' }, apiError];
    expect(lastActivityAt(rows)).toBe(new Date('2026-10-14T12:27:12Z').getTime());
    expect(lastTranscriptError(rows)).toEqual({ text: 'API Error: Connection lost mid-response. The response above may be incomplete.', at: new Date('2026-10-14T20:55:13.587Z').getTime() });
  });

  it('is not reported once the model does something after it', () => {
    expect(lastTranscriptError([apiError, { type: 'assistant', timestamp: '2026-10-14T21:00:00Z' }])).toBeNull();
    expect(lastTranscriptError([{ type: 'assistant', timestamp: '2026-10-14T12:27:12Z' }])).toBeNull();
  });
});

describe('resumeStep', () => {
  const t = (s: string) => new Date(s).getTime();
  const launch = { requested_at: '2026-10-14T20:52:51Z', picked_at: '2026-10-14T20:52:51Z', finished_at: '2026-10-14T20:52:52Z' };
  it('treats a skipped resume that the runner reports as "ok: skipped" as skipped, then stuck after the grace period', () => {
    const skipped = { ...launch, result: 'ok: skipped: this session already runs as background session 2894a8e0' };
    expect(resumeStep(skipped, null, t('2026-10-14T20:53:00Z'))).toBe('skipped');
    expect(resumeStep(skipped, null, t('2026-10-14T21:09:00Z'))).toBe('stuck');
  });
  it('gives a started session two minutes, then calls it stuck', () => {
    const ok = { ...launch, result: 'ok: backgrounded' };
    expect(resumeStep(ok, null, t('2026-10-14T20:53:30Z'))).toBe('reconnecting');
    expect(resumeStep(ok, null, t('2026-10-14T20:55:30Z'))).toBe('stuck');
  });
  it('shows a failed launch and an unfinished one as they are', () => {
    expect(resumeStep({ ...launch, result: 'failed: x' }, null, t('2026-10-14T21:09:00Z'))).toBe('failed');
    expect(resumeStep({ requested_at: launch.requested_at }, null, 0)).toBe('queued');
    expect(resumeStep({ requested_at: launch.requested_at, picked_at: launch.picked_at }, null, 0)).toBe('starting');
  });
  it('says "sent" for a click newer than the last launch, so Restart session answers at once', () => {
    expect(resumeStep(null, t('2026-10-14T21:09:00Z'), t('2026-10-14T21:09:01Z'))).toBe('sent');
    expect(resumeStep({ ...launch, result: 'ok: x' }, t('2026-10-14T21:09:00Z'), t('2026-10-14T21:09:01Z'))).toBe('sent');
    expect(resumeStep(null, null, 0)).toBeNull();
  });
});
