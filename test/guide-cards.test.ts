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

  it('senior.md and deliver.md: the same two intervals, both inside the 30 minute lease', () => {
    expect(POLICY.leaseSec).toBe(30 * 60);
    const lease = `It renews your lease, which lasts ${POLICY.leaseSec / 60} minutes.`;
    // Senior card: 20 minutes in general, 5 while waiting for CI or Copilot. Delivery card: the 5 minute rule only.
    expect(card('senior.md')).toContain(`at least every 20 minutes during long work, and every 5 minutes while you wait for CI or for a Copilot review (see the delivery loop). ${lease}`);
    expect(card('deliver.md')).toContain(`call \`report_progress\` at least every 5 minutes while you wait (the Senior card says the same). It renews your lease, which lasts ${POLICY.leaseSec / 60} minutes,`);
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
    expect(card('researcher.md')).toContain("in the persona's runtime, as `codex exec` or as `claude -p`");
  });
});
