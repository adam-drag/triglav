import { BASE, cleanup, clientFetch, expect, openLive, RUNNER_KEY, SimAgent, test } from './fixtures.ts';

const REPO = '/tmp/e2e-repo';

/** Plays the host runner: takes the queued launches and reports each one done, like scripts/runner.ts would. */
async function runner(result = 'ok: started') {
  const taken: any[] = [];
  for (let i = 0; i < 10; i++) {
    const res = await fetch(`${BASE}/api/runner/next`, { method: 'POST', headers: { authorization: `Bearer ${RUNNER_KEY}`, 'content-type': 'application/json' }, body: '{}' });
    const { launch } = await res.json();
    if (!launch) break;
    taken.push(launch);
    await fetch(`${BASE}/api/runner/${launch.id}/done`, { method: 'POST', headers: { authorization: `Bearer ${RUNNER_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ result }) });
  }
  return taken;
}

test('the New job form shows field errors inline and queues a staff_start launch that carries only the request id', async ({ page, consoleErrors, agents }) => {
  await runner();
  await openLive(page, 'new');
  const url = `https://acme.atlassian.net/browse/ENG-${Date.now()}`;

  await page.getByTestId('job-url').fill('ftp://example.test/1');
  await page.getByTestId('job-repo').fill(REPO);
  await page.getByTestId('job-submit').click();
  await expect(page.getByTestId('job-error')).toContainText('http and https');
  await page.getByTestId('job-url').fill(url);
  await page.getByTestId('job-repo').fill('relative/path');
  await page.getByTestId('job-submit').click();
  await expect(page.getByTestId('job-error')).toContainText('absolute');
  await page.getByTestId('job-repo').fill(REPO);
  await page.getByTestId('job-branch').fill('--upload-pack=x');
  await page.getByTestId('job-submit').click();
  await expect(page.getByTestId('job-error')).toContainText('base branch');
  // The browser logs each 400 as a console error; these three are the ones this test caused on purpose.
  expect(consoleErrors.splice(0).every((e) => /status of 400/.test(e))).toBe(true);

  await page.getByTestId('job-branch').fill('main');
  await page.getByTestId('job-submit').click();
  // The progress shows under the form while the request waits for the runner, and does not say "started" before it has.
  await expect(page.getByTestId('start-status')).toHaveAttribute('data-state', 'queued');
  await expect(page.getByTestId('start-status')).toContainText(url);
  // The form stays ready for the next job: the URL is cleared, the repository and branch are kept.
  await expect(page.getByTestId('job-url')).toHaveValue('');
  await expect(page.getByTestId('job-repo')).toHaveValue(REPO);
  await expect(page.getByTestId('job-submit')).toBeEnabled();
  const row = page.locator('[data-testid=job-requests] tr[data-status=queued]', { hasText: url });
  await expect(row).toHaveCount(1);
  const requestId = (await row.getAttribute('data-request-id'))!;

  // The runner gets the id, the directory, the model and the effort. It does not get the Client's URL.
  const [launch, ...rest] = await runner();
  expect(rest).toEqual([]);
  expect(launch).toMatchObject({ kind: 'staff_start', request_id: requestId, cwd: REPO, runtime: 'claude-code' });
  expect(JSON.stringify(launch)).not.toContain('atlassian');
  await expect(page.locator(`[data-testid=job-requests] tr[data-request-id="${requestId}"]`)).toHaveAttribute('data-status', 'started');
  await expect(page.getByTestId('start-status')).toHaveAttribute('data-state', 'started');

  // Link mode with a URL that is not Linear: Staff reads the request and registers the job from its own snapshot.
  const staff = await SimAgent.register({ role: 'staff', nickname: 'staff-link-e2e' });
  agents.push(staff);
  const read = await staff.call('get_job_request', { request_id: requestId });
  expect(read).toMatchObject({ mode: 'link', source_url: url, repo_path: REPO, base_branch: 'main' });
  const ident = `ENG-E2E-${Date.now().toString(36).toUpperCase()}`;
  const job = await staff.call('register_job', {
    request_id: requestId,
    ticket_snapshot: { id: ident, identifier: ident, title: 'Jira ticket from a link', description: 'Read by Staff.', url, state: 'To Do', children: [] },
  });
  try {
    // Once Staff registers the job, the page moves to it.
    await expect(page).toHaveURL(new RegExp(`#/jobs/${job.job_id}$`));
    await expect(page.getByTestId('job-status')).toHaveAttribute('data-status', 'queued');
    await expect(page.getByText('Started from a ticket link').first()).toBeVisible();
  } finally {
    await cleanup(job.job_id);
  }
});

test('the New job form starts several jobs in a row, keeps a card for each, and stays on the page', async ({ page, consoleErrors: _, agents }) => {
  await runner();
  await openLive(page, 'new');
  const stamp = Date.now();
  const urls = [0, 1].map((n) => `https://acme.atlassian.net/browse/ENG-ROW${stamp}-${n}`);
  await page.getByTestId('job-repo').fill(REPO);
  for (const u of urls) {
    await page.getByTestId('job-url').fill(u);
    await page.getByTestId('job-submit').click();
    await expect(page.getByTestId('job-url')).toHaveValue('');
    await expect(page.locator('[data-testid=job-requests] tr', { hasText: u })).toHaveCount(1);
  }
  // One card per request, in the order they were sent.
  const cards = page.getByTestId('start-status');
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0)).toContainText(urls[0]);
  await expect(cards.nth(1)).toContainText(urls[1]);
  const launches = await runner();
  expect(launches.map((l: any) => l.kind)).toEqual(['staff_start', 'staff_start']);

  const requests: any[] = await clientFetch(`${BASE}/api/job-requests`).then((r) => r.json());
  const jobs: string[] = [];
  const register = async (n: number) => {
    const staff = await SimAgent.register({ role: 'staff', nickname: `staff-row-${n}-e2e` });
    agents.push(staff);
    const requestId = requests.find((r) => r.source_url === urls[n]).id;
    await staff.call('get_job_request', { request_id: requestId });
    const ident = `ENG-ROW-${stamp.toString(36).toUpperCase()}-${n}`;
    const job = await staff.call('register_job', { request_id: requestId, ticket_snapshot: { id: ident, identifier: ident, title: `Row ${n}`, description: 'Read by Staff.', url: urls[n], state: 'To Do', children: [] } });
    jobs.push(job.job_id);
    return ident;
  };
  try {
    // Each card turns into a link to its job as Staff registers it, and the page stays, because several jobs were started.
    const first = await register(0);
    await expect(cards.nth(0)).toHaveAttribute('data-state', 'registered');
    await expect(cards.nth(0)).toContainText(first);
    await expect(cards.nth(1)).toHaveAttribute('data-state', 'started');
    const second = await register(1);
    await expect(cards.nth(1)).toHaveAttribute('data-state', 'registered');
    await expect(cards.nth(1)).toContainText(second);
    await expect(page).toHaveURL(/#\/new$/);
    await expect(page.locator('[data-testid=job-requests] tr', { hasText: urls[0] })).toContainText(first);
  } finally {
    for (const id of jobs) await cleanup(id);
  }
});

test('a prompt job starts in refining: Staff proposes, the Client answers and edits, only the Client approves', async ({ page, consoleErrors: _, agents }) => {
  await runner();
  await openLive(page, 'new');
  await page.getByTestId('mode-prompt').click();
  const prompt = `Add a CSV export to the reports page (${Date.now()})`;
  await page.getByTestId('job-prompt').fill(prompt);
  await page.getByTestId('job-repo').fill(REPO);
  await page.getByTestId('job-submit').click();
  await expect(page.getByTestId('start-status')).toHaveAttribute('data-state', 'queued');
  const [launch] = await runner();
  expect(launch.kind).toBe('staff_start');
  expect(JSON.stringify(launch)).not.toContain('CSV export');

  const staff = await SimAgent.register({ role: 'staff', nickname: 'staff-prompt-e2e' });
  agents.push(staff);
  const read = await staff.call('get_job_request', { request_id: launch.request_id });
  expect(read).toMatchObject({ mode: 'prompt', prompt });
  const job = await staff.call('register_job', { request_id: launch.request_id, title: 'CSV export' });
  try {
    expect(job.job_source).toBe('prompt');
    // The New job page moves to the job, where the Client sees that Staff is drafting.
    await expect(page).toHaveURL(new RegExp(`#/jobs/${job.job_id}$`));
    await expect(page.getByTestId('job-status')).toHaveAttribute('data-status', 'refining');
    await expect(page.getByTestId('refine-turn')).toHaveAttribute('data-turn', 'drafting');
    await expect(page.getByTestId('refine-prompt')).toContainText('CSV export');
    // Staff is writing the proposal, so the two fields are locked and show the working dots.
    await expect(page.getByTestId('refine-plan')).toBeDisabled();
    await expect(page.getByTestId('refine-criteria')).toBeDisabled();
    await expect(page.locator('[data-testid=refine-panel] .working-dots')).toHaveCount(2);
    // No criteria yet, so there is nothing to approve.
    await expect(page.getByTestId('refine-approve')).toBeDisabled();

    // Staff proposes and asks; this arrives live.
    const detail = await staff.call('get_job', { job_id: job.job_id });
    await staff.call('update_job', { job_id: job.job_id, plan: 'Goal: CSV export.\nNon-goals: Excel.', acceptance_criteria: '1. A CSV downloads.' });
    await staff.call('post_message', { thread_id: detail.threads[0].id, type: 'discussion', body: '1. Which delimiter?' });
    await expect(page.getByTestId('refine-criteria')).toHaveValue('1. A CSV downloads.');
    await expect(page.getByTestId('refine-thread')).toContainText('Which delimiter?');
    await expect(page.getByTestId('refine-turn')).toHaveAttribute('data-turn', 'client');
    await expect(page.getByTestId('refine-approve')).toHaveText('Approve and start planning');
    await expect(page.getByTestId('refine-send')).toBeDisabled();
    await expect(page.getByTestId('refine-criteria')).toBeEnabled();
    await expect(page.locator('[data-testid=refine-panel] .working-dots')).toHaveCount(0);

    // A job in refinement waits for the Client, so Decisions lists it and counts it.
    await openLive(page, 'queue');
    await expect(page.locator(`[data-testid=refine-item][data-job-id="${job.job_id}"]`)).toBeVisible();
    await expect(page.getByTestId('nav-queue')).not.toHaveAttribute('data-count', '0');
    await openLive(page, `jobs/${job.job_id}`);

    // The Client answers and edits the criteria; that wakes Staff.
    await page.getByTestId('refine-answer').fill('Use a semicolon.');
    await page.getByTestId('refine-criteria').fill('1. A CSV downloads.\n2. It uses a semicolon.');
    await expect(page.getByTestId('refine-approve')).toHaveText('Send and start planning');
    await page.getByTestId('refine-send').click();
    const reply = await staff.waitFor('refinement.client_reply');
    expect(reply.payload.excerpt).toContain('semicolon');
    await expect(page.getByTestId('refine-thread')).toContainText('Use a semicolon.');
    await expect(page.getByTestId('refine-criteria')).toHaveValue(/semicolon/);
    await expect(page.getByTestId('refine-turn')).toHaveAttribute('data-turn', 'revising');
    await expect(page.getByTestId('refine-criteria')).toBeDisabled();

    // Staff cannot leave refining by itself.
    await expect(staff.call('update_job', { job_id: job.job_id, status: 'planning' })).rejects.toThrow(/Client/);

    // A last answer goes with the approval: Staff gets it while planning, not as another round of refinement.
    await page.getByTestId('refine-answer').fill('Quote every field.');
    await page.getByTestId('refine-approve').click();
    const approved = await staff.waitFor('refinement.approved');
    expect(approved.payload.note).toContain('Quote every field.');
    await expect(page.getByTestId('job-status')).toHaveAttribute('data-status', 'planning');
    await expect(page.getByTestId('refine-panel')).toHaveCount(0);
    await expect(page.getByTestId('job-next-action')).toHaveText('Staff plans and writes acceptance criteria');
  } finally {
    await cleanup(job.job_id);
  }
});

test('New job and Models offer the models the CLIs list, and a model chosen for a role is saved and used', async ({ page, consoleErrors: _ }) => {
  const report = (body: object) => fetch(`${BASE}/api/runner/runtimes`, { method: 'POST', headers: { authorization: `Bearer ${RUNNER_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const claude = { version: '2.1.0 (Claude Code)', models: [{ id: 'claude-opus-5-5', label: 'Opus 5.5', efforts: ['low', 'high', 'max'] }, { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', efforts: ['low', 'high'] }] };
  const codex = { version: 'codex-cli 0.1.0', models: [{ id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', efforts: ['low', 'medium'] }] };
  const senior = (role: string) => clientFetch(`${BASE}/api/role-models`).then((r) => r.json()).then((v: any) => v.roles.find((m: any) => m.role === role));
  try {
    await report({ 'claude-code': claude, codex });
    await openLive(page, 'new');
    const agents = page.getByTestId('job-agents');
    // The model list is the CLI's own, so there is nothing to type. Staff can run on either CLI.
    await expect(agents.locator('tr[data-role=staff]').getByLabel('staff runtime').locator('option')).toHaveText(['claude-code', 'codex']);
    await expect(agents.locator('tr[data-role=staff]').getByLabel('staff model').locator('option')).toHaveText(['Opus 5.5', 'Sonnet 5.5']);
    await expect(agents.locator('tr[data-role=senior]').getByLabel('senior runtime').locator('option')).toHaveText(['claude-code', 'codex']);

    // Switching a Senior to Codex picks that CLI's first model and an effort it accepts.
    const row = agents.locator('tr[data-role=senior]');
    await row.getByLabel('senior runtime').selectOption('codex');
    await expect(row.getByLabel('senior model')).toHaveValue('gpt-6.1-sol');
    await expect(row.getByLabel('senior effort').locator('option')).toHaveText(['low', 'medium']);
    await row.getByLabel('senior effort').selectOption('medium');
    await agents.locator('tr[data-role=staff]').getByLabel('staff runtime').selectOption('codex');

    await page.getByTestId('job-url').fill(`https://acme.atlassian.net/browse/ENG-M${Date.now()}`);
    await page.getByTestId('job-repo').fill(REPO);
    await page.getByTestId('job-submit').click();
    await expect(page.getByTestId('start-status')).toHaveAttribute('data-state', 'queued');
    expect(await senior('senior')).toMatchObject({ runtime: 'codex', model: 'gpt-6.1-sol', effort: 'medium' });
    // Staff on Codex: the runner is told to start it with Codex and that model.
    const [launch] = await runner();
    expect(launch).toMatchObject({ kind: 'staff_start', runtime: 'codex', model: 'gpt-6.1-sol' });

    // The Models page offers the same lists; the server refuses a name the CLI does not list.
    await openLive(page, 'models');
    const models = page.locator('[data-testid=role-model][data-role=senior]');
    await expect(models.getByLabel('senior model').locator('option')).toHaveText(['GPT-6.1-Sol']);
    const bad = await clientFetch(`${BASE}/api/role-models/senior`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runtime: 'codex', model: 'gpt-6.1-solx', effort: 'low' }) });
    expect(bad.status).toBe(400);
  } finally {
    await clientFetch(`${BASE}/api/role-models/staff`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runtime: 'claude-code', model: 'claude-opus-5-5', effort: 'high' }) });
    await clientFetch(`${BASE}/api/role-models/senior`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runtime: 'claude-code', model: 'claude-sonnet-5-5', effort: 'high' }) });
    await report({ 'claude-code': { version: '2.1.0 (Claude Code)', models: [] }, codex: { version: 'codex-cli 0.1.0', models: [] } });
  }
});

