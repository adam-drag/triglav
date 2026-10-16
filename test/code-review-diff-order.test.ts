import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { changedRanges } from '../src/review-ranges.ts';
import { diffForSeat, MAX_DIFF_CHARS, REPEAT_MEMBER, seededFileOrder, splitDiffFiles, worktreeDiff } from '../scripts/code-review-run.ts';
import { seatPrompt } from '../scripts/review-eval/run.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { PATH: process.env.PATH!, HOME: cwd, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
const env = { PATH: process.env.PATH!, HOME: tmpdir() };
const HEAD = 'a'.repeat(40);
const OTHER_HEAD = 'b'.repeat(40);

/** A hand-written diff of n files, each with two hunks, so a shuffle has something to move and something to keep. */
function manyFiles(n: number): string {
  let out = '';
  for (let i = 0; i < n; i += 1) {
    out += `diff --git a/src/f${i}.ts b/src/f${i}.ts\nindex 1111111..2222222 100644\n--- a/src/f${i}.ts\n+++ b/src/f${i}.ts\n`;
    out += `@@ -1,2 +1,2 @@\n context ${i}\n-old first ${i}\n+new first ${i}\n`;
    out += `@@ -20,2 +20,2 @@\n context late ${i}\n-old second ${i}\n+new second ${i}\n`;
  }
  return out;
}

const blocksOf = (diff: string) => splitDiffFiles(diff)!;
const names = (diff: string) => [...diff.matchAll(/^diff --git a\/(\S+) /gm)].map((m) => m[1]);

