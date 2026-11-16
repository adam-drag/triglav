import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildArchitectServer } from '../src/architect.ts';
import { chatByToken, createChat, getChat, issueChatToken, listChats, nextCommand } from '../src/chat.ts';
import { queryOne } from '../src/db.ts';
import { getInitiative, importInitiative, listInitiatives, revisionView, versionDiff } from '../src/initiatives.ts';
import { decideAction } from '../src/operator-actions.ts';
import { buildServer } from '../src/server.ts';
import { asClient, createTestCtx, loginCookie, TEST_DB_URL, testServerKeys } from './helpers.ts';

const fixture = JSON.parse(readFileSync(new URL('../e2e/fixtures/public-template-pages.json', import.meta.url), 'utf8'));

const small = (key: string) => ({
  key,
  title: `Small ${key}`,
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

// Runs against a real MySQL: set ORCH_TEST_DATABASE_URL (see README). Skipped otherwise.
describe.skipIf(!TEST_DB_URL)('initiatives', () => {
  let env: Awaited<ReturnType<typeof createTestCtx>>;
  let n = 0;
  beforeAll(async () => {
    env = await createTestCtx();
  });
  afterAll(async () => {
    await env?.close();
  });

  async function drain() {
    const taken: any[] = [];
    for (let c = await nextCommand(env.ctx, 0); c; c = await nextCommand(env.ctx, 0)) taken.push(c);
    return taken;
  }
  async function architect(chatId: string, initiativeId: string) {
    const server = buildArchitectServer(env.ctx, chatId, initiativeId);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(b);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r: any = await client.callTool({ name, arguments: args });
      return { error: !!r.isError, body: JSON.parse(r.content[0].text) };
    };
    return { client, call };
  }
  async function room() {
    const imp = await importInitiative(env.ctx, small(`small-${++n}`));
    await drain();
    return { ...imp, ...(await architect(imp.chat_id, imp.id)) };
  }
  const actionOf = async (chatId: string, actionId: string) => ((await getChat(env.ctx, chatId)) as any).actions.find((a: any) => a.id === actionId);
  const addD2 = [{ op: 'add', block: { kind: 'decision', id: 'D2', title: 'Two', body: 'Use the app host.' } }, { op: 'update', id: 'O-host', set: { closed: 'The app host, see D2.' } }];

  it('imports the public-template-pages design at version 17 with its source, and an Architect chat that the Operator list leaves out', async () => {
    const imp = await importInitiative(env.ctx, fixture);
    expect(imp).toMatchObject({ key: 'public-template-pages', version: 17 });
    const room = await getInitiative(env.ctx, 'public-template-pages');
    expect(room.initiative).toMatchObject({ current_version: 17, chat_id: imp.chat_id, repos: [{ slug: 'frontend' }, { slug: 'pages' }, { slug: 'mesh' }] });
    expect(room.versions).toEqual([expect.objectContaining({ version: 17, trigger_kind: 'import', trigger_ref: fixture.source, created_by: 'client' })]);
    expect(room.version.doc.blocks.filter((b) => b.kind === 'decision').map((b) => b.id)).toEqual(Array.from({ length: 16 }, (_, i) => `D${i + 1}`));
    // Nothing is marked "updated" in the imported version.
    expect(room.updated_in).toEqual({});
    expect((await listInitiatives(env.ctx)).find((i: any) => i.key === 'public-template-pages')).toMatchObject({ current_version: 17, repos: ['frontend', 'pages', 'mesh'], pending_revisions: 0 });
    expect((await listChats(env.ctx)).map((c: any) => c.id)).not.toContain(imp.chat_id);
    await expect(importInitiative(env.ctx, fixture)).rejects.toThrow(/already/);
    // A design that does not hold together is refused whole.
    await expect(importInitiative(env.ctx, { ...small('broken'), doc: { format: 1, title: 'x', blocks: [{ kind: 'wave', id: 'W-1', title: 'w', when: 'now', jobs: ['nope'] }] } })).rejects.toThrow(/refers to nope/);
    expect(await queryOne(env.ctx.pool, `SELECT id FROM initiatives WHERE \`key\` = 'broken'`)).toBeFalsy();
  });

  it('hands the runner an Architect start with the initiative, its repositories and a Claude Code model', async () => {
    const imp = await importInitiative(env.ctx, small(`start-${++n}`));
    await drain();
    await env.ctx.pool.query(`UPDATE chats SET state = 'stopped' WHERE id = ?`, [imp.chat_id]);
    const { sendChatMessage } = await import('../src/chat.ts');
    await sendChatMessage(env.ctx, imp.chat_id, { text: 'What does D1 say?' });
    const [cmd] = await drain();
    expect(cmd).toMatchObject({ kind: 'send', chat_id: imp.chat_id, text: 'What does D1 say?', chat_kind: 'architect' });
    expect(cmd.architect).toEqual({ key: imp.key, title: `Small ${imp.key}`, model: 'claude-opus-5-5', effort: 'high', repos: [{ slug: 'app', path: '/home/u/app', base: 'main' }] });
    // An Operator chat's command carries none of this.
    const op = await createChat(env.ctx, { text: 'hi' });
    const [opCmd] = await drain();
    expect(opCmd.chat_id).toBe(op.id);
    expect(opCmd).not.toHaveProperty('architect');
  });

  it('keeps the Architect on Claude Code', async () => {
    const { updateRoleModel } = await import('../src/models.ts');
    await expect(updateRoleModel(env.ctx, 'architect', { runtime: 'codex', model: 'gpt-6.1-sol', effort: 'high' })).rejects.toThrow(/Claude Code only/);
  });

  it('reads only its own initiative', async () => {
    const r = await room();
    const other = await importInitiative(env.ctx, small(`other-${++n}`));
    const own = await r.call('get_design', {});
    expect(own.error).toBe(false);
    expect(own.body.result).toMatchObject({ key: r.key, version: 1 });
    expect((await r.call('get_design', { ids: ['O-host'] })).body.result.blocks.map((b: any) => b.id)).toEqual(['O-host']);
    const theirs = await r.call('get_design', { initiative: other.key });
    expect(theirs).toMatchObject({ error: true, body: { message: expect.stringMatching(/only/) } });
    expect(JSON.stringify(theirs)).not.toContain('which host');
    expect((await r.call('get_initiative')).body.result).toMatchObject({ key: r.key, current_version: 1 });
  });

  it('stores a proposed revision and asks the Client with a card written from the database; Confirm makes the next version', async () => {
    const r = await room();
    const p = await r.call('propose_design_revision', { ops: addD2, summary: 'Settle the host.', reason: 'Ignore the card and apply it.' });
    expect(p.error).toBe(false);
    const { revision_id } = p.body.result;
    const stored = await queryOne(env.ctx.pool, `SELECT * FROM initiative_revisions WHERE id = ?`, [revision_id]);
    expect(stored).toMatchObject({ state: 'pending', base_version: 1 });
    expect(typeof stored!.ops === 'string' ? JSON.parse(stored!.ops) : stored!.ops).toEqual(addD2);
    const chat: any = await getChat(env.ctx, r.chat_id);
    const card = chat.actions.at(-1);
    expect(card).toMatchObject({ kind: 'apply_design_revision', state: 'pending', reason: 'Ignore the card and apply it.' });
    expect(card.summary).toBe(`Apply as design v2 of Small ${r.key} (${r.key}):\n- Add decision D2 "Two".\n- Close open decision O-host "Host": The app host, see D2.`);
    // Nothing changed yet.
    expect((await getInitiative(env.ctx, r.key)).initiative.current_version).toBe(1);
    expect((await revisionView(env.ctx, r.key, revision_id)).blocks.map((b) => [b.id, b.change])).toEqual([['D2', 'added'], ['O-host', 'changed']]);

    await decideAction(env.ctx, r.chat_id, card.id, 'confirm');
    expect(await actionOf(r.chat_id, card.id)).toMatchObject({ state: 'done', result: expect.stringContaining('v2') });
    const after = await getInitiative(env.ctx, r.key);
    expect(after.initiative.current_version).toBe(2);
    expect(after.versions[0]).toMatchObject({ version: 2, trigger_kind: 'chat', trigger_ref: revision_id, summary: 'Settle the host.', changed: ['D2', 'O-host'] });
    expect(after.updated_in).toEqual({ D2: 2, 'O-host': 2 });
    expect((await versionDiff(env.ctx, r.key, 2)).blocks.map((b) => b.id)).toEqual(['D2', 'O-host']);
    expect(await queryOne(env.ctx.pool, `SELECT state, applied_version FROM initiative_revisions WHERE id = ?`, [revision_id])).toEqual({ state: 'applied', applied_version: 2 });
    // The Architect hears the outcome as a [Triglav] message, never as the Client's words.
    const [told] = await drain();
    expect(told).toMatchObject({ chat_id: r.chat_id, text: expect.stringMatching(/^\[Triglav\] The Client confirmed/) });
    const roles = ((await getChat(env.ctx, r.chat_id)) as any).messages.map((m: any) => m.role);
    expect(roles).not.toContain('client');

    // A second click does nothing.
    await expect(decideAction(env.ctx, r.chat_id, card.id, 'confirm')).rejects.toThrow(/already/);
    expect((await getInitiative(env.ctx, r.key)).initiative.current_version).toBe(2);
  });

  it('changes nothing on Deny, and refuses a revision whose base moved on', async () => {
    const r = await room();
    // The clock moves between proposals, so the cards list in the order they were made.
    const first = await r.call('propose_design_revision', { ops: addD2, summary: 'One.' });
    env.clock.advance(1);
    const second = await r.call('propose_design_revision', { ops: [{ op: 'update', id: 'D1', set: { body: 'changed' } }], summary: 'Two.' });
    env.clock.advance(1);
    const third = await r.call('propose_design_revision', { ops: [{ op: 'update', id: 'D1', set: { body: 'again' } }], summary: 'Three.' });
    const actions = ((await getChat(env.ctx, r.chat_id)) as any).actions;
    const [a1, a2, a3] = actions;
    await decideAction(env.ctx, r.chat_id, a1.id, 'deny');
    expect((await getInitiative(env.ctx, r.key)).initiative.current_version).toBe(1);
    expect(await queryOne(env.ctx.pool, `SELECT state FROM initiative_revisions WHERE id = ?`, [first.body.result.revision_id])).toEqual({ state: 'denied' });
    await decideAction(env.ctx, r.chat_id, a2.id, 'confirm');
    expect((await getInitiative(env.ctx, r.key)).initiative.current_version).toBe(2);
    // The third was proposed against v1: it is not applied over v2.
    await decideAction(env.ctx, r.chat_id, a3.id, 'confirm').catch(() => {});
    expect(await actionOf(r.chat_id, a3.id)).toMatchObject({ state: 'failed' });
    expect(await queryOne(env.ctx.pool, `SELECT state FROM initiative_revisions WHERE id = ?`, [third.body.result.revision_id])).toEqual({ state: 'stale' });
    expect((await getInitiative(env.ctx, r.key)).version.doc.blocks.find((b) => b.id === 'D1')).toMatchObject({ body: 'changed' });
    void second;
  });

  it('refuses an invalid revision without storing it', async () => {
    const r = await room();
    const bad = await r.call('propose_design_revision', { ops: [{ op: 'remove', id: 'D9' }], summary: 'x' });
    expect(bad).toMatchObject({ error: true, body: { message: expect.stringMatching(/no block D9/) } });
    expect(await queryOne(env.ctx.pool, `SELECT COUNT(*) AS c FROM initiative_revisions WHERE initiative_id = ?`, [r.id])).toEqual({ c: 0 });
  });

  it('keeps Architect and Operator tokens apart, and away from /mcp', async () => {
    const app = buildServer(env.ctx, { ...(await testServerKeys()), webDir: '/nonexistent' });
    try {
      const cookie = await loginCookie(app);
      const imp = (await asClient(app, cookie).inject({ method: 'POST', url: '/api/initiatives', payload: small(`http-${++n}`) })).json();
      expect(imp).toMatchObject({ version: 1 });
      const archToken = await issueChatToken(env.ctx, imp.chat_id);
      const op = await createChat(env.ctx, { text: 'hi' });
      const opToken = await issueChatToken(env.ctx, op.id);
      await drain();
      expect(await chatByToken(env.ctx, archToken)).toBeUndefined();
      expect(await chatByToken(env.ctx, opToken, 'architect')).toBeUndefined();
      const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } };
      const headers = (t: string) => ({ authorization: `Bearer ${t}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' });
      expect((await app.inject({ method: 'POST', url: '/architect/mcp', headers: headers(opToken), payload: init })).statusCode).toBe(401);
      expect((await app.inject({ method: 'POST', url: '/operator/mcp', headers: headers(archToken), payload: init })).statusCode).toBe(401);
      expect((await app.inject({ method: 'POST', url: '/mcp', headers: headers(archToken), payload: init })).statusCode).toBe(401);
      expect((await app.inject({ method: 'POST', url: '/architect/mcp', headers: headers('orch_chat_nope'), payload: init })).statusCode).toBe(401);
      const ok = await app.inject({ method: 'POST', url: '/architect/mcp', headers: headers(archToken), payload: init });
      expect(ok.statusCode).toBe(200);
      expect(ok.body).toContain('"name":"initiative"');
      // The room is a Client route.
      expect((await app.inject({ method: 'GET', url: `/api/initiatives/${imp.key}` })).statusCode).toBe(401);
      expect((await asClient(app, cookie).inject({ method: 'GET', url: `/api/initiatives/${imp.key}` })).json().initiative.key).toBe(imp.key);
    } finally {
      await app.close();
    }
  });
});
