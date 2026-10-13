import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { editAgent } from '../src/agent-edit.ts';
import { authenticate, listAgents, registerAgent } from '../src/agents.ts';
import { createChat, nextCommand } from '../src/chat.ts';
import { exec, queryOne } from '../src/db.ts';
import { recordHostRuntimes } from '../src/models.ts';
import { decideAction, proposeAction } from '../src/operator-actions.ts';
import { finishLaunch, nextLaunch } from '../src/telemetry.ts';
import { createTestCtx, TEST_DB_URL } from './helpers.ts';

const SESSION = '11111111-1111-4111-8111-111111111111';

// Runs against a real MySQL: set ORCH_TEST_DATABASE_URL (see README). Skipped otherwise.
describe.skipIf(!TEST_DB_URL)('the Client edits an agent', () => {
  let env: Awaited<ReturnType<typeof createTestCtx>>;
  let n = 0;
  beforeAll(async () => {
    env = await createTestCtx();
  });
  afterAll(async () => {
    await env?.close();
  });

  /** An agent with a live session the runner could resume, as telemetry records it. */
  async function agent(role: string, runtime = 'claude-code') {
    const reg = await registerAgent(env.ctx, { role: role as any, nickname: `${role}-${++n}`, runtime, model: 'claude-opus-5-5' });
    const a = await authenticate(env.ctx, reg.session_token);
    await exec(env.ctx.pool, `UPDATE agent_sessions SET transcript_session = ?, transcript_cwd = '/repo' WHERE agent_id = ? AND ended_at IS NULL`, [SESSION, a.id]);
    return a;
  }
  /** A Senior is registered from a spawn ticket Staff holds; only its row matters here. */
  async function senior() {
    const id = `agt_senior${++n}`;
    await exec(env.ctx.pool, `INSERT INTO agents (id, nickname, role, runtime, model, created_at) VALUES (?, ?, 'senior', 'claude-code', 'claude-sonnet-5-5', ?)`, [id, `senior-${n}`, env.ctx.clock.now()]);
    return { id };
  }
  const row = async (id: string) => (await queryOne(env.ctx.pool, `SELECT nickname, model, effort FROM agents WHERE id = ?`, [id]))!;

  it('renames at once, for any role', async () => {
    const a = await senior();
    expect(await editAgent(env.ctx, a.id, { nickname: '  senior-ben ' })).toEqual({ ok: true, switch_queued: false });
    expect((await row(a.id)).nickname).toBe('senior-ben');
    await expect(editAgent(env.ctx, a.id, { nickname: '   ' })).rejects.toThrow(/empty/);
    await expect(editAgent(env.ctx, a.id, {})).rejects.toThrow(/Nothing/);
  });

  it('restarts a Claude Staff with the new model, and the agent changes only when the runner says it worked', async () => {
    const a = await agent('staff');
    expect(await editAgent(env.ctx, a.id, { model: 'claude-sonnet-5-5', effort: 'medium' })).toEqual({ ok: true, switch_queued: true });
    expect((await row(a.id)).model).toBe('claude-opus-5-5');
    await expect(editAgent(env.ctx, a.id, { model: 'claude-sonnet-5-5', effort: 'low' })).rejects.toThrow(/already queued/);
    const l: any = await nextLaunch(env.ctx);
    expect(l).toMatchObject({ kind: 'switch', runtime: 'claude-code', session_id: SESSION, cwd: '/repo', model: 'claude-sonnet-5-5', effort: 'medium' });
    await finishLaunch(env.ctx, l.id, 'failed: boom');
    expect(await row(a.id)).toMatchObject({ model: 'claude-opus-5-5', effort: null });
    await editAgent(env.ctx, a.id, { model: 'claude-sonnet-5-5', effort: 'medium' });
    const l2: any = await nextLaunch(env.ctx);
    await finishLaunch(env.ctx, l2.id, 'ok: backgrounded');
    expect(await row(a.id)).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'medium' });
    const listed = (await listAgents(env.ctx, { includeInactive: true })).find((x) => x.id === a.id);
    expect(listed).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'medium' });
  });

  it('never changes the runtime, and refuses what cannot be switched', async () => {
    const codex = await agent('staff', 'codex');
    await expect(editAgent(env.ctx, codex.id, { model: 'gpt-6.1-sol', effort: 'high' })).rejects.toThrow(/Only a Claude Code Staff/);
    const sr = await senior();
    await expect(editAgent(env.ctx, sr.id, { model: 'claude-sonnet-5-5', effort: 'high' })).rejects.toThrow(/cannot be switched/);
    const staff = await agent('staff');
    await expect(editAgent(env.ctx, staff.id, { model: 'claude-sonnet-5-5' })).rejects.toThrow(/both a model and an effort/);
    await expect(editAgent(env.ctx, staff.id, { model: '--bad', effort: 'high' })).rejects.toThrow(/may only contain/);
    await recordHostRuntimes(env.ctx, { 'claude-code': { version: '2.1', models: [{ id: 'claude-opus-5-5', label: 'Opus', efforts: ['low', 'high'] }] }, codex: null });
    await expect(editAgent(env.ctx, staff.id, { model: 'gpt-6.1-sol', effort: 'high' })).rejects.toThrow(/does not offer/);
    await expect(editAgent(env.ctx, staff.id, { model: 'claude-opus-5-5', effort: 'max' })).rejects.toThrow(/does not accept/);
  });

  it('is an Operator action that waits for the Client, then edits', async () => {
    const a = await agent('staff');
    const { id: chatId } = await createChat(env.ctx, { text: 'switch staff' });
    while (await nextCommand(env.ctx, 0)) { /* drain */ }
    const { id, summary } = await proposeAction(env.ctx, chatId, 'edit_agent', { agent_id: a.id, nickname: 'staff-x', model: 'claude-opus-5-5', effort: 'low' }, undefined);
    expect(summary).toContain(`For ${a.nickname} (staff)`);
    expect(summary).toContain('restarts a running Staff session');
    expect((await row(a.id)).nickname).toBe(a.nickname);
    await expect(proposeAction(env.ctx, chatId, 'edit_agent', { agent_id: a.id }, undefined)).rejects.toThrow();
    await decideAction(env.ctx, chatId, id, 'confirm');
    expect((await row(a.id)).nickname).toBe('staff-x');
    expect(await queryOne(env.ctx.pool, `SELECT kind, model, effort FROM launches WHERE agent_id = ? AND finished_at IS NULL`, [a.id])).toMatchObject({ kind: 'switch', model: 'claude-opus-5-5', effort: 'low' });
  });
});
