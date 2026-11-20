import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BASE, clientFetch, expect, SimAgent, test } from './fixtures.ts';
import { ArchitectSim } from './architect-sim.ts';
import { card, runnerCall, serveRunner, startAndDeliver, startCard, stateOf } from './initiative-runner.ts';

// The dates of the room are printed with the browser's locale (web/src/api.ts fmt), so the spec pins it.
test.use({ locale: 'en-US' });

/** Seeds the public-template-pages design (v17) under a fresh key, with repositories that point nowhere. */
async function seed(): Promise<string> {
  const fixture = JSON.parse(readFileSync('e2e/fixtures/public-template-pages.json', 'utf8'));
  const key = `p5-${Date.now().toString(36)}`;
  const repos = fixture.repos.map((r: { slug: string }) => ({ slug: r.slug, path: `/nonexistent-e2e/${r.slug}`, base: 'main' }));
  const res = await clientFetch(`${BASE}/api/initiatives`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...fixture, key, repos }) });
  expect(res.status).toBe(200);
  return key;
}

const PLAIN = 'Adam decided this in a meeting on 2026-11-13, with these answers on the same day.';

test('a Quote button and a selection put chips in the Architect composer, and the message holds the stored text', async ({ page }) => {
  const key = await seed();
  await page.goto(`/#/initiatives/${key}`);
  await expect(page.getByTestId('room-version')).toHaveValue('17');
  await page.locator('[data-testid="design-block"][data-id="D16"]').getByTestId('quote-block').click();
  await expect(page.getByTestId('quote-chips')).toContainText('D16.body v17');
  // A selection of plain words in the same block: the popover quotes exactly that text.
  await page.locator('[data-block="D16"][data-field="body"]').evaluate((el, want) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const at = (n.textContent ?? '').indexOf(want);
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(n, at);
      range.setEnd(n, at + want.length);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      return;
    }
    throw new Error('the selected words are not in the block');
  }, PLAIN);
  await page.getByTestId('quote-selection').click();
  await expect(page.getByTestId('quote-chips').locator('li')).toHaveCount(2);
  // The chip shows a shortened label; the full quoted text is checked in the message the Architect gets.
  await expect(page.getByTestId('quote-chips')).toContainText('Adam decided this in a meeting');

  await page.getByLabel('Message').fill('Is this still right?');
  await page.getByTestId('chat-send').click();
  // The chips leave the composer once sent, and the message the Architect gets quotes the stored text as data.
  await expect(page.getByTestId('quote-chips')).toHaveCount(0);
  await expect(page.getByTestId('chat-client').last()).toContainText('Reference 2: D16.body, design v17');
  await expect(page.getByTestId('chat-client').last()).toContainText(`> ${PLAIN}`);
  await expect(page.getByTestId('chat-client').last()).toContainText('Is this still right?');
});

test('the room has no horizontal scroll at 375 px, and the chat toggle works', async ({ page }) => {
  const key = await seed();
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto(`/#/initiatives/${key}`);
  await expect(page.getByTestId('room-version')).toHaveValue('17');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByTestId('pane-architect').click();
  await expect(page.getByTestId('architect-pane')).toBeVisible();
  await expect(page.getByTestId('design')).toBeHidden();
  await page.getByTestId('pane-design').click();
  await expect(page.getByTestId('design')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('Download as markdown links to the chosen version, which the Client session fetches as a file', async ({ page }) => {
  const key = await seed();
  await page.goto(`/#/initiatives/${key}`);
  await expect(page.getByTestId('room-version')).toHaveValue('17');
  const href = await page.getByTestId('download-markdown').getAttribute('href');
  expect(href).toBe(`/api/initiatives/${key}/versions/17/markdown`);
  const res = await clientFetch(`${BASE}${href}`);
  expect(res.status).toBe(200);
  expect(res.headers.get('content-disposition')).toContain('attachment');
  expect(await res.text()).toContain('## D16');
});

/** Seeds a design of this test under a fresh key, with a repository that points nowhere and a GitHub slug for the checks. */
async function seedDesign(prefix: string, doc: unknown): Promise<string> {
  const key = `${prefix}-${Date.now().toString(36)}`;
  const repo = { slug: 'app', path: `/nonexistent-e2e/${key}`, base: 'main', github: 'owner/app' };
  const res = await clientFetch(`${BASE}/api/initiatives`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key, title: `Phase 5 ${key}`, repos: [repo], source: 'e2e', doc }) });
  expect(res.status, await res.clone().text()).toBe(200);
  return key;
}

const cardOf = (page: import('@playwright/test').Page, title: string) => page.getByTestId('job-card').filter({ has: page.locator('strong', { hasText: title }) });

test('a your-step card shows its steps, and a Copy button for the first command of a step', async ({ page }) => {
  const key = await seedDesign('p5-steps', {
    format: 1,
    title: 'Your step',
    blocks: [
      { kind: 'wave', id: 'W-1', title: 'Wave one', when: 'Now', jobs: ['a'] },
      { kind: 'checkpoint', id: 'CP-A', title: 'Check the deploy', steps: ['Run `npm run deploy` from the app folder', 'Check the page loads'] },
      card('a', 'PDF endpoint', [{ kind: 'client_step', ref: 'CP-A' }]),
    ],
  });
  await page.goto(`/#/initiatives/${key}`);
  await page.getByTestId('tab-jobs').click();
  const job = cardOf(page, 'PDF endpoint');
  await expect(job).toHaveAttribute('data-state', 'your_step');
  const yourStep = job.getByTestId('your-step');
  await expect(yourStep).toContainText('Run npm run deploy from the app folder');
  await expect(yourStep).toContainText('Check the page loads');
  // Only the first step has a command, so only one Copy button, and the code it copies is the command.
  await expect(yourStep.getByTestId('copy-command')).toHaveCount(1);
  await expect(yourStep.locator('code')).toHaveText('npm run deploy');
});

