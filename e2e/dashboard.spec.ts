import { BASE, cleanup, clientFetch, expect, openLive, RUNNER_KEY, SimAgent, spawnSenior, staffWithJob, test } from './fixtures.ts';

test('shows registered jobs, subjobs and the active roster', async ({ page, consoleErrors: _, agents }) => {
  const { staff, identifier, parentId } = await staffWithJob('roster');
  const researcher = await SimAgent.register({ role: 'researcher', nickname: 'res-roster', focus: 'backend' });
  agents.push(staff, researcher);
  try {
    await openLive(page, 'jobs');
    await expect(page.locator(`[data-testid=job-row][data-identifier^="${identifier}"]`)).toHaveCount(3);
    await expect(page.locator(`[data-testid=job-row][data-identifier="${identifier}-1"]`)).toHaveAttribute('data-status', 'ready');
    await page.locator(`[data-testid=job-row][data-identifier="${identifier}"] a`).click();
    await expect(page.getByTestId('job-status')).toHaveAttribute('data-status', 'planning');
    await expect(page.getByTestId('job-next-action')).toHaveText('Staff plans and writes acceptance criteria');
    await expect(page.getByText('Export works and has tests').first()).toBeVisible();

    await page.getByRole('link', { name: 'Agents' }).click();
    await expect(page.locator(`[data-testid=agent-row][data-agent-id="${staff.id}"]`)).toHaveAttribute('data-presence', 'active');
    await expect(page.locator(`[data-testid=agent-row][data-agent-id="${researcher.id}"]`)).toContainText('backend');
  } finally {
    await cleanup(parentId);
  }
});

test('Client proposal is found through the all-jobs feed, assessed with reasons, decided, and persisted', async ({ page, consoleErrors: _, agents }) => {
  const { staff, parentId } = await staffWithJob('proposal');
  const r1 = await SimAgent.register({ role: 'researcher', nickname: 'res-support' });
  const r2 = await SimAgent.register({ role: 'researcher', nickname: 'res-reject' });
  agents.push(staff, r1, r2);
  try {
    await openLive(page, `jobs/${parentId}`);
    const form = page.getByTestId('new-post');
    await form.getByRole('button', { name: 'proposal' }).click();
    await form.getByPlaceholder('Your proposal').fill('Skip PDF metadata in v1.');
    await form.getByRole('button', { name: 'Post as Client' }).click();

    // Researchers discover the human post without an invitation.
    const seen = await r1.waitFor('proposal.posted');
    await r2.waitFor('proposal.posted');
    const threadId = seen.thread_id as string;
    const proposalId = seen.payload.message_id as number;
    await r1.call('post_message', { thread_id: threadId, stance: 'support', reason: 'Saves a day of work', body: 'Agree, metadata can wait.', in_reply_to: proposalId });
    await r2.call('post_message', { thread_id: threadId, stance: 'reject', reason: 'Screen readers need the document title', body: 'Keep at least the title.', in_reply_to: proposalId });

    await openLive(page, `threads/${threadId}`);
    await expect(page.locator('[data-testid=message][data-stance=support]')).toContainText('Saves a day of work');
    await expect(page.locator('[data-testid=message][data-stance=reject]')).toContainText('Screen readers need the document title');

    const thread = await staff.call('get_thread', { thread_id: threadId });
    await staff.call('record_decision', {
      thread_id: threadId,
      body: 'Skip metadata except the document title.',
      rationale: 'Keeps accessibility and saves most of the work.',
      considered_message_ids: thread.messages.map((m: any) => m.id),
    });
    // Arrives live, without a reload.
    await expect(page.getByTestId('decision')).toContainText('Skip metadata except the document title.');

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('message')).toHaveCount(4);
    await expect(page.locator('[data-testid=message][data-author=client]')).toContainText('Skip PDF metadata in v1.');
    await expect(page.getByTestId('decision')).toHaveAttribute('data-authority', 'staff');
  } finally {
    await cleanup(parentId);
  }
});

