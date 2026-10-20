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
    await page.goto('/#/board', { waitUntil: 'domcontentloaded' });
    const rows = page.getByTestId('board-row');
    await expect(rows).toHaveCount(25);
    await expect(rows.first()).toContainText('Board thread 30');
    await expect(rows.nth(1)).toContainText('Board thread 29');
    // The page is as long as one page of rows, not as long as the whole board.
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThan(2400);

    const pager = page.getByTestId('board-pager');
    await expect(pager).toContainText('Page 1 of');
    await expect(pager.getByRole('button', { name: 'Previous' })).toBeDisabled();
    const pages = Number(/of (\d+) ·/.exec((await page.getByTestId('board-range').textContent()) ?? '')?.[1]);
    expect(pages).toBeGreaterThanOrEqual(2);

    // The next page continues where the first one stopped, and the address says which page it is.
    await pager.getByRole('button', { name: 'Next' }).click();
    await expect(page).toHaveURL(/#\/board\/2$/);
    await expect(pager).toContainText('Page 2 of');
    await expect(rows.first()).toContainText('Board thread 5');
    await expect(pager.getByRole('button', { name: 'Previous' })).toBeEnabled();
    await pager.getByRole('button', { name: 'Previous' }).click();
    await expect(page).toHaveURL(/#\/board$/);
    await expect(rows.first()).toContainText('Board thread 30');

    // A page past the end shows the last one.
    await page.goto('/#/board/999', { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(new RegExp(`#/board/${pages}$`));
    await expect(pager.getByRole('button', { name: 'Next' })).toBeDisabled();
    await expect(rows.first()).toBeVisible();
  } finally {
    await cleanup(parentId);
  }
});