test('a merged gate that a check marked puts the PR and merge date on the card whose job merged, and the waiting card keeps its line', async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), 'phase5-merged-'));
  const key = await seedDesign('p5-merged', {
    format: 1,
    title: 'Merged source',
    blocks: [
      { kind: 'wave', id: 'W-1', title: 'Wave one', when: 'Now', jobs: ['a', 'b'] },
      card('a', 'PDF endpoint', []),
      card('b', 'Export button', [{ kind: 'merged', job: 'a' }], ['a']),
    ],
  });
  const MERGE = 'f'.repeat(40);
  await startAndDeliver(key, 51);
  // The loop stops when card b is Ready, which only the checked merge of card a makes it.
  await serveRunner({ prNumber: 51, mergeSha: MERGE, dir, done: async () => (await stateOf(key, 'b')) === 'ready', timeoutMs: 170_000 });

  await page.goto(`/#/initiatives/${key}`);
  const source = page.locator('[data-testid="design-block"][data-id="a"]');
  const line = source.getByTestId('source-merged');
  await expect(line).toHaveCount(1);
  await expect(line).toContainText('Merged (checked)');
  await expect(line.getByRole('link', { name: 'PR' })).toHaveAttribute('href', 'https://github.com/owner/app/pull/51');
  // The merge day is the stub's mergedAt (2026-11-19T09:00:00Z), printed by the room in the browser's locale.
  const mergedDay = new Date('2026-11-19T09:00:00Z').toLocaleString('en-US', { month: 'short', day: 'numeric' });
  await expect(line).toContainText(`merged ${mergedDay}`);
  // The waiting card keeps its own line, which names the card whose merge it is, and the same day.
  const waiting = page.locator('[data-testid="design-block"][data-id="b"]').getByTestId('merged-gate');
  await expect(waiting).toContainText('Merged gate a (checked)');
  await expect(waiting).toContainText(`merged ${mergedDay}`);
});

test('a delegated answer with a code citation shows its Checked line in the Inbox', async ({ page }) => {
  const SHA = 'c'.repeat(40);
  const key = await seedDesign('p5-cited', {
    format: 1,
    title: 'Cited fact',
    blocks: [
      { kind: 'wave', id: 'W-1', title: 'Wave one', when: 'Now', jobs: ['a'] },
      card('a', 'PDF endpoint', []),
    ],
  });
  const got = await (await clientFetch(`${BASE}/api/initiatives/${key}`)).json();
  const chatId = String(got.initiative.chat_id);

  // Staff starts the card and raises a client decision on its job.
  const started = await startCard(key, 'a');
  await runnerCall(`/api/runner/${started.launch_id}/done`, { result: 'ok: started' });
  const staff = await SimAgent.register({ role: 'staff', nickname: `p5-cited-${Date.now().toString(36)}`, runtime: 'claude-code' });
  const job = await staff.call('register_job', { request_id: started.request_id, title: 'PDF endpoint' });
  const jobId = String(job.job_id);
  const blocker = await staff.call('raise_blocker', {
    job_id: jobId,
    kind: 'client_decision',
    requested_decision: 'Keep the old file name?',
    recommendation: 'Keep the old name.',
    unblock_condition: 'The Client answers the question.',
  });

  // The Architect answers from the code: the runner checks the quote at the sha before the answer is posted.
  const { token } = await runnerCall(`/api/runner/chat/${chatId}/token`);
  const architect = await ArchitectSim.connect(token);
  const cited = await architect.call('answer_staff_question', {
    job_id: jobId,
    blocker_id: String(blocker.blocker_id),
    answer: 'Keep the old name, as src/pdf.ts does.',
    citation: { code: { repo: 'app', path: 'src/pdf.ts', line: 3, sha: SHA, quote: 'export function renderPdf' } },
  });
  expect(cited.state).toBe('checking');
  let check: any = null;
  for (let i = 0; i < 30 && !check; i++) {
    const { launch } = await runnerCall('/api/runner/next');
    if (!launch) continue;
    if (launch.kind === 'quote_check' && launch.sha === SHA && launch.path === 'src/pdf.ts') check = launch;
    // A launch this test does not answer (a gate check left by the merge test, say) is finished, so it does not hold the queue.
    else await runnerCall(`/api/runner/${launch.id}/done`, { result: 'not answered by this test' });
  }
  expect(check, 'the quote_check launch for the cited answer').toBeTruthy();
  await runnerCall(`/api/runner/${check.id}/quote-output`, { code: 0, stdout: 'import x from "y";\n\nexport function renderPdf(doc) {}\n', stderr: '' });

  // The answer is posted and listed in the Inbox, with the commit and the age of the check.
  await page.goto(`/#/initiatives/${key}`);
  await page.getByTestId('tab-inbox').click();
  const row = page.getByTestId('answer-row').filter({ has: page.getByTestId('cited-fact') });
  await expect(row).toHaveCount(1);
  // The age counts from the time the check was decided, so it reads in minutes for a check made in this test.
  await expect(row.getByTestId('cited-fact')).toContainText(/Checked: src\/pdf\.ts:3 at cccccccccccc \(app\), verified \d+ min ago/);
});
