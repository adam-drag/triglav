import { readFileSync } from 'node:fs';
import { BASE, clientFetch, expect, openCard, test } from './fixtures.ts';
import { card } from './initiative-runner.ts';

// The room's Design outline, the Plan tab's wave map and the Architect's widths, on the long public-template-pages design.

/** Seeds the public-template-pages design (v17) under a fresh key, as initiatives.spec.ts does. */
async function seed(): Promise<string> {
  const fixture = JSON.parse(readFileSync('e2e/fixtures/public-template-pages.json', 'utf8'));
  const key = `plan-${Date.now().toString(36)}`;
  const repos = fixture.repos.map((r: { slug: string }) => ({ slug: r.slug, path: `/nonexistent-e2e/${r.slug}`, base: 'main' }));
  const res = await clientFetch(`${BASE}/api/initiatives`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...fixture, key, repos }) });
  expect(res.status).toBe(200);
  return key;
}

test('the Design tab lists decisions as rows that open, with an outline and a filter', async ({ page, consoleErrors: _ }) => {
  const key = await seed();
  await page.goto(`/#/initiatives/${key}`);
  await expect(page.getByTestId('room-version')).toHaveValue('17');

  // The overview is open; a decision shows its title and not its body until it is opened.
  await expect(page.locator('[data-testid="design-block"][data-id="T-problem"] [data-block="T-problem"]')).toBeVisible();
  const d13 = page.locator('[data-testid="design-block"][data-id="D13"]');
  await expect(d13).toContainText('The public page is a path on the app host');
  await expect(d13.locator('[data-block="D13"]')).toHaveCount(0);
  await d13.getByTestId('block-toggle').click();
  await expect(d13.getByTestId('block-toggle')).toHaveAttribute('aria-expanded', 'true');
  await expect(d13.locator('[data-block="D13"]')).toContainText('Adam chose this on 2026-11-11.');

  // The outline counts each section; waves and cards are on the Plan tab.
  const outline = page.getByTestId('design-outline');
  await expect(outline.locator('[data-testid="outline-link"][data-kind="decision"]')).toContainText('16');
  await expect(outline.locator('[data-testid="outline-link"][data-kind="open"]')).toContainText('9');
  await expect(page.locator('[data-testid="design-section"][data-kind="wave"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="design-block"][data-id="public-run-loop"]')).toHaveCount(0);

  // The filter narrows every section, and the counts say how many are left.
  await page.getByTestId('design-filter').fill('token-store');
  await expect(page.locator('[data-testid="design-section"][data-kind="open"] [data-testid="design-block"]')).toHaveCount(1);
  await expect(page.locator('[data-testid="design-section"][data-kind="open"] [data-testid="design-block"]')).toHaveAttribute('data-id', 'O-host');
  await expect(outline.locator('[data-testid="outline-link"][data-kind="open"]')).toContainText('1 of 9');
  await page.getByTestId('design-filter').fill('');

  // Open all opens every decision, and the outline's Plan link opens the Plan tab.
  const decisions = page.locator('[data-testid="design-section"][data-kind="decision"]');
  await decisions.getByTestId('section-toggle-all').click();
  await expect(decisions.locator('[data-testid="block-toggle"][aria-expanded="false"]')).toHaveCount(0);
  await page.getByTestId('outline-plan').click();
  await expect(page.getByTestId('plan-map')).toBeVisible();
});

test('the Plan tab maps the cards by milestone and wave, folds delivered waves and opens a card', async ({ page, consoleErrors: _ }) => {
  const key = await seed();
  await page.goto(`/#/initiatives/${key}`);
  await page.getByTestId('tab-plan').click();
  await expect(page.getByTestId('plan-group')).toHaveCount(2);
  await expect(page.getByTestId('plan-group').first()).toContainText('Milestone A');
  await expect(page.getByTestId('plan-group').nth(1)).toContainText('Milestone B');

  // Waves whose cards are all delivered are folded; Show them brings their cards back.
  const tile = page.locator('[data-testid="plan-tile"][data-key="public-run-loop"]');
  await expect(page.getByTestId('plan-folded').first()).toBeVisible();
  await expect(tile).toHaveCount(0);
  await page.getByTestId('plan-folded').first().click();
  await expect(tile).toHaveAttribute('data-state', 'delivered');

  // A picked card shows its design with the long lists closed except the scope, its job, and the cards that wait for it.
  const card = await openCard(page, "Recalculate in the visitor's browser when an input changes");
  await expect(card.locator('[data-testid="card-list"][data-list="scope"]')).toHaveAttribute('open', '');
  await expect(card.locator('[data-testid="card-list"][data-list="scope"] summary')).toContainText('11');
  await expect(card.locator('[data-testid="card-list"][data-list="traps"]')).not.toHaveAttribute('open', '');
  await expect(card.getByTestId('job-card')).toHaveAttribute('data-state', 'delivered');
  await expect(card.getByTestId('plan-unlocks')).toContainText('edit-prompt');
  await expect(page.locator('[data-testid="plan-tile"][data-key="edit-prompt"]')).toHaveClass(/unlocks/);

  // Milestone B can be hidden from the map.
  await page.getByTestId('plan-milestone').filter({ hasText: 'Milestone B' }).click();
  await expect(page.getByTestId('plan-group')).toHaveCount(1);
});

