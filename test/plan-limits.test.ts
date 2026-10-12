import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { planLimits, recordClaudeUsage } from '../src/telemetry.ts';
import { createTestCtx, TEST_DB_URL } from './helpers.ts';

// Runs against a real MySQL: set ORCH_TEST_DATABASE_URL (see README). Skipped otherwise.
describe.skipIf(!TEST_DB_URL)('plan limits', () => {
  let env: Awaited<ReturnType<typeof createTestCtx>>;
  beforeAll(async () => {
    env = await createTestCtx();
  });
  afterAll(async () => {
    await env?.close();
  });

  it('keeps the newest reading per window and shows a passed reset as reset', async () => {
    const now = env.clock.now();
    const later = new Date(now.getTime() + 3 * 3600_000);
    await recordClaudeUsage(env.ctx.pool, { window: 'five_hour', used: 24, resetsAt: later, at: now, source: 'statusline' });
    await recordClaudeUsage(env.ctx.pool, { window: 'five_hour', used: 10, resetsAt: later, at: new Date(now.getTime() - 60_000), source: 'statusline' });
    let five = (await planLimits(env.ctx.pool, now)).claude.find((r) => r.window === 'five_hour');
    expect(five).toMatchObject({ used: 24, reset: false });
    five = (await planLimits(env.ctx.pool, new Date(later.getTime() + 1000))).claude.find((r) => r.window === 'five_hour');
    expect(five).toMatchObject({ used: 0, reset: true, resets_at: null });
  });
});
