import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runningFork } from '../scripts/forks.ts';

const A = '11111111-1111-4111-8111-111111111111'; // the session Triglav would resume
const B = '22222222-2222-4222-8222-222222222222'; // a fork of it, continued after a usage limit
const C = '33333333-3333-4333-8333-333333333333'; // another Staff in the same repository

describe('runningFork', () => {
  const home = mkdtempSync(join(tmpdir(), 'forks-'));
  const cwd = '/work/repo';
  const dir = join(home, '.claude', 'projects', '-work-repo');
  mkdirSync(dir, { recursive: true });
  const transcript = (id: string, firstUser: string) =>
    writeFileSync(join(dir, `${id}.jsonl`), [JSON.stringify({ type: 'queue-operation' }), JSON.stringify({ type: 'user', uuid: firstUser }), ''].join('\n'));
  transcript(A, 'lineage-1');
  transcript(B, 'lineage-1');
  transcript(C, 'lineage-2');

  it('finds a live, busy fork of the same session and nothing else', () => {
    expect(runningFork(home, A, cwd, () => [{ sessionId: B, kind: 'background', pid: 1, status: 'busy' }])).toBe(B);
    expect(runningFork(home, A, cwd, () => [{ sessionId: B, kind: 'background', status: 'busy' }])).toBeNull(); // no pid: not running
    expect(runningFork(home, A, cwd, () => [{ sessionId: B, kind: 'background', pid: 1, status: 'idle' }])).toBeNull(); // ended its turn
    expect(runningFork(home, A, cwd, () => [{ sessionId: C, kind: 'background', pid: 1, status: 'busy' }])).toBeNull(); // another Staff
    expect(
      runningFork(home, A, cwd, () => {
        throw new Error('no claude');
      }),
    ).toBeNull();
  });
});
