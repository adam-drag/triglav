import type { Page } from '@playwright/test';
import { BASE, clientFetch, expect, openLive, test } from './fixtures.ts';

// Images in the Architect's chat (design v4, C-chat-images) on the :7401 stack. A paste is played as a browser does for a
// screenshot: a ClipboardEvent whose clipboardData holds the File. Nothing runs the Architect here, so the message is only
// stored and shown. A real Architect describing a pasted picture (AC1) needs a Client session and is not part of this spec.

// A 1x1 png: the smallest picture that the composer can check, shrink and show.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

async function paste(page: Page, files: { name: string; type: string; base64: string }[]) {
  await page.getByLabel('Message').evaluate((el, list) => {
    const dt = new DataTransfer();
    for (const f of list) {
      const bytes = Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0));
      dt.items.add(new File([bytes], f.name, { type: f.type }));
    }
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, files);
}

async function seed(label: string): Promise<string> {
  const key = `img-e2e-${label}-${Date.now().toString(36)}`;
  const doc = { format: 1, title: 'Images e2e', blocks: [{ kind: 'decision', id: 'D1', title: 'One', body: 'b1' }] };
  const body = { key, title: `Images e2e ${key}`, repos: [{ slug: 'app', path: `/nonexistent-e2e/${key}`, base: 'main', github: 'owner/app' }], source: 'e2e', doc };
  const res = await clientFetch(`${BASE}/api/initiatives`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  expect(res.status, await res.clone().text()).toBe(200);
  return key;
}

test('the Architect chat takes a pasted png, shows its thumbnail, and sends it with the Client message', async ({ page, consoleErrors: _ }) => {
  const key = await seed('send');
  await openLive(page, `initiatives/${key}`);
  await paste(page, [{ name: 'shot.png', type: 'image/png', base64: PNG }]);
  const thumbs = page.getByTestId('chat-thumbs');
  await expect(thumbs.locator('img')).toHaveCount(1);
  await page.getByTestId('chat-send').click();
  // The thumbnails clear once the message is sent, and the message shows the picture.
  await expect(thumbs).toHaveCount(0);
  const shown = page.getByTestId('chat-image');
  await expect(shown).toHaveCount(1);
  // The picture is served back to the Client's session with its stored type and nosniff.
  const src = await shown.getAttribute('src');
  expect(src).toBeTruthy();
  const res = await clientFetch(`${BASE}${src}`);
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('image/png');
  expect(res.headers.get('x-content-type-options')).toBe('nosniff');
});

test('the composer refuses a file that is not an image and a fifth image, and the Operator takes no image', async ({ page, consoleErrors: _ }) => {
  const key = await seed('refuse');
  await openLive(page, `initiatives/${key}`);
  await paste(page, [{ name: 'notes.txt', type: 'text/plain', base64: btoa('hello') }]);
  await expect(page.getByTestId('chat-refusal')).toHaveText('That file is not a png, jpeg, webp or gif image.');
  await expect(page.getByTestId('chat-thumbs')).toHaveCount(0);
  // Five pictures in one paste: the first four are kept, and the fifth is refused.
  await paste(page, Array.from({ length: 5 }, (_, i) => ({ name: `shot${i}.png`, type: 'image/png', base64: PNG })));
  await expect(page.getByTestId('chat-thumbs').locator('img')).toHaveCount(4);
  await expect(page.getByTestId('chat-refusal')).toHaveText('A message can carry at most 4 images. Remove one first.');
  // The Operator's composer refuses a picture and keeps none.
  await openLive(page, 'operator');
  await paste(page, [{ name: 'shot.png', type: 'image/png', base64: PNG }]);
  await expect(page.getByTestId('chat-refusal')).toHaveText("The Operator takes text only. Images go to an initiative's Architect.");
  await expect(page.getByTestId('chat-thumbs')).toHaveCount(0);
});
