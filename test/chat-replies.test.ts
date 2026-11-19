import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildArchitectServer, checkReplies, REPLIES_MAX, REPLY_MAX } from '../src/architect.ts';
import { createChat, getChat, ingestChatEvents, nextCommand, notifyOperator, sendChatMessage } from '../src/chat.ts';
import { subscribe, type ChatEvent } from '../src/chat-queue.ts';
import { flushArchitectWakes } from '../src/architect-wake.ts';
import { exec } from '../src/db.ts';
import { importInitiative } from '../src/initiatives.ts';
import { createTestCtx, TEST_DB_URL } from './helpers.ts';

// The one-click replies an Architect offers (D10, C-suggest-replies). The limits are pure; the rest runs against MySQL.

describe('checkReplies', () => {
  it('keeps one to four replies, trimmed', () => {
    expect(checkReplies([' Yes, option A '])).toEqual(['Yes, option A']);
    expect(checkReplies(['a', 'b', 'c', 'd'])).toEqual(['a', 'b', 'c', 'd']);
  });

  it('refuses a fifth reply, and none, with the count', () => {
    expect(() => checkReplies(['a', 'b', 'c', 'd', 'e'])).toThrow(/Give 1 to 4 replies, not 5\. Nothing was stored\./);
    expect(() => checkReplies([])).toThrow(/not 0/);
  });

  it('refuses a newline, a carriage return and a tab, even a trailing one', () => {
    for (const bad of ['Yes\n', 'a\rb', 'tab\tin', 'line sep', 'para sep']) expect(() => checkReplies([bad])).toThrow(/line break, a control character, an invisible character or a text-direction mark/);
  });

  it('refuses an empty or blank reply', () => {
    expect(() => checkReplies(['   '])).toThrow(/Reply 1 is empty/);
    expect(() => checkReplies(['ok', ''])).toThrow(/Reply 2 is empty/);
  });

  it('accepts exactly 200 characters and refuses 201, counting characters not UTF-16 units', () => {
    expect(checkReplies(['x'.repeat(REPLY_MAX)])).toEqual(['x'.repeat(REPLY_MAX)]);
    expect(() => checkReplies(['x'.repeat(REPLY_MAX + 1)])).toThrow(/Reply 1 is 201 characters; the limit is 200/);
    // 200 emoji are 400 UTF-16 units but 200 characters.
    expect(checkReplies(['\u{1F600}'.repeat(REPLY_MAX)])).toHaveLength(1);
  });

  it('allows the zero-width joiners that emoji and some scripts need', () => {
    expect(checkReplies(['a\u200Db', 'a\u200Cb'])).toEqual(['a\u200Db', 'a\u200Cb']);
  });

  it('refuses zero-width and bidi control characters', () => {
    for (const bad of ['​x', 'x‏', '‮abc', '⁦x⁩', '﻿x']) expect(() => checkReplies([bad])).toThrow(/text-direction mark/);
  });

  it('refuses a reply that looks like a credential', () => {
    expect(() => checkReplies(['Use AKIAABCDEFGHIJKLMNOP for it'])).toThrow(/looks like a credential/);
  });

  it('keeps the limits the tool advertises', () => {
    expect(REPLIES_MAX).toBe(4);
    expect(REPLY_MAX).toBe(200);
  });
});

