import type { BrowserContext, Page, Request } from '@playwright/test';
import { cleanup, expect, openLive, SimAgent, staffWithJob, test } from './fixtures.ts';
import { PASSWORD } from './sim.ts';

/** Records every request for /api/stream made in the context. */
function watchStreams(context: BrowserContext): Request[] {
  const streams: Request[] = [];
  context.on('request', (r) => {
    if (new URL(r.url()).pathname === '/api/stream') streams.push(r);
  });
  return streams;
}

/** Sends the errors of a tab that is not the test's own page to the same list the fixture checks. */
function watchErrors(p: Page, errors: string[]) {
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
}

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

// A tab opened while the stream is already live learns from the leader that it is connected.
test('a tab opened while the stream is live shows it connected, with one stream', async ({ page, consoleErrors }) => {
  const streams = watchStreams(page.context());
  await openLive(page, 'jobs');
  const late = await page.context().newPage();
  watchErrors(late, consoleErrors);
  try {
    await openLive(late, 'jobs');
    expect(streams).toHaveLength(1);
  } finally {
    await late.close();
  }
});

// Without Web Locks every tab keeps its own stream, and each one stays live.
test('without Web Locks each tab opens its own stream and stays live', async ({ page, consoleErrors, agents }) => {
  await page.context().addInitScript(() => {
    delete (Navigator.prototype as unknown as { locks?: unknown }).locks;
  });
  const { staff, parentId } = await staffWithJob('live-stream-fallback');
  agents.push(staff);
  const streams = watchStreams(page.context());
  const other = await page.context().newPage();
  watchErrors(other, consoleErrors);
  try {
    const job = await staff.call('get_job', { job_id: parentId });
    const general = job.threads.find((t: { title: string }) => t.title === 'General');
    await openLive(page, `threads/${general.id}`);
    await openLive(other, `threads/${general.id}`);
    for (const p of [page, other]) expect(await p.evaluate(() => 'locks' in navigator)).toBe(false);
    expect(streams).toHaveLength(2);

    const marker = `live-stream fallback ${Date.now()}`;
    await staff.call('post_message', { job_id: parentId, thread_id: general.id, type: 'discussion', body: marker });
    for (const p of [page, other]) await expect(p.getByText(marker).first()).toBeVisible();
    expect(streams).toHaveLength(2);
  } finally {
    await other.close();
    await cleanup(parentId);
  }
});

// The server refuses the leader's first stream (a 503), which the browser closes for good. The leader opens a new one,
// and the other tab comes back with it.
test('a leader whose stream is refused opens a new one, and the other tab comes back', async ({ page, consoleErrors, agents }) => {
  const { staff, parentId } = await staffWithJob('live-stream-refused');
  agents.push(staff);
  const streams = watchStreams(page.context());
  const other = await page.context().newPage();
  watchErrors(other, consoleErrors);
  try {
    const job = await staff.call('get_job', { job_id: parentId });
    const general = job.threads.find((t: { title: string }) => t.title === 'General');

    let requests = 0;
    await page.route('**/api/stream', async (route) => {
      if (requests++ === 0) {
        await route.fulfill({ status: 503, contentType: 'text/plain', body: 'refused by the e2e test' });
        return;
      }
      await route.continue();
    });
    await page.goto(`/#/threads/${general.id}`, { waitUntil: 'domcontentloaded' });
    await expect.poll(() => streams.length).toBe(1);
    await openLive(other, `threads/${general.id}`);
    await expect(page.getByTestId('live-status')).toHaveAttribute('data-connected', 'true');
    await expect.poll(() => streams.length).toBe(2);

    const marker = `live-stream refused ${Date.now()}`;
    await staff.call('post_message', { job_id: parentId, thread_id: general.id, type: 'discussion', body: marker });
    for (const p of [page, other]) await expect(p.getByText(marker).first()).toBeVisible();
    expect(streams).toHaveLength(2);

    // The refused stream is the one error this test expects; the fixture checks the list for any other.
    const refused = consoleErrors.filter((e) => e.includes('503'));
    expect(refused).toHaveLength(1);
    consoleErrors.splice(0, consoleErrors.length, ...consoleErrors.filter((e) => !e.includes('503')));
  } finally {
    await other.close();
    await cleanup(parentId);
  }
});

// Logging out unmounts the dashboard, and its hook releases the stream lock. Logging in again then opens a new stream,
// which it could not do while the lock of the unmounted hook stayed held.
test('logging out closes the stream and the channel and releases the lock, and logging in again opens a new stream', async ({ page }) => {
  // Counts the EventSources and BroadcastChannels that the page's own code has not closed. A stream that the server or the
  // browser ended, but the page never closed, still counts: its close() never ran, so the wrapper still holds it.
  await page.context().addInitScript(() => {
    const streams = new Set<EventSource>();
    const channels = new Set<BroadcastChannel>();
    const Stream = window.EventSource;
    window.EventSource = class extends Stream {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(url, init);
        streams.add(this);
      }
      close() {
        streams.delete(this);
        super.close();
      }
    } as typeof EventSource;
    const Channel = window.BroadcastChannel;
    window.BroadcastChannel = class extends Channel {
      constructor(name: string) {
        super(name);
        channels.add(this);
      }
      close() {
        channels.delete(this);
        super.close();
      }
    } as typeof BroadcastChannel;
    Object.assign(window, {
      openCounts: () => ({ streams: streams.size, channels: channels.size }),
    });
  });
  const streams = watchStreams(page.context());
  await openLive(page, 'jobs');
  const held = () => page.evaluate(async () => ((await navigator.locks.query()).held ?? []).map((l) => l.name));
  const counts = () => page.evaluate(() => (window as unknown as { openCounts: () => { streams: number; channels: number } }).openCounts());
  expect(await held()).toContain('triglav-live-stream');
  expect(await counts()).toEqual({ streams: 1, channels: 1 });

  await page.getByTestId('logout').click();
  await expect(page.getByTestId('login')).toBeVisible();
  await expect.poll(held).not.toContain('triglav-live-stream');
  await expect.poll(counts).toEqual({ streams: 0, channels: 0 });

  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('live-status')).toHaveAttribute('data-connected', 'true');
  expect(await held()).toContain('triglav-live-stream');
  expect(await counts()).toEqual({ streams: 1, channels: 1 });
  expect(streams).toHaveLength(2);
});
