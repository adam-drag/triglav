import { readFileSync } from 'node:fs';
import { BASE, clientFetch, expect, test } from './fixtures.ts';

/** Seeds the public-template-pages design (v17) under a fresh key, with repositories that point nowhere. */
async function seed(): Promise<string> {
  const fixture = JSON.parse(readFileSync('e2e/fixtures/public-template-pages.json', 'utf8'));
  const key = `p5-${Date.now().toString(36)}`;
  const repos = fixture.repos.map((r: { slug: string }) => ({ slug: r.slug, path: `/nonexistent-e2e/${r.slug}`, base: 'main' }));
  const res = await clientFetch(`${BASE}/api/initiatives`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...fixture, key, repos }) });
  expect(res.status).toBe(200);
  return key;
}

const PLAIN = 'Template sharing works like sharing a Claude artifact.';

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
  await expect(page.getByTestId('quote-chips')).toContainText(PLAIN);

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