test('the Architect starts as a rail, keeps the chosen width, and opens for a quote and the \\ key', async ({ page, consoleErrors: _ }) => {
  const key = await seed();
  await page.goto(`/#/initiatives/${key}`);
  // The fixtures store Side for every test; this one starts with no stored width, as a new browser does.
  await page.evaluate(() => localStorage.setItem('triglav.architect-width', 'rail'));
  await page.reload();
  const pane = page.getByTestId('architect-pane');
  await expect(pane).toHaveAttribute('data-width', 'rail');
  await expect(page.getByTestId('architect-rail')).toBeVisible();
  await expect(page.getByLabel('Message')).toBeHidden();

  await page.getByTestId('architect-open').click();
  await expect(pane).toHaveAttribute('data-width', 'side');
  await page.getByTestId('architect-width-wide').click();
  await expect(pane).toHaveAttribute('data-width', 'wide');
  const wide = await pane.evaluate((el) => el.getBoundingClientRect().width);
  await page.reload();
  await expect(pane).toHaveAttribute('data-width', 'wide');
  expect(await pane.evaluate((el) => el.getBoundingClientRect().width)).toBeCloseTo(wide, 0);

  // The \ key folds it and opens it at the last width; it does nothing while the Client types.
  await page.keyboard.press('\\');
  await expect(pane).toHaveAttribute('data-width', 'rail');
  await page.keyboard.press('\\');
  await expect(pane).toHaveAttribute('data-width', 'wide');
  await page.getByLabel('Message').press('\\');
  await expect(page.getByLabel('Message')).toHaveValue('\\');
  await expect(pane).toHaveAttribute('data-width', 'wide');
  await page.getByLabel('Message').fill('');

  // A Quote on a folded pane opens it, so the chip is in view.
  await page.getByTestId('architect-width-rail').click();
  await page.locator('[data-testid="design-block"][data-id="D16"]').getByTestId('quote-block').click();
  await expect(pane).toHaveAttribute('data-width', 'wide');
  await expect(page.getByTestId('quote-chips')).toContainText('D16.body v17');
});

