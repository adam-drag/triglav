import { BASE, cleanup, clientFetch, expect, openLive, spawnSenior, staffWithJob, test } from './fixtures.ts';

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

test('a job Staff finished shows in the Inbox with its own count until the Client clicks Got it', async ({ page, consoleErrors: _, agents }) => {
  const { staff, parentId, identifier, a, b } = await staffWithJob('finished');
  agents.push(staff);
  try {
    // The Client closes the subjobs, so only the parent, finished by Staff, is news.
    for (const id of [a, b]) {
      const res = await clientFetch(`${BASE}/api/jobs/${id}/mark-done`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'e2e' }) });
      expect(res.ok).toBe(true);
    }
    await openLive(page, 'queue');
    const item = page.locator(`[data-testid=finished-item][data-job-id="${parentId}"]`);
    await expect(item).toHaveCount(0);
    const nav = page.getByTestId('nav-queue');
    const before = Number(await nav.getAttribute('data-finished'));

    await staff.call('complete_job', { job_id: parentId, integration_summary: 'Checked end to end' });
    await expect(item).toContainText(identifier);
    await expect(nav).toHaveAttribute('data-finished', String(before + 1));
    await item.getByRole('button', { name: 'Got it' }).click();
    await expect(item).toHaveCount(0);
    await expect(nav).toHaveAttribute('data-finished', String(before));
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

test('a critical message is labelled, sorts first, and survives Mark all as read', async ({ page, consoleErrors: _, agents }) => {
  const { staff, parentId, identifier } = await staffWithJob('inbox-critical');
  agents.push(staff);
  try {
    await staff.call('post_message', { job_id: parentId, type: 'discussion', body: `Delivered for ${identifier}, PR ready to merge.`, mentions: ['client'] });
    await staff.call('post_message', { job_id: parentId, type: 'discussion', body: `Review requested for ${identifier}.`, mentions: ['client'] });
    await staff.call('post_message', {
      job_id: parentId,
      type: 'discussion',
      priority: 'critical',
      reason: 'prod down since 10:03 UTC',
      body: `Production is down for ${identifier}.`,
      mentions: ['client'],
    });

    await openLive(page, 'queue');
    const nav = page.getByTestId('nav-queue');
    await expect(nav).toHaveAttribute('data-critical', '1');

    const items = page.getByTestId('inbox-item');
    await expect(items.first()).toHaveAttribute('data-priority', 'critical');
    await expect(items.first()).toContainText('Critical');
    await expect(items.first()).toContainText('Production is down');

    // Mark all as read clears only the normal message.
    await page.getByRole('button', { name: 'Mark all as read' }).click();
    await expect(page.locator('[data-testid=inbox-item][data-priority="normal"]')).toHaveCount(0);
    const critical = page.locator('[data-testid=inbox-item][data-priority="critical"]');
    await expect(critical).toHaveCount(1);
    await expect(nav).toHaveAttribute('data-critical', '1');

    // Opening the thread also shows the critical flag next to the message, and clears the inbox count.
    await critical.getByRole('link', { name: 'Open thread' }).click();
    await expect(page.locator('[data-testid=message][data-priority="critical"]')).toContainText('critical');
    await expect(nav).toHaveAttribute('data-critical', '0');
  } finally {
    await cleanup(parentId);
  }
});

test('an open objection shows on the job page until Staff decides, and a dissent lands in the Inbox marked as such', async ({ page, consoleErrors: _, agents }) => {
  const { staff, parentId, a } = await staffWithJob('dissent');
  const senior = await spawnSenior(staff, a, 'senior-dissent');
  agents.push(staff, senior);
  try {
    const objection = await senior.call('post_message', { job_id: a, type: 'discussion', stance: 'challenge', reason: 'render.ts:40 already streams pages.', body: 'Reuse the streaming renderer.' });
    await openLive(page, `jobs/${a}`);
    const open = page.getByTestId('open-objections');
    await expect(open).toContainText('render.ts:40 already streams pages.');

    const d = await staff.call('record_decision', { thread_id: objection.thread_id, body: 'Write a new renderer.', rationale: 'The streaming one leaks memory.', considered_message_ids: [objection.message_id] });
    await expect(open).toHaveCount(0);

    const reason = 'The leak was fixed in render.ts:52 last week; a new renderer repeats that work and loses the page cache.';
    await senior.call('file_dissent', { decision_id: d.decision_id, reason });
    await page.goto('/#/queue');
    const item = page.locator('[data-testid=inbox-item]', { hasText: reason });
    await expect(item).toContainText('Dissent with a Staff decision');
    await item.getByRole('link', { name: 'Open thread' }).click();
    await expect(page.getByTestId('decision')).toContainText('The streaming one leaks memory.');
  } finally {
    await cleanup(parentId);
  }
});
