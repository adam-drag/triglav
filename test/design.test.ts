import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyOps, blockDiff, checkDoc, describeRevision, type Doc } from '../src/design.ts';
import { ImportSchema } from '../src/initiatives.ts';

const fixture = JSON.parse(readFileSync(new URL('../e2e/fixtures/public-template-pages.json', import.meta.url), 'utf8'));

const card = (id: string, extra: Record<string, unknown> = {}) => ({
  kind: 'card', id, title: `Card ${id}`, repo: 'app', wave: 'W-1', deps: [], goal: 'g', scope: [], out: [], accept: [], verify: [], traps: [], safety: [], dod: [], gates: [], ...extra,
});
const small = (): Doc =>
  checkDoc({
    format: 1,
    title: 'Small',
    blocks: [
      { kind: 'decision', id: 'D1', title: 'One', body: 'b1' },
      { kind: 'decision', id: 'D2', title: 'Two', body: 'b2' },
      { kind: 'open', id: 'O-host', title: 'Host', body: 'which host' },
      { kind: 'wave', id: 'W-1', title: 'Wave 1', when: 'now', jobs: ['a', 'b'] },
      card('a'),
      card('b', { deps: ['a'], gates: [{ kind: 'merged', job: 'a' }, { kind: 'decision', ref: 'O-host' }] }),
    ],
  });

describe('the public-template-pages fixture', () => {
  it('imports at version 17 with its source, and D1 to D16 carry the numbering and titles of description.md', () => {
    const imp = ImportSchema.parse(fixture);
    expect(imp.version).toBe(17);
    expect(imp.source).toMatch(/ai-plans.*66a76a0/);
    const doc = checkDoc(imp.doc);
    const decisions = doc.blocks.filter((b) => b.kind === 'decision');
    expect(decisions.map((b) => [b.id, b.title.slice(0, 60)])).toEqual([
      ['D1', "A public page is one built-in template version that staff ex"],
      ['D2', "Evaluation runs only in the visitor's browser, through `runT"],
      ['D3', "Page content reaches the visitor as static files written at "],
      ['D4', "Publishing is gated, and the gate stores the values."],
      ['D5', "In v1 a visitor changes input values only, on the template-p"],
      ['D6', "Print uses the client iframe path (`generatePageHtml` and `c"],
      ['D7', "Datasets, page files and uploaded images are out of v1, and "],
      ['D8', "The public page is its own entry point, outside the app shel"],
      ['D9', "A visitor's value is a MathJS expression over the template's"],
      ['D10', "In v1, Python code and derived formulas are read-only, and t"],
      ['D11', "The public page runs Python in a dedicated Worker and stops "],
      ['D12', "On every input change, a MathJS-only run goes first, then th"],
      ['D13', "The public page is a path on the app host: `/t/<slug>`, with"],
      ['D14', "Analytics on the public page is PostHog with `persistence: '"],
      ['D15', "Step 0 is a go, with a size target added for real networks."],
      ['D16', "Template sharing works like sharing a Claude artifact."],
    ]);
    expect(doc.blocks.filter((b) => b.kind === 'card')).toHaveLength(26);
    expect(doc.blocks.filter((b) => b.kind === 'open').map((b) => b.id)).toEqual([
      'O-launch-set', 'O-gallery', 'O-cta', 'O-error-monitoring', 'O-host', 'O-share-version', 'O-only-you', 'O-who-public', 'O-abuse',
    ]);
  });
});

describe('a design revision', () => {
  it('applies add, update and remove, and names the changed blocks', () => {
    const base = small();
    const { doc, changed, removed } = applyOps(base, [
      { op: 'add', block: { kind: 'decision', id: 'D3', title: 'Three', body: 'b3' } },
      { op: 'update', id: 'O-host', set: { closed: 'The app host. See D3.' } },
      { op: 'update', id: 'D1', set: { body: 'b1' } },
      { op: 'update', id: 'b', set: { gates: [{ kind: 'merged', job: 'a' }] } },
    ]);
    // Added after the last decision, not at the end; an update that sets the same value changes nothing.
    expect(doc.blocks.map((b) => b.id)).toEqual(['D1', 'D2', 'D3', 'O-host', 'W-1', 'a', 'b']);
    expect(changed.sort()).toEqual(['D3', 'O-host', 'b']);
    expect(removed).toEqual([]);
    expect(applyOps(base, [{ op: 'update', id: 'b', set: { deps: [], gates: [] } }, { op: 'update', id: 'W-1', set: { jobs: ['b'] } }, { op: 'remove', id: 'a' }]).removed).toEqual(['a']);
  });

  it('refuses a revision that would break the design, and changes nothing', () => {
    const base = small();
    const before = JSON.stringify(base);
    expect(() => applyOps(base, [{ op: 'remove', id: 'a' }])).toThrow(/refers to a/);
    expect(() => applyOps(base, [{ op: 'add', block: { kind: 'decision', id: 'D1', title: 'x', body: 'y' } }])).toThrow(/already exists/);
    expect(() => applyOps(base, [{ op: 'update', id: 'D1', set: { kind: 'open' } }])).toThrow(/never change/);
    expect(() => applyOps(base, [{ op: 'update', id: 'D9', set: { body: 'x' } }])).toThrow(/no block D9/);
    expect(() => applyOps(base, [{ op: 'add', block: { kind: 'decision', id: 'X1', title: 'x', body: 'y' } }])).toThrow(/not valid/);
    expect(() => applyOps(base, [])).toThrow(/not valid/);
    expect(() => applyOps(base, [{ op: 'update', id: 'D1', set: { script: '<b>' } }])).toThrow(/not valid/);
    expect(JSON.stringify(base)).toBe(before);
  });

  it('describes itself from the operations, block by block', () => {
    const lines = describeRevision(small(), [
      { op: 'add', block: { kind: 'decision', id: 'D3', title: 'Three', body: 'b3' } },
      { op: 'update', id: 'O-host', set: { closed: 'The app host.' } },
      { op: 'update', id: 'D2', set: { body: 'new' } },
    ]);
    expect(lines).toEqual(['Change decision D2 "Two": body.', 'Add decision D3 "Three".', 'Close open decision O-host "Host": The app host.']);
  });

  it('diffs two versions field by field', () => {
    const base = small();
    const { doc } = applyOps(base, [{ op: 'update', id: 'D2', set: { body: 'new' } }, { op: 'add', block: { kind: 'decision', id: 'D3', title: 'Three', body: 'b3' } }]);
    expect(blockDiff(base, doc)).toEqual([
      { id: 'D2', kind: 'decision', title: 'Two', change: 'changed', fields: [{ field: 'body', before: 'b2', after: 'new' }] },
      { id: 'D3', kind: 'decision', title: 'Three', change: 'added', fields: [{ field: 'title', before: null, after: 'Three' }, { field: 'body', before: null, after: 'b3' }] },
    ]);
  });
});
