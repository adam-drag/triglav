import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clientQueue } from '../src/blockers.ts';
import { POLICY } from '../src/context.ts';
import { exec } from '../src/db.ts';
import { createTestCtx } from './helpers.ts';

describe('clientQueue attention', () => {
  let env: Awaited<ReturnType<typeof createTestCtx>>;
  beforeAll(async () => {
    env = await createTestCtx();
  });
  afterAll(async () => {
    await env.close();
  });

  it('gives an unavailable_owner blocker attention only after staffOfflineAttentionSec, and a client decision at once', async () => {
    const now = env.clock.now();
    await exec(
      env.ctx.pool,
      `INSERT INTO jobs (id, linear_issue_id, linear_identifier, linear_url, linear_snapshot, title, repo_path, base_branch, staff_agent_id, status, linear_fetched_at, created_at, updated_at)
       VALUES ('job_attn1', 'prompt:attn1', 'PRM-ATTN1', '', '{}', 't', '/repo', 'main', NULL, 'planning', ?, ?, ?)`,
      [now, now, now],
    );
    await exec(
      env.ctx.pool,
      `INSERT INTO blockers (id, job_id, kind, responsible, requested_decision, unblock_condition, raised_by, created_at)
       VALUES ('blk_attn_owner', 'job_attn1', 'unavailable_owner', 'client', 'Staff is offline.', 'Staff is back.', 'scheduler', ?),
              ('blk_attn_decision', 'job_attn1', 'client_decision', 'client', 'Which way?', 'The Client answers.', 'scheduler', ?)`,
      [now, now],
    );
    const attention = async (id: string) => Number((await clientQueue(env.ctx)).find((b) => b.id === id)?.attention);

    expect(await attention('blk_attn_owner')).toBe(0);
    expect(await attention('blk_attn_decision')).toBe(1);
    env.clock.advance(POLICY.staffOfflineAttentionSec - 1);
    expect(await attention('blk_attn_owner')).toBe(0);
    env.clock.advance(1);
    expect(await attention('blk_attn_owner')).toBe(1);
  });
});
