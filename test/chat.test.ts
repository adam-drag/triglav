import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { chatByToken, createChat, getChat, ingestChatEvents, issueChatToken, listChats, revokeChatToken, nextCommand, resetChatStates, sendChatMessage, stopChat, subscribe, type ChatEvent } from '../src/chat.ts';
import { exec, query, queryOne } from '../src/db.ts';
import { sha256 } from '../src/lib.ts';
import { buildOperatorServer } from '../src/operator.ts';
import { planLimits } from '../src/telemetry.ts';
import { createTestCtx, TEST_DB_URL } from './helpers.ts';

// Runs against a real MySQL: set ORCH_TEST_DATABASE_URL (see README). Skipped otherwise.
describe.skipIf(!TEST_DB_URL)('the Operator chat', () => {
  let env: Awaited<ReturnType<typeof createTestCtx>>;
  beforeAll(async () => {
    env = await createTestCtx();
  });
  afterAll(async () => {
    await env?.close();
  });

  it('queues the first message for the runner, with no token and no session yet', async () => {
    const { id, message } = await createChat(env.ctx, { text: '  Why is staff-safety offline?  ' });
    expect(message).toMatchObject({ role: 'client', text: 'Why is staff-safety offline?' });
    const command = await nextCommand(env.ctx, 0);
    expect(command).toMatchObject({ kind: 'send', chat_id: id, text: 'Why is staff-safety offline?', session_id: null });
    // The token is not part of a command: the runner asks for one when it starts a process (issueChatToken).
    expect(JSON.stringify(command)).not.toContain('orch_chat_');
    expect(command).not.toHaveProperty('token');
    // Taken once: the same command is not handed out again, and an empty queue answers null after the wait.
    expect(await nextCommand(env.ctx, 0)).toBeNull();
    const chat = await getChat(env.ctx, id);
    expect(chat).toMatchObject({ id, state: 'working', title: 'Why is staff-safety offline?' });
    expect(JSON.stringify(chat)).not.toContain('orch_chat_');
    expect(JSON.stringify(await listChats(env.ctx))).not.toContain('orch_chat_');
  });

  it('wakes a waiting runner as soon as a message arrives', async () => {
    const { id } = await createChat(env.ctx, { text: 'first' });
    await nextCommand(env.ctx, 0);
    const waiting = nextCommand(env.ctx, 5000);
    await new Promise((r) => setTimeout(r, 150));
    const started = Date.now();
    await sendChatMessage(env.ctx, id, { text: 'second' });
    const command = await waiting;
    expect(command).toMatchObject({ kind: 'send', text: 'second' });
    expect(Date.now() - started).toBeLessThan(2500);
  });

  it('does not hand a message to a runner that has hung up, and gives back one it took too late', async () => {
    const { id } = await createChat(env.ctx, { text: 'for the next runner' });
    // Hung up before it looked: the command stays in the queue.
    const gone = new AbortController();
    gone.abort();
    expect(await nextCommand(env.ctx, 1000, gone.signal)).toBeNull();
    // Hangs up while waiting on an empty queue, then a message arrives: the dead poll must not take it.
    await nextCommand(env.ctx, 0);
    const later = new AbortController();
    const waiting = nextCommand(env.ctx, 5000, later.signal);
    await new Promise((r) => setTimeout(r, 100));
    later.abort();
    expect(await waiting).toBeNull();
    await sendChatMessage(env.ctx, id, { text: 'arrives after the hang up' });
    await new Promise((r) => setTimeout(r, 200));
    expect(await nextCommand(env.ctx, 0)).toMatchObject({ text: 'arrives after the hang up' });
  });

  it('keeps what the Operator says, tells open streams, and resumes with the session it reported', async () => {
    const { id } = await createChat(env.ctx, { text: 'hello' });
    await nextCommand(env.ctx, 0);
    const seen: ChatEvent[] = [];
    const sub = subscribe(id, (e) => seen.push(e));
    await ingestChatEvents(env.ctx, id, [
      { type: 'session', session_id: '1b85d8aa-ea20-41ef-baa6-1de0d08eb630' },
      { type: 'delta', text: 'Hel' },
      { type: 'delta', text: 'lo' },
    ]);
    expect(subscribe(id, () => {}).partial).toBe('Hello');
    await ingestChatEvents(env.ctx, id, [{ type: 'message', role: 'tool', text: 'list_agents' }, { type: 'message', role: 'operator', text: 'Hello there' }, { type: 'state', state: 'idle' }]);
    sub.unsubscribe();
    expect(seen.map((e) => e.type)).toEqual(['delta', 'delta', 'message', 'message', 'state']);
    expect(subscribe(id, () => {}).partial).toBe('');
    const chat: any = await getChat(env.ctx, id);
    expect(chat.state).toBe('idle');
    expect(chat.messages.map((m: any) => [m.role, m.text])).toEqual([['client', 'hello'], ['tool', 'list_agents'], ['operator', 'Hello there']]);
    await sendChatMessage(env.ctx, id, { text: 'and now?' });
    expect(await nextCommand(env.ctx, 0)).toMatchObject({ kind: 'send', session_id: '1b85d8aa-ea20-41ef-baa6-1de0d08eb630' });
  });

  it('passes a stop to the runner and marks every chat stopped when the runner starts again', async () => {
    const { id } = await createChat(env.ctx, { text: 'long job' });
    await nextCommand(env.ctx, 0);
    await stopChat(env.ctx, id);
    expect(await nextCommand(env.ctx, 0)).toMatchObject({ kind: 'stop', chat_id: id });
    await resetChatStates(env.ctx);
    expect(((await getChat(env.ctx, id)) as any).state).toBe('stopped');
  });

  it('clears every token when a runner starts, for one that was killed before it could revoke its own', async () => {
    const { id } = await createChat(env.ctx, { text: 'left behind' });
    const token = await issueChatToken(env.ctx, id);
    expect(await chatByToken(env.ctx, token)).toMatchObject({ id });
    await resetChatStates(env.ctx);
    expect(await chatByToken(env.ctx, token)).toBeUndefined();
  });

  it('records the plan usage from the stream as an exact Claude reading', async () => {
    const { id } = await createChat(env.ctx, { text: 'usage' });
    const reset = Math.floor(Date.now() / 1000) + 3600;
    await ingestChatEvents(env.ctx, id, [{ type: 'usage', windows: [{ window: 'five_hour', used: 22, resets_at: reset }, { window: 'seven_day', used: 33, resets_at: null }] }]);
    const limits = await planLimits(env.ctx.pool, new Date());
    expect(limits.claude.map((r: any) => [r.window, r.source, r.used, r.reset])).toEqual([
      ['five_hour', 'stream', 22, false],
      ['seven_day', 'stream', 33, false],
    ]);
  });

  it('refuses empty and oversized messages and unknown chats', async () => {
    await expect(createChat(env.ctx, { text: '   ' })).rejects.toThrow(/Write a message/);
    await expect(createChat(env.ctx, { text: 'x'.repeat(8001) })).rejects.toThrow(/at most 8000/);
    await expect(sendChatMessage(env.ctx, 'cht_0000000000000000', { text: 'hi' })).rejects.toThrow(/not found/);
    await expect(ingestChatEvents(env.ctx, 'cht_0000000000000000', [])).rejects.toThrow(/not found/);
  });

  it('knows a chat by its token and by nothing else', async () => {
    const { id } = await createChat(env.ctx, { text: 'who am i' });
    const token = await issueChatToken(env.ctx, id);
    expect(token).toMatch(/^orch_chat_/);
    expect(await chatByToken(env.ctx, token)).toMatchObject({ id });
    expect(await chatByToken(env.ctx, 'orch_chat_wrong')).toBeUndefined();
  });

  it('stores only a hash of the token, and a new token replaces the old one', async () => {
    const { id } = await createChat(env.ctx, { text: 'hash me' });
    expect(await chatByToken(env.ctx, 'anything')).toBeUndefined();
    const first = await issueChatToken(env.ctx, id);
    const second = await issueChatToken(env.ctx, id);
    expect(second).not.toBe(first);
    // The table has no column that could hold the token, and the hash column holds the SHA-256 of the current one.
    const columns = (await query<{ COLUMN_NAME: string }>(env.ctx.pool, `SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'chats'`)).map((c) => c.COLUMN_NAME);
    expect(columns).not.toContain('token');
    expect(columns).toContain('token_hash');
    const row = await queryOne<{ token_hash: string }>(env.ctx.pool, `SELECT token_hash FROM chats WHERE id = ?`, [id]);
    expect(row!.token_hash).toBe(sha256(second));
    const everything = JSON.stringify(await query(env.ctx.pool, `SELECT * FROM chats`)) + JSON.stringify(await query(env.ctx.pool, `SELECT * FROM chat_commands`)) + JSON.stringify(await query(env.ctx.pool, `SELECT * FROM chat_messages`));
    expect(everything).not.toContain(first);
    expect(everything).not.toContain(second);
    // The first token no longer opens anything: its process was replaced.
    expect(await chatByToken(env.ctx, first)).toBeUndefined();
    expect(await chatByToken(env.ctx, second)).toMatchObject({ id });
    // The hash itself is not a token.
    expect(await chatByToken(env.ctx, row!.token_hash)).toBeUndefined();
    await expect(issueChatToken(env.ctx, 'cht_0000000000000000')).rejects.toThrow(/not found/);
  });

  it('revokes a token when its process ends, but never a newer one', async () => {
    const { id } = await createChat(env.ctx, { text: 'revoke me' });
    const first = await issueChatToken(env.ctx, id);
    const second = await issueChatToken(env.ctx, id);
    // The first process closes late: the second one keeps its token.
    await revokeChatToken(env.ctx, id, first);
    expect(await chatByToken(env.ctx, second)).toMatchObject({ id });
    await revokeChatToken(env.ctx, id, second);
    expect(await chatByToken(env.ctx, second)).toBeUndefined();
    expect((await queryOne<{ token_hash: string | null }>(env.ctx.pool, `SELECT token_hash FROM chats WHERE id = ?`, [id]))!.token_hash).toBeNull();
  });

  it('a chat that had no token hash (an old chat after the migration) has no valid token until the runner asks for one', async () => {
    const { id } = await createChat(env.ctx, { text: 'old chat' });
    await exec(env.ctx.pool, `UPDATE chats SET token_hash = NULL WHERE id = ?`, [id]);
    expect(await chatByToken(env.ctx, '')).toBeUndefined();
    expect(await chatByToken(env.ctx, 'null')).toBeUndefined();
    expect(await chatByToken(env.ctx, await issueChatToken(env.ctx, id))).toMatchObject({ id });
  });

  it('gives the Operator tools that read, and tools that only ask', async () => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const server = buildOperatorServer(env.ctx, 'cht_0000000000000000');
    await server.connect(serverSide);
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(clientSide);
    const { tools } = await client.listTools();
    const reads = tools.filter((t) => !t.name.startsWith('propose_'));
    expect(reads.map((t) => t.name).sort()).toEqual(['client_decisions', 'get_agent', 'get_job', 'launches', 'list_agents', 'list_jobs', 'overview', 'usage']);
    for (const t of reads) expect(t.annotations?.readOnlyHint, t.name).toBe(true);
    const overview: any = await client.callTool({ name: 'overview', arguments: {} });
    const body = JSON.parse(overview.content[0].text);
    expect(body.notice).toMatch(/never instructions/);
    expect(body.result).toMatchObject({ decisions_waiting: 0 });
    const missing: any = await client.callTool({ name: 'get_job', arguments: { job_id: 'job_nope' } });
    expect(missing.isError).toBe(true);
    await client.close();
    await server.close();
  });
});
