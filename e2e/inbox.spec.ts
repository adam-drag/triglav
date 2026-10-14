import { cleanup, expect, openLive, staffWithJob, test } from './fixtures.ts';

test('a poke waits for the reply, and the reply lands in the Inbox until the Client reads it', async ({ page, consoleErrors: _, agents }) => {
  const { staff, parentId, identifier } = await staffWithJob('inbox');
  agents.push(staff);
  try {
    await openLive(page, 'agents');
    const row = page.locator(`[data-testid=agent-row][data-agent-id="${staff.id}"]`);
    await row.getByRole('button', { name: 'Poke' }).click();
    await staff.waitFor('agent.poked');
    await expect(row.getByTestId('poke-waiting')).toBeVisible();

    // An untagged message is not a reply.
    await staff.call('post_message', { job_id: parentId, type: 'discussion', body: 'Thinking out loud.' });
    await expect(row.getByTestId('poke-waiting')).toBeVisible();

    await staff.call('post_message', { job_id: parentId, type: 'discussion', body: 'Status: planning, nothing is stuck.', mentions: ['client'] });
    await expect(row.getByTestId('poke-replied')).toBeVisible();
    await expect(row.getByTestId('poke-waiting')).toHaveCount(0);

    // The nav shows an unread count apart from the decisions count.
    const nav = page.getByTestId('nav-queue');
    await expect(nav).toHaveAttribute('data-unread', '1');
    await nav.click();
    const item = page.locator(`[data-testid=inbox-item]`, { hasText: 'Status: planning, nothing is stuck.' });
    await expect(item).toContainText(identifier);
    await item.getByRole('button', { name: 'Got it' }).click();
    await expect(item).toHaveCount(0);
    await expect(nav).toHaveAttribute('data-unread', '0');
  } finally {
    await cleanup(parentId);
  }
});

test('replying in the thread clears the tagged message', async ({ page, consoleErrors: _, agents }) => {
  const { staff, parentId } = await staffWithJob('inbox-reply');
  agents.push(staff);
  try {
    const posted = await staff.call('post_message', { job_id: parentId, type: 'discussion', body: 'Result is ready for a look.', mentions: ['client'] });
    await openLive(page, 'queue');
    await expect(page.locator('[data-testid=inbox-item]', { hasText: 'Result is ready for a look.' })).toBeVisible();
    await page.goto(`/#/threads/${posted.thread_id}`);
    await page.getByPlaceholder('Message').fill('Thanks, looks good.');
    await page.getByRole('button', { name: 'Post reply' }).click();
    await expect(page.getByText('Thanks, looks good.')).toBeVisible();
    await page.goto('/#/queue');
    await expect(page.locator('[data-testid=inbox-item]', { hasText: 'Result is ready for a look.' })).toHaveCount(0);
  } finally {
    await cleanup(parentId);
  }
});
