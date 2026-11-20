import { expect, openLive, test } from './fixtures.ts';

// New job, the third choice: the Client creates two initiatives from one title and one repository. The server makes a key for
// each, so both rooms open at version 1 with their own addresses. ORCH_HOST_HOME is /home/e2e on the e2e stack, so the path is
// inside it. Nothing checks the directory at creation: the runner only reads it when an Architect starts.
test('New job creates two initiatives from the same title and repository, and both rooms open at version 1', async ({ page, consoleErrors: _ }) => {
  const keys: string[] = [];
  for (let i = 0; i < 2; i++) {
    await openLive(page, 'new');
    await page.getByTestId('kind-initiative').click();
    await expect(page.getByTestId('new-initiative-form')).toBeVisible();
    await page.getByTestId('initiative-title').fill('Create flow');
    await page.getByTestId('initiative-repo-path').fill('/home/e2e/create-flow/app');
    await page.getByTestId('initiative-repo-base').fill('main');
    await page.getByTestId('initiative-prompt').fill('Plan the create flow. Keep it small.');
    await page.getByTestId('initiative-submit').click();
    await page.waitForURL(/#\/initiatives\/create-flow-[0-9a-f]{6}$/);
    keys.push(page.url().split('#/initiatives/')[1]!);
    await expect(page.getByTestId('room-version')).toHaveValue('1');
  }
  expect(keys[0]).not.toBe(keys[1]);

  // Both rooms open on their own addresses, at version 1, and History names the trigger as Created.
  for (const key of keys) {
    await page.goto(`/#/initiatives/${key}`);
    await expect(page.getByTestId('room-version')).toHaveValue('1');
    await page.getByTestId('tab-history').click();
    await expect(page.getByTestId('history-trigger').first()).toHaveText('Created');
    await page.getByTestId('tab-design').click();
  }
});

// The draft of the New initiative form lives in the page, so switching to another kind and back keeps what the Client typed.
test('a New initiative draft is kept when the Client switches to another kind and back', async ({ page, consoleErrors: _ }) => {
  await openLive(page, 'new');
  await page.getByTestId('kind-initiative').click();
  await page.getByTestId('initiative-title').fill('Kept draft');
  await page.getByTestId('initiative-repo-path').fill('/home/e2e/kept-draft/app');
  await page.getByTestId('initiative-prompt').fill('Keep this text.');
  await page.getByTestId('kind-implement').click();
  await expect(page.getByTestId('new-initiative-form')).toHaveCount(0);
  await page.getByTestId('kind-initiative').click();
  await expect(page.getByTestId('initiative-title')).toHaveValue('Kept draft');
  await expect(page.getByTestId('initiative-repo-path')).toHaveValue('/home/e2e/kept-draft/app');
  await expect(page.getByTestId('initiative-prompt')).toHaveValue('Keep this text.');
});
