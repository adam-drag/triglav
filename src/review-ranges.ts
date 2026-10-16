/**
 * The lines a code review's diff changed, per file (new side), and the label the server derives from them.
 *
 * The runner computes the ranges from the diff it already builds (`changedRanges`), posts them next to the reviewer's
 * output, and the server validates them again (`parseRanges`) before it compares them with the sites of a finding
 * (`outsideDelta`). No dependency on the database, so the runner can import it.
 *
 * `outside_delta` is a location label only. A defect that a changed caller causes can be reported at an unchanged callee, so
 * a site outside the ranges does not show that the defect was there before. Nothing here says "previously missed" and
 * nothing here touches `blocks()`.
 */

/** First and last changed line (1-based, both included) of one stretch of the new side. */
export type Range = [number, number];
export interface FileRanges {
  file: string;
  ranges: Range[];
}

/** More than these and the whole field is dropped: a part of the ranges would label a site "outside" by mistake. */
export const MAX_RANGE_FILES = 1000;
export const MAX_RANGES_PER_FILE = 500;
export const MAX_RANGE_PATH = 300;
export const MAX_RANGES_BYTES = 200_000;
const MAX_LINE = 10_000_000;

/** Sorts and joins ranges that overlap or touch. */
function joined(ranges: Range[]): Range[] {
  const out: Range[] = [];
  for (const [s, e] of [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
    const last = out[out.length - 1];
    if (last && s <= last[1] + 1) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

/** git's C-style quoting of a path ("a\tb", "\303\251"): the bytes between the quotes, decoded as UTF-8. Null when malformed. */
function unquote(text: string): string | null {
  if (text.length < 2 || !text.startsWith('"') || !text.endsWith('"')) return null;
  const bytes: number[] = [];
  const simple: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };
  const body = text.slice(1, -1);
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i]!;
    if (c !== '\\') {
      bytes.push(...Buffer.from(c, 'utf8'));
      continue;
    }
    const next = body[i + 1];
    if (next === undefined) return null;
    if (/[0-7]/.test(next)) {
      const oct = /^[0-7]{1,3}/.exec(body.slice(i + 1))![0];
      bytes.push(parseInt(oct, 8) & 0xff);
      i += oct.length;
    } else if (next in simple) {
      bytes.push(simple[next]!);
      i += 1;
    } else return null;
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * The file named by a `+++ ` line: `undefined` when it cannot be read (the whole result is then dropped), `null` for
 * `/dev/null` (a deleted file has no new side), else the path without the `b/` prefix. The runner passes
 * `--dst-prefix=b/`, so the prefix is always there. git adds a tab after a path that has a space.
 */
function newPath(rest: string): string | null | undefined {
  if (rest === '/dev/null') return null;
  const raw = rest.startsWith('"') ? unquote(rest.replace(/\t$/, '')) : rest.replace(/\t$/, '');
  if (raw === null || !raw.startsWith('b/') || raw.length <= 2) return undefined;
  return raw.slice(2);
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * The changed lines of the new side, per file, read from a unified diff made with `--src-prefix=a/ --dst-prefix=b/`.
 * An added or changed line is a range of its own. A stretch of removed lines with nothing added in its place marks the line
 * before and the line after the removal, because a finding about removed code is reported at its neighbours. A file with no
 * new side (deleted) or no hunk (binary, mode change, pure rename) has no range. Hunks are read by their line counts, so
 * a line of file content that looks like a header is never taken for one.
 *
 * Returns null when the diff cannot be read exactly or the result is over the caps: no ranges at all, never a part of them.
 */
export function changedRanges(diff: string): FileRanges[] | null {
  const files = new Map<string, Range[]>();
  const lines = diff.split('\n');
  let file: string | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      file = null;
      continue;
    }
    if (l.startsWith('+++ ')) {
      const p = newPath(l.slice(4));
      if (p === undefined) return null;
      file = p;
      continue;
    }
    const h = HUNK.exec(l);
    if (!h) continue;
    let oldLeft = h[2] === undefined ? 1 : Number(h[2]);
    let newLeft = h[4] === undefined ? 1 : Number(h[4]);
    const newStart = Number(h[3]);
    // A hunk with no lines on the new side names the line before the removal as its start.
    let n = newLeft === 0 ? newStart + 1 : newStart;
    const add = (s: number, e: number) => {
      if (file === null) return;
      const list = files.get(file) ?? [];
      list.push([Math.max(s, 1), Math.max(e, 1)]);
      files.set(file, list);
    };
    let removing = false;
    const flush = (next: string | undefined) => {
      if (removing && next !== '+') add(n - 1, n);
      removing = false;
    };
    while (oldLeft > 0 || newLeft > 0) {
      i += 1;
      const body = lines[i];
      if (body === undefined) return null;
      const c = body[0];
      if (c === '\\') continue;
      if (c === '-') {
        removing = true;
        oldLeft -= 1;
        continue;
      }
      flush(c);
      if (c === '+') {
        add(n, n);
        n += 1;
        newLeft -= 1;
      } else {
        // A context line; an empty line is a context line whose space an editor removed.
        n += 1;
        oldLeft -= 1;
        newLeft -= 1;
      }
    }
    flush(undefined);
  }
  const out: FileRanges[] = [];
  for (const [f, list] of [...files].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    const ranges = joined(list);
    if (f.length > MAX_RANGE_PATH || ranges.length > MAX_RANGES_PER_FILE) return null;
    out.push({ file: f, ranges });
  }
  if (out.length > MAX_RANGE_FILES || JSON.stringify(out).length > MAX_RANGES_BYTES) return null;
  return out;
}

/**
 * Checks a `ranges` value that arrived from the runner and returns it joined and sorted, or null. All or nothing: one bad
 * entry, or any cap exceeded, drops the whole field, because a part of the ranges would label a site outside by mistake.
 */
export function parseRanges(value: unknown): FileRanges[] | null {
  if (!Array.isArray(value) || value.length > MAX_RANGE_FILES) return null;
  const byFile = new Map<string, Range[]>();
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const { file, ranges } = item as { file?: unknown; ranges?: unknown };
    if (typeof file !== 'string' || !file || file.length > MAX_RANGE_PATH || file.startsWith('/') || file.includes('\0') || /(^|\/)\.\.(\/|$)/.test(file)) return null;
    if (!Array.isArray(ranges) || ranges.length > MAX_RANGES_PER_FILE) return null;
    const list = byFile.get(file) ?? [];
    for (const r of ranges) {
      if (!Array.isArray(r) || r.length !== 2) return null;
      const [s, e] = r as unknown[];
      if (!Number.isInteger(s) || !Number.isInteger(e) || (s as number) < 1 || (e as number) < (s as number) || (e as number) > MAX_LINE) return null;
      list.push([s as number, e as number]);
    }
    byFile.set(file, list);
  }
  const out: FileRanges[] = [];
  for (const [file, list] of [...byFile].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    const ranges = joined(list);
    if (ranges.length > MAX_RANGES_PER_FILE) return null;
    out.push({ file, ranges });
  }
  return out;
}

/** The ranges of several seats of one review, joined (the seats of a review run on the same diff, so they normally agree). */
export function unionRanges(all: FileRanges[][]): FileRanges[] | null {
  if (!all.length) return null;
  const byFile = new Map<string, Range[]>();
  for (const one of all) for (const f of one) byFile.set(f.file, [...(byFile.get(f.file) ?? []), ...f.ranges]);
  return [...byFile].map(([file, list]) => ({ file, ranges: joined(list) }));
}

/**
 * Whether a finding lies outside the changed lines: true when none of its sites is in a changed range, false when one is,
 * null when there is nothing to compare (no ranges, or the finding has no site). A site on a file the diff did not touch is
 * outside. A site at line 0 means "somewhere in the file" and counts as inside when the file has any changed line.
 */
export function outsideDelta(sites: { file: string; line: number }[], ranges: FileRanges[] | null): boolean | null {
  if (!ranges || !sites.length) return null;
  const byFile = new Map(ranges.map((f) => [f.file, f.ranges] as const));
  const inside = sites.some((s) => {
    const list = byFile.get(s.file);
    return !!list && (s.line === 0 || list.some(([a, b]) => s.line >= a && s.line <= b));
  });
  return !inside;
}