test('a start that fails is shown as failed on the form, stays in view on every page, and can be retried or dismissed', async ({ page, consoleErrors: _ }) => {
  const api = (path: string, init?: RequestInit) => clientFetch(`${BASE}${path}`, { ...init, headers: { 'content-type': 'application/json' } }).then((r) => r.json());
  await runner();
  // Start problems left by an earlier run on the same stack would also show in the bar; this test looks at its own.
  for (const r of (await api('/api/job-requests')).filter((x: any) => !x.dismissed_at && !x.job_id && x.status === 'failed')) await api(`/api/job-requests/${r.id}/dismiss`, { method: 'POST', body: '{}' });
  await openLive(page, 'new');
  await page.getByTestId('mode-prompt').click();
  const prompt = `Fix the flaky test (${Date.now()})`;
  await page.getByTestId('job-prompt').fill(prompt);
  await page.getByTestId('job-repo').fill(REPO);
  await page.getByTestId('job-submit').click();
  await expect(page.getByTestId('start-status')).toHaveAttribute('data-state', 'queued');

  const reason = `Claude Code does not trust ${REPO} yet. Run "cd ${REPO} && claude" once, accept the trust prompt, then retry.`;
  await runner(`failed: ${reason}\nCommand failed: claude --bg -n staff-x`);
  const status = page.getByTestId('start-status');
  await expect(status).toHaveAttribute('data-state', 'failed');
  await expect(status).toContainText('The job did not start.');
  await expect(status).toContainText(reason);
  await expect(page.getByTestId('job-submit')).toBeEnabled();
  // What the Client typed is kept, so a wrong path can be fixed and sent again.
  await expect(page.getByTestId('job-prompt')).toHaveValue(prompt);

  // On any other page the problem stays in view until it is dealt with.
  await openLive(page, '');
  const banner = page.getByTestId('start-problems');
  await expect(banner).toContainText('A job did not start.');
  await expect(banner).toContainText(reason);
  const before = (await api('/api/job-requests')).filter((r: any) => r.prompt === prompt);
  expect(before).toHaveLength(1);
  await banner.getByTestId('problem-retry').click();
  await expect(banner).toHaveCount(0);
  const after = (await api('/api/job-requests')).filter((r: any) => r.prompt === prompt);
  expect(after.map((r: any) => [r.status, !!r.dismissed_at]).sort()).toEqual([['failed', true], ['queued', false]]);
  await runner();

  // A second failure can be dismissed instead.
  const second = await api('/api/job-requests', { method: 'POST', body: JSON.stringify({ mode: 'prompt', prompt: `${prompt} again`, repo_path: REPO }) });
  await runner('failed: The command "claude" was not found on the runner\'s PATH.');
  await page.reload();
  await expect(page.getByTestId('start-problems')).toContainText('was not found on the runner');
  await page.getByTestId('problem-dismiss').click();
  await expect(page.getByTestId('start-problems')).toHaveCount(0);
  expect(second.id).toMatch(/^req_/);
});

