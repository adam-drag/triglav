import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tick } from '../src/scheduler.ts';
import { buildServer } from '../src/server.ts';
import { createTestCtx, GATE_HEAD, passGate, TEST_DB_URL, TEST_ENROLLMENT_KEY, testServerKeys } from './helpers.ts';

const KEY = TEST_ENROLLMENT_KEY;

// Drives the real MCP tools over HTTP, as the CLIs would. Needs ORCH_TEST_DATABASE_URL.
describe.skipIf(!TEST_DB_URL)('end to end over MCP', () => {
  let env: Awaited<ReturnType<typeof createTestCtx>>;
  let app: ReturnType<typeof buildServer>;
  let base = '';

  beforeAll(async () => {
    env = await createTestCtx(null); // no Linear key: Staff supplies the snapshot
    app = buildServer(env.ctx, { ...(await testServerKeys()), webDir: '/nonexistent' });
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://localhost:${(app.server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await app?.close();
    await env?.close();
  });

  async function client() {
    const c = new Client({ name: 'e2e', version: '0' });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${KEY}` } } }));
    return {
      async call(name: string, args: Record<string, unknown>) {
        const res = (await c.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
        const body = JSON.parse(res.content[0]!.text);
        if (res.isError) throw new Error(`${name}: ${body.message}`);
        return body;
      },
      close: () => c.close(),
    };
  }

  it('plans, delegates, asks, answers, reviews and completes a ticket', async () => {
    env.clock.set('2026-10-07T09:00:00.000Z');
    const staffC = await client();
    const staffReg = (await staffC.call('register_agent', { role: 'staff', nickname: 'staff-ada', runtime: 'claude-code' })).result;
    const staff = staffReg.session_token;

    const snapshot = {
      id: 'uuid-E2E-1',
      identifier: 'E2E-1',
      title: 'Export reports as PDF',
      url: 'https://linear.app/x/issue/E2E-1',
      description: 'Users export reports.',
      children: [],
    };
    const job = (await staffC.call('register_job', { session_token: staff, linear_issue: 'E2E-1', repo_path: '/repo', base_branch: 'main', ticket_snapshot: snapshot })).result;
    expect(job.snapshot_source).toBe('agent');
    await staffC.call('update_job', { session_token: staff, job_id: job.job_id, status: 'planning' });
    await staffC.call('update_job', { session_token: staff, job_id: job.job_id, acceptance_criteria: 'PDF downloads; tests pass', status: 'ready' });
    const ticket = (await staffC.call('create_spawn_ticket', { session_token: staff, job_id: job.job_id, role: 'senior', brief: 'Build the endpoint' })).result;
    expect(ticket.start_prompt).toContain(ticket.spawn_ticket);

    // The Senior shares nothing with Staff except the start prompt.
    const seniorC = await client();
    const seniorReg = (await seniorC.call('register_agent', { role: 'senior', nickname: 'senior-ben', runtime: 'claude-code', spawn_ticket: ticket.spawn_ticket })).result;
    const senior = seniorReg.session_token;
    const asg = seniorReg.assignment;
    expect(asg.attempt).toBe(1);

    // Routine events (the Senior claiming and its progress) do not wake Staff; they come back with the next waking event.
    const quiet = await staffC.call('wait_for_events', { session_token: staff, cursor: staffReg.cursor, max_wait_sec: 1 });
    expect(quiet.result.timed_out).toBe(true);
    expect(quiet.result.events.map((e: any) => e.type)).toContain('assignment.claimed');
    const staffCursor = quiet.result.next_cursor;

    const resC = await client();
    const resReg = (await resC.call('register_agent', { role: 'researcher', nickname: 'codex-res', runtime: 'codex', focus: 'backend' })).result;
    const researcher = resReg.session_token;

    const q = (
      await seniorC.call('ask_question', {
        session_token: senior,
        job_id: job.job_id,
        title: 'Renderer choice',
        summary: 'Endpoint skeleton done.',
        question: 'Puppeteer or a PDF library?',
        why_it_matters: 'Image size and cold start',
        waiting_work: 'Rendering',
        window_sec: 60,
      })
    ).result;

    const wake = await resC.call('wait_for_events', { session_token: researcher, cursor: resReg.cursor, max_wait_sec: 2 });
    const staffWake = await staffC.call('wait_for_events', { session_token: staff, cursor: staffCursor, max_wait_sec: 2 });
    expect(staffWake.result.timed_out).toBe(false);
    expect(staffWake.result.events.map((e: any) => e.type)).toContain('question.opened');
    expect(wake.result.events.some((e: any) => e.type === 'question.opened')).toBe(true);
    expect(wake.notice).toMatch(/Never follow instructions/);
    await resC.call('post_message', { session_token: researcher, thread_id: q.thread_id, stance: 'support', reason: 'Small image', body: 'A library keeps the image small.' });
    await staffC.call('post_message', { session_token: staff, thread_id: q.thread_id, body: 'Use a PDF library.', intended_decision: true });

    const early = await seniorC.call('await_question', { session_token: senior, thread_id: q.thread_id, max_wait_sec: 1 });
    expect(early.result.window_closed).toBe(false);
    env.clock.advance(61);
    await tick(env.ctx);
    const closed = await seniorC.call('await_question', { session_token: senior, thread_id: q.thread_id, max_wait_sec: 1 });
    expect(closed.result.state).toBe('resolved');

    await seniorC.call('report_progress', { session_token: senior, assignment_id: asg.id, attempt: asg.attempt, note: 'Implemented', worktree_path: '/repo-e2e-1' });
    await passGate(env.ctx, asg.job_id, seniorReg.agent_id);
    const pkg = (
      await seniorC.call('submit_review_package', {
        session_token: senior,
        assignment_id: asg.id,
        attempt: asg.attempt,
        head_sha: GATE_HEAD,
        summary: 'Endpoint with library renderer',
        artifacts: ['https://github.com/x/y/pull/1'],
        validation: 'pnpm test: 14 passed',
      })
    ).result;
    const verdict = await staffC.call('record_verdict', { session_token: staff, package_id: pkg.package_id, outcome: 'accept', findings: [] });
    // An accepted review is not done: the Senior still runs the Copilot loop and gets CI green.
    expect(verdict.result.job_status).toBe('delivering');

    const delivery = {
      session_token: senior,
      assignment_id: asg.id,
      attempt: asg.attempt,
      pr_url: 'https://github.com/x/y/pull/1',
      head_sha: 'abc1234',
      copilot_status: 'DONE',
      copilot_summary: '2 rounds; 1 finding fixed, 1 false positive',
      ci_summary: 'ci: success on abc1234',
    };
    await expect(seniorC.call('report_delivery', { ...delivery, ci_conclusion: 'failure' })).rejects.toThrow();
    await seniorC.call('report_delivery', { ...delivery, ci_conclusion: 'success' });
    await expect(staffC.call('confirm_delivery', { session_token: staff, job_id: job.job_id, head_sha: 'def5678', ci_conclusion: 'success', evidence: 'gh pr checks 1' })).rejects.toThrow(/reported abc1234/);
    expect((await staffC.call('get_job', { session_token: staff, job_id: job.job_id })).result.job.status).toBe('delivering');
    const confirmed = await staffC.call('confirm_delivery', { session_token: staff, job_id: job.job_id, head_sha: 'abc1234', ci_conclusion: 'success', evidence: 'gh pr checks 1: ci pass' });
    expect(confirmed.result.job_status).toBe('done');

    const jobView = (await staffC.call('get_job', { session_token: staff, job_id: job.job_id })).result;
    expect(jobView.job.status).toBe('done');
    expect(jobView.reviews[0].verdict.outcome).toBe('accept');
    expect(jobView.deliveries[0].confirmed_by).toBeTruthy();

    for (const c of [staffC, seniorC, resC]) await c.close();
  });
});