test('a timed question waits the full window, collects every timely answer, and keeps late replies', async ({ page, consoleErrors: _, agents }) => {
  test.setTimeout(150_000);
  const { staff, parentId, a } = await staffWithJob('question');
  const senior = await spawnSenior(staff, a, 'senior-question');
  const researcher = await SimAgent.register({ role: 'researcher', nickname: 'res-question' });
  agents.push(staff, senior, researcher);
  try {
    const q = await senior.call('ask_question', {
      job_id: a,
      title: 'Renderer choice',
      summary: 'PDF endpoint skeleton exists; criteria: export works and has tests.',
      question: 'Puppeteer or a PDF library?',
      why_it_matters: 'Image size and cold start time',
      waiting_work: 'Rendering implementation',
      window_sec: 60,
    });
    await openLive(page, `threads/${q.thread_id}`);
    await expect(page.getByTestId('question-head')).toHaveAttribute('data-state', 'collecting');
    await expect(page.getByTestId('question-head')).toContainText('s left');

    await staff.call('post_message', { thread_id: q.thread_id, body: 'Use a PDF library.', intended_decision: true });
    await researcher.waitFor('question.opened');
    await researcher.call('post_message', { thread_id: q.thread_id, stance: 'challenge', reason: 'Charts need a real browser engine', body: 'The library cannot render our SVG charts.' });

    // The early Staff answer does not end the window.
    const early = await senior.call('await_question', { thread_id: q.thread_id, max_wait_sec: 2 });
    expect(early.window_closed).toBe(false);

    // A timely challenge blocks automatic promotion, so Staff must decide.
    await expect(page.getByTestId('question-head')).toHaveAttribute('data-state', 'awaiting_staff_decision', { timeout: 90_000 });
    const closed = await senior.call('await_question', { thread_id: q.thread_id, max_wait_sec: 5 });
    expect(closed.window_closed).toBe(true);
    const timely = closed.thread.messages.filter((m: any) => m.timely && m.type !== 'question').map((m: any) => m.id);
    expect(timely).toHaveLength(2);

    await staff.call('record_decision', { thread_id: q.thread_id, body: 'Use Puppeteer for charts.', rationale: 'The challenge shows the library cannot render charts.', considered_message_ids: timely });
    await expect(page.getByTestId('question-head')).toHaveAttribute('data-state', 'resolved');
    await expect(page.getByTestId('decision')).toContainText('Use Puppeteer for charts.');

    await researcher.call('post_message', { thread_id: q.thread_id, stance: 'support', reason: 'Matches what I saw', body: 'Late, but agreed.' });
    await expect(page.locator('[data-testid=message][data-timely=false]')).toContainText('Late, but agreed.');
  } finally {
    await cleanup(parentId);
  }
});

test('a client decision blocker shows in the queue and the Client unblocks it', async ({ page, consoleErrors: _, agents }) => {
  const { staff, parentId, b } = await staffWithJob('blocker');
  agents.push(staff);
  try {
    await staff.call('raise_blocker', {
      job_id: b,
      kind: 'client_decision',
      requested_decision: 'One-click export or choose the page size first?',
      recommendation: 'One-click, see https://github.com/example-org/app/pull/1 and run `gh pr checks 1`.',
      unblock_condition: 'The Client picks one.',
      commands: [{ label: 'Deploy', command: "gh workflow run deploy.yml --ref main" }, { command: "aws lambda invoke --payload '{}' out.json" }],
    });
    await openLive(page, 'jobs');
    await expect(page.getByTestId('nav-queue')).not.toHaveAttribute('data-count', '0');
    await expect(page).toHaveTitle(/^\(\d+\) Triglav$/);

    await page.getByTestId('nav-queue').click();
    const item = page.locator(`[data-testid=queue-item][data-job-id="${b}"]`);
    await expect(item).toContainText('One-click export or choose the page size first?');
    await item.locator('summary').click();
    await expect(item.getByRole('link', { name: 'https://github.com/example-org/app/pull/1' })).toHaveAttribute('href', 'https://github.com/example-org/app/pull/1');
    await expect(item.locator('code.code-chip')).toHaveText('gh pr checks 1');
    const blocks = item.getByTestId('command-block');
    await expect(blocks).toHaveCount(2);
    await expect(blocks.nth(0)).toContainText('1. Deploy');
    await expect(blocks.nth(1).locator('pre')).toHaveText("aws lambda invoke --payload '{}' out.json");
    await expect(blocks.nth(0).getByRole('button', { name: 'Copy command: Deploy' })).toBeVisible();
    await item.getByPlaceholder('Your decision').fill('One-click export.');
    await item.getByRole('button', { name: 'Answer and unblock' }).click();
    await expect(item).toHaveCount(0);

    await staff.waitFor('blocker.resolved');
    const job = await staff.call('get_job', { job_id: b });
    expect(job.job.status).toBe('planning');
  } finally {
    await cleanup(parentId);
  }
});