describe('the file order of a repeat member', () => {
  it('splits a diff into its file blocks so that they join to the same bytes', () => {
    const d = manyFiles(5);
    const blocks = blocksOf(d);
    expect(blocks).toHaveLength(5);
    expect(blocks.join('')).toBe(d);
    for (const b of blocks) expect(b.startsWith('diff --git ')).toBe(true);
  });

  it('gives the same order for the same seed and a different one for another seat', () => {
    const d = manyFiles(10);
    const a = seededFileOrder(d, `strong-2\n${HEAD}`);
    expect(seededFileOrder(d, `strong-2\n${HEAD}`)).toBe(a);
    expect(a).not.toBe(d);
    expect(seededFileOrder(d, `strong-3\n${HEAD}`)).not.toBe(a);
    expect(seededFileOrder(d, `strong-4\n${HEAD}`)).not.toBe(a);
    // The head sha is part of the seed.
    expect(seededFileOrder(d, `strong-2\n${OTHER_HEAD}`)).not.toBe(a);
  });

  it('keeps the content: the blocks of the output are a permutation of the blocks of the input, byte for byte', () => {
    const d = manyFiles(12);
    for (const seat of ['strong-2', 'strong-3', 'strong-4']) {
      const out = seededFileOrder(d, `${seat}\n${HEAD}`);
      expect(out.length).toBe(d.length);
      expect(blocksOf(out).sort()).toEqual(blocksOf(d).sort());
      expect([...names(out)].sort()).toEqual([...names(d)].sort());
    }
  });

  it('keeps the hunks of a file in their order', () => {
    const d = manyFiles(8);
    const out = seededFileOrder(d, `strong-2\n${HEAD}`);
    for (const b of blocksOf(out)) {
      expect(b.indexOf('@@ -1,2 +1,2 @@')).toBeLessThan(b.indexOf('@@ -20,2 +20,2 @@'));
      expect(b.match(/^@@ /gm)).toHaveLength(2);
    }
  });

  it('leaves a diff of one file, an empty diff and a diff it cannot split exactly as they are', () => {
    const one = manyFiles(1);
    expect(seededFileOrder(one, 'x')).toBe(one);
    expect(seededFileOrder('', 'x')).toBe('');
    const d = manyFiles(6);
    // No final newline: a block moved to the middle would run into the next header.
    expect(splitDiffFiles(d.slice(0, -1))).toBeNull();
    expect(seededFileOrder(d.slice(0, -1), 'x')).toBe(d.slice(0, -1));
    // A text before the first header, a hunk that is cut short, and a hunk line that does not fit its counts.
    expect(seededFileOrder(`preamble\n${d}`, 'x')).toBe(`preamble\n${d}`);
    const cut = d.replace(/\n\+new second 5\n$/, '\n');
    expect(splitDiffFiles(cut)).toBeNull();
    expect(seededFileOrder(cut, 'x')).toBe(cut);
    const extra = d.replace('@@ -1,2 +1,2 @@\n context 2\n', '@@ -1,2 +1,3 @@\n context 2\n');
    expect(splitDiffFiles(extra)).toBeNull();
    expect(seededFileOrder(extra, 'x')).toBe(extra);
    const badPrefix = d.replace(' context 3\n', '?context 3\n');
    expect(splitDiffFiles(badPrefix)).toBeNull();
  });

  it('does not split on a line of file content that looks like a header', () => {
    // The added file holds a diff itself: its lines are `+diff --git ...`, `+@@ -1,3 +1,3 @@` and so on.
    const inner = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n';
    const added = `diff --git a/doc.md b/doc.md\nnew file mode 100644\nindex 0000000..3333333\n--- /dev/null\n+++ b/doc.md\n@@ -0,0 +1,5 @@\n${inner.split('\n').filter(Boolean).map((l) => `+${l}`).join('\n')}\n+@@ -9,9 +9,9 @@ not a hunk\n`;
    const d = `${added}${manyFiles(4)}`;
    const blocks = blocksOf(d);
    expect(blocks).toHaveLength(5);
    expect(blocks[0]).toBe(added);
    // Whatever the order, the added file stays one block with its content.
    for (const seat of ['strong-2', 'strong-3', 'strong-4']) {
      const out = seededFileOrder(d, `${seat}\n${HEAD}`);
      expect(blocksOf(out)).toContain(added);
      expect(blocksOf(out).sort()).toEqual(blocksOf(d).sort());
    }
  });

  it('reads a context line whose space was removed, and a "no newline" marker, as part of the hunk', () => {
    const one = 'diff --git a/a.txt b/a.txt\nindex 1..2 100644\n--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,3 @@\n one\n\n-three\n\\ No newline at end of file\n+four\n\\ No newline at end of file\n';
    const d = `${one}${manyFiles(3)}`;
    expect(blocksOf(d)).toHaveLength(4);
    expect(blocksOf(d)[0]).toBe(one);
  });

  describe('on a diff that git made', () => {
    function repo() {
      const dir = mkdtempSync(join(tmpdir(), 'diff-order-'));
      git(dir, 'init', '-q', '-b', 'main');
      writeFileSync(join(dir, 'old-name.txt'), Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n') + '\n');
      writeFileSync(join(dir, 'gone.txt'), 'bye\n');
      writeFileSync(join(dir, 'tool.sh'), '#!/bin/sh\necho hi\n');
      writeFileSync(join(dir, 'bin.dat'), Buffer.from([0, 1, 2, 3, 0, 255]));
      writeFileSync(join(dir, 'multi.txt'), Array.from({ length: 60 }, (_, i) => `m${i}`).join('\n') + '\n');
      git(dir, 'add', '.');
      git(dir, 'commit', '-q', '-m', 'base');
      const base = git(dir, 'rev-parse', 'HEAD');
      renameSync(join(dir, 'old-name.txt'), join(dir, 'new-name.txt'));
      rmSync(join(dir, 'gone.txt'));
      chmodSync(join(dir, 'tool.sh'), 0o755);
      writeFileSync(join(dir, 'bin.dat'), Buffer.from([9, 8, 7, 0, 0, 1]));
      // Two hunks far apart, and the second edit removes the final newline.
      const m = Array.from({ length: 60 }, (_, i) => `m${i}`);
      m[2] = 'CHANGED start';
      m[55] = 'CHANGED end';
      writeFileSync(join(dir, 'multi.txt'), m.join('\n'));
      mkdirSync(join(dir, 'docs'));
      writeFileSync(join(dir, 'docs', 'sample.diff'), 'diff --git a/q b/q\n--- a/q\n+++ b/q\n@@ -1 +1 @@\n-a\n+b\n');
      writeFileSync(join(dir, 'zeta.txt'), 'z\n');
      git(dir, 'add', '-A');
      git(dir, 'commit', '-q', '-m', 'change');
      return { dir, base, head: git(dir, 'rev-parse', 'HEAD') };
    }

    it('keeps rename, mode and binary headers and the no-newline marker inside their blocks, and moves whole blocks only', async () => {
      const r = repo();
      const { diff, ranges } = await worktreeDiff({ cwd: r.dir, base: r.base, head: r.head, env });
      const blocks = blocksOf(diff);
      expect(blocks.length).toBe(7);
      expect(blocks.join('')).toBe(diff);
      expect(blocks.find((b) => b.includes('rename from old-name.txt'))).toContain('rename to new-name.txt');
      expect(blocks.find((b) => b.includes('Binary files'))).toContain('bin.dat');
      expect(blocks.find((b) => b.includes('old mode 100644'))).toContain('new mode 100755');
      expect(blocks.find((b) => b.includes('deleted file mode'))).toContain('gone.txt');
      expect(blocks.find((b) => b.includes('+diff --git a/q b/q'))).toContain('docs/sample.diff');
      expect(blocks.find((b) => b.includes('multi.txt'))!.match(/^@@ /gm)).toHaveLength(2);
      expect(blocks.find((b) => b.includes('multi.txt'))).toContain('\\ No newline at end of file');
      for (const seat of ['strong-2', 'strong-3', 'strong-4']) {
        const out = diffForSeat(diff, seat, r.head);
        expect(blocksOf(out).sort()).toEqual([...blocks].sort());
        // The changed lines are read from the same content: the ranges of the original diff hold for the reordered one.
        expect(changedRanges(out)).toEqual(ranges);
      }
      expect(diffForSeat(diff, 'strong', r.head)).toBe(diff);
    });

    it('does not change the size cap or the ranges: worktreeDiff returns the original diff', async () => {
      const r = repo();
      const a = await worktreeDiff({ cwd: r.dir, base: r.base, head: r.head, env });
      const b = await worktreeDiff({ cwd: r.dir, base: r.base, head: r.head, env });
      expect(b).toEqual(a);
      expect(a.diff.length).toBeLessThan(MAX_DIFF_CHARS);
      expect(a.ranges).toEqual(changedRanges(a.diff));
    });
  });
});

describe('which seats read their own order', () => {
  const d = manyFiles(10);

  it('is only strong-2 and later', () => {
    expect(REPEAT_MEMBER.test('strong')).toBe(false);
    for (const s of ['strong-2', 'strong-3', 'strong-4']) expect(REPEAT_MEMBER.test(s)).toBe(true);
    for (const s of ['strong-1', 'strong-0', 'strong-02', 'strong-', 'strong-2x', 'xstrong-2', 'cheap-claude', 'cheap-claude-2', 'cheap-codex-3', 'Strong-2', 'strong-2\n']) expect(REPEAT_MEMBER.test(s), s).toBe(false);
  });

  it('gives the strong seat, every cheap seat and a launch with no seat the diff as git printed it', () => {
    for (const s of ['strong', 'cheap-claude', 'cheap-codex', 'cheap-claude-2', 'cheap-codex-3']) expect(diffForSeat(d, s, HEAD), s).toBe(d);
    expect(diffForSeat(d, undefined, HEAD)).toBe(d);
  });

  it('reorders strong-2 and later, the same way every time', () => {
    const two = diffForSeat(d, 'strong-2', HEAD);
    expect(two).not.toBe(d);
    expect(diffForSeat(d, 'strong-2', HEAD)).toBe(two);
    expect(two).toBe(seededFileOrder(d, `strong-2\n${HEAD}`));
    expect(diffForSeat(d, 'strong-3', HEAD)).not.toBe(two);
    expect(diffForSeat(d, 'strong-2', OTHER_HEAD)).not.toBe(two);
  });

  it('refuses a seat or a head that is not what the server sends, before it reads anything', () => {
    for (const bad of [null, 2, {}, '', 'strong 2', 'strong-2; rm', '../strong-2', 'a'.repeat(41), 'STRONG-2', 'strong--2', 'strong-222']) expect(() => diffForSeat(d, bad, HEAD), String(bad)).toThrow(/bad seat name/);
    expect(() => diffForSeat(d, 'strong-2', 'abc')).toThrow(/bad head sha/);
  });

  it('is the order the evaluation harness sends to a seat, and only the order', () => {
    const fixture = { id: 'p1', pr: 1, base: 'c'.repeat(40), head: HEAD, title: 'T', notes: '', findings: [] } as never;
    const prompt = (seat: string) => seatPrompt(fixture, { seat, runtime: 'codex' }, d);
    expect(prompt('strong-2')).toContain(diffForSeat(d, 'strong-2', HEAD));
    expect(prompt('strong-2')).not.toContain(d);
    expect(prompt('strong')).toContain(d);
    expect(prompt('cheap-claude')).toContain(d);
  });

  it('is wired in the runner after the diff is read, and the launch seat is the only input', () => {
    const runner = readFileSync(join(import.meta.dirname, '..', 'scripts', 'runner.ts'), 'utf8');
    expect(runner).toMatch(/reviewPrompt\(l\.prompt, l\.base_sha!, l\.head_sha!, diffForSeat\(diff, l\.seat, l\.head_sha!\)\)/);
    expect(runner.indexOf('worktreeDiff({')).toBeLessThan(runner.indexOf('diffForSeat(diff'));
  });
});
