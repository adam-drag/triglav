import type { Page } from '@playwright/test';
import { BASE, clientFetch, expect, openLive, test } from './fixtures.ts';

// Images in the Architect's chat (design v4, C-chat-images) on the :7401 stack. A paste is played as a browser does for a
// screenshot: a ClipboardEvent whose clipboardData holds the File. Nothing runs the Architect here, so the message is only
// stored and shown. A real Architect describing a pasted picture (AC1) needs a Client session and is not part of this spec.

// A 1x1 png: the smallest picture that the composer can check, shrink and show.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

// Returns true when the browser keeps its default paste (the text goes into the box), false when the handler stopped it.
async function paste(page: Page, files: { name: string; type: string; base64: string }[], text = ''): Promise<boolean> {
  return page.getByLabel('Message').evaluate((el, [list, plain]) => {
    const dt = new DataTransfer();
    for (const f of list) {
      const bytes = Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0));
      dt.items.add(new File([bytes], f.name, { type: f.type }));
    }
    if (plain) dt.setData('text/plain', plain);
    return el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, [files, text] as const);
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

test('two pastes in a row share the four-image limit', async ({ page, consoleErrors: _ }) => {
  const key = await seed('overlap');
  await openLive(page, `initiatives/${key}`);
  // Two pastes of three pictures land one after the other: the second one sees the first one's thumbnails.
  const three = Array.from({ length: 3 }, (_, i) => ({ name: `shot${i}.png`, type: 'image/png', base64: PNG }));
  await paste(page, three);
  await paste(page, three);
  await expect(page.getByTestId('chat-thumbs').locator('img')).toHaveCount(4);
  await expect(page.getByTestId('chat-refusal')).toHaveText('A message can carry at most 4 images. Remove one first.');
});

test('a picture that passes the signature check but cannot be decoded is refused', async ({ page, consoleErrors: _ }) => {
  const key = await seed('corrupt');
  await openLive(page, `initiatives/${key}`);
  // The png signature, then bytes that are not a picture.
  const corrupt = btoa('\x89PNG\r\n\x1a\n' + 'not a real picture');
  await paste(page, [{ name: 'broken.png', type: 'image/png', base64: corrupt }]);
  await expect(page.getByTestId('chat-refusal')).toHaveText('That image could not be read.');
  await expect(page.getByTestId('chat-thumbs')).toHaveCount(0);
});

test('a paste with text and a picture keeps the text in the Architect and in the Operator', async ({ page, consoleErrors: _ }) => {
  const key = await seed('mixed');
  await openLive(page, `initiatives/${key}`);
  // The Architect takes the picture and leaves the text to the browser.
  const kept = await paste(page, [{ name: 'shot.png', type: 'image/png', base64: PNG }], 'see the table');
  expect(kept).toBe(true);
  await expect(page.getByTestId('chat-thumbs').locator('img')).toHaveCount(1);
  await expect(page.getByTestId('chat-refusal')).toHaveCount(0);
  // The Operator keeps the text too, and shows no refusal for the picture it does not take.
  await openLive(page, 'operator');
  const operatorKept = await paste(page, [{ name: 'shot.png', type: 'image/png', base64: PNG }], 'see the table');
  expect(operatorKept).toBe(true);
  await expect(page.getByTestId('chat-refusal')).toHaveCount(0);
  await expect(page.getByTestId('chat-thumbs')).toHaveCount(0);
});

test('a picture added while a send is in flight stays in the box after the send', async ({ page, consoleErrors: _ }) => {
  const key = await seed('inflight');
  await openLive(page, `initiatives/${key}`);
  // The send request waits until the test lets it go, so a second picture can land while it is in flight.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/api/architect-chats/*/messages', async (route) => {
    await held;
    await route.continue();
  });
  await paste(page, [{ name: 'first.png', type: 'image/png', base64: PNG }]);
  await expect(page.getByTestId('chat-thumbs').locator('img')).toHaveCount(1);
  await page.getByTestId('chat-send').click();
  await paste(page, [{ name: 'second.png', type: 'image/png', base64: PNG }]);
  await expect(page.getByTestId('chat-thumbs').locator('img')).toHaveCount(2);
  release();
  // The first picture was sent and leaves the box; the second one stays.
  await expect(page.getByTestId('chat-image')).toHaveCount(1);
  await expect(page.getByTestId('chat-thumbs').locator('img')).toHaveCount(1);
});