test('pause, resume and cancel from the dashboard reach the Senior', async ({ page, consoleErrors: _, agents }) => {
  const { staff, parentId, a } = await staffWithJob('controls');
  const senior = await spawnSenior(staff, a, 'senior-controls');
  agents.push(staff, senior);
  try {
    await openLive(page, `jobs/${parentId}`);
    await page.getByRole('button', { name: 'Pause' }).click();
    await expect(page.getByTestId('job-status')).toHaveAttribute('data-control', 'pause');
    await senior.call('list_jobs');
    expect(senior.lastControl?.action).toBe('pause');

    await page.getByRole('button', { name: 'Resume' }).click();
    await expect(page.getByTestId('job-status')).toHaveAttribute('data-control', 'continue');
    await senior.call('list_jobs');
    expect(senior.lastControl?.action).toBe('continue');

    page.once('dialog', (dialog) => dialog.accept('Not needed any more'));
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByTestId('job-status')).toHaveAttribute('data-status', 'cancelled');
    await senior.call('list_jobs');
    expect(senior.lastControl?.action).toBe('cancel');
    await expect(senior.call('report_progress', { assignment_id: senior.assignment!.id, attempt: senior.assignment!.attempt, note: 'still working' })).rejects.toThrow(/lease|no longer/);
  } finally {
    await cleanup(parentId);
  }
});

test('an agent page shows its activity and a poke reaches the agent', async ({ page, consoleErrors: _, agents }) => {
  const { staff, parentId } = await staffWithJob('poke');
  agents.push(staff);
  try {
    await openLive(page, 'agents');
    await page.locator(`[data-testid=agent-row][data-agent-id="${staff.id}"] a`).first().click();
    await expect(page.getByTestId('agent-activity')).toContainText('job.registered');
    await page.getByRole('button', { name: 'Poke' }).click();
    const poked = await staff.waitFor('agent.poked');
    expect(poked.actor).toBe('client');
    await expect(page.getByTestId('agent-activity')).toContainText('agent.poked');
  } finally {
    await cleanup(parentId);
  }
});

async function setSeniorModel(body: Record<string, string>) {
  const res = await clientFetch(`${BASE}/api/role-models/senior`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`reset failed: ${res.status}`);
}

test('the Models page edits a role in flight and the launch commands follow', async ({ page, consoleErrors: _, agents }) => {
  const { staff, parentId, a } = await staffWithJob('models');
  agents.push(staff);
  try {
    await openLive(page, 'models');
    await page.getByPlaceholder('Linear ticket, for example ENG-123').fill('ENG-1');
    await expect(page.getByTestId('launch-staff')).toContainText(`claude --bg -n 'staff-eng-1' --settings '{"autoCompactWindow":300000}' --model claude-opus-5-5 --effort high`);

    const row = page.locator('[data-testid=role-model][data-role=senior]');
    await expect(row.getByLabel('senior effort')).toHaveValue('high');
    await row.getByLabel('senior effort').fill('medium');
    await row.getByRole('button', { name: 'Save' }).click();
    await expect(row.getByRole('button', { name: 'Save' })).toBeDisabled();
    await expect(row).toContainText('updated');
    const ticket = await staff.call('create_spawn_ticket', { job_id: a, role: 'senior', brief: 'x' });
    expect(ticket.model.effort).toBe('medium');
  } finally {
    await setSeniorModel({ runtime: 'claude-code', model: 'claude-sonnet-5-5', effort: 'high' });
    await cleanup(parentId);
  }
});

test('browser notifications fire on job status changes once the Client turns them on', async ({ page, context, consoleErrors: _, agents }) => {
  await context.grantPermissions(['notifications']);
  await page.addInitScript(() => {
    const shown: string[] = [];
    (window as any).__shown = shown;
    class FakeNotification {
      static permission = 'granted';
      static requestPermission = async () => 'granted';
      constructor(title: string) {
        shown.push(title);
      }
    }
    (window as any).Notification = FakeNotification;
  });
  const { staff, identifier, parentId } = await staffWithJob('notify');
  agents.push(staff);
  try {
    await openLive(page, 'jobs');
    await page.getByTestId('notify-toggle').click();
    await expect(page.getByTestId('notify-toggle')).toHaveAttribute('aria-pressed', 'true');
    await staff.call('update_job', { job_id: parentId, status: 'ready' });
    await expect.poll(() => page.evaluate(() => (window as any).__shown as string[])).toContainEqual(`${identifier}: planning → ready`);
  } finally {
    await cleanup(parentId);
  }
});

