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
    // Opens on the newest message, with the reply form on the same screen. The scroll runs after the render, so poll.
    await expect.poll(atBottom).toBe(true);
    await expect(page.locator('[data-testid=message]', { hasText: 'Message 40' })).toBeInViewport();
    await expect(page.getByTestId('reply-form').getByRole('button', { name: 'Post reply' })).toBeInViewport();

    // At the bottom, a new message is followed.
    await post(41);
    await expect(page.locator('[data-testid=message]', { hasText: 'Message 41' })).toBeInViewport();
    await expect(page.getByTestId('jump-latest')).toHaveCount(0);

    // A decision shrinks the list without a new message: the newest one stays in view.
    await staff.call('record_decision', { thread_id: threadId, body: 'Go on.', rationale: 'Enough said.', considered_message_ids: [] });
    await expect(page.getByTestId('decision')).toBeVisible();
    await expect(page.locator('[data-testid=message]', { hasText: 'Message 41' })).toBeInViewport();

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

    // The Client's own reply comes into view even after reading older messages.
    await list.evaluate((el) => (el.scrollTop = 0));
    await page.getByTestId('reply-form').getByPlaceholder('Message').fill('Thanks, going ahead.');
    await page.getByRole('button', { name: 'Post reply' }).click();
    await expect(page.locator('[data-testid=message]', { hasText: 'Thanks, going ahead.' })).toBeInViewport();
  } finally {
    await cleanup(parentId);
  }
});

/** A thread of `n` messages between the Client and a Staff agent. */
async function seedThread(n: number, label: string) {
  const { staff, parentId } = await staffWithJob(label);
  const clientPost = (data: object) => clientFetch(`${BASE}/api/messages`, { method: 'POST', headers: json, body: JSON.stringify(data) });
  const first = await (await clientPost({ job_id: parentId, type: 'discussion', body: 'Message 1' })).json();
  const threadId = first.thread_id as string;
  for (let i = 2; i <= n; i++) {
    if (i % 4 === 0) await clientPost({ thread_id: threadId, type: 'reply', stance: 'inform', body: `Message ${i}` });
    else await staff.call('post_message', { thread_id: threadId, stance: 'inform', body: `Message ${i}: ${'a line of discussion. '.repeat(6)}` });
  }
  return { staff, parentId, threadId, clientPost };
}

test('the thread fits a narrow window with a wrapped header and a short window', async ({ page, consoleErrors: _, agents }) => {
  const { staff, parentId, threadId } = await seedThread(24, 'thread-sizes');
  agents.push(staff);
  try {
    const noPageScroll = () => page.evaluate(() => document.documentElement.scrollHeight <= innerHeight);
    // At 800 px and below the header wraps onto several rows; the thread still takes only the rest of the window.
    await page.setViewportSize({ width: 390, height: 700 });
    await page.goto(`/#/threads/${threadId}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('message')).toHaveCount(24);
    // Failed job starts left by other specs show a banner above the page; this check is about the header alone.
    await page.evaluate(() => document.querySelectorAll<HTMLElement>('.start-problems').forEach((el) => (el.style.display = 'none')));
    expect(await noPageScroll()).toBe(true);
    await expect(page.locator('[data-testid=message]', { hasText: 'Message 24' })).toBeInViewport();
    await expect(page.getByTestId('reply-form').getByRole('button', { name: 'Post reply' })).toBeInViewport();

    // A window too short for the whole page scrolls inside main, never the page, so the header stays.
    await page.setViewportSize({ width: 1280, height: 420 });
    await expect.poll(noPageScroll).toBe(true);
    await expect(page.locator('header')).toBeInViewport();
  } finally {
    await cleanup(parentId);
  }
});

test('a refresh with several new messages or after a failed fetch keeps the thread usable', async ({ page, consoleErrors, agents }) => {
  const { staff, parentId, threadId, clientPost } = await seedThread(30, 'thread-refresh');
  agents.push(staff);
  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`/#/threads/${threadId}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('message')).toHaveCount(30);
    const list = page.getByTestId('messages');
    const msg = (text: string) => page.locator('[data-testid=message]', { hasText: text });

    // The Client's reply and an agent message arrive in one refresh while the Client reads older messages.
    await expect.poll(() => list.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 40)).toBe(true);
    await list.evaluate((el) => (el.scrollTop = 0));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await page.route(`**/api/threads/${threadId}`, async (route) => {
      await gate;
      await route.continue();
    });
    await clientPost({ thread_id: threadId, type: 'reply', stance: 'inform', body: 'Client says hello' });
    await staff.call('post_message', { thread_id: threadId, stance: 'inform', body: 'Staff answers hello' });
    release();
    await expect(page.getByTestId('message')).toHaveCount(32);
    await expect(msg('Client says hello')).toBeInViewport();
    await page.unroute(`**/api/threads/${threadId}`);

    // A failed refresh shows the error above the list and keeps it. The next one that works leaves the list on the newest message.
    await page.route(`**/api/threads/${threadId}`, (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: 'refresh failed' }) }));
    await staff.call('post_message', { thread_id: threadId, stance: 'inform', body: 'Staff adds a note' });
    await expect(page.locator('.thread-page .error')).toBeVisible();
    await expect(page.getByTestId('message')).toHaveCount(32);
    await page.unroute(`**/api/threads/${threadId}`);
    // The browser logs each failed request as a console error; these were made on purpose.
    expect(consoleErrors.every((e) => e.startsWith('Failed to load resource'))).toBe(true);
    consoleErrors.length = 0;
    // Any event refreshes the page; a job update adds no message to this thread, so the same messages come back.
    const refreshed = page.waitForResponse((r) => r.url().endsWith(`/api/threads/${threadId}`) && r.ok());
    await staff.call('update_job', { job_id: parentId, acceptance_criteria: 'Export works, has tests and a thread to discuss it' });
    await refreshed;
    await expect(page.locator('.thread-page .error')).toHaveCount(0);
    await expect(page.getByTestId('message')).toHaveCount(33);
    await expect(msg('Staff adds a note')).toBeInViewport();
  } finally {
    await cleanup(parentId);
  }
});
