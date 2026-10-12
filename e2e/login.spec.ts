import { expect as baseExpect, test as base } from '@playwright/test';
import { BASE, PASSWORD, RUNNER_KEY } from './sim.ts';

// These tests start logged out, so they do not use the fixtures that log in.
const test = base;
const expect = baseExpect;

test('the dashboard shows the login form, refuses a wrong password, and opens with the right one', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // A Content-Security-Policy violation is reported as a console error.
  page.on('console', (m) => m.type() === 'error' && /Content.Security|Refused to/i.test(m.text()) && errors.push(m.text()));
  await page.goto('/#/');
  await expect(page.getByTestId('login')).toBeVisible();
  await expect(page.getByTestId('live-status')).toHaveCount(0);

  await page.getByLabel('Password').fill('not the password');
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('login-error')).toContainText('Wrong password');
  await expect(page.getByTestId('login')).toBeVisible();

  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('live-status')).toHaveAttribute('data-connected', 'true');

  // The cookie keeps the session across a reload, and it cannot be read by the page.
  await page.reload();
  await expect(page.getByTestId('live-status')).toHaveAttribute('data-connected', 'true');
  expect(await page.evaluate(() => document.cookie)).toBe('');
  const cookie = (await page.context().cookies()).find((c) => c.name === 'triglav_session')!;
  expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Strict' });

  // Logging out ends the session on the server too.
  await page.getByTestId('logout').click();
  await expect(page.getByTestId('login')).toBeVisible();
  const after = await page.request.get('/api/jobs', { headers: { cookie: `triglav_session=${cookie.value}` } });
  expect(after.status()).toBe(401);
  expect(errors).toEqual([]);
});

test('the dashboard API answers 401 without a session, even with no Origin header, and the runner key does not open it', async () => {
  for (const [method, path] of [['GET', '/api/jobs'], ['GET', '/api/chats'], ['POST', '/api/jobs/x/approve'], ['POST', '/api/chats/cht_0/actions/act_0'], ['POST', '/api/blockers/blk_0/resolve']] as const) {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
    expect(res.status, `${method} ${path}`).toBe(401);
  }
  const withRunnerKey = await fetch(`${BASE}/api/jobs`, { headers: { authorization: `Bearer ${RUNNER_KEY}` } });
  expect(withRunnerKey.status).toBe(401);
});

test('the dashboard page carries a Content-Security-Policy that blocks outside sources', async ({ page }) => {
  const res = await page.goto('/');
  const csp = res!.headers()['content-security-policy'] ?? '';
  expect(csp).toContain("default-src 'self'");
  expect(csp).not.toContain('unsafe-inline');
});