test('Home shows what needs the Client, and the nav reaches the live map and the More pages', async ({ page, consoleErrors: _, agents }) => {
  const { staff, b, identifier, parentId } = await staffWithJob('home');
  agents.push(staff);
  try {
    await staff.call('raise_blocker', { job_id: b, kind: 'client_decision', requested_decision: 'Ship the home dashboard?', unblock_condition: 'The Client answers.' });
    await openLive(page, '');
    const needs = page.getByTestId('home-needs');
    await expect(needs).toContainText('Ship the home dashboard?');
    await expect(page.getByTestId('tile-needs-you')).toContainText('decision');
    await expect(page.locator(`[data-testid=home-job][data-identifier^="${identifier}"]`).first()).toBeVisible();
    // No status line reading yet: Claude usage is unknown, so the card says so instead of showing a number.
    await expect(page.getByTestId('home-usage')).toContainText('No limit reached*');
    await expect(page.getByTestId('claude-estimate-note')).toContainText('claude-statusline.sh');
    await fetch(`${BASE}/api/usage/claude`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ five_hour: { used_percentage: 42, resets_at: Math.floor(Date.now() / 1000) + 3600 } }) });
    // A usage reading is not an event, so the card picks it up on the next load.
    await page.reload();
    await expect(page.getByTestId('home-usage')).toContainText('Session (5 hr) 42%');
    await expect(page.getByTestId('home-usage')).not.toContainText('*');
    await expect(page.getByTestId('claude-estimate-note')).toHaveCount(0);
    await needs.getByRole('link', { name: 'Review and answer' }).click();
    await expect(page.getByTestId('queue-item')).toContainText('Ship the home dashboard?');

    const main = page.getByRole('navigation', { name: 'Main' });
    await main.getByRole('link', { name: 'Activity', exact: true }).click();
    await expect(page.getByTestId('live-map')).toBeVisible();
    // The Linear chip opens the job's own ticket URL, in whichever workspace it is.
    await page.getByTestId('map-job').filter({ hasText: identifier }).first().hover();
    await expect(page.getByTestId('map-card').getByRole('link', { name: /^Linear/ })).toHaveAttribute('href', new RegExp(`^https://linear\\.app/e2e/issue/${identifier}`));
    await page.getByRole('navigation', { name: 'Activity' }).getByRole('link', { name: 'Feed' }).click();
    await expect(page.getByTestId('feed')).toBeVisible();

    await main.getByRole('button', { name: 'More' }).click();
    await expect(page.locator('#more-menu').getByRole('link')).toHaveText([/Usage/, /Models/, /Guide/]);
    await page.locator('#more-menu').getByRole('link', { name: /Usage/ }).click();
    await expect(page.getByRole('heading', { name: 'Plan limits' })).toBeVisible();
    // The page's CSP blocks style attributes in markup but not styles that React sets through the DOM, so the bar still has its width.
    const bar = page.getByTestId('plan-claude').locator('.meter > div').first();
    const [barWidth, trackWidth] = await Promise.all([bar.evaluate((el) => el.getBoundingClientRect().width), bar.evaluate((el) => el.parentElement!.getBoundingClientRect().width)]);
    expect(barWidth / trackWidth).toBeCloseTo(0.42, 1);
    await expect(page.locator('#more-menu')).toHaveCount(0);

    await main.getByRole('button', { name: 'More' }).click();
    await page.locator('#more-menu').getByRole('link', { name: /Guide/ }).click();
    const guide = page.getByTestId('guide');
    await expect(guide.getByRole('heading', { level: 1, name: 'Using Triglav' })).toBeVisible();
    await expect(guide.getByRole('heading', { level: 2, name: 'Decisions' })).toBeVisible();
    await expect(guide).not.toContainText('**');
    // The agents' guide is for agents: none of it is shown to the Client.
    await expect(guide).not.toContainText('register_agent');
    await expect(page.getByRole('link', { name: '/guide.md' })).toHaveCount(0);
  } finally {
    await cleanup(parentId);
  }
});

