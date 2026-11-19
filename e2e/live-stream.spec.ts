import type { Request } from '@playwright/test';
import { cleanup, expect, openLive, SimAgent, staffWithJob, test } from './fixtures.ts';

// Eight tabs of one origin share one /api/stream connection (Web Locks leader, BroadcastChannel relay).
test('eight tabs share one stream, and the others keep updating when the stream tab closes', async ({ page, consoleErrors, agents }) => {
  const { staff, parentId } = await staffWithJob('live-stream');
  agents.push(staff);
  try {
    const job = await staff.call('get_job', { job_id: parentId });
    const general = job.threads.find((t: { title: string }) => t.title === 'General');

    const context = page.context();
    const streams: Request[] = [];
    context.on('request', (r) => {
      if (new URL(r.url()).pathname === '/api/stream') streams.push(r);
    });
    const others = await Promise.all(Array.from({ length: 7 }, () => context.newPage()));
    for (const p of others) {
      p.on('pageerror', (e) => consoleErrors.push(e.message));
      p.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
    }
    const tabs = [page, ...others];
    try {
      await Promise.all(tabs.map((p) => openLive(p, `threads/${general.id}`)));
      // Every tab is live, and only one of them opened the stream.
      for (const p of tabs) await expect(p.getByTestId('live-status')).toHaveAttribute('data-connected', 'true');
      expect(streams).toHaveLength(1);

      // The tab that opened the stream is the leader. Closing it hands the stream to another tab.
      const leader = streams[0]!.frame().page();
      await leader.close();
      const remaining = tabs.filter((p) => p !== leader);
      await expect.poll(() => streams.length).toBe(2);
      for (const p of remaining) await expect(p.getByTestId('live-status')).toHaveAttribute('data-connected', 'true');

      // A server event reaches every remaining tab, and each one shows it without a reload.
      const marker = `live-stream marker ${Date.now()}`;
      await staff.call('post_message', { job_id: parentId, thread_id: general.id, type: 'discussion', body: marker });
      for (const p of remaining) await expect(p.getByText(marker).first()).toBeVisible();
      expect(streams).toHaveLength(2);
    } finally {
      for (const p of tabs) await p.close().catch(() => {});
    }
  } finally {
    await cleanup(parentId);
  }
});
