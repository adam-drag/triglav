import { test, expect, BASE, clientFetch, staffWithJob, cleanup } from './fixtures.ts';

const json = { 'content-type': 'application/json' };

test('the Board shows 25 threads a page, the newest first, and pages through the rest', async ({ page, consoleErrors: _, agents }) => {
  const { staff, parentId } = await staffWithJob('board-pages');
  agents.push(staff);
  try {
    // 30 threads, each with a message; the last one asked is the newest.
    for (let i = 1; i <= 30; i++) {
      const res = await clientFetch(`${BASE}/api/questions`, { method: 'POST', headers: json, body: JSON.stringify({ job_id: parentId, title: `Board thread ${i}`, question: `Question ${i}?`, window_sec: 300 }) });
      expect(res.ok, `question ${i}`).toBe(true);
    }
    // Other threads on this stack may also get a message while the test runs, so the pages are compared with what the API says.
    const board = async (offset: number) => (await (await clientFetch(`${BASE}/api/board?limit=25&offset=${offset}`)).json()) as { threads: { thread_id: string; title: string; last_message_at: string }[]; total: number; offset: number; limit: number };
    const first = await board(0);
    const second = await board(25);
    expect(first).toMatchObject({ offset: 0, limit: 25 });
    expect(first.threads).toHaveLength(25);
    expect(first.total).toBeGreaterThanOrEqual(30);
    expect(second.offset).toBe(25);
    const all = [...first.threads, ...second.threads];
    expect(new Set(all.map((t) => t.thread_id)).size, 'a thread is on one page only').toBe(all.length);
    expect(all.map((t) => t.last_message_at), 'newest message first').toEqual(all.map((t) => t.last_message_at).sort().reverse());

    await page.goto('/#/board', { waitUntil: 'domcontentloaded' });
    const rows = page.getByTestId('board-row');
    const shown = () => rows.locator('a[href^="#/threads/"]').evaluateAll((links) => links.map((a) => (a as HTMLAnchorElement).hash.replace('#/threads/', '')));
    await expect(rows).toHaveCount(25);
    expect(await shown()).toEqual(first.threads.map((t) => t.thread_id));
    // The page is as long as one page of rows, not as long as the whole board.
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThan(2400);

    const pager = page.getByTestId('board-pager');
    await expect(pager).toContainText('Page 1 of');
    await expect(pager.getByRole('button', { name: 'Previous' })).toBeDisabled();
    const pages = Number(/of (\d+) ·/.exec((await page.getByTestId('board-range').textContent()) ?? '')?.[1]);
    expect(pages).toBe(Math.ceil(first.total / 25));

    // The next page continues where the first one stopped, opens at the top, and the address says which page it is.
    // While page 2 loads, the pager and the rows still describe page 1 and the buttons wait.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await page.route('**/api/board?limit=25&offset=25', async (route) => {
      await gate;
      await route.continue();
    });
    await pager.getByRole('button', { name: 'Next' }).click();
    await expect(page).toHaveURL(/#\/board\/2$/);
    await expect(pager).toContainText('Page 1 of');
    await expect(pager.getByRole('button', { name: 'Next' })).toBeDisabled();
    await expect(pager.getByRole('button', { name: 'Previous' })).toBeDisabled();
    expect(await shown()).toEqual(first.threads.map((t) => t.thread_id));
    release();
    await expect(pager).toContainText('Page 2 of');
    await expect.poll(shown).toEqual(second.threads.map((t) => t.thread_id));
    expect(await page.evaluate(() => scrollY)).toBe(0);
    await expect(pager.getByRole('button', { name: 'Previous' })).toBeEnabled();
    await pager.getByRole('button', { name: 'Previous' }).click();
    await expect(page).toHaveURL(/#\/board$/);
    await expect.poll(shown).toEqual(first.threads.map((t) => t.thread_id));

    // A page past the end shows the last one.
    await page.goto('/#/board/999', { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(new RegExp(`#/board/${pages}$`));
    await expect(pager).toContainText(`Page ${pages} of ${pages}`);
    await expect(pager.getByRole('button', { name: 'Next' })).toBeDisabled();
    await expect(rows.first()).toBeVisible();
  } finally {
    await cleanup(parentId);
  }
});
