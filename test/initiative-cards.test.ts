import { describe, expect, it } from 'vitest';
import { checkDoc, type Doc } from '../src/design.ts';
import { evaluateCards, gateKeyOf, type Facts } from '../src/card-state.ts';
import { buildCardPrompt } from '../src/card-prompt.ts';
import { parseGateOutput, parsePrUrl, prViewArgs, provesMerged } from '../src/gate-check.ts';

// Pure checks of the phase 2 modules: the gh argv of a merged check, the evaluator, and the prompt of a Start.

const SHA = 'a'.repeat(40);

describe('gh argv of a merged check', () => {
  it('is the fixed argv: pr view, the number, -R with the slug, and the fields. Nothing else', () => {
    expect(prViewArgs(12, 'owner/app')).toEqual(['pr', 'view', '12', '-R', 'owner/app', '--json', 'state,mergedAt,mergeCommit,url']);
  });

  it('refuses a number that is not a positive integer, and a slug that is not owner/name', () => {
    for (const pr of [0, -1, 1.5, 1_000_000_000, Number.NaN]) expect(() => prViewArgs(pr, 'owner/app')).toThrow(/positive integer/);
    for (const slug of ['owner', '-owner/app', 'owner/app; rm -rf /', 'owner/app $(id)', 'owner/app extra', '../x/y', 'owner/']) {
      expect(() => prViewArgs(1, slug)).toThrow(/owner\/name slug/);
    }
  });

  it('reads the number and the slug of a GitHub pull request URL only', () => {
    expect(parsePrUrl('https://github.com/owner/app/pull/34')).toEqual({ slug: 'owner/app', number: 34 });
    for (const url of ['http://github.com/owner/app/pull/34', 'https://github.com/owner/app/pull/0', 'https://github.com/owner/app/issues/34', 'https://evil.example/owner/app/pull/34', 'https://github.com/owner/app/pull/34/files']) {
      expect(parsePrUrl(url)).toBeNull();
    }
  });
});

describe('the JSON of a merged check', () => {
  const merged = JSON.stringify({ state: 'MERGED', mergedAt: '2026-11-17T10:00:00Z', mergeCommit: { oid: SHA }, url: 'https://github.com/owner/app/pull/34' });

  it('parses the fields it asks for and proves a merge only with a merge time and a commit', () => {
    const out = parseGateOutput(merged);
    expect(out).toMatchObject({ state: 'MERGED', mergeCommit: { oid: SHA } });
    expect(provesMerged(out!)).toBe(true);
    expect(provesMerged(parseGateOutput(JSON.stringify({ state: 'OPEN', mergedAt: null, mergeCommit: null, url: 'https://github.com/owner/app/pull/34' }))!)).toBe(false);
    expect(provesMerged(parseGateOutput(JSON.stringify({ state: 'MERGED', mergedAt: null, mergeCommit: { oid: SHA }, url: 'https://github.com/owner/app/pull/34' }))!)).toBe(false);
  });

  it('refuses text that is not that shape: not JSON, a bad state, a short commit id', () => {
    expect(parseGateOutput('not json')).toBeNull();
    expect(parseGateOutput(merged.replace('MERGED', 'merged'))).toBeNull();
    expect(parseGateOutput(merged.replace(SHA, 'abc1234'))).toBeNull();
    expect(parseGateOutput('[]')).toBeNull();
  });
});

// A small design: card A is delivered by its job, card B waits for A's merge and a decision, card C has a client step.
const doc: Doc = checkDoc({
  format: 1,
  title: 'Small',
  blocks: [
    { kind: 'wave', id: 'W-1', title: 'First', when: 'now', jobs: ['a', 'b', 'c'] },
    { kind: 'open', id: 'O-host', title: 'Host', body: 'which host', closed: 'The app host, see D1.' },
    { kind: 'open', id: 'O-cache', title: 'Cache', body: 'which cache' },
    { kind: 'decision', id: 'D1', title: 'One', body: 'Use the app host.' },
    { kind: 'decision', id: 'D2', title: 'Two', body: 'Not listed by any card.' },
    { kind: 'checkpoint', id: 'CP-A', title: 'Client signs off', steps: ['Check the page'] },
    { kind: 'contract', id: 'C-api', title: 'API', body: 'The API shape.' },
    card('a', []),
    card('b', [{ kind: 'merged', job: 'a' }, { kind: 'decision', ref: 'O-host' }]),
    card('c', [{ kind: 'client_step', ref: 'CP-A' }]),
  ],
});

function card(id: string, gates: unknown[]) {
  return {
    kind: 'card',
    id,
    title: `Card ${id}`,
    repo: 'app',
    wave: 'W-1',
    deps: [],
    decisions: id === 'a' ? ['D1'] : undefined,
    goal: `Goal of ${id}. Keeps C-api.`,
    scope: ['Scope one'],
    out: [],
    accept: ['Accept'],
    verify: ['Verify'],
    traps: [],
    safety: [],
    dod: [],
    gates,
  };
}

const none: Facts = { rows: new Map(), starts: new Map() };
const byKey = (facts: Facts, milestones: string[] = []) => Object.fromEntries(evaluateCards(doc, milestones, facts).map((c) => [c.key, c]));