test('a message that arrives while the Architect is a rail puts a dot on it', async ({ page, consoleErrors: _ }) => {
  const key = await seed();
  await page.goto(`/#/initiatives/${key}`);
  await page.evaluate(() => localStorage.setItem('triglav.architect-width', 'rail'));
  await page.reload();
  await expect(page.getByTestId('architect-rail')).toBeVisible();
  await expect(page.getByTestId('architect-unseen')).toHaveCount(0);
  const got = await (await clientFetch(`${BASE}/api/initiatives/${key}`)).json();
  const res = await clientFetch(`${BASE}/api/architect-chats/${String(got.initiative.chat_id)}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Sent from another tab', refs: [] }) });
  expect(res.ok, await res.clone().text()).toBe(true);
  await expect(page.getByTestId('architect-unseen')).toBeVisible();
  // Opening the pane reads it, and the dot is gone when the pane folds again.
  await page.getByTestId('architect-rail-chat').click();
  await expect(page.getByTestId('chat-client').last()).toContainText('Sent from another tab');
  await page.getByTestId('architect-width-rail').click();
  await expect(page.getByTestId('architect-unseen')).toHaveCount(0);
});

test('at 375 px the Plan tab does not scroll the page sideways', async ({ page, consoleErrors: _ }) => {
  const key = await seed();
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto(`/#/initiatives/${key}`);
  await page.getByTestId('tab-plan').click();
  await expect(page.getByTestId('plan-map')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  // The map scrolls inside its own box.
  expect(await page.getByTestId('plan-map').evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
});

test('Plan shows no job controls while the current version is still loading after an older one', async ({ page, consoleErrors: _ }) => {
  const key = await seed();
  // Starting milestone B writes v18, so v17 becomes an older version.
  const started = await clientFetch(`${BASE}/api/initiatives/${key}/milestones/B/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  expect(started.ok, await started.clone().text()).toBe(true);
  await page.goto(`/#/initiatives/${key}`);
  await expect(page.getByTestId('room-version')).toHaveValue('18');
  await page.getByTestId('tab-plan').click();
  const card = await openCard(page, "Recalculate in the visitor's browser when an input changes");
  await expect(card.getByTestId('job-card')).toBeVisible();
  await page.getByTestId('room-version').selectOption('17');
  await expect(page.getByText('This is an older version.')).toBeVisible();
  await expect(card.getByTestId('job-card')).toHaveCount(0);

  // The current version's read is held back, so the v17 design is still on screen: no state, no Start, no Mark met.
  let release: () => void = () => {};
  const held = new Promise<void>((r) => (release = r));
  await page.route((u) => u.pathname === `/api/initiatives/${key}` && u.search === '', async (route) => {
    await held;
    await route.continue();
  });
  await page.getByTestId('room-version').selectOption('18');
  await expect(page.getByText('This is an older version.')).toBeVisible();
  await expect(card.getByTestId('job-card')).toHaveCount(0);
  release();
  await expect(page.getByTestId('room-version')).toHaveValue('18');
  await expect(card.getByTestId('job-card')).toBeVisible();
});

test('a card that waits for a deploy is listed under the card it waits for', async ({ page, consoleErrors: _ }) => {
  const key = `plan-deploy-${Date.now().toString(36)}`;
  const repo = { slug: 'app', path: `/nonexistent-e2e/${key}`, base: 'main', github: 'owner/app', deploy: { workflow: 'deploy.yml', job: 'deploy-prod', step: 'Deploy', note: 'e2e' } };
  const doc = {
    format: 1,
    title: 'Deploy wait',
    blocks: [
      { kind: 'wave', id: 'W-1', title: 'Wave one', when: 'Now', jobs: ['a', 'b', 'c'] },
      card('a', 'PDF endpoint', []),
      card('b', 'Export button', [{ kind: 'merged', job: 'a' }], ['a']),
      card('c', 'Release page', [{ kind: 'deployed', repo: 'app', after: 'a' }]),
    ],
  };
  const res = await clientFetch(`${BASE}/api/initiatives`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key, title: `Deploy ${key}`, repos: [repo], source: 'e2e', doc }) });
  expect(res.status, await res.clone().text()).toBe(200);
  await page.goto(`/#/initiatives/${key}`);
  await page.getByTestId('tab-plan').click();
  const picked = await openCard(page, 'PDF endpoint');
  await expect(picked.getByTestId('plan-unlocks').locator('button')).toHaveText(['b', 'c']);
  await expect(page.locator('[data-testid="plan-tile"][data-key="c"]')).toHaveClass(/unlocks/);
});

test('on Plan, a selection in a card goal is quoted, and a wave opens with its timing, checkpoint and Quote', async ({ page, consoleErrors: _ }) => {
  const key = await seed();
  await page.goto(`/#/initiatives/${key}`);
  await page.getByTestId('tab-plan').click();
  await openCard(page, "Recalculate in the visitor's browser when an input changes");
  const words = 'A visitor edits an input and sees dependent MathJS and Python outputs update in the browser.';
  // The popover sits over the selection, so the goal must be on screen, as it is when the Client selects it.
  const goal = page.locator('[data-block="public-run-loop"][data-field="goal"]');
  await goal.scrollIntoViewIfNeeded();
  await goal.evaluate((el, want) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const at = (n.textContent ?? '').indexOf(want);
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(n, at);
      range.setEnd(n, at + want.length);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      return;
    }
    throw new Error('the goal does not hold the selected words');
  }, words);
  await page.getByTestId('quote-selection').click();
  await expect(page.getByTestId('quote-chips')).toContainText('public-run-loop.goal v17');

  // A wave's name opens the wave: when it runs, the checkpoint after it, its cards, and a Quote of its timing.
  await page.locator('[data-testid="plan-wave"][data-key="W-5"]').click();
  const wave = page.getByTestId('plan-card');
  await expect(wave).toHaveAttribute('data-key', 'W-5');
  await expect(wave.locator('[data-block="W-5"][data-field="when"]')).toContainText('Now: all three can start, in parallel.');
  await expect(wave.getByTestId('wave-checkpoint')).toContainText('Then Client checkpoint CP-A: Checkpoint A: publish the first link by hand.');
  await wave.getByTestId('quote-block').click();
  await expect(page.getByTestId('quote-chips')).toContainText('W-5.when v17');
});