test('the review mode is chosen on New job and on Models, is saved, and refuses a value that does not exist', async ({ page, consoleErrors }) => {
  const mode = () => clientFetch(`${BASE}/api/role-models`).then((r) => r.json()).then((v: any) => v.review_mode);
  try {
    await openLive(page, 'new');
    const picker = page.getByTestId('review-mode');
    await expect(picker.getByLabel('Review before delivery')).toHaveValue('auto');
    await expect(picker).toContainText('checks whether Copilot has reviewed recent PRs');
    await picker.getByLabel('Review before delivery').selectOption('ci_only');
    await expect(picker).toContainText('No Copilot review is requested');
    await expect.poll(mode).toBe('ci_only');
    await openLive(page, 'models');
    await expect(page.getByTestId('review-mode').getByLabel('Review before delivery')).toHaveValue('ci_only');
    await page.getByTestId('review-mode').getByLabel('Review before delivery').selectOption('copilot');
    await expect.poll(mode).toBe('copilot');
    const bad = await clientFetch(`${BASE}/api/review-mode`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'whenever' }) });
    expect(bad.status).toBe(400);
    expect(consoleErrors.splice(0).every((e) => /status of 400/.test(e))).toBe(true);
  } finally {
    await clientFetch(`${BASE}/api/review-mode`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'auto' }) });
  }
});

