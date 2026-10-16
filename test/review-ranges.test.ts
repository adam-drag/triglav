import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { blocks, buildReviewPrompt, mergeResolved, parseReviewerOutput } from '../src/code-review.ts';
import { changedRanges, MAX_RANGE_FILES, MAX_RANGES_PER_FILE, outsideDelta, parseRanges, unionRanges } from '../src/review-ranges.ts';
import { reviewerReport, reviewSchemaJson, REVIEW_SCHEMA_JSON, worktreeDiff } from '../scripts/code-review-run.ts';

/** A one-file diff with the given header lines and body. */
const diff = (path: string, hunks: string) => `diff --git a/${path} b/${path}\nindex 111..222 100644\n--- a/${path}\n+++ b/${path}\n${hunks}`;

describe('changedRanges', () => {
  it('marks added and changed lines of the new side, one range per stretch', () => {
    const d = diff('src/a.ts', '@@ -1,6 +1,7 @@\n one\n-two\n+TWO\n three\n four\n+five\n six\n seven\n');
    // new side: 1 one, 2 TWO, 3 three, 4 four, 5 five, 6 six, 7 seven
    expect(changedRanges(d)).toEqual([{ file: 'src/a.ts', ranges: [[2, 2], [5, 5]] }]);
  });

  it('joins ranges that touch and keeps the ones that do not', () => {
    const d = diff('a.ts', '@@ -1,2 +1,5 @@\n x\n+a\n+b\n+c\n y\n@@ -20,2 +22,3 @@\n p\n+q\n r\n');
    expect(changedRanges(d)).toEqual([{ file: 'a.ts', ranges: [[2, 4], [23, 23]] }]);
  });

  it('marks the lines around a removal with nothing added in its place', () => {
    // new side: 1 a, 2 b, 3 e, 4 f ; "c" and "d" were removed between b and e
    const d = diff('a.ts', '@@ -1,6 +1,4 @@\n a\n b\n-c\n-d\n e\n f\n');
    expect(changedRanges(d)).toEqual([{ file: 'a.ts', ranges: [[2, 3]] }]);
  });

  it('handles a file emptied by a change, a new file, and a hunk of one line', () => {
    expect(changedRanges(diff('e.ts', '@@ -1,2 +0,0 @@\n-x\n-y\n'))).toEqual([{ file: 'e.ts', ranges: [[1, 1]] }]);
    expect(changedRanges('diff --git a/n.ts b/n.ts\nnew file mode 100644\nindex 0..1\n--- /dev/null\n+++ b/n.ts\n@@ -0,0 +1,3 @@\n+a\n+b\n+c\n')).toEqual([{ file: 'n.ts', ranges: [[1, 3]] }]);
    expect(changedRanges(diff('o.ts', '@@ -5 +5 @@\n-old\n+new\n'))).toEqual([{ file: 'o.ts', ranges: [[5, 5]] }]);
  });

  it('gives a deleted file, a binary file and a pure rename no range', () => {
    const deleted = 'diff --git a/gone.ts b/gone.ts\ndeleted file mode 100644\nindex 1..0\n--- a/gone.ts\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-a\n-b\n';
    const binary = 'diff --git a/i.png b/i.png\nindex 1..2 100644\nBinary files a/i.png and b/i.png differ\n';
    const renamed = 'diff --git a/x.ts b/y.ts\nsimilarity index 100%\nrename from x.ts\nrename to y.ts\n';
    expect(changedRanges(deleted + binary + renamed)).toEqual([]);
    expect(changedRanges('')).toEqual([]);
  });

  it('uses the new path of a renamed file that also changed', () => {
    const d = 'diff --git a/x.ts b/y.ts\nsimilarity index 80%\nrename from x.ts\nrename to y.ts\nindex 1..2 100644\n--- a/x.ts\n+++ b/y.ts\n@@ -1,2 +1,2 @@\n a\n-b\n+c\n';
    expect(changedRanges(d)).toEqual([{ file: 'y.ts', ranges: [[2, 2]] }]);
  });

  it('reads quoted paths and paths with a space', () => {
    expect(changedRanges(diff('a b.ts', '@@ -1 +1 @@\n-x\n+y\n').replace('+++ b/a b.ts', '+++ b/a b.ts\t'))).toEqual([{ file: 'a b.ts', ranges: [[1, 1]] }]);
    const quoted = 'diff --git "a/t\\tab.ts" "b/t\\tab.ts"\n--- "a/t\\tab.ts"\n+++ "b/t\\tab.ts"\n@@ -1 +1 @@\n-x\n+y\n';
    expect(changedRanges(quoted)).toEqual([{ file: 't\tab.ts', ranges: [[1, 1]] }]);
    const accent = 'diff --git "a/caf\\303\\251.ts" "b/caf\\303\\251.ts"\n--- "a/caf\\303\\251.ts"\n+++ "b/caf\\303\\251.ts"\n@@ -1 +1 @@\n-x\n+y\n';
    expect(changedRanges(accent)).toEqual([{ file: 'café.ts', ranges: [[1, 1]] }]);
  });

  it('never takes a line of file content for a header, and skips the no-newline marker', () => {
    // The added lines look like a diff header and a hunk header.
    const d = diff('a.md', '@@ -1,2 +1,4 @@\n keep\n+++ b/evil.ts\n+@@ -1 +900 @@\n+--- a/x\n tail\n\\ No newline at end of file\n');
    expect(changedRanges(d)).toEqual([{ file: 'a.md', ranges: [[2, 4]] }]);
  });

  it('returns null, not a part, for a diff it cannot read exactly or one over the caps', () => {
    expect(changedRanges(diff('a.ts', '@@ -1,5 +1,5 @@\n a\n b\n'))).toBeNull();
    expect(changedRanges('diff --git a/x b/x\n--- a/x\n+++ not-a-prefix\n@@ -1 +1 @@\n-a\n+b\n')).toBeNull();
    expect(changedRanges('diff --git a/x b/x\n--- a/x\n+++ "b/bad\\q"\n@@ -1 +1 @@\n-a\n+b\n')).toBeNull();
    const many = Array.from({ length: MAX_RANGE_FILES + 1 }, (_, i) => diff(`f${i}.ts`, '@@ -1 +1 @@\n-a\n+b\n')).join('');
    expect(changedRanges(many)).toBeNull();
    // Every other line changed: more separate ranges than one file may hold.
    const lines = Array.from({ length: MAX_RANGES_PER_FILE + 1 }, () => '+a\n x\n').join('');
    expect(changedRanges(diff('big.ts', `@@ -1,${MAX_RANGES_PER_FILE + 1} +1,${(MAX_RANGES_PER_FILE + 1) * 2} @@\n${lines}`))).toBeNull();
  });
});

