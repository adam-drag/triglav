import { test, expect, BASE, clientFetch, staffWithJob, cleanup } from './fixtures.ts';

const json = { 'content-type': 'application/json' };

test('a long thread is one screen that scrolls like a chat, opening on the newest message', async ({ page, consoleErrors: _, agents }) => {
  const { staff, parentId } = await staffWithJob('thread-scroll');
  agents.push(staff);
  try {
    const clientPost = (data: object) => clientFetch(`${BASE}/api/messages`, { method: 'POST', headers: json, body: JSON.stringify(data) });
    const first = await (await clientPost({ job_id: parentId, type: 'discussion', body: 'Message 1' })).json();
    const threadId = first.thread_id as string;
    // A Senior may not post more than a few times in a row, so the Client answers now and then.
    const post = async (i: number) =>
      i % 4 === 0
        ? clientPost({ thread_id: threadId, type: 'reply', stance: 'inform', body: `Message ${i}` })
        : staff.call('post_message', { thread_id: threadId, stance: 'inform', body: `Message ${i}: ${'a line of discussion. '.repeat(6)}` });
    for (let i = 2; i <= 40; i++) await post(i);

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`/#/threads/${threadId}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('message')).toHaveCount(40);

    const list = page.getByTestId('messages');
    const atBottom = () => list.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 40);
    // The page does not grow with the thread: only the list scrolls.
    expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(true);
    expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    // Opens on the newest message, with the reply form on the same screen.
    expect(await atBottom()).toBe(true);
    await expect(page.locator('[data-testid=message]', { hasText: 'Message 40' })).toBeInViewport();
    await expect(page.getByTestId('reply-form').getByRole('button', { name: 'Post reply' })).toBeInViewport();

    // At the bottom, a new message is followed.
    await post(41);
    await expect(page.locator('[data-testid=message]', { hasText: 'Message 41' })).toBeInViewport();
    await expect(page.getByTestId('jump-latest')).toHaveCount(0);

    // Reading older messages: a new one does not move the list, and a button offers the way back.
    await list.evaluate((el) => (el.scrollTop = 0));
    await expect(page.locator('[data-testid=message]', { hasText: 'Message 1' }).first()).toBeInViewport();
    await post(42);
    await expect(page.getByTestId('message')).toHaveCount(42);
    await expect(page.getByTestId('jump-latest')).toBeVisible();
    expect(await list.evaluate((el) => el.scrollTop)).toBe(0);
    await page.getByTestId('jump-latest').click();
    await expect(page.locator('[data-testid=message]', { hasText: 'Message 42' })).toBeInViewport();
    await expect(page.getByTestId('jump-latest')).toHaveCount(0);
  } finally {
    await cleanup(parentId);
  }
});