test('the ? on Home opens a popup that links to the guide and the Operator', async ({ page, consoleErrors: _ }) => {
  await openLive(page, '');
  await expect(page.getByTestId('help-popup')).toHaveCount(0);
  // It sits in the bottom-right corner of the window, small.
  const box = (await page.getByTestId('help-trigger').boundingBox())!;
  const view = page.viewportSize()!;
  expect(box.x + box.width).toBeGreaterThan(view.width - 40);
  expect(box.y + box.height).toBeGreaterThan(view.height - 40);
  expect(box.width).toBeLessThanOrEqual(32);
  await page.getByTestId('help-trigger').click();
  const popup = page.getByTestId('help-popup');
  await expect(popup.getByRole('link', { name: /Read the guide/ })).toHaveAttribute('href', '#/guide');
  await expect(popup.getByRole('link', { name: /Ask the Operator/ })).toHaveAttribute('href', '#/operator');
  await page.keyboard.press('Escape');
  await expect(popup).toHaveCount(0);
  await page.getByTestId('help-trigger').click();
  await page.getByRole('link', { name: /Ask the Operator/ }).click();
  await expect(page).toHaveURL(/#\/operator/);
  await expect(popup).toHaveCount(0);
});

test('the Models page says which agent CLIs the runner found and switches roles that need a missing one', async ({ page, consoleErrors: _ }) => {
  const report = (body: object) => fetch(`${BASE}/api/runner/runtimes`, { method: 'POST', headers: { authorization: `Bearer ${RUNNER_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    await report({ 'claude-code': { version: '2.1.0 (Claude Code)', models: [] }, codex: null });
    await openLive(page, 'models');
    await expect(page.getByTestId('detected-runtimes')).toContainText('found Claude Code 2.1.0 (Claude Code), not Codex');
    const researcher = page.locator('[data-testid=role-model][data-role=researcher]');
    await expect(researcher.getByTestId('role-replaced')).toContainText('codex is not on this machine, so Triglav uses claude-code claude-opus-5-5 high.');
    await expect(researcher.getByLabel('researcher runtime').locator('option')).toHaveText(['claude-code', 'codex']);
    await expect(page.locator('[data-testid=role-model][data-role=staff]').getByTestId('role-replaced')).toHaveCount(0);
    await report({ 'claude-code': { version: '2.1.0 (Claude Code)', models: [] }, codex: { version: 'codex-cli 0.1.0', models: [] } });
    await page.reload();
    await expect(page.getByTestId('detected-runtimes')).toContainText('Claude Code 2.1.0 (Claude Code) and Codex codex-cli 0.1.0');
    await expect(researcher.getByTestId('role-replaced')).toHaveCount(0);
  } finally {
    await report({ 'claude-code': { version: '2.1.0 (Claude Code)', models: [] }, codex: { version: 'codex-cli 0.1.0', models: [] } });
  }
});

test('a ticket id in a decision links to its Linear ticket, using the workspace of the jobs', async ({ page, consoleErrors: _, agents }) => {
  const { staff, identifier, parentId, b } = await staffWithJob('links');
  agents.push(staff);
  try {
    await staff.call('raise_blocker', { job_id: b, kind: 'client_decision', requested_decision: `Ship ${identifier} before the rest? Also UTF-8 and SHA-256 are not tickets.`, unblock_condition: 'The Client picks one.' });
    await openLive(page, 'queue');
    const item = page.locator(`[data-testid=queue-item][data-job-id="${b}"]`);
    await item.locator('summary').click();
    await expect(item.getByRole('link', { name: identifier, exact: true })).toHaveAttribute('href', `https://linear.app/e2e/issue/${identifier}`);
    // Ids of teams that have no job here are plain text, so nothing links to a guessed workspace.
    await expect(item.getByRole('link', { name: 'UTF-8' })).toHaveCount(0);
    await expect(item.getByRole('link', { name: 'SHA-256' })).toHaveCount(0);
  } finally {
    await cleanup(parentId);
  }
});

test('the Client asks a Senior for its own view on a thread and sees when it answers', async ({ page, consoleErrors: _, agents }) => {
  const { staff, parentId, a } = await staffWithJob('view');
  const senior = await spawnSenior(staff, a, 'senior-view');
  const outsider = await SimAgent.register({ role: 'staff', nickname: 'staff-outsider' });
  agents.push(staff, senior, outsider);
  try {
    const posted = await staff.call('post_message', { job_id: parentId, body: 'Plan: queue the exports.' });
    await openLive(page, `threads/${posted.thread_id}`);
    const ask = page.getByTestId('ask-view');
    await expect(ask.getByLabel(/senior-view/)).toBeVisible();
    await expect(ask.getByLabel(/staff-view/)).toBeVisible();
    // Only agents that can answer on this job are offered.
    await expect(ask.getByLabel(/staff-outsider/)).toHaveCount(0);

    await ask.getByLabel(/senior-view/).check();
    await page.getByRole('button', { name: 'Post and ask' }).click();
    const asked = page.locator(`[data-testid=asked-for-view] [data-agent="${senior.id}"]`);
    await expect(asked).toHaveAttribute('data-answered', 'false');

    const mention = await senior.waitFor('mention');
    expect(mention.payload.view_requested).toBe(true);
    await senior.call('post_message', { thread_id: posted.thread_id, type: 'reply', stance: 'challenge', reason: 'Exports are small', body: 'Inline is enough.', in_reply_to: mention.payload.message_id });
    await expect(asked).toHaveAttribute('data-answered', 'true');
    await expect(asked).toContainText('answered in #');
  } finally {
    await cleanup(parentId);
  }
});
