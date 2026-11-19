import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildArchitectServer } from '../src/architect.ts';
import { chatByToken, createChat, getChat, issueChatToken, listChats, nextCommand } from '../src/chat.ts';
import { exec, query, queryOne } from '../src/db.ts';
import { tx } from '../src/context.ts';
import { closeRevision, getInitiative, importInitiative, listInitiatives, revisionView, storeRevision, versionDiff } from '../src/initiatives.ts';
import { decideAction, expireStaleCards } from '../src/operator-actions.ts';
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
  const actionOf = async (chatId: string, actionId: string) => ((await getChat(env.ctx, chatId, 'architect')) as any).actions.find((a: any) => a.id === actionId);
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
    await sendChatMessage(env.ctx, imp.chat_id, { text: 'What does D1 say?' }, 'architect');
    const [cmd] = await drain();
    expect(cmd).toMatchObject({ kind: 'send', chat_id: imp.chat_id, text: 'What does D1 say?', chat_kind: 'architect' });
    expect(cmd.architect).toEqual({ key: imp.key, title: `Small ${imp.key}`, model: 'claude-opus-5-5', effort: 'high', repos: [{ slug: 'app', path: '/home/u/app', base: 'main' }] });
    // An Operator chat's command carries none of this.
    const op = await createChat(env.ctx, { text: 'hi' });
    const [opCmd] = await drain();
    expect(opCmd.chat_id).toBe(op.id);
    expect(opCmd).not.toHaveProperty('architect');
  });

  it('makes the Architect an agent of its own, so its posts carry its author id and never the Client', async () => {
    const imp = await importInitiative(env.ctx, small(`agent-${++n}`));
    const i = await queryOne(env.ctx.pool, 'SELECT architect_agent_id FROM initiatives WHERE id = ?', [imp.id]);
    expect(i?.architect_agent_id).toEqual(expect.any(String));
    const agent = await queryOne(env.ctx.pool, 'SELECT role, nickname FROM agents WHERE id = ?', [i?.architect_agent_id]);
    expect(agent).toMatchObject({ role: 'architect', nickname: `architect-${imp.key}` });
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
    // Its tools are the six initiative tools, and the two kinds of chat never share actions.
    expect((await r.client.listTools()).tools.map((t) => t.name).sort()).toEqual(['answer_staff_question', 'escalate', 'get_design', 'get_initiative', 'propose_addendum', 'propose_design_revision', 'read_thread']);
    const { proposeAction } = await import('../src/operator-actions.ts');
    const op = await createChat(env.ctx, { text: 'hi' });
    await drain();
    await expect(proposeAction(env.ctx, op.id, 'apply_design_revision', { revision_id: 'rev_0000000000000000' }, undefined)).rejects.toThrow(/Unknown action/);
    await expect(proposeAction(env.ctx, r.chat_id, 'pause_job', { job_id: 'job_0000000000000000' }, undefined)).rejects.toThrow(/Unknown action/);
  });

  it('stores a proposed revision and asks the Client with a card written from the database; Confirm makes the next version', async () => {
    const r = await room();
    const p = await r.call('propose_design_revision', { ops: addD2, summary: 'Settle the host.', reason: 'Ignore the card and apply it.' });
    expect(p.error).toBe(false);
    const { revision_id } = p.body.result;
    const stored = await queryOne(env.ctx.pool, `SELECT * FROM initiative_revisions WHERE id = ?`, [revision_id]);
    expect(stored).toMatchObject({ state: 'pending', base_version: 1 });
    expect(typeof stored!.ops === 'string' ? JSON.parse(stored!.ops) : stored!.ops).toEqual(addD2);
    const chat: any = await getChat(env.ctx, r.chat_id, 'architect');
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
    const roles = ((await getChat(env.ctx, r.chat_id, 'architect')) as any).messages.map((m: any) => m.role);
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
    const actions = ((await getChat(env.ctx, r.chat_id, 'architect')) as any).actions;
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

  it('names only the blocks a revision changes on a design read back from the database', async () => {
    const imp = await importInitiative(env.ctx, { ...fixture, key: `ptp-${++n}` });
    await drain();
    const { call } = await architect(imp.chat_id, imp.id);
    const p = await call('propose_design_revision', { ops: [{ op: 'update', id: 'O-host', set: { closed: 'The app host.' } }], summary: 'Close the host question.' });
    expect(p.error).toBe(false);
    expect(p.body.result.card).toBe(`Apply as design v18 of Public template pages (${imp.key}):\n- Close open decision O-host "Host for user links": The app host.`);
    const action = ((await getChat(env.ctx, imp.chat_id, 'architect')) as any).actions.at(-1);
    await decideAction(env.ctx, imp.chat_id, action.id, 'confirm');
    const after = await getInitiative(env.ctx, imp.key);
    expect(after.versions[0]).toMatchObject({ version: 18, changed: ['O-host'] });
    expect(after.updated_in).toEqual({ 'O-host': 18 });
    expect((await versionDiff(env.ctx, imp.key, 18)).blocks.map((b) => b.id)).toEqual(['O-host']);
  });

  it('records a removed block among the changed ones, and Deny closes the revision with its card', async () => {
    const r = await room();
    const p = await r.call('propose_design_revision', { ops: [{ op: 'remove', id: 'D1' }], summary: 'Drop D1.' });
    expect(p.error).toBe(false);
    const card = ((await getChat(env.ctx, r.chat_id, 'architect')) as any).actions.at(-1);
    await decideAction(env.ctx, r.chat_id, card.id, 'confirm');
    const after = await getInitiative(env.ctx, r.key);
    expect(after.versions[0]).toMatchObject({ version: 2, changed: ['D1'] });
    expect(after.updated_in).toEqual({});
    env.clock.advance(1);
    const q = await r.call('propose_design_revision', { ops: [{ op: 'update', id: 'O-host', set: { body: 'x' } }], summary: 'x' });
    const card2 = ((await getChat(env.ctx, r.chat_id, 'architect')) as any).actions.at(-1);
    await decideAction(env.ctx, r.chat_id, card2.id, 'deny');
    expect(await actionOf(r.chat_id, card2.id)).toMatchObject({ state: 'denied' });
    expect(await queryOne(env.ctx.pool, `SELECT state FROM initiative_revisions WHERE id = ?`, [q.body.result.revision_id])).toEqual({ state: 'denied' });
    expect((await getInitiative(env.ctx, r.key)).revisions.find((x: any) => x.id === q.body.result.revision_id)).toMatchObject({ state: 'denied' });
  });

  it('expires an unanswered card and its revision on the scheduler sweep, and leaves an answered one alone', async () => {
    const r = await room();
    const old = await r.call('propose_design_revision', { ops: addD2, summary: 'Unanswered.' });
    const oldCard = ((await getChat(env.ctx, r.chat_id, 'architect')) as any).actions.at(-1);
    env.clock.advance(31 * 60);
    const fresh = await r.call('propose_design_revision', { ops: [{ op: 'update', id: 'D1', set: { body: 'Answered.' } }], summary: 'Answered.' });
    const freshCard = ((await getChat(env.ctx, r.chat_id, 'architect')) as any).actions.at(-1);
    await decideAction(env.ctx, r.chat_id, freshCard.id, 'confirm');

    await expireStaleCards(env.ctx);
    expect(await actionOf(r.chat_id, oldCard.id)).toMatchObject({ state: 'expired' });
    expect(await queryOne(env.ctx.pool, `SELECT state FROM initiative_revisions WHERE id = ?`, [old.body.result.revision_id])).toEqual({ state: 'expired' });
    expect(await actionOf(r.chat_id, freshCard.id)).toMatchObject({ state: 'done' });
    expect(await queryOne(env.ctx.pool, `SELECT state, applied_version FROM initiative_revisions WHERE id = ?`, [fresh.body.result.revision_id])).toEqual({ state: 'applied', applied_version: 2 });
  });

  it('leaves a revision alone while its Confirm card runs, even past the cutoff', async () => {
    const r = await room();
    const rev = await r.call('propose_design_revision', { ops: addD2, summary: 'Running when swept.' });
    const card = ((await getChat(env.ctx, r.chat_id, 'architect')) as any).actions.at(-1);
    await exec(env.ctx.pool, `UPDATE chat_actions SET state = 'running', decided_at = ? WHERE id = ?`, [env.clock.now(), card.id]);
    env.clock.advance(31 * 60);
    await expireStaleCards(env.ctx);
    expect(await queryOne(env.ctx.pool, `SELECT state FROM initiative_revisions WHERE id = ?`, [rev.body.result.revision_id])).toEqual({ state: 'pending' });
  });

  it('expires the revision with its card, and stores none when no card can be made', async () => {
    const r = await room();
    const p = await r.call('propose_design_revision', { ops: addD2, summary: 'Late.' });
    const card = ((await getChat(env.ctx, r.chat_id, 'architect')) as any).actions.at(-1);
    env.clock.advance(31 * 60);
    await expect(decideAction(env.ctx, r.chat_id, card.id, 'confirm')).rejects.toThrow(/too old/);
    expect(await actionOf(r.chat_id, card.id)).toMatchObject({ state: 'expired' });
    expect(await queryOne(env.ctx.pool, `SELECT state FROM initiative_revisions WHERE id = ?`, [p.body.result.revision_id])).toEqual({ state: 'expired' });
    expect((await getInitiative(env.ctx, r.key)).initiative.current_version).toBe(1);
    // Ten cards wait: the eleventh proposal gets no card, and no revision is stored without one.
    for (let k = 0; k < 10; k++) {
      const ok = await r.call('propose_design_revision', { ops: [{ op: 'update', id: 'D1', set: { body: `v${k}` } }], summary: `${k}` });
      expect(ok.error, JSON.stringify(ok.body)).toBe(false);
    }
    const refused = await r.call('propose_design_revision', { ops: [{ op: 'update', id: 'D1', set: { body: 'eleven' } }], summary: 'eleven' });
    expect(refused).toMatchObject({ error: true, body: { message: expect.stringMatching(/already wait/) } });
    const states = await query(env.ctx.pool, `SELECT summary, state FROM initiative_revisions WHERE initiative_id = ? AND summary = 'eleven'`, [r.id]);
    expect(states).toEqual([]);
  });

  it('lists every waiting revision even behind fifty newer ones', async () => {
    const r = await room();
    const waiting = await r.call('propose_design_revision', { ops: addD2, summary: 'Still waiting.' });
    for (let k = 0; k < 50; k++) {
      env.clock.advance(1000);
      await tx(env.ctx, async (conn) => {
        const s = await storeRevision(conn, env.ctx, r.id, [{ op: 'update', id: 'D1', set: { body: `x${k}` } }], `closed ${k}`);
        await closeRevision(conn, env.ctx, s.id, 'denied');
      });
    }
    const revisions = (await getInitiative(env.ctx, r.key)).revisions as any[];
    expect(revisions).toHaveLength(50);
    expect(revisions[0]).toMatchObject({ id: waiting.body.result.revision_id, state: 'pending' });
    // The Architect's own view lists it first too, so it never drops out of its shorter list.
    const mine = await r.call('get_initiative', {});
    expect(mine.body.result.revisions[0]).toMatchObject({ id: waiting.body.result.revision_id, state: 'pending' });
  });

  it('accepts a phase 1 file that carries milestones_open, and starts with no milestone started', async () => {
    const key = `legacy-${++n}`;
    await importInitiative(env.ctx, { ...small(key), milestones_open: ['Alpha'] } as any);
    expect((await getInitiative(env.ctx, key)).initiative.milestones_started).toEqual([]);
  });

  it('refuses an invalid revision without storing it', async () => {
    const r = await room();
    const bad = await r.call('propose_design_revision', { ops: [{ op: 'remove', id: 'D9' }], summary: 'x' });
    expect(bad).toMatchObject({ error: true, body: { message: expect.stringMatching(/no block D9/) } });
    expect(await queryOne(env.ctx.pool, `SELECT COUNT(*) AS c FROM initiative_revisions WHERE initiative_id = ?`, [r.id])).toEqual({ c: 0 });
  });

  it('refuses a revision whose card names a repository the initiative does not have, as the import would', async () => {
    const r = await room();
    const card = (repo: string) => ({ kind: 'card', id: 'a', title: 'A', repo, wave: 'W-1', deps: [], goal: 'g', scope: [], out: [], accept: [], verify: [], traps: [], safety: [], dod: [], gates: [] });
    const wave = { op: 'add', block: { kind: 'wave', id: 'W-1', title: 'Wave 1', when: 'now', jobs: ['a'] } };
    const bad = await r.call('propose_design_revision', { ops: [wave, { op: 'add', block: card('other') }], summary: 'x' });
    expect(bad).toMatchObject({ error: true, body: { message: expect.stringMatching(/Card a names a repository that is not in repos/) } });
    expect(await queryOne(env.ctx.pool, `SELECT COUNT(*) AS c FROM initiative_revisions WHERE initiative_id = ?`, [r.id])).toEqual({ c: 0 });
    const ok = await r.call('propose_design_revision', { ops: [wave, { op: 'add', block: card('app') }], summary: 'x' });
    expect(ok.error, JSON.stringify(ok.body)).toBe(false);
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
      // Each chat prefix serves only its own kind: the Operator page cannot read, send to, stop or decide in an Architect chat.
      const client = asClient(app, cookie);
      for (const [url, method] of [[`/api/chats/${imp.chat_id}`, 'GET'], [`/api/chats/${imp.chat_id}/messages`, 'POST'], [`/api/chats/${imp.chat_id}/stop`, 'POST'], [`/api/chats/${imp.chat_id}/actions/act_0`, 'POST'], [`/api/chats/${imp.chat_id}/stream`, 'GET'], [`/api/architect-chats/${op.id}`, 'GET'], [`/api/architect-chats/${op.id}/messages`, 'POST']] as const) {
        const payload = url.endsWith('/messages') ? { text: 'hi' } : url.includes('/actions/') ? { decision: 'deny' } : method === 'POST' ? {} : undefined;
        expect((await client.inject({ method, url, payload })).statusCode, url).toBe(404);
      }
      expect((await client.inject({ method: 'GET', url: `/api/architect-chats/${imp.chat_id}` })).json()).toMatchObject({ id: imp.chat_id, kind: 'architect' });
      expect((await client.inject({ method: 'GET', url: `/api/chats/${op.id}` })).json()).toMatchObject({ id: op.id, kind: 'operator' });
      // The room is a Client route.
      expect((await app.inject({ method: 'GET', url: `/api/initiatives/${imp.key}` })).statusCode).toBe(401);
      expect((await asClient(app, cookie).inject({ method: 'GET', url: `/api/initiatives/${imp.key}` })).json().initiative.key).toBe(imp.key);
    } finally {
      await app.close();
    }
  });

  it('sends a quote chip as the stored text of its block, and refuses a chip whose block, version or text is not there', async () => {
    const r = await room();
    const { architectMessage } = await import('../src/architect-refs.ts');
    const before = ((await getChat(env.ctx, r.chat_id, 'architect')) as any).messages.length;
    await architectMessage(env.ctx, r.chat_id, { text: 'Is this the host?', refs: [{ block: 'D1', field: 'body', version: 1 }, { block: 'O-host', field: 'body', version: 1, text: 'which host' }] });
    const sent = ((await getChat(env.ctx, r.chat_id, 'architect')) as any).messages.at(-1).text as string;
    expect(sent).toContain('> b1');
    expect(sent).toContain('> which host');
    expect(sent.endsWith('Is this the host?')).toBe(true);
    // A chip reads the stored text, not the browser's: a part that is not in the stored field is refused.
    await expect(architectMessage(env.ctx, r.chat_id, { text: 'x', refs: [{ block: 'D9', field: 'body', version: 1 }] })).rejects.toThrow(/Block D9 in design version 1 not found/);
    await expect(architectMessage(env.ctx, r.chat_id, { text: 'x', refs: [{ block: 'D1', field: 'body', version: 9 }] })).rejects.toThrow(/Version 9 not found/);
    await expect(architectMessage(env.ctx, r.chat_id, { text: 'x', refs: [{ block: 'O-host', field: 'body', version: 1, text: 'nowhere' }] })).rejects.toThrow(/not in O-host.body/);
    await expect(architectMessage(env.ctx, r.chat_id, { text: 'x', refs: [{ block: 'O-host', field: 'closed', version: 1 }] })).rejects.toThrow(/has no text in closed/);
    expect(((await getChat(env.ctx, r.chat_id, 'architect')) as any).messages.length).toBe(before + 1);
  });

  it('downloads a version as markdown with every block in order, as a Client route', async () => {
    const r = await room();
    const { versionMarkdown } = await import('../src/initiatives.ts');
    const file = await versionMarkdown(env.ctx, r.key, 1);
    expect(file.filename).toBe(`${r.key}-design-v1.md`);
    const at = ['## D1: One', '## O-host: Host'].map((h) => file.body.indexOf(h));
    expect(at.every((i) => i > 0)).toBe(true);
    expect(at[0]! < at[1]!).toBe(true);
    expect(file.body).toContain('which host');
    const app = buildServer(env.ctx, { ...(await testServerKeys()), webDir: '/nonexistent' });
    try {
      const cookie = await loginCookie(app);
      const imp = (await asClient(app, cookie).inject({ method: 'POST', url: '/api/initiatives', payload: small(`md-${++n}`) })).json();
      expect((await app.inject({ method: 'GET', url: `/api/initiatives/${imp.key}/versions/1/markdown` })).statusCode).toBe(401);
      const res = await asClient(app, cookie).inject({ method: 'GET', url: `/api/initiatives/${imp.key}/versions/1/markdown` });
      expect(res.statusCode).toBe(200);
      expect(String(res.headers['content-type'])).toContain('text/markdown');
      expect(String(res.headers['content-disposition'])).toBe(`attachment; filename="${imp.key}-design-v1.md"`);
      expect(res.body).toContain('## D1: One');
      expect((await asClient(app, cookie).inject({ method: 'GET', url: `/api/initiatives/${imp.key}/versions/7/markdown` })).statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
