import { expect, BASE, clientFetch, RUNNER_KEY, test } from './fixtures.ts';
import { ArchitectSim } from './architect-sim.ts';

// D10 end to end on the :7401 stack: the Architect offers two replies, the room shows them as buttons under its latest
// message, a click sends the exact text as the Client's message, and the buttons go. The Architect is the stub from
// architect-sim.ts (a real MCP client of /architect/mcp with the token the runner would mint); the runner's side is the same
// /api/runner/chat calls the runner makes, taken and answered here by the test.

async function runnerCall(path: string, body: unknown = {}): Promise<any> {
  const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: { authorization: `Bearer ${RUNNER_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

async function seed(): Promise<{ key: string; chatId: string }> {
  const key = `replies-e2e-${Date.now().toString(36)}`;
  const design = {
    format: 1,
    title: 'Replies e2e',
    blocks: [{ kind: 'decision', id: 'D1', title: 'App host', body: 'Links use the app host.' }],
  };
  const body = { key, title: `Replies e2e ${key}`, repos: [{ slug: 'app', path: `/nonexistent-e2e/${key}`, base: 'main', github: 'owner/app' }], source: 'e2e', doc: design };
  const res = await clientFetch(`${BASE}/api/initiatives`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  expect(res.status, await res.clone().text()).toBe(200);
  const got = await (await clientFetch(`${BASE}/api/initiatives/${key}`)).json();
  return { key, chatId: String(got.initiative.chat_id) };
}

test('the Architect offers two replies, a click sends the exact text, and the buttons go', async ({ page, consoleErrors: _ }) => {
  const { key, chatId } = await seed();
  await page.goto(`/#/initiatives/${key}`);
  const pane = page.getByTestId('architect-pane');
  await expect(pane).toBeVisible();

  // 1. The Client asks a question in the room. The runner takes the send, and the Architect's turn starts.
  await pane.getByLabel('Message').fill('Which host should the links use?');
  await pane.getByTestId('chat-send').click();
  await expect(pane.getByTestId('chat-client')).toContainText('Which host should the links use?');
  let sent: any = null;
  // The e2e stack keeps one queue for every chat, so earlier specs can leave commands ahead of this one.
  for (let i = 0; i < 50 && !sent; i++) {
    const { command } = await runnerCall('/api/runner/chat/next');
    if (command?.kind === 'send' && command.chat_id === chatId) sent = command;
  }
  expect(sent, 'the runner takes the Client message').toBeTruthy();

  // 2. The stub Architect asks for a choice and offers the two answers as replies. One reply has markup-like text: it must show as text.
  const { token } = await runnerCall(`/api/runner/chat/${chatId}/token`);
  const architect = await ArchitectSim.connect(token);
  const replies = ['Use the app host', 'Use [the CDN](http://cdn.example)'];
  expect(await architect.call('suggest_replies', { replies })).toEqual({ replies });
  await runnerCall(`/api/runner/chat/${chatId}/events`, {
    events: [
      { type: 'message', role: 'operator', text: 'Two options. Which host should the links use? Pick one below.' },
      { type: 'state', state: 'idle' },
    ],
  });

  // 3. The buttons show under the Architect's latest message, with the full text as plain text (no link).
  const buttons = pane.getByTestId('suggested-reply');
  await expect(buttons).toHaveCount(2);
  await expect(buttons.nth(0)).toHaveText('Use the app host');
  await expect(buttons.nth(1)).toHaveText('Use [the CDN](http://cdn.example)');
  await expect(pane.getByTestId('chat-log').locator('a[href="http://cdn.example"]')).toHaveCount(0);

  // 3b. A Quote chip is pending in the composer. A reply click must send its text alone, and the chip stays for the composer.
  await page.locator('[data-testid="design-block"][data-id="D1"]').getByTestId('quote-block').click();
  await expect(page.getByTestId('quote-chips')).toContainText('D1.body');

  // 4. A click sends that exact text as the Client's message (no refs), and the buttons disappear.
  const replyRequest = page.waitForRequest((r) => r.method() === 'POST' && /\/messages$/.test(r.url()));
  await buttons.nth(0).click();
  expect((await replyRequest).postDataJSON()).toEqual({ text: 'Use the app host', refs: [] });
  await expect(page.getByTestId('quote-chips')).toHaveCount(1);
  await expect(pane.getByTestId('chat-client').last()).toHaveText('Use the app host');
  await expect(pane.getByTestId('suggested-reply')).toHaveCount(0);
  const stored = await (await clientFetch(`${BASE}/api/architect-chats/${chatId}`)).json();
  expect(stored.suggested_replies).toBeNull();
  expect(stored.messages.filter((m: { role: string }) => m.role === 'client').map((m: { text: string }) => m.text)).toContain('Use the app host');

  // 5. The runner takes the click's message as an ordinary send, with the same text.
  let clicked: any = null;
  for (let i = 0; i < 50 && !clicked; i++) {
    const { command } = await runnerCall('/api/runner/chat/next');
    if (command?.kind === 'send' && command.chat_id === chatId) clicked = command;
  }
  expect(clicked).toMatchObject({ kind: 'send', text: 'Use the app host' });
  await runnerCall(`/api/runner/chat/${chatId}/events`, { events: [{ type: 'state', state: 'idle' }] });
});
