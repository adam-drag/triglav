// The reply buttons of the chat log: plain text only, Architect chats only, hidden while the Architect works. The full click is
// in e2e/architect-replies.spec.ts; the click guard is clickReply, tested at the end of this file.
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ARCHITECT_CHATS, ChatLog, OPERATOR_CHATS, clickReply } from './chat.tsx';

type Chat = Parameters<typeof ChatLog>[0]['chat'];

function chat(over: Partial<Record<'base' | 'state' | 'replies' | 'messages', unknown>> = {}): Chat {
  return { messages: [], partial: '', state: 'idle', actions: {}, replies: null, base: ARCHITECT_CHATS, ...over } as unknown as Chat;
}

const send = async () => undefined;
const render = (c: Chat, withSend: boolean = true) => renderToStaticMarkup(<ChatLog chatId="cht_x" chat={c} who="The Architect" reply={withSend ? send : undefined} />);
const buttons = (html: string) => html.match(/data-testid="suggested-reply"/g)?.length ?? 0;

describe('suggested replies in the chat log', () => {
  it('shows one button per reply with its full text, as plain text', () => {
    const full = 'x'.repeat(200);
    const html = render(chat({ replies: ['[x](http://a)', '<img src=x onerror="alert(1)">', full] }));
    expect(buttons(html)).toBe(3);
    // The text is escaped, never parsed: no link, no image, no injected element.
    expect(html).toContain('[x](http://a)');
    expect(html).toContain('&lt;img src=x onerror=');
    expect(html).not.toMatch(/<a[\s>]/);
    expect(html).not.toMatch(/<img[\s>]/);
    expect(html).toContain(full);
  });

  it('shows nothing on an Operator chat, even with replies in its data', () => {
    expect(buttons(render(chat({ base: OPERATOR_CHATS, replies: ['Yes', 'No'] })))).toBe(0);
  });

  it('hides the buttons while the Architect is working, and when there are none', () => {
    expect(buttons(render(chat({ state: 'working', replies: ['Yes'] })))).toBe(0);
    expect(buttons(render(chat({ replies: null })))).toBe(0);
    expect(buttons(render(chat({ replies: [] })))).toBe(0);
  });

  it('shows nothing without a send function, so a click always has one to call', () => {
    expect(buttons(render(chat({ replies: ['Yes'] }), false))).toBe(0);
  });
});

// A real click needs a DOM, which the web tests do not have, so the click guard is a plain function. run has the same contract
// as useAction.run: true when fn resolved, false when it rejected (the component shows that error from useAction).
const runLike = (fn: () => Promise<unknown>) => fn().then(() => true, () => false);

describe('clicking a suggested reply', () => {
  it('sends the text once and reports sent when the send resolves', async () => {
    const send = vi.fn(async (_text: string) => undefined);
    expect(await clickReply('Use the app host', false, false, runLike, send)).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('Use the app host');
  });

  it('sends nothing once a reply was sent, or while a send is in flight', async () => {
    const send = vi.fn(async (_text: string) => undefined);
    expect(await clickReply('Yes', true, false, runLike, send)).toBe(false);
    expect(await clickReply('Yes', false, true, runLike, send)).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('does not mark the buttons sent when the send rejects, so they stay enabled', async () => {
    const send = vi.fn(async (_text: string) => {
      throw new Error('offline');
    });
    expect(await clickReply('Yes', false, false, runLike, send)).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