test('a request still waiting for the runner shows as queued on Jobs and can be cancelled there or on the form, so it never starts', async ({ page, consoleErrors: _ }) => {
  const api = (path: string) => clientFetch(`${BASE}${path}`).then((r) => r.json());
  await runner();
  await openLive(page, 'new');
  await page.getByTestId('mode-prompt').click();
  const prompt = `Wrong repository (${Date.now()})`;
  await page.getByTestId('job-prompt').fill(prompt);
  await page.getByTestId('job-repo').fill(REPO);
  await page.getByTestId('job-submit').click();
  await expect(page.getByTestId('start-status')).toHaveAttribute('data-state', 'queued');
  await page.getByTestId('start-cancel').click();
  await expect(page.getByTestId('start-status')).toHaveCount(0);
  await expect(page.getByTestId('job-submit')).toBeEnabled();
  await expect(page.locator('[data-testid="job-requests"] tr', { hasText: prompt })).toHaveAttribute('data-status', 'cancelled');

  // A second one is cancelled from the Jobs page, where it is listed as queued.
  await page.getByTestId('job-prompt').fill(`${prompt} again`);
  await page.getByTestId('job-submit').click();
  await expect(page.getByTestId('start-status')).toHaveAttribute('data-state', 'queued');
  await openLive(page, 'jobs');
  const row = page.getByTestId('request-row').filter({ hasText: `${prompt} again` });
  await expect(row).toHaveAttribute('data-status', 'queued');
  await row.getByTestId('request-cancel').click();
  await expect(row).toHaveCount(0);

  expect(await runner()).toEqual([]);
  const mine = (await api('/api/job-requests')).filter((r: any) => String(r.prompt).startsWith(prompt));
  expect(mine.map((r: any) => r.status)).toEqual(['cancelled', 'cancelled']);
});