describe('the one gate evaluator', () => {
  it('derives a decision gate from the design and never marks it by hand', () => {
    const cards = byKey(none);
    expect(cards.b!.gates.find((g) => g.kind === 'decision')).toMatchObject({ key: 'decision:O-host', met: true, markable: false });
    expect(cards.b!.gates.find((g) => g.kind === 'merged')).toMatchObject({ key: 'merged:a', met: false, markable: true });
  });

  it('is Ready when every gate is met and nothing runs; Locked while a merged gate is open; Your step when only a client step is open', () => {
    const cards = byKey(none);
    expect(cards.a!.state).toBe('ready');
    expect(cards.b!.state).toBe('locked');
    expect(cards.b!.open).toBe(1);
    expect(cards.c!.state).toBe('your_step');
  });

  it('is Running with the job phase while the card has an active start, and Delivered once its job is done', () => {
    const starts = (job_status: string | null, request_status = 'registered') =>
      byKey({ rows: new Map(), starts: new Map([['a', { request_status, job_id: job_status ? 'job_1' : null, job_status, started_from_version: 3, started_at: '2026-11-17T09:00:00.000Z' }]]) });
    expect(starts('in_progress').a).toMatchObject({ state: 'running', phase: 'in_progress', job_id: 'job_1', started_from_version: 3 });
    expect(starts(null, 'queued').a).toMatchObject({ state: 'running', phase: 'starting', job_id: null });
    expect(starts('done').a).toMatchObject({ state: 'delivered' });
    expect(starts('cancelled').a!.state).toBe('ready');
    expect(starts(null, 'failed').a!.state).toBe('ready');
  });

  it('counts a merged gate met only from its row, and shows the evidence and the Client reason', () => {
    const rows = new Map([
      ['b|merged:a', { met_at: '2026-11-17T10:05:00.000Z', met_by: 'check', reason: null, evidence: { merged_at: '2026-11-17T10:00:00Z', merge_commit: SHA } }],
    ]);
    const cards = byKey({ rows, starts: new Map() });
    expect(cards.b!.gates.find((g) => g.kind === 'merged')).toMatchObject({ met: true, met_by: 'check', evidence: { merge_commit: SHA } });
    // The decision gate is closed in the design, so with the merged row B has no open gate left.
    expect(cards.b!.state).toBe('ready');
  });

  it('marks a milestone gate met when the milestone is no longer open', () => {
    const milestoned = checkDoc({ ...doc, blocks: [...doc.blocks.filter((b) => b.id !== 'b'), card('b', [{ kind: 'milestone', ref: 'Beta' }])] });
    const open = evaluateCards(milestoned, ['Beta'], none).find((c) => c.key === 'b')!;
    const closed = evaluateCards(milestoned, [], none).find((c) => c.key === 'b')!;
    expect(open.gates[0]).toMatchObject({ key: 'milestone:Beta', met: false });
    expect(closed.gates[0]).toMatchObject({ met: true, markable: false });
  });

  it('keys a gate the same way everywhere', () => {
    expect(gateKeyOf({ kind: 'deployed', repo: 'mesh', after: 'a', note: 'x' })).toBe('deployed:mesh:a');
    expect(gateKeyOf({ kind: 'client_step', ref: 'CP-A' })).toBe('client_step:CP-A');
  });
});

describe('the prompt of a Start', () => {
  const base = {
    initiative: { key: 'ptp', title: 'Public template pages' },
    doc,
    version: 17,
    repo: { slug: 'app', path: '/home/u/app', base: 'main' },
  };

  it('holds the sections in order, the listed decisions in full, an index of the others, and the contract the card names', () => {
    const card = doc.blocks.find((b) => b.id === 'a') as Extract<(typeof doc.blocks)[number], { kind: 'card' }>;
    const prompt = buildCardPrompt({ ...base, card, merged: [] });
    const order = ['You are Staff', 'Repository: app', 'Goal\n', 'Scope\n', 'Out of scope\n', 'Acceptance criteria\n', 'Verification\n', 'Traps\n', 'Safety\n', 'Done when\n', 'Merged dependencies\n', 'Decisions of this card, in full\n', 'All other decisions, id and title only\n', 'Contracts this card names\n', 'Repository rules', 'Questions:'];
    const at = order.map((s) => prompt.indexOf(s));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((x, y) => x - y)).toEqual(at);
    expect(prompt).toContain('D1 "One"\nUse the app host.');
    expect(prompt).toContain('- D2 "Two"');
    expect(prompt).not.toContain('- D1 "One"');
    expect(prompt).toContain('C-api "API"\nThe API shape.');
    expect(prompt).toContain('version 17');
    expect(prompt).not.toContain('—');
  });

  it('names the merged dependency with its PR and merge date, and says when the Client marked it', () => {
    const card = doc.blocks.find((b) => b.id === 'b') as Extract<(typeof doc.blocks)[number], { kind: 'card' }>;
    const withPr = buildCardPrompt({ ...base, card, merged: [{ key: 'a', title: 'Card a', pr_url: 'https://github.com/owner/app/pull/34', merged_at: '2026-11-17T10:00:00Z' }] });
    expect(withPr).toContain('- a "Card a": PR https://github.com/owner/app/pull/34, merged 2026-11-17T10:00:00Z');
    const byHand = buildCardPrompt({ ...base, card, merged: [{ key: 'a', title: 'Card a', pr_url: null, merged_at: null }] });
    expect(byHand).toContain('- a "Card a": merged (the Client marked it)');
  });
});
