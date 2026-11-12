import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BLOCKER_KINDS } from '../src/blockers.ts';
import { POLICY } from '../src/context.ts';

const card = (name: string) => readFileSync(join(import.meta.dirname, '../src/guide', name), 'utf8');

describe('guide cards agree with the server limits they state', () => {
  it('common.md: the message limit and the server cap', () => {
    const common = card('common.md');
    expect(common).toContain('Keep to 3 messages per thread unless someone mentions you.');
    expect(common).toContain(`your last ${POLICY.maxRepliesPerThread} messages in the thread are all yours`);
  });

  it('senior.md and deliver.md: the lease lasts 30 minutes and both renewal gaps stay inside it', () => {
    expect(POLICY.leaseSec).toBe(30 * 60);
    expect(card('senior.md')).toContain(`at least every 20 minutes during long work. It renews your lease, which lasts ${POLICY.leaseSec / 60} minutes.`);
    const deliver = card('deliver.md');
    expect(deliver).toContain('at least every 5 minutes while you wait');
    expect(deliver).toContain(`the lease lasts ${POLICY.leaseSec / 60}`);
  });

  it('senior.md points at the delivery loop section that deliver.md starts', () => {
    expect(card('senior.md')).toContain('"Delivery loop: Copilot review in at most 3 rounds" section that comes after this card');
    expect(card('senior.md')).not.toContain('at the end of this card');
    expect(card('deliver.md')).toContain('## Delivery loop: Copilot review in at most 3 rounds');
  });

  it('staff.md names the two blockers the server raises itself, and what Staff does', () => {
    const staff = card('staff.md');
    expect(BLOCKER_KINDS).toContain('no_convergence');
    expect(staff).toContain('`no_convergence` from `record_verdict`');
    expect(staff).toContain(`\`failed_execution\` from the scheduler: one assignment lost its lease ${POLICY.maxFailedAttempts} times`);
    expect(staff).toContain(`review round ${POLICY.maxReviewRounds} (\`maxReviewRounds\`)`);
    expect(staff).toContain('`resolve_blocker` refuses you');
  });

  it('researcher.md: a run is codex exec or claude -p', () => {
    expect(card('researcher.md')).toContain('`codex exec`, or as `claude -p` when it found no Codex');
  });
});
