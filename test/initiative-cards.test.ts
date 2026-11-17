import { describe, expect, it } from 'vitest';
import { checkDoc, type Doc } from '../src/design.ts';
import { checkpointHash, evaluateCards, gateKeyOf, type Facts } from '../src/card-state.ts';
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
    expect(parseGateOutput(JSON.stringify({ state: 'MERGED', mergedAt: '2026-11-17T10:00:00Z', mergeCommit: { oid: SHA } }))).toBeNull();
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
    contracts: id === 'a' ? ['C-api'] : undefined,
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
    const starts = (job_status: string | null, request_status = 'registered', dismissed = false) =>
      byKey({ rows: new Map(), starts: new Map([['a', { request_status, job_id: job_status ? 'job_1' : null, job_status, dismissed, started_from_version: 3, started_at: '2026-11-17T09:00:00.000Z' }]]) });
    expect(starts('in_progress').a).toMatchObject({ state: 'running', phase: 'in_progress', job_id: 'job_1', started_from_version: 3 });
    expect(starts(null, 'queued').a).toMatchObject({ state: 'running', phase: 'starting', job_id: null });
    expect(starts('done').a).toMatchObject({ state: 'delivered' });
    expect(starts('cancelled').a!.state).toBe('ready');
    expect(starts(null, 'failed').a!.state).toBe('ready');
    expect(starts(null, 'started').a!.state).toBe('running');
    expect(starts(null, 'started', true).a!.state).toBe('ready');
  });

  it('counts a merged gate met only from its row, and shows the evidence and the Client reason', () => {
    const rows = new Map([
      ['b|merged:a', { met_at: '2026-11-17T10:05:00.000Z', met_by: 'check', reason: null, evidence: { merged_at: '2026-11-17T10:00:00Z', merge_commit: SHA }, checkpoint_hash: null }],
    ]);
    const cards = byKey({ rows, starts: new Map() });
    expect(cards.b!.gates.find((g) => g.kind === 'merged')).toMatchObject({ met: true, met_by: 'check', evidence: { merge_commit: SHA } });
    // The decision gate is closed in the design, so with the merged row B has no open gate left.
    expect(cards.b!.state).toBe('ready');
  });

  it('meets a milestone gate once the milestone is started, and labels it so', () => {
    const milestoned = checkDoc({ ...doc, blocks: [...doc.blocks.filter((b) => b.id !== 'b'), card('b', [{ kind: 'milestone', ref: 'Beta' }])] });
    const notStarted = evaluateCards(milestoned, [], none).find((c) => c.key === 'b')!;
    const started = evaluateCards(milestoned, ['Beta'], none).find((c) => c.key === 'b')!;
    expect(notStarted.gates[0]).toMatchObject({ key: 'milestone:Beta', met: false, label: 'Milestone Beta started' });
    expect(started.gates[0]).toMatchObject({ met: true, markable: false });
  });

  it('re-opens a client_step mark when its checkpoint steps change, and keeps it while they do not', () => {
    const cp = (steps: string[]) => ({ kind: 'checkpoint' as const, id: 'CP-A', title: 'Check the page', steps });
    const withCard = (steps: string[]) => checkDoc({ ...doc, blocks: [...doc.blocks.filter((b) => b.id !== 'b' && b.id !== 'CP-A'), cp(steps), card('b', [{ kind: 'client_step', ref: 'CP-A' }])] });
    const marked = (steps: string[], hash: string | null): Facts => ({ rows: new Map([['b|client_step:CP-A', { met_at: '2026-11-18T10:00:00.000Z', met_by: 'client', reason: 'Checked.', evidence: null, checkpoint_hash: hash }]]), starts: new Map() });
    const before = withCard(['Open the page.', 'Read the total.']);
    const hash = checkpointHash(['Open the page.', 'Read the total.']);

    const same = evaluateCards(before, [], marked(['Open the page.', 'Read the total.'], hash)).find((c) => c.key === 'b')!;
    expect(same.gates[0]).toMatchObject({ met: true, reopened: false });

    // Spacing does not count as a change; a different step does.
    const spaced = evaluateCards(withCard(['Open  the page.', ' Read the total. ']), [], marked(['Open the page.', 'Read the total.'], hash)).find((c) => c.key === 'b')!;
    expect(spaced.gates[0]).toMatchObject({ met: true, reopened: false });
    const changed = evaluateCards(withCard(['Open the page.', 'Read the grand total.']), [], marked(['Open the page.', 'Read the total.'], hash)).find((c) => c.key === 'b')!;
    expect(changed.gates[0]).toMatchObject({ met: false, reopened: true, markable: true });
    expect(changed.state).toBe('your_step');

    // A mark from before the column has no hash: it stays met, until the room adopts the hash.
    const legacy = evaluateCards(withCard(['Something else.']), [], marked(['Open the page.'], null)).find((c) => c.key === 'b')!;
    expect(legacy.gates[0]).toMatchObject({ met: true, reopened: false });
  });

  it('shows a card delivered from the design as recorded, and never as a job', () => {
    const delivered = checkDoc({ ...doc, blocks: [...doc.blocks.filter((b) => b.id !== 'b'), { ...card('b', []), delivered: { note: 'Shipped before the room.' } }] });
    const view = evaluateCards(delivered, [], none).find((c) => c.key === 'b')!;
    expect(view).toMatchObject({ state: 'delivered', recorded: true });
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

  it('holds the sections in order, the listed decisions in full, an id and title for every decision, and the contract the card names', () => {
    const card = doc.blocks.find((b) => b.id === 'a') as Extract<(typeof doc.blocks)[number], { kind: 'card' }>;
    const prompt = buildCardPrompt({ ...base, card, merged: [] });
    const order = ['You are Staff', 'Repository: app', 'Goal\n', 'Scope\n', 'Out of scope\n', 'Acceptance criteria\n', 'Verification\n', 'Traps\n', 'Safety\n', 'Done when\n', 'Merged dependencies\n', 'Decisions of this card, in full\n', 'All decisions, id and title only\n', 'All contracts, id and title only\n', 'Contracts this card names\n', 'Repository rules', 'Questions:'];
    const at = order.map((s) => prompt.indexOf(s));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((x, y) => x - y)).toEqual(at);
    expect(prompt).toContain('D1 "One"\nUse the app host.');
    expect(prompt).toContain('- D2 "Two"');
    expect(prompt).toContain('- D1 "One"');
    expect(prompt).toContain('C-api "API"\nThe API shape.');
    // A contract the card only mentions in its text is not listed: the design lists the contracts a card names.
    const other = buildCardPrompt({ ...base, card: { ...card, id: 'b', contracts: undefined }, merged: [] });
    expect(other).toContain('None named by this card.');
    expect(other).not.toContain('C-api "API"\nThe API shape.');
    // Every contract is in the index by id and title, named by the card or not.
    expect(prompt).toContain('All contracts, id and title only\n- C-api "API"');
    expect(other).toContain('- C-api "API"');
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

describe('the prompt of a Start: step, note, done-when and closed answers', () => {
  const design = checkDoc({
    format: 1,
    title: 'Prompt',
    blocks: [
      { kind: 'wave', id: 'W-1', title: 'First', when: 'now', jobs: ['a'] },
      { kind: 'dod', id: 'DOD-v1', title: 'Definition of done', items: ['First item.', 'Second item.', 'Third item.'] },
      { kind: 'open', id: 'O-host', title: 'Host', body: 'Which host.', closed: 'The app host.' },
      { kind: 'open', id: 'O-other', title: 'Other', body: 'Still open.' },
      {
        kind: 'card',
        id: 'a',
        title: 'Card a',
        repo: 'app',
        wave: 'W-1',
        deps: [],
        goal: 'Goal of a.',
        step: 'Step 2',
        note: 'Ask the Client if the host is not recorded.',
        scope: [],
        out: [],
        accept: [],
        verify: [],
        traps: [],
        safety: [],
        dod: ['2 (load)', 'Plain item'],
        gates: [{ kind: 'decision', ref: 'O-host' }],
      },
    ],
  });
  const card = design.blocks.find((b) => b.id === 'a') as Extract<(typeof design.blocks)[number], { kind: 'card' }>;
  const prompt = buildCardPrompt({ initiative: { key: 'x', title: 'X' }, doc: design, version: 3, card, repo: { slug: 'app', path: '/home/u/app', base: 'main' }, merged: [] });

  it('holds the step and the note of the card', () => {
    expect(prompt).toContain('Step\nStep 2');
    expect(prompt).toContain('Note\nAsk the Client if the host is not recorded.');
  });

  it('gives the text of each numbered done-when item beside its number', () => {
    expect(prompt).toContain('2 (load): Second item.');
    expect(prompt).toContain('- Plain item');
  });

  it('holds the Client answer to each open decision its decision gate waits for, and no open one', () => {
    expect(prompt).toContain('Answers to the open decisions this card waits for\nO-host "Host": The app host.');
    expect(prompt).not.toContain('O-other');
  });
});
