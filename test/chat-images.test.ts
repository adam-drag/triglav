import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createChat, getChat, nextCommand, sendChatMessage } from '../src/chat.ts';
import { ARCHITECT_BODY_LIMIT } from '../src/chat-images.ts';
import { exec, queryOne } from '../src/db.ts';
import { importInitiative } from '../src/initiatives.ts';
import { MAX_IMAGE_BYTES } from '../src/image-types.ts';
import { buildServer } from '../src/server.ts';
import { asClient, createTestCtx, loginCookie, TEST_DB_URL, testServerKeys } from './helpers.ts';

// Images in the Architect's chat (design v4, C-chat-images). Runs against a real MySQL, like test/chat.test.ts.
const PNG_HEAD = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const JPEG = Buffer.from('ffd8ffe000104a4649460001', 'hex');
const png = (total = PNG_HEAD.length) => Buffer.concat([PNG_HEAD, Buffer.alloc(total - PNG_HEAD.length, 7)]);
const b64 = (bytes: Buffer) => bytes.toString('base64');
const small = (key: string) => ({
  key,
  title: `Images ${key}`,
  repos: [{ slug: 'app', path: '/home/u/app', base: 'main' }],
  source: 'a test',
  doc: { format: 1, title: 'Images', blocks: [{ kind: 'decision', id: 'D1', title: 'One', body: 'b1' }] },
});

