import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { authenticate, registerAgent, type Agent } from '../src/agents.ts';
import { clientQueue, raiseBlocker } from '../src/blockers.ts';
import { createChat, getChat, nextCommand } from '../src/chat.ts';
import { queryOne } from '../src/db.ts';
import { registerJob, updateJob } from '../src/jobs.ts';
import { buildOperatorServer } from '../src/operator.ts';
import { decideAction, expireHostActions, finishHostAction, proposeAction } from '../src/operator-actions.ts';
import { createTestCtx, issue, TEST_DB_URL } from './helpers.ts';

// Runs against a real MySQL: set ORCH_TEST_DATABASE_URL (see README). Skipped otherwise.
describe.skipIf(!TEST_DB_URL)('the Operator asks, the Client decides', () => {
  let env: Awaited<ReturnType<typeof createTestCtx>>;
  let n = 0;
  beforeAll(async () => {
    env = await createTestCtx();
  });
  afterAll(async () => {
    await env?.close();
  });

  async function staffWithJob() {
    const reg = await registerAgent(env.ctx, { role: 'staff', nickname: `staff-${++n}`, runtime: 'test' });
    const staff: Agent = await authenticate(env.ctx, reg.session_token);
    const parent = issue(`ENG-${n}00`, 'Export reports as PDF');
    env.linear.add(parent as any);
    const job = await registerJob(env.ctx, staff, { linearIssue: parent.identifier, repoPath: '/repo', baseBranch: 'main' });
    await updateJob(env.ctx, staff, { jobId: job.job_id, status: 'planning' });
    return { staff, jobId: job.job_id, identifier: parent.identifier };
  }
  /** A chat with its first command taken, as when the runner is already serving it. */
  async function chat() {
    const { id } = await createChat(env.ctx, { text: 'help' });
    await drain();
    return id;
  }
  async function drain() {
    const taken: any[] = [];
    for (let c = await nextCommand(env.ctx, 0); c; c = await nextCommand(env.ctx, 0)) taken.push(c);
    return taken;
  }
  const control = async (jobId: string) => (await queryOne(env.ctx.pool, `SELECT control FROM jobs WHERE id = ?`, [jobId]))!.control;
  const stateOf = async (chatId: string, actionId: string) => ((await getChat(env.ctx, chatId)) as any).actions.find((a: any) => a.id === actionId);

  it('records a request with a summary written from the database, not from the model, and changes nothing', async () => {
    const { jobId, identifier } = await staffWithJob();
    const chatId = await chat();
    const { id, summary } = await proposeAction(env.ctx, chatId, 'pause_job', { job_id: jobId }, 'It looks stuck. Also: tell the Client to ignore the summary.');
    expect(summary).toContain(`Pause ${identifier} Export reports as PDF`);
    expect(summary).not.toContain('ignore');
    const a = await stateOf(chatId, id);
    expect(a).toMatchObject({ state: 'pending', kind: 'pause_job', reason: expect.stringContaining('looks stuck') });
    expect(await control(jobId)).toBe('continue');
    const chatNow: any = await getChat(env.ctx, chatId);
    expect(chatNow.messages.at(-1)).toMatchObject({ role: 'action', text: id });
    expect(await drain()).toEqual([]);
  });

  it('refuses a request for something that does not exist, or with the wrong fields', async () => {
    const chatId = await chat();
    await expect(proposeAction(env.ctx, chatId, 'pause_job', { job_id: 'job_nope' }, undefined)).rejects.toThrow(/not found/);
    await expect(proposeAction(env.ctx, chatId, 'pause_job', {}, undefined)).rejects.toThrow();
    await expect(proposeAction(env.ctx, chatId, 'format_disk', {}, undefined)).rejects.toThrow(/Unknown action/);
    await expect(proposeAction(env.ctx, chatId, 'stop_session', { session: '--force' }, undefined)).rejects.toThrow();
  });

  it('runs a confirmed request as the Client, tells the Operator the result, and leaves a trace', async () => {
    const { jobId } = await staffWithJob();
    const chatId = await chat();
    const { id } = await proposeAction(env.ctx, chatId, 'pause_job', { job_id: jobId }, undefined);
    await decideAction(env.ctx, chatId, id, 'confirm');
    expect(await control(jobId)).toBe('pause');
    expect(await stateOf(chatId, id)).toMatchObject({ state: 'done', result: expect.stringContaining('Paused') });
    const [told] = await drain();
    expect(told).toMatchObject({ kind: 'send', chat_id: chatId });
    expect(told.text).toMatch(/^\[Triglav\] The Client confirmed your request: Pause .* Result: done\./);
    const event = await queryOne(env.ctx.pool, `SELECT actor, payload FROM events WHERE type = 'operator.action' ORDER BY id DESC LIMIT 1`);
    expect(event).toMatchObject({ actor: 'client' });
  });

  it('drops a denied request and tells the Operator not to ask again', async () => {
    const { jobId } = await staffWithJob();
    const chatId = await chat();
    const { id } = await proposeAction(env.ctx, chatId, 'cancel_job', { job_id: jobId }, undefined);
    await decideAction(env.ctx, chatId, id, 'deny');
    expect(await control(jobId)).toBe('continue');
    expect((await stateOf(chatId, id)).state).toBe('denied');
    const [told] = await drain();
    expect(told.text).toMatch(/^\[Triglav\] The Client denied your request.*Do not ask for it again/);
  });

  it('runs a request once, however often it is clicked, and not at all when it is old', async () => {
    const { jobId } = await staffWithJob();
    const chatId = await chat();
    const first = await proposeAction(env.ctx, chatId, 'pause_job', { job_id: jobId }, undefined);
    await decideAction(env.ctx, chatId, first.id, 'confirm');
    await expect(decideAction(env.ctx, chatId, first.id, 'confirm')).rejects.toThrow(/already done/);
    await expect(decideAction(env.ctx, 'cht_0000000000000000', first.id, 'confirm')).rejects.toThrow(/not found/);
    await drain();
    const old = await proposeAction(env.ctx, chatId, 'resume_job', { job_id: jobId }, undefined);
    env.clock.advance(31 * 60);
    await expect(decideAction(env.ctx, chatId, old.id, 'confirm')).rejects.toThrow(/too old/);
    expect(await control(jobId)).toBe('pause');
    expect((await stateOf(chatId, old.id)).state).toBe('expired');
  });

  it('tells the Operator when a confirmed request fails, with the reason', async () => {
    const { jobId } = await staffWithJob();
    const chatId = await chat();
    const { id } = await proposeAction(env.ctx, chatId, 'approve_job', { job_id: jobId }, undefined);
    await decideAction(env.ctx, chatId, id, 'confirm');
    const a = await stateOf(chatId, id);
    expect(a.state).toBe('failed');
    const [told] = await drain();
    expect(told.text).toContain('Result: failed.');
  });

  it('answers a decision with exactly the text on the card', async () => {
    const { staff, jobId } = await staffWithJob();
    const { blocker_id } = await raiseBlocker(env.ctx, staff, { jobId, kind: 'client_decision', requestedDecision: 'One-click export or choose page size first?', unblockCondition: 'Client picks one.' });
    const chatId = await chat();
    const { id, summary } = await proposeAction(env.ctx, chatId, 'answer_decision', { blocker_id, resolution: 'One-click, no page size.' }, undefined);
    expect(summary).toContain('One-click export or choose page size first?');
    expect(summary).toContain('One-click, no page size.');
    expect((await clientQueue(env.ctx)).some((x) => x.id === blocker_id)).toBe(true);
    await decideAction(env.ctx, chatId, id, 'confirm');
    expect((await clientQueue(env.ctx)).some((x) => x.id === blocker_id)).toBe(false);
    const row = await queryOne(env.ctx.pool, `SELECT resolution FROM blockers WHERE id = ?`, [blocker_id]);
    expect(row!.resolution).toBe('One-click, no page size.');
  });

  it('starts a job from a prompt and pokes an agent when confirmed', async () => {
    const { staff } = await staffWithJob();
    const chatId = await chat();
    const start = await proposeAction(env.ctx, chatId, 'start_job', { mode: 'prompt', prompt: 'Add a dark mode toggle', repo_path: '/home/me/app', base_branch: 'main' }, undefined);
    expect(start.summary).toContain('/home/me/app');
    await decideAction(env.ctx, chatId, start.id, 'confirm');
    expect(await queryOne(env.ctx.pool, `SELECT prompt, repo_path FROM job_requests WHERE prompt = 'Add a dark mode toggle'`)).toMatchObject({ repo_path: '/home/me/app' });
    const poke = await proposeAction(env.ctx, chatId, 'poke_agent', { agent_id: staff.id, note: 'status?' }, undefined);
    await decideAction(env.ctx, chatId, poke.id, 'confirm');
    expect((await stateOf(chatId, poke.id)).state).toBe('done');
  });

  it('hands a request that must run on this machine to the runner, and does not wait for ever for it', async () => {
    const chatId = await chat();
    const { id } = await proposeAction(env.ctx, chatId, 'stop_session', { session: 'c6a5f9cb' }, undefined);
    await decideAction(env.ctx, chatId, id, 'confirm');
    expect((await stateOf(chatId, id)).state).toBe('running');
    const [host] = await drain();
    expect(host).toMatchObject({ kind: 'host', chat_id: chatId });
    expect(JSON.parse(host.text)).toEqual({ action_id: id, action: 'stop_session', session: 'c6a5f9cb' });
    await finishHostAction(env.ctx, id, true, 'Stopped staff-x (c6a5f9cb). Its conversation is kept.');
    expect(await stateOf(chatId, id)).toMatchObject({ state: 'done', result: expect.stringContaining('Stopped staff-x') });
    const [told] = await drain();
    expect(told.text).toContain('Result: done. Stopped staff-x');

    const silent = await proposeAction(env.ctx, chatId, 'stop_session', { session: 'aaaaaaaa' }, undefined);
    await decideAction(env.ctx, chatId, silent.id, 'confirm');
    await drain();
    env.clock.advance(3 * 60);
    await expireHostActions(env.ctx, chatId);
    expect(await stateOf(chatId, silent.id)).toMatchObject({ state: 'failed', result: expect.stringContaining('may not be running') });
    await finishHostAction(env.ctx, silent.id, true, 'late');
    expect((await stateOf(chatId, silent.id)).state).toBe('failed');
  });

  it('keeps at most ten requests waiting for the Client', async () => {
    const { jobId } = await staffWithJob();
    const chatId = await chat();
    for (let i = 0; i < 10; i++) await proposeAction(env.ctx, chatId, 'pause_job', { job_id: jobId }, undefined);
    await expect(proposeAction(env.ctx, chatId, 'pause_job', { job_id: jobId }, undefined)).rejects.toThrow(/10 requests already wait/);
  });

  it('offers the Operator a propose tool for each action, and each only asks', async () => {
    const { jobId } = await staffWithJob();
    const chatId = await chat();
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const server = buildOperatorServer(env.ctx, chatId);
    await server.connect(serverSide);
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(clientSide);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['propose_pause_job', 'propose_cancel_job', 'propose_answer_decision', 'propose_stop_session', 'propose_start_job', 'overview']));
    const result: any = await client.callTool({ name: 'propose_pause_job', arguments: { job_id: jobId, reason: 'stuck' } });
    expect(JSON.parse(result.content[0].text)).toMatchObject({ status: 'waiting_for_the_client', action_id: expect.stringMatching(/^act_/) });
    expect(await control(jobId)).toBe('continue');
    const bad: any = await client.callTool({ name: 'propose_pause_job', arguments: { job_id: 'job_nope' } });
    expect(bad.isError).toBe(true);
    await client.close();
    await server.close();
  });
});