// Runs against a real MySQL: set ORCH_TEST_DATABASE_URL (see README). Skipped otherwise.
describe.skipIf(!TEST_DB_URL)('suggested replies in the chat', () => {
  let env: Awaited<ReturnType<typeof createTestCtx>>;
  let n = 0;
  beforeAll(async () => {
    env = await createTestCtx();
  });
  afterAll(async () => {
    await env?.close();
  });

  const small = (key: string) => ({
    key,
    title: `Replies ${key}`,
    repos: [{ slug: 'app', path: '/home/u/app', base: 'main' }],
    source: 'a test',
    doc: {
      format: 1,
      title: 'Small',
      blocks: [
        { kind: 'decision', id: 'D1', title: 'One', body: 'b1' },
        { kind: 'open', id: 'O-host', title: 'Host', body: 'which host' },
      ],
    },
  });

  async function drain() {
    const taken: any[] = [];
    for (let c = await nextCommand(env.ctx, 0); c; c = await nextCommand(env.ctx, 0)) taken.push(c);
    return taken;
  }

  /** The Architect of an initiative, as a client of its own MCP server (the token's chat is the closure). */
  async function architect(chatId: string, initiativeId: string) {
    const server = buildArchitectServer(env.ctx, chatId, initiativeId);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(b);
    const suggest = async (replies: unknown) => {
      const r: any = await client.callTool({ name: 'suggest_replies', arguments: { replies } });
      return { error: !!r.isError, text: r.content[0].text, body: JSON.parse(r.content[0].text) };
    };
    return { client, suggest };
  }

  async function room() {
    const imp = await importInitiative(env.ctx, small(`replies-${++n}`));
    await drain();
    return imp;
  }

  const repliesOf = async (chatId: string) => (await getChat(env.ctx, chatId, 'architect')).suggested_replies;

  it('takes the reply list only from the tool schema, which names no chat', async () => {
    const imp = await room();
    const { client } = await architect(imp.chat_id, imp.id);
    const tools = (await client.listTools()).tools;
    expect(Object.keys(tools.find((t) => t.name === 'suggest_replies')!.inputSchema.properties ?? {})).toEqual(['replies']);
  });

  it('stores the trimmed replies, replaces them on each call, and reads them back for the Architect chat', async () => {
    const imp = await room();
    const { suggest } = await architect(imp.chat_id, imp.id);
    expect(await repliesOf(imp.chat_id)).toBeNull();
    const first = await suggest([' Option A ', 'Option B']);
    expect(first.error).toBe(false);
    expect(first.body.result).toEqual({ replies: ['Option A', 'Option B'] });
    expect(await repliesOf(imp.chat_id)).toEqual(['Option A', 'Option B']);
    await suggest(['Only this']);
    expect(await repliesOf(imp.chat_id)).toEqual(['Only this']);
  });

  it('refuses a bad call with a reason the Architect can read, and keeps the replies it had', async () => {
    const imp = await room();
    const { suggest } = await architect(imp.chat_id, imp.id);
    await suggest(['Keep me']);
    const refused = [['a', 'b', 'c', 'd', 'e'], ['two\nlines'], ['   '], ['x'.repeat(201)], ['AKIAABCDEFGHIJKLMNOP']];
    for (const replies of refused) {
      const r = await suggest(replies);
      expect(r.error).toBe(true);
      expect(r.body).toMatchObject({ ok: false, message: expect.stringMatching(/Nothing was stored\./) });
    }
    expect(await repliesOf(imp.chat_id)).toEqual(['Keep me']);
  });

  it("changes only the calling Architect's own chat, never another initiative's, and an Operator chat is refused", async () => {
    const mine = await room();
    const other = await room();
    const operator = await createChat(env.ctx, { text: 'hello' });
    await drain();
    const { suggest } = await architect(mine.chat_id, mine.id);
    expect((await suggest(['Mine'])).error).toBe(false);
    expect(await repliesOf(mine.chat_id)).toEqual(['Mine']);
    expect(await repliesOf(other.chat_id)).toBeNull();
    // A server built on an Operator chat (no real token does this) still cannot write there: the chat is not an Architect's.
    const bogus = await architect(operator.id, mine.id);
    const r = await bogus.suggest(['Nope']);
    expect(r.error).toBe(true);
    expect(r.body.message).toBe('This chat is not an Architect chat.');
    expect((await getChat(env.ctx, operator.id, 'operator')).suggested_replies).toBeNull();
  });

  it('never shows replies on an Operator chat, even when a row says so', async () => {
    const operator = await createChat(env.ctx, { text: 'hello' });
    await drain();
    await exec(env.ctx.pool, `UPDATE chats SET suggested_replies = ? WHERE id = ?`, [JSON.stringify(['Stale']), operator.id]);
    expect((await getChat(env.ctx, operator.id, 'operator')).suggested_replies).toBeNull();
  });

  it('publishes the set, and the clear, to the chat stream', async () => {
    const imp = await room();
    const { suggest } = await architect(imp.chat_id, imp.id);
    const seen: ChatEvent[] = [];
    const sub = subscribe(imp.chat_id, (e) => seen.push(e));
    await suggest(['One', 'Two']);
    await sendChatMessage(env.ctx, imp.chat_id, { text: 'One' }, 'architect');
    sub.unsubscribe();
    expect(seen.filter((e) => e.type === 'replies')).toEqual([
      { type: 'replies', replies: ['One', 'Two'] },
      { type: 'replies', replies: null },
    ]);
  });

  it('clears the replies when the Client sends a message, in the same step that queues it', async () => {
    const imp = await room();
    const { suggest } = await architect(imp.chat_id, imp.id);
    await suggest(['Yes', 'No']);
    await sendChatMessage(env.ctx, imp.chat_id, { text: 'Yes' }, 'architect');
    expect(await repliesOf(imp.chat_id)).toBeNull();
    const queued = (await drain()).filter((c) => c.chat_id === imp.chat_id);
    expect(queued).toEqual([expect.objectContaining({ kind: 'send', text: 'Yes' })]);
  });

  it('clears the replies when the Operator is notified in an Architect chat', async () => {
    const imp = await room();
    const { suggest } = await architect(imp.chat_id, imp.id);
    await suggest(['Pick one']);
    await notifyOperator(env.ctx, imp.chat_id, 'Done.', '[Triglav] Done.');
    expect(await repliesOf(imp.chat_id)).toBeNull();
    await drain();
  });

  it('clears the replies when a Triglav wake reaches the Architect', async () => {
    const imp = await room();
    const { suggest } = await architect(imp.chat_id, imp.id);
    await suggest(['Keep this until the wake']);
    // A pending question, as a Staff post leaves it when the wake interval is still running (architect_wake_pending).
    const ref = { kind: 'staff_posted', job_id: 'job_wake', thread_id: 'thr_wake', blocker_id: null, excerpt: 'Which host?' };
    await exec(env.ctx.pool, 'UPDATE initiatives SET architect_wake_pending = ?, architect_woken_at = NULL WHERE id = ?', [JSON.stringify([ref]), imp.id]);
    await flushArchitectWakes(env.ctx);
    expect(await repliesOf(imp.chat_id)).toBeNull();
    const wake = (await drain()).find((c) => c.chat_id === imp.chat_id);
    expect(wake.text).toMatch(/^\[Triglav\] Staff asked on initiative/);
  });

  it('clears replies a turn offered before the Architect takes the next message, and keeps the ones it offers after the take', async () => {
    const imp = await room();
    const { suggest } = await architect(imp.chat_id, imp.id);
    // Turn N: the Client sends M1 (clears), then the Architect offers replies while turn N still runs.
    await sendChatMessage(env.ctx, imp.chat_id, { text: 'M1' }, 'architect');
    await drain();
    await suggest(['Set during N']);
    expect(await repliesOf(imp.chat_id)).toEqual(['Set during N']);
    // The Client sends M2 while N still runs, so M2 waits in the queue. The replies of N are out of date now.
    await sendChatMessage(env.ctx, imp.chat_id, { text: 'M2' }, 'architect');
    expect(await repliesOf(imp.chat_id)).toBeNull();
    // Turn N calls the tool once more, after M2 was queued: the replies are set again.
    await suggest(['Set before the take']);
    expect(await repliesOf(imp.chat_id)).toEqual(['Set before the take']);
    // The runner takes M2, which starts turn N+1: the replies that turn N left go.
    const taken = await nextCommand(env.ctx, 0);
    expect(taken).toMatchObject({ kind: 'send', text: 'M2', chat_kind: 'architect' });
    expect(await repliesOf(imp.chat_id)).toBeNull();
    // Replies offered after the take belong to turn N+1 and stay.
    await suggest(['Set after the take']);
    expect(await repliesOf(imp.chat_id)).toEqual(['Set after the take']);
  });

  it('clears the replies at a runner turn end that a queued message follows, and keeps them when nothing is queued', async () => {
    const imp = await room();
    const { suggest } = await architect(imp.chat_id, imp.id);
    const seen: ChatEvent[] = [];
    const sub = subscribe(imp.chat_id, (e) => seen.push(e));
    // Turn N runs for M1; M2 is queued behind it, so the runner ends turn N with a message still waiting.
    await sendChatMessage(env.ctx, imp.chat_id, { text: 'M1' }, 'architect');
    await drain();
    await suggest(['Set during N']);
    await sendChatMessage(env.ctx, imp.chat_id, { text: 'M2' }, 'architect');
    await suggest(['Set before the turn end']);
    expect(await repliesOf(imp.chat_id)).toEqual(['Set before the turn end']);
    await ingestChatEvents(env.ctx, imp.chat_id, [{ type: 'replies_clear' }]);
    expect(await repliesOf(imp.chat_id)).toBeNull();
    expect(seen).toContainEqual({ type: 'replies', replies: null });
    // The runner takes M2 and its turn ends with nothing queued: the replies that turn offered stay.
    expect(await nextCommand(env.ctx, 0)).toMatchObject({ kind: 'send', text: 'M2' });
    await suggest(['Last turn']);
    await ingestChatEvents(env.ctx, imp.chat_id, [{ type: 'state', state: 'idle' }]);
    expect(await repliesOf(imp.chat_id)).toEqual(['Last turn']);
    sub.unsubscribe();
  });

  it('keeps the replies when the Architect stores its own message', async () => {
    const imp = await room();
    const { suggest } = await architect(imp.chat_id, imp.id);
    await suggest(['Keep these']);
    await ingestChatEvents(env.ctx, imp.chat_id, [{ type: 'message', role: 'operator', text: 'Pick one of the two options.' }]);
    expect(await repliesOf(imp.chat_id)).toEqual(['Keep these']);
  });
});
