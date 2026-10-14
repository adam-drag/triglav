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

    await staff.call('post_message', { job_id: parentId, type: 'discussion', body: `Status for ${identifier}: planning, nothing is stuck.`, mentions: ['client'] });
    await expect(row.getByTestId('poke-replied')).toBeVisible();
    await expect(row.getByTestId('poke-waiting')).toHaveCount(0);

    // The nav shows an unread count apart from the decisions count.
    const nav = page.getByTestId('nav-queue');
    await expect(nav).toHaveAttribute('data-unread', '1');
    await nav.click();
    const item = page.locator('[data-testid=inbox-item]', { hasText: `Status for ${identifier}: planning, nothing is stuck.` });
    await expect(item).toContainText(identifier);
    await item.getByRole('button', { name: 'Got it' }).click();
    await expect(item).toHaveCount(0);
    await expect(nav).toHaveAttribute('data-unread', '0');

    // Read messages come back only on request, marked read and without the Got it button.
    await page.getByTestId('inbox-show-read').check();
    await expect(item).toHaveAttribute('data-read', 'true');
    await expect(item.getByRole('button', { name: 'Got it' })).toHaveCount(0);
    await page.getByTestId('inbox-show-read').uncheck();
    await expect(item).toHaveCount(0);
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

test('the Client writes to an agent from its page, and the agent receives the text', async ({ page, consoleErrors: _, agents }) => {
  const { staff, parentId } = await staffWithJob('message');
  agents.push(staff);
  try {
    await openLive(page, `agents/${staff.id}`);
    const form = page.getByTestId('message-agent');
    await expect(form.getByRole('button', { name: 'Send message' })).toBeDisabled();
    await form.getByRole('textbox').fill('Please start with the export button.');
    await form.getByRole('button', { name: 'Send message' }).click();
    const got = await staff.waitFor('agent.poked');
    expect(got.payload.note).toBe('Please start with the export button.');
    await expect(form.getByRole('textbox')).toHaveValue('');
    await expect(page.getByTestId('poke-waiting')).toBeVisible();
    await expect(page.getByTestId('agent-activity')).toContainText('Please start with the export button.');
  } finally {
    await cleanup(parentId);
  }
});
