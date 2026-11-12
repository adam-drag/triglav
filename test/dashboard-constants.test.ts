import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { JOB_STATUSES } from '../src/jobs.ts';

describe('dashboard copies of server constants', () => {
  // The web build stage does not copy src/jobs.ts, so App.tsx cannot import JOB_STATUSES: the test reads the source text.
  it('STATUS_ORDER in App.tsx lists the job statuses in the order of JOB_STATUSES', () => {
    const app = readFileSync(new URL('../web/src/App.tsx', import.meta.url), 'utf8');
    const m = app.match(/^const STATUS_ORDER = \[([^\]]*)\];$/m);
    expect(m, 'STATUS_ORDER is a one-line array literal in App.tsx').not.toBeNull();
    const order = [...m![1]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
    expect(order).toEqual([...JOB_STATUSES]);
  });
});
