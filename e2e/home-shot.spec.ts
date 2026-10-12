import { cleanup, expect, openLive, SimAgent, spawnSenior, staffWithJob, test } from './fixtures.ts';

// Screenshot of a busy live map, for comparing designs. Runs only with HOME_SHOT=<file.png>.
test('live map screenshot', async ({ page, consoleErrors: _, agents }) => {
  test.skip(!process.env.HOME_SHOT, 'set HOME_SHOT to a file path');
  await page.setViewportSize({ width: 1680, height: 1050 });
  const one = await staffWithJob('safety');
  const two = await staffWithJob('plan');
  const senior = await spawnSenior(one.staff, one.a, 'senior-safety');
  const researcher = await SimAgent.register({ role: 'researcher', nickname: 'Main', focus: 'decisions' });
  agents.push(one.staff, two.staff, senior, researcher);
  try {
    await one.staff.call('raise_blocker', { job_id: one.b, kind: 'client_decision', requested_decision: 'Ship it?', unblock_condition: 'Client answers' });
    await openLive(page, 'live');
    await expect(page.getByTestId('live-map')).toBeVisible();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: process.env.HOME_SHOT!, fullPage: false });
  } finally {
    await cleanup(one.parentId);
    await cleanup(two.parentId);
  }
});