describe('changedRanges on a real git diff', () => {
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { PATH: process.env.PATH!, HOME: cwd, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
  const env = { PATH: process.env.PATH!, HOME: tmpdir() };

  it('reads the ranges of worktreeDiff, also with a hostile diff config in the user environment', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ranges-repo-'));
    git(dir, 'init', '-q', '-b', 'main');
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'a.ts'), Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
    writeFileSync(join(dir, 'gone.ts'), 'x\ny\n');
    writeFileSync(join(dir, 'a b.ts'), 'p\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'one');
    const base = git(dir, 'rev-parse', 'HEAD');
    writeFileSync(join(dir, 'src', 'a.ts'), Array.from({ length: 20 }, (_, i) => (i === 3 ? 'CHANGED 4' : i === 11 ? 'CHANGED 12\nINSERTED' : `line ${i + 1}`)).join('\n') + '\n');
    git(dir, 'rm', '-q', 'gone.ts');
    writeFileSync(join(dir, 'a b.ts'), 'q\n');
    writeFileSync(join(dir, 'new.ts'), 'n1\nn2\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'two');
    const head = git(dir, 'rev-parse', 'HEAD');
    // color.diff=always, no prefix and mnemonic prefixes would change the headers; the runner overrides them.
    git(dir, 'config', 'color.diff', 'always');
    git(dir, 'config', 'diff.noprefix', 'true');
    const d = await worktreeDiff({ cwd: dir, base, head, env });
    expect(d.ranges).toEqual([
      { file: 'a b.ts', ranges: [[1, 1]] },
      { file: 'new.ts', ranges: [[1, 2]] },
      { file: 'src/a.ts', ranges: [[4, 4], [12, 13]] },
    ]);
  });
});

describe('parseRanges', () => {
  it('accepts what changedRanges makes, joined and sorted', () => {
    expect(parseRanges([{ file: 'b.ts', ranges: [[5, 6], [1, 2], [3, 3]] }, { file: 'a.ts', ranges: [[9, 9]] }])).toEqual([
      { file: 'a.ts', ranges: [[9, 9]] },
      { file: 'b.ts', ranges: [[1, 3], [5, 6]] },
    ]);
    expect(parseRanges([])).toEqual([]);
  });

  it('drops the whole field for one bad entry or any cap, never a part of it', () => {
    const ok = { file: 'a.ts', ranges: [[1, 2]] };
    const bad: unknown[] = [
      undefined,
      null,
      'x',
      {},
      [null],
      [{ file: 'a.ts' }],
      [{ file: '', ranges: [] }],
      [{ file: '/etc/passwd', ranges: [[1, 1]] }],
      [{ file: '../x.ts', ranges: [[1, 1]] }],
      [{ file: 'a/../x.ts', ranges: [[1, 1]] }],
      [{ file: 'a\0.ts', ranges: [[1, 1]] }],
      [{ file: 'x'.repeat(301), ranges: [[1, 1]] }],
      [{ file: 7, ranges: [[1, 1]] }],
      [{ file: 'a.ts', ranges: [[3, 2]] }],
      [{ file: 'a.ts', ranges: [[0, 2]] }],
      [{ file: 'a.ts', ranges: [[1.5, 2]] }],
      [{ file: 'a.ts', ranges: [[1, 2, 3]] }],
      [{ file: 'a.ts', ranges: [['1', 2]] }],
      [{ file: 'a.ts', ranges: [[1, 99_999_999]] }],
      [{ file: 'a.ts', ranges: Array.from({ length: MAX_RANGES_PER_FILE + 1 }, (_, i) => [i * 3 + 1, i * 3 + 1]) }],
      Array.from({ length: MAX_RANGE_FILES + 1 }, (_, i) => ({ file: `f${i}.ts`, ranges: [[1, 1]] })),
    ];
    for (const value of bad) expect(parseRanges(value), JSON.stringify(value)?.slice(0, 80)).toBeNull();
    // The good entry next to a bad one does not survive either.
    expect(parseRanges([ok, { file: 'b.ts', ranges: 'x' }])).toBeNull();
  });
});

describe('outsideDelta', () => {
  const ranges = [{ file: 'a.ts', ranges: [[10, 20] as [number, number]] }];
  it('is true when no site is on a changed line, false when one is', () => {
    expect(outsideDelta([{ file: 'a.ts', line: 30 }], ranges)).toBe(true);
    expect(outsideDelta([{ file: 'a.ts', line: 9 }, { file: 'a.ts', line: 21 }], ranges)).toBe(true);
    expect(outsideDelta([{ file: 'a.ts', line: 10 }], ranges)).toBe(false);
    expect(outsideDelta([{ file: 'a.ts', line: 20 }], ranges)).toBe(false);
    expect(outsideDelta([{ file: 'a.ts', line: 30 }, { file: 'a.ts', line: 15 }], ranges)).toBe(false);
  });
  it('treats a file the diff did not touch as outside, and line 0 as the whole file', () => {
    expect(outsideDelta([{ file: 'other.ts', line: 12 }], ranges)).toBe(true);
    expect(outsideDelta([{ file: 'other.ts', line: 0 }], ranges)).toBe(true);
    expect(outsideDelta([{ file: 'a.ts', line: 0 }], ranges)).toBe(false);
  });
  it('is null when there is nothing to compare: no ranges, or no site', () => {
    expect(outsideDelta([{ file: 'a.ts', line: 30 }], null)).toBeNull();
    expect(outsideDelta([], ranges)).toBeNull();
    expect(outsideDelta([{ file: 'a.ts', line: 30 }], [])).toBe(true);
  });
  it('joins the ranges of several seats', () => {
    expect(unionRanges([[{ file: 'a.ts', ranges: [[1, 2]] }], [{ file: 'a.ts', ranges: [[3, 4]] }, { file: 'b.ts', ranges: [[7, 7]] }]])).toEqual([
      { file: 'a.ts', ranges: [[1, 4]] },
      { file: 'b.ts', ranges: [[7, 7]] },
    ]);
    expect(unionRanges([])).toBeNull();
  });
});

describe('the resolved list of a round 2 answer', () => {
  const claude = (payload: unknown) => JSON.stringify({ type: 'result', is_error: false, structured_output: payload, usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0 });
  const finding = { severity: 'P1', title: 'A bug', body: 'It breaks.', sites: [{ file: 'src/a.ts', line: 3 }] };

  it('parses each entry alone and drops a bad one without failing the review', () => {
    const out = parseReviewerOutput(
      'claude-code',
      claude({
        findings: [finding],
        resolved: [
          { id: 'fnd_1', status: 'fixed', sites: [{ file: 'src/a.ts', line: 4 }] },
          { id: 'fnd_2', status: 'not_fixed', sites: [] },
          { id: 'fnd_3', status: 'maybe', sites: [] },
          { id: '', status: 'fixed', sites: [] },
          { status: 'fixed' },
          'x',
          { id: 'fnd_4', status: 'fixed', sites: [{ file: '/etc/passwd', line: 1 }, { file: '../x', line: 1 }, { file: 'ok.ts', line: 2 }] },
        ],
      }),
    );
    expect(out).toMatchObject({ ok: true, rejected: 0 });
    if (!out.ok) return;
    expect(out.findings).toHaveLength(1);
    expect(out.resolved).toEqual([
      { id: 'fnd_1', status: 'fixed', sites: [{ file: 'src/a.ts', line: 4 }] },
      { id: 'fnd_2', status: 'not_fixed', sites: [] },
      { id: 'fnd_4', status: 'fixed', sites: [{ file: 'ok.ts', line: 2 }] },
    ]);
  });

  it('treats a missing or malformed list as no list, for both runtimes', () => {
    for (const resolved of [undefined, null, 'x', 7, { id: 'fnd_1' }]) {
      const out = parseReviewerOutput('claude-code', claude({ findings: [finding], resolved }));
      expect(out).toMatchObject({ ok: true, resolved: [] });
    }
    const codex = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ findings: [], resolved: [{ id: 'fnd_9', status: 'fixed', sites: [] }] }) } });
    expect(parseReviewerOutput('codex', codex)).toMatchObject({ ok: true, resolved: [{ id: 'fnd_9', status: 'fixed', sites: [] }] });
  });

  it('caps the list', () => {
    const many = Array.from({ length: 400 }, (_, i) => ({ id: `fnd_${i}`, status: 'fixed', sites: [] }));
    const out = parseReviewerOutput('claude-code', claude({ findings: [], resolved: many }));
    expect(out.ok && out.resolved.length).toBe(300);
  });

  it('merges the seats: not_fixed when any seat says so, every seat and site kept', () => {
    const merged = mergeResolved([
      { seat: 'strong', resolved: [{ id: 'f1', status: 'fixed', sites: [{ file: 'a.ts', line: 1 }] }, { id: 'f2', status: 'fixed', sites: [] }] },
      { seat: 'cheap-claude', resolved: [{ id: 'f1', status: 'not_fixed', sites: [{ file: 'a.ts', line: 1 }, { file: 'b.ts', line: 2 }] }] },
    ]);
    expect(merged).toEqual([
      { id: 'f1', status: 'not_fixed', sites: [{ file: 'a.ts', line: 1 }, { file: 'b.ts', line: 2 }], fixed_by: ['strong'], not_fixed_by: ['cheap-claude'] },
      { id: 'f2', status: 'fixed', sites: [], fixed_by: ['strong'], not_fixed_by: [] },
    ]);
    expect(mergeResolved([])).toEqual([]);
  });
});