test('a send right after a paste includes the picture that is still being decoded', async ({ page, consoleErrors: _ }) => {
  const key = await seed('racesend');
  await openLive(page, `initiatives/${key}`);
  await page.getByLabel('Message').fill('look at this');
  // The paste and the click run in one step, so the send starts while the picture is still being decoded.
  await page.getByLabel('Message').evaluate((el, b64) => {
    const dt = new DataTransfer();
    dt.items.add(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], 'race.png', { type: 'image/png' }));
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    (document.querySelector('[data-testid="chat-send"]') as HTMLButtonElement).click();
  }, PNG);
  // The picture goes with the text: it is shown in the sent message and no thumbnail is left for the next one.
  await expect(page.getByTestId('chat-image')).toHaveCount(1);
  await expect(page.getByTestId('chat-thumbs')).toHaveCount(0);
});

test('two sends in one step, while a paste is still decoding, post the message once', async ({ page, consoleErrors: _ }) => {
  const key = await seed('doublesend');
  await openLive(page, `initiatives/${key}`);
  await page.getByLabel('Message').fill('look at this once');
  // A paste and two clicks of Send in one step: the second click lands while the picture is still being decoded.
  await page.getByLabel('Message').evaluate((el, b64) => {
    const dt = new DataTransfer();
    dt.items.add(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], 'twice.png', { type: 'image/png' }));
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    const send = document.querySelector('[data-testid="chat-send"]') as HTMLButtonElement;
    send.click();
    send.click();
  }, PNG);
  await expect(page.getByTestId('chat-image')).toHaveCount(1);
  await expect(page.getByText('look at this once', { exact: true })).toHaveCount(1);
  await expect(page.getByTestId('chat-thumbs')).toHaveCount(0);
});

test('a refusal from a file pasted just before a send stays on screen after the send', async ({ page, consoleErrors: _ }) => {
  const key = await seed('refusedsend');
  await openLive(page, `initiatives/${key}`);
  await page.getByLabel('Message').fill('look at this too');
  // A file that is not an image is pasted and the text is sent in one step: the refusal must still be shown after the send.
  await page.getByLabel('Message').evaluate((el, b64) => {
    const dt = new DataTransfer();
    dt.items.add(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], 'notes.txt', { type: 'text/plain' }));
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    (document.querySelector('[data-testid="chat-send"]') as HTMLButtonElement).click();
  }, btoa('hello'));
  await expect(page.getByText('look at this too', { exact: true })).toHaveCount(1);
  await expect(page.getByTestId('chat-refusal')).toHaveText('That file is not a png, jpeg, webp or gif image.');
});

test('text typed while a paste is still decoding goes with the message and is not wiped', async ({ page, consoleErrors: _ }) => {
  const key = await seed('typedwait');
  await openLive(page, `initiatives/${key}`);
  await page.getByLabel('Message').fill('first');
  // A paste, a click of Send, and more typing in one step: the words typed during the wait belong to the same message.
  await page.getByLabel('Message').evaluate((el, b64) => {
    const dt = new DataTransfer();
    dt.items.add(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], 'typed.png', { type: 'image/png' }));
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    (document.querySelector('[data-testid="chat-send"]') as HTMLButtonElement).click();
    const textarea = el as HTMLTextAreaElement;
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    setValue.call(textarea, 'first second');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  }, PNG);
  await expect(page.getByText('first second', { exact: true })).toHaveCount(1);
  await expect(page.getByTestId('chat-image')).toHaveCount(1);
  await expect(page.getByLabel('Message')).toHaveValue('');
});

test('text typed while a send is in flight stays in the box without the words that were sent', async ({ page, consoleErrors: _ }) => {
  const key = await seed('typedflight');
  await openLive(page, `initiatives/${key}`);
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/api/architect-chats/*/messages', async (route) => {
    await held;
    await route.continue();
  });
  await page.getByLabel('Message').fill('first');
  await page.getByTestId('chat-send').click();
  // While the send waits, the Client types on: the box now holds the sent words and the new ones.
  await page.getByLabel('Message').fill('first second');
  release();
  await expect(page.getByText('first', { exact: true })).toHaveCount(1);
  await expect(page.getByLabel('Message')).toHaveValue('second');
});

test('a refusal from a file pasted while a send is in flight stays on screen after the send', async ({ page, consoleErrors: _ }) => {
  const key = await seed('refusalflight');
  await openLive(page, `initiatives/${key}`);
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/api/architect-chats/*/messages', async (route) => {
    await held;
    await route.continue();
  });
  await page.getByLabel('Message').fill('look at this during the send');
  await page.getByTestId('chat-send').click();
  await paste(page, [{ name: 'notes.txt', type: 'text/plain', base64: btoa('hello') }]);
  await expect(page.getByTestId('chat-refusal')).toHaveText('That file is not a png, jpeg, webp or gif image.');
  release();
  // The box empties only when the send has succeeded, so the refusal is checked after that.
  await expect(page.getByLabel('Message')).toHaveValue('');
  await expect(page.getByText('look at this during the send', { exact: true })).toHaveCount(1);
  await expect(page.getByTestId('chat-refusal')).toHaveText('That file is not a png, jpeg, webp or gif image.');
});