test('a rail opened on a chat with history shows no dot until something new arrives', async ({ page, consoleErrors: _ }) => {
  const key = await seed();
  const got = await (await clientFetch(`${BASE}/api/initiatives/${key}`)).json();
  const chat = String(got.initiative.chat_id);
  const post = (text: string) => clientFetch(`${BASE}/api/architect-chats/${chat}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, refs: [] }) });
  expect((await post('Written before the room opened')).ok).toBe(true);
  await page.goto(`/#/initiatives/${key}`);
  await page.evaluate(() => localStorage.setItem('triglav.architect-width', 'rail'));
  await page.reload();
  // The history has loaded (the folded log holds it), and it lights nothing.
  await expect(page.getByTestId('chat-client')).toHaveCount(1);
  await expect(page.getByTestId('architect-unseen')).toHaveCount(0);
  expect((await post('Written while the rail was folded')).ok).toBe(true);
  await expect(page.getByTestId('architect-unseen')).toBeVisible();
});

test('a picked card starts with its own lists: Scope open and the others closed', async ({ page, consoleErrors: _ }) => {
  const key = await seed();
  await page.goto(`/#/initiatives/${key}`);
  await page.getByTestId('tab-plan').click();
  const first = await openCard(page, "Recalculate in the visitor's browser when an input changes");
  await first.locator('[data-testid="card-list"][data-list="scope"] summary').click();
  await first.locator('[data-testid="card-list"][data-list="traps"] summary').click();
  await expect(first.locator('[data-testid="card-list"][data-list="traps"]')).toHaveAttribute('open', '');
  const next = await openCard(page, 'Build page.json from a built-in version, behind the publish gate');
  await expect(next.locator('[data-testid="card-list"][data-list="scope"]')).toHaveAttribute('open', '');
  await expect(next.locator('[data-testid="card-list"][data-list="traps"]')).not.toHaveAttribute('open', '');
});

test('while a new design version and its job states load one after the other, Plan shows no job controls', async ({ page, consoleErrors: _ }) => {
  const key = await seed();
  await page.goto(`/#/initiatives/${key}`);
  await expect(page.getByTestId('live-status')).toHaveAttribute('data-connected', 'true');
  await page.getByTestId('tab-plan').click();
  const card = await openCard(page, "Recalculate in the visitor's browser when an input changes");
  await expect(card.getByTestId('job-card')).toBeVisible();

  // The job states of the new version are held back, so the room has v18's design and v17's states for a while.
  let release: () => void = () => {};
  const held = new Promise<void>((r) => (release = r));
  await page.route((u) => u.pathname === `/api/initiatives/${key}/jobs`, async (route) => {
    await held;
    await route.continue();
  });
  // The Client starts milestone B in the room, which writes v18 and reloads the design and the job states.
  await page.getByTestId('milestone-start').click();
  await page.getByTestId('milestone-start-submit').click();
  await expect(page.getByTestId('room-version')).toHaveValue('18');
  await expect(card.getByTestId('job-card')).toHaveCount(0);
  release();
  await expect(card.getByTestId('job-card')).toBeVisible();
});

test('opening a folded Architect shows the latest message of a long chat', async ({ page, consoleErrors: _ }) => {
  const key = await seed();
  const got = await (await clientFetch(`${BASE}/api/initiatives/${key}`)).json();
  const chat = String(got.initiative.chat_id);
  for (let n = 1; n <= 6; n++) {
    const text = `Message ${n}. ${'A long line of text that makes the chat taller than its pane. '.repeat(20)}`;
    const res = await clientFetch(`${BASE}/api/architect-chats/${chat}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, refs: [] }) });
    expect(res.ok, await res.clone().text()).toBe(true);
  }
  await page.goto(`/#/initiatives/${key}`);
  await page.evaluate(() => localStorage.setItem('triglav.architect-width', 'rail'));
  await page.reload();
  // The history loads into the folded log, then the pane opens.
  await expect(page.getByTestId('chat-client')).toHaveCount(6);
  await page.getByTestId('architect-open').click();
  await expect(page.getByTestId('chat-client').last()).toBeInViewport();
  await expect(page.getByTestId('chat-client').first()).not.toBeInViewport();
});