describe('the round 2 schema and prompt', () => {
  it('leaves round 1 as it was, makes resolved optional for Claude and a required key for Codex', () => {
    expect(reviewSchemaJson('claude-code', false)).toBe(REVIEW_SCHEMA_JSON);
    expect(reviewSchemaJson('codex', false)).toBe(REVIEW_SCHEMA_JSON);
    const claude = JSON.parse(reviewSchemaJson('claude-code', true));
    const codex = JSON.parse(reviewSchemaJson('codex', true));
    expect(claude.required).toEqual(['findings']);
    // Codex's structured output refuses a schema whose `required` leaves out a property.
    expect(codex.required).toEqual(['findings', 'resolved']);
    for (const s of [claude, codex]) {
      expect(Object.keys(s.properties)).toEqual(['findings', 'resolved']);
      expect(s.additionalProperties).toBe(false);
      const item = s.properties.resolved.items;
      expect(item.required).toEqual(Object.keys(item.properties));
      expect(item.properties.status.enum).toEqual(['fixed', 'not_fixed']);
      expect(item.properties.sites).toEqual(JSON.parse(REVIEW_SCHEMA_JSON).properties.findings.items.properties.sites);
    }
  });

  const ticket = { identifier: 'T-1', title: 't', description: 'd', criteria: 'c' };
  it('lists the previous findings by id, keeps the id when the list is cut, and asks for resolved only in round 2 and later', () => {
    const previous = [{ id: 'fnd_abc123', severity: 'P1', title: 'Crash on empty list', body: 'b', sites: [{ file: 'src/a.ts', line: 10 }] }];
    const p = buildReviewPrompt({ seat: 'strong', ticket, notes: null, previous });
    expect(p).toContain('1. [P1] Crash on empty list (src/a.ts:10)');
    expect(p).toContain('[id fnd_abc123]');
    expect(p).toContain('"resolved"');
    expect(p).toContain('"status": "fixed" or "not_fixed"');
    // The instruction not to report what the diff did not touch is unchanged.
    expect(p).toContain('Do not report problems the diff did not touch or cause');
    const first = buildReviewPrompt({ seat: 'strong', ticket, notes: null });
    expect(first).not.toContain('resolved');
    expect(first).toContain('Do not report problems the diff did not touch or cause');
    // A long list is cut to one line each; the id still ends every line.
    const long = Array.from({ length: 900 }, (_, i) => ({ id: `fnd_${String(i).padStart(6, '0')}`, severity: 'P2', title: `Title ${'x'.repeat(150)} ${i}`, body: 'y'.repeat(1200), sites: [{ file: 'src/a.ts', line: i }] }));
    const big = buildReviewPrompt({ seat: 'strong', ticket, notes: null, previous: long });
    for (const f of long) expect(big).toContain(`[id ${f.id}]`);
  });
});

