import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { BASE, clientFetch, expect, openLive, test } from './fixtures.ts';

/** Seeds the public-template-pages design (v17) under a fresh key, as initiatives.spec.ts does. */
async function seed(): Promise<string> {
  const fixture = JSON.parse(readFileSync('e2e/fixtures/public-template-pages.json', 'utf8'));
  const key = `room-${Date.now().toString(36)}`;
  const repos = fixture.repos.map((r: { slug: string }) => ({ slug: r.slug, path: `/nonexistent-e2e/${r.slug}`, base: 'main' }));
  const res = await clientFetch(`${BASE}/api/initiatives`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...fixture, key, repos }) });
  expect(res.status).toBe(200);
  return key;
}

/** Widths of the page's main element, the room body and the Architect pane, in CSS pixels. */
function measure(page: Page) {
  return page.evaluate(() => {
    const main = document.querySelector('main') as HTMLElement;
    const style = getComputedStyle(main);
    const body = document.querySelector('.room-body') as HTMLElement | null;
    const pane = document.querySelector('.architect-pane') as HTMLElement | null;
    return {
      viewport: document.documentElement.clientWidth,
      mainClass: main.className,
      mainBorderBox: main.getBoundingClientRect().width,
      mainContent: main.getBoundingClientRect().width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
      paddingLeft: parseFloat(style.paddingLeft),
      paddingRight: parseFloat(style.paddingRight),
      bodyWidth: body ? body.getBoundingClientRect().width : null,
      paneWidth: pane ? pane.getBoundingClientRect().width : null,
      bodyColumns: body ? getComputedStyle(body).gridTemplateColumns : null,
    };
  });
}

test.describe('initiative room width', () => {
  test('at 3440 px the room spans the window and the Architect column is 38% of the body', async ({ page, consoleErrors: _ }) => {
    await page.setViewportSize({ width: 3440, height: 1440 });
    const key = await seed();
    await openLive(page, `initiatives/${key}`);
    await expect(page.getByTestId('room-version')).toHaveValue('17');
    await expect(page.locator('.room-body')).toBeVisible();

    const m = await measure(page);
    expect(m.mainClass).toBe('room-wide-main');
    // No max-width: the border box is the whole client width, and main keeps its 20 px side padding.
    expect(m.mainBorderBox).toBe(m.viewport);
    expect(m.paddingLeft).toBe(20);
    expect(m.paddingRight).toBe(20);
    expect(m.mainContent).toBe(m.viewport - 40);
    // The Architect pane fills its grid column, so its width is the column width.
    expect(m.bodyWidth).not.toBeNull();
    expect(m.paneWidth).not.toBeNull();
    expect(Math.abs(m.paneWidth! - 0.38 * m.bodyWidth!)).toBeLessThanOrEqual(2);
  });

  test('at 1280 px the Architect column is at least 420 px', async ({ page, consoleErrors: _ }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const key = await seed();
    await openLive(page, `initiatives/${key}`);
    await expect(page.getByTestId('room-version')).toHaveValue('17');
    await expect(page.locator('.room-body')).toBeVisible();

    const m = await measure(page);
    expect(m.mainClass).toBe('room-wide-main');
    expect(m.paneWidth!).toBeGreaterThanOrEqual(420);
  });

  test('at 700 px the room keeps the Design and Architect toggle and one column', async ({ page, consoleErrors: _ }) => {
    await page.setViewportSize({ width: 700, height: 900 });
    const key = await seed();
    await openLive(page, `initiatives/${key}`);
    await expect(page.getByTestId('room-version')).toHaveValue('17');

    await expect(page.locator('.room-panes')).toBeVisible();
    const m = await measure(page);
    expect(m.bodyColumns!.trim().split(/\s+/)).toHaveLength(1);
    // styles.css sets main to 12px 10px at 700 px and below, so the side padding is 10 px here.
    expect(m.paddingLeft).toBe(10);
    expect(m.mainContent).toBe(m.viewport - 20);
  });

  test('at 3440 px the initiative list and another page keep the 1400 px cap', async ({ page, consoleErrors: _ }) => {
    await page.setViewportSize({ width: 3440, height: 1440 });
    // The list shows a seeded initiative, so seed one here rather than rely on an earlier test.
    await seed();
    await openLive(page, 'initiatives');
    await expect(page.getByRole('link', { name: 'Public template pages' }).first()).toBeVisible();
    const list = await measure(page);
    expect(list.mainClass).not.toContain('room-wide-main');
    expect(list.mainBorderBox).toBe(1400);

    await openLive(page, 'queue');
    await expect(page.locator('main')).toBeVisible();
    const queue = await measure(page);
    expect(queue.mainClass).not.toContain('room-wide-main');
    expect(queue.mainBorderBox).toBe(1400);
  });
});
