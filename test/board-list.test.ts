import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authenticate, registerAgent } from '../src/agents.ts';
import { countBoard, listBoard, postMessage } from '../src/board.ts';
import { generalThreadId, registerJob, updateJob } from '../src/jobs.ts';
import { createTestCtx, issue, TEST_DB_URL } from './helpers.ts';

// The board the dashboard pages through: newest message first, a stable order, and the total.
describe.skipIf(!TEST_DB_URL)('board listing', () => {
  let env: Awaited<ReturnType<typeof createTestCtx>>;

  beforeAll(async () => {
    env = await createTestCtx();
  });
  afterAll(async () => {
    await env?.close();
  });

  it('pages the threads that have a message, the newest message first, and counts them', async () => {
    const reg = await registerAgent(env.ctx, { role: 'staff', nickname: 'staff-board', runtime: 'test' });
    const staff = await authenticate(env.ctx, reg.session_token);
    const threads: string[] = [];
    for (let i = 1; i <= 5; i++) {
      const parent = issue(`BRD-${i}`, `Board job ${i}`);
      env.linear.add(parent as any);
      const job = await registerJob(env.ctx, staff, { linearIssue: parent.identifier, repoPath: '/repo', baseBranch: 'main' });
      await updateJob(env.ctx, staff, { jobId: job.job_id, status: 'planning' });
      threads.push(await generalThreadId(env.ctx.pool, job.job_id));
    }
    // The fifth job's thread stays silent; the others get a message each, oldest first.
    for (const threadId of threads.slice(0, 4)) {
      env.clock.advance(10);
      await postMessage(env.ctx, { kind: 'client' }, { threadId, type: 'discussion', body: `Hello on ${threadId}` });
    }
    // An older thread that gets a new message moves to the top.
    env.clock.advance(10);
    await postMessage(env.ctx, { kind: 'client' }, { threadId: threads[0]!, type: 'discussion', body: 'Back again' });

    const newestFirst = [threads[0], threads[3], threads[2], threads[1]];
    expect(await countBoard(env.ctx.pool, {})).toBe(4);
    expect((await listBoard(env.ctx.pool, {})).map((r) => r.thread_id)).toEqual(newestFirst);
    expect((await listBoard(env.ctx.pool, { limit: 2 })).map((r) => r.thread_id)).toEqual(newestFirst.slice(0, 2));
    expect((await listBoard(env.ctx.pool, { limit: 2, offset: 2 })).map((r) => r.thread_id)).toEqual(newestFirst.slice(2));
    expect(await listBoard(env.ctx.pool, { limit: 2, offset: 4 })).toEqual([]);
    expect(await countBoard(env.ctx.pool, { jobId: undefined, openQuestionsOnly: true })).toBe(0);
  });
});