describe('what the runner posts', () => {
  const r = { code: 0, signal: null, stdout: 'out', stderr: '', overflow: false, secs: 1 };
  const ranges = [{ file: 'a.ts', ranges: [[1, 2]] as [number, number][] }];
  it('adds the ranges to a successful report, and only then', () => {
    expect(reviewerReport(r, ranges)).toEqual({ code: 0, stdout: 'out', stderr: '', secs: 1, ranges });
    expect(reviewerReport(r)).not.toHaveProperty('ranges');
    expect(reviewerReport(r, null)).not.toHaveProperty('ranges');
    expect(reviewerReport({ ...r, code: 2 }, ranges)).not.toHaveProperty('ranges');
    expect(reviewerReport({ ...r, signal: 'SIGKILL' }, ranges)).not.toHaveProperty('ranges');
  });
  it('drops the ranges rather than make a valid answer too large to report', () => {
    const near = { ...r, stdout: 'x'.repeat(899_950) };
    expect(reviewerReport(near, ranges)).toMatchObject({ code: 0 });
    expect(reviewerReport(near, ranges)).not.toHaveProperty('ranges');
  });
});

describe('blocks', () => {
  it('reads only severity and triage: a location label cannot change it', () => {
    for (const severity of ['P0', 'P1', 'P2', 'P3']) {
      for (const triage of [null, 'valid', 'debatable', 'invalid']) {
        const plain = blocks({ severity, triage });
        for (const outside of [true, false, null]) expect(blocks({ severity, triage, outside_delta: outside } as { severity: string; triage: string | null }), `${severity} ${triage} ${outside}`).toBe(plain);
      }
    }
  });
});
