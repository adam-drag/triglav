import { test as base, expect, type Page } from '@playwright/test';
import { BASE, clientFetch, PASSWORD, SimAgent } from './sim.ts';

export { BASE, clientFetch, KEY, PASSWORD, RUNNER_KEY, SimAgent, spawnSenior, staffWithJob } from './sim.ts';

/** Fails the test on any console error or uncaught page error, like a production console check. */
export const test = base.extend<{ consoleErrors: string[]; agents: SimAgent[] }>({
  // Every test starts logged in, the way the Client is after the login form. login.spec.ts tests the form itself.
  page: async ({ page }, use) => {
    const res = await page.request.post('/api/login', { data: { password: PASSWORD } });
    expect(res.ok(), 'e2e login').toBe(true);
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

/** Cancels a parent job so its Seniors release their slots for later tests. */
export async function cleanup(parentId: string) {
  await clientFetch(`${BASE}/api/jobs/${parentId}/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'cancel', reason: 'e2e cleanup' }) }).catch(() => {});
}