describe.skipIf(!TEST_DB_URL)('images in the Architect chat', () => {
  let env: Awaited<ReturnType<typeof createTestCtx>>;
  let n = 0;
  beforeAll(async () => {
    env = await createTestCtx();
  });
  afterAll(async () => {
    await env?.close();
  });

  /** Empties the queue, so the next handout is the command of the test. */
  async function drain() {
    for (let c = await nextCommand(env.ctx, 0); c; c = await nextCommand(env.ctx, 0)) void c;
  }
  async function architectChat() {
    const imp = await importInitiative(env.ctx, small(`img-${++n}`));
    await drain();
    return imp.chat_id as string;
  }

  it('sends the Client message with its images, and the runner gets them in order with the text empty', async () => {
    const chat = await architectChat();
    await sendChatMessage(env.ctx, chat, { text: '', images: [{ media_type: 'image/png', bytes: png() }, { media_type: 'image/jpeg', bytes: JPEG }] }, 'architect');
    const shown = await getChat(env.ctx, chat, 'architect');
    const last = shown.messages.at(-1)!;
    expect(last).toMatchObject({ role: 'client', text: '' });
    expect(last.images).toHaveLength(2);
    const command = await nextCommand(env.ctx, 0);
    expect(command).toMatchObject({ kind: 'send', chat_id: chat, text: '', chat_kind: 'architect' });
    expect(command?.images).toEqual([
      { media_type: 'image/png', data: b64(png()) },
      { media_type: 'image/jpeg', data: b64(JPEG) },
    ]);
  });

  it('hands the same images out again when the command goes back to the queue', async () => {
    const chat = await architectChat();
    await sendChatMessage(env.ctx, chat, { text: 'look at this', images: [{ media_type: 'image/png', bytes: png() }] }, 'architect');
    const first = await nextCommand(env.ctx, 0);
    // A runner that restarted before it used the command: its row goes back to the queue, as nextCommand does when the poll hangs up.
    const row = await queryOne(env.ctx.pool, `SELECT id FROM chat_commands WHERE chat_id = ? ORDER BY id DESC LIMIT 1`, [chat]);
    await exec(env.ctx.pool, `UPDATE chat_commands SET taken_at = NULL WHERE id = ?`, [row!.id]);
    const again = await nextCommand(env.ctx, 0);
    expect(again?.text).toBe('look at this');
    expect(again?.images).toEqual(first?.images);
    expect(again?.images?.[0]?.data).toBe(b64(png()));
  });

  it('keeps the Operator text-only: the service and the route both refuse images', async () => {
    const op = await createChat(env.ctx, { text: 'hi' });
    await drain();
    await expect(sendChatMessage(env.ctx, op.id, { text: 'x', images: [{ media_type: 'image/png', bytes: png() }] }, 'operator')).rejects.toThrow(/Only the Architect chat takes images/);
    const app = buildServer(env.ctx, { ...(await testServerKeys()), webDir: '/nonexistent' });
    try {
      const cookie = await loginCookie(app);
      const res = await asClient(app, cookie).inject({ method: 'POST', url: `/api/chats/${op.id}/messages`, payload: { text: 'x', images: [{ data: b64(png()) }] } });
      expect(res.statusCode).toBe(400);
      // Nothing was stored for the Operator's chat.
      expect((await getChat(env.ctx, op.id, 'operator')).messages.every((m) => !m.images?.length)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('refuses a message with an empty text and no image, on the Architect route as before', async () => {
    const chat = await architectChat();
    await expect(sendChatMessage(env.ctx, chat, { text: '   ', images: [] }, 'architect')).rejects.toThrow(/Write a message first/);
  });

  it('refuses a fifth image, a file that is not an image and an image over 5 MB, on the route, before anything is stored', async () => {
    const chat = await architectChat();
    const app = buildServer(env.ctx, { ...(await testServerKeys()), webDir: '/nonexistent' });
    try {
      const client = asClient(app, await loginCookie(app));
      const send = (payload: unknown) => client.inject({ method: 'POST', url: `/api/architect-chats/${chat}/messages`, payload: payload as object });
      const five = Array.from({ length: 5 }, () => ({ data: b64(png()) }));
      expect((await send({ text: 'x', images: five })).statusCode).toBe(400);
      const notImage = await send({ text: 'x', images: [{ data: b64(Buffer.from('<html><script>alert(1)</script></html>')) }] });
      expect(notImage.statusCode).toBe(400);
      expect(notImage.json().message).toMatch(/Image 1: Only png, jpeg, webp and gif images can be sent/);
      const over = await send({ text: 'x', images: [{ data: b64(png(MAX_IMAGE_BYTES + 1)) }] });
      expect(over.statusCode).toBe(400);
      expect(over.json().message).toMatch(/Image 1: Each image is at most 5 MB/);
      // None of the refused messages was stored.
      expect((await getChat(env.ctx, chat, 'architect')).messages.filter((m) => m.role === 'client')).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('stores a 5 MB image and reads it back byte for byte, with the stored type and nosniff, for the Client only', async () => {
    const chat = await architectChat();
    const atLimit = png(MAX_IMAGE_BYTES);
    await sendChatMessage(env.ctx, chat, { text: 'big', images: [{ media_type: 'image/png', bytes: atLimit }] }, 'architect');
    const shown = await getChat(env.ctx, chat, 'architect');
    const id = shown.messages.at(-1)!.images![0]!;
    const app = buildServer(env.ctx, { ...(await testServerKeys()), webDir: '/nonexistent' });
    try {
      const cookie = await loginCookie(app);
      const res = await asClient(app, cookie).inject({ method: 'GET', url: `/api/architect-chats/${chat}/images/${id}` });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('image/png');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['content-disposition']).toBe('inline');
      expect(String(res.headers['cache-control'])).toContain('private');
      expect(res.rawPayload.equals(atLimit)).toBe(true);
      // Another chat's path does not reach the image, and no session does not either.
      const other = await createChat(env.ctx, { text: 'other' });
      expect((await asClient(app, cookie).inject({ method: 'GET', url: `/api/architect-chats/${other.id}/images/${id}` })).statusCode).toBe(404);
      expect((await asClient(app, cookie).inject({ method: 'GET', url: `/api/chats/${chat}/images/${id}` })).statusCode).toBe(404);
      expect((await app.inject({ method: 'GET', url: `/api/architect-chats/${chat}/images/${id}` })).statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('checks the session before it reads the body: an unauthenticated large post gets 401', async () => {
    const chat = await architectChat();
    const app = buildServer(env.ctx, { ...(await testServerKeys()), webDir: '/nonexistent' });
    try {
      const huge = '{"text":"' + 'x'.repeat(ARCHITECT_BODY_LIMIT) + '"}';
      const res = await app.inject({ method: 'POST', url: `/api/architect-chats/${chat}/messages`, headers: { 'content-type': 'application/json' }, payload: huge });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('takes four images of 5 MB each on the Architect route (the body limit is raised for it only)', async () => {
    const chat = await architectChat();
    const app = buildServer(env.ctx, { ...(await testServerKeys()), webDir: '/nonexistent' });
    try {
      const client = asClient(app, await loginCookie(app));
      const four = Array.from({ length: 4 }, () => ({ data: b64(png(MAX_IMAGE_BYTES)) }));
      const res = await client.inject({ method: 'POST', url: `/api/architect-chats/${chat}/messages`, payload: { text: '', images: four } });
      expect(res.statusCode).toBe(200);
      expect((await getChat(env.ctx, chat, 'architect')).messages.at(-1)!.images).toHaveLength(4);
    } finally {
      await app.close();
    }
  }, 120_000);
});