test('a request the runner has taken no longer offers Cancel, though it stays queued until the runner reports', async ({ page, consoleErrors: _ }) => {
  await runner();
  await openLive(page, 'new');
  await page.getByTestId('mode-prompt').click();
  const prompt = `Taken by the runner (${Date.now()})`;
  await page.getByTestId('job-prompt').fill(prompt);
  await page.getByTestId('job-repo').fill(REPO);
  await page.getByTestId('job-submit').click();
  await expect(page.getByTestId('start-cancel')).toBeVisible();
  // The runner takes the launch and has not reported yet.
  const res = await fetch(`${BASE}/api/runner/next`, { method: 'POST', headers: { authorization: `Bearer ${RUNNER_KEY}`, 'content-type': 'application/json' }, body: '{}' });
  const { launch } = await res.json();
  expect(launch).toBeTruthy();
  try {
    await expect(page.getByTestId('start-cancel')).toHaveCount(0);
    await expect(page.locator('[data-testid="job-requests"] tr', { hasText: prompt })).toHaveAttribute('data-status', 'queued');
    await expect(page.locator('[data-testid="job-requests"] tr', { hasText: prompt }).getByTestId('request-cancel')).toHaveCount(0);
    await openLive(page, 'jobs');
    await expect(page.getByTestId('request-row').filter({ hasText: prompt })).toHaveCount(0);
  } finally {
    await fetch(`${BASE}/api/runner/${launch.id}/done`, { method: 'POST', headers: { authorization: `Bearer ${RUNNER_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ result: 'ok: started' }) });
  }
});
