import { test as base, expect, type Page } from '@playwright/test';
import { BASE, clientFetch, PASSWORD, SimAgent } from './sim.ts';

export { BASE, clientFetch, KEY, PASSWORD, RUNNER_KEY, SimAgent, spawnSenior, staffWithJob } from './sim.ts';

/** Fails the test on any console error or uncaught page error, like a production console check. */
export const test = base.extend<{ consoleErrors: string[]; agents: SimAgent[] }>({
  // Every test starts logged in, the way the Client is after the login form. login.spec.ts tests the form itself.
  page: async ({ page }, use) => {
    const res = await page.request.post('/api/login', { data: { password: PASSWORD } });
    expect(res.ok(), 'e2e login').toBe(true);
    // The room's Architect starts as a rail; the tests that talk to it want it open, so the width is Side unless a test
    // stored one itself. architect-rail.spec.ts tests the rail.
    await page.addInitScript(() => {
      if (localStorage.getItem('triglav.architect-width') === null) localStorage.setItem('triglav.architect-width', 'side');
    });
    await use(page);
  },
  consoleErrors: async ({ page }, use) => {
    const errors: string[] = [];
    page.on('console', (msg) => msg.type() === 'error' && errors.push(msg.text()));
    page.on('pageerror', (err) => errors.push(err.message));
    await use(errors);
    expect(errors, 'browser console errors').toEqual([]);
  },
  agents: async ({}, use) => {
    const list: SimAgent[] = [];
    await use(list);
    await Promise.all(list.map((a) => a.close()));
  },
});

export { expect };

/** Opens a dashboard route and waits for the live stream, so later changes arrive without a reload. */
export async function openLive(page: Page, hash: string) {
  await page.goto(`/#/${hash}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('live-status')).toHaveAttribute('data-connected', 'true');
}

/**
 * Picks a job card on the room's Plan tab by its title and returns the card's detail (its design and its job). A card in a
 * folded delivered wave is shown first; a card that is already picked stays picked.
 */
export async function openCard(page: Page, title: string) {
  await expect(page.getByTestId('plan-map')).toBeVisible();
  const tile = page.getByTestId('plan-tile').filter({ has: page.locator('.plan-tile-title', { hasText: title }) });
  if ((await tile.count()) === 0 && (await page.getByTestId('plan-folded').count()) > 0) await page.getByTestId('plan-folded').first().click();
  if ((await tile.getAttribute('aria-pressed')) !== 'true') await tile.click();
  const card = page.getByTestId('plan-card');
  await expect(card.getByTestId('design-block')).toHaveAttribute('data-id', (await tile.getAttribute('data-key'))!);
  return card;
}

/** Cancels a parent job so its Seniors release their slots for later tests. */
export async function cleanup(parentId: string) {
  await clientFetch(`${BASE}/api/jobs/${parentId}/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'cancel', reason: 'e2e cleanup' }) }).catch(() => {});
}
