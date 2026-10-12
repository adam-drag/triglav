import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { BASE, cleanup, clientFetch, expect, openLive, RUNNER_KEY, staffWithJob, test } from './fixtures.ts';

// The host runner, serving the Operator only, with a stub in place of `claude` (the suite cannot call the real model).
function startRunner(stubLog: string) {
  return spawn('node', ['scripts/runner.ts'], {
    env: { ...process.env, ORCH_URL: BASE, ORCH_RUNNER_KEY: RUNNER_KEY, ORCH_CLAUDE_BIN: resolve('e2e/stub-claude.mjs'), ORCH_RUNNER_CHAT_ONLY: '1', STUB_LOG: stubLog },
    stdio: 'ignore',
  });
}
const lines = (log: string) => readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const launches = (log: string): { args: string[]; session: string; cwd: string }[] => lines(log).filter((l) => l.session);
/** The Operator's own tools, as its Claude process would reach them: the URL and token it was started with. */
async function operatorTools(args: string[]) {
  const { url, headers } = JSON.parse(args[args.indexOf('--mcp-config') + 1]!).mcpServers.triglav;
  const tools = new Client({ name: 'e2e', version: '0' });
  await tools.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
  return tools;
}
const controlOf = async (jobId: string) => ((await (await clientFetch(`${BASE}/api/jobs`)).json()) as { id: string; control: string }[]).find((j) => j.id === jobId)!.control;

test('the Operator streams a reply, keeps the conversation, stops, resumes, is safe to render, and reports plan usage', async ({ page, consoleErrors: _ }) => {
  const log = join(mkdtempSync(join(tmpdir(), 'operator-e2e-')), 'stub.log');
  const runner = startRunner(log);
  const reply = page.getByTestId('chat-operator');
  const message = page.getByLabel('Message');
  try {
    await openLive(page, 'operator');
    await message.fill('hello operator');
    await page.getByTestId('chat-send').click();
    await expect(page).toHaveURL(/#\/operator\/cht_[0-9a-f]{16}$/);
    const chatUrl = page.url();
    await expect(page.getByTestId('chat-client')).toHaveText('hello operator');
    await expect(reply).toContainText('You said: hello operator. This is turn 1 of this process.');

    // The next message goes to the same process, so it remembers.
    await message.fill('again');
    await message.press('Enter');
    await expect(reply.last()).toContainText('This is turn 2 of this process.');
    const [first] = launches(log);
    expect(launches(log)).toHaveLength(1);
    expect(first!.cwd).toBe(resolve('.'));
    expect(first!.args).toContain('--strict-mcp-config');
    // No Bash at all, and the host commands come from a stdio MCP server with fixed tools.
    expect(first!.args[first!.args.indexOf('--tools') + 1]).toBe('Read,Grep,Glob');
    expect(first!.args[first!.args.indexOf('--allowedTools') + 1]).not.toMatch(/Bash/);
    expect(Object.keys(JSON.parse(first!.args[first!.args.indexOf('--mcp-config') + 1]!).mcpServers)).toEqual(['triglav', 'host']);
    expect(first!.args[first!.args.indexOf('--permission-mode') + 1]).toBe('dontAsk');
    expect(first!.args).not.toContain('--resume');

    // Reply text is data: markup in it is shown, not run, and a javascript: link is not a link.
    await message.fill('inject please');
    await message.press('Enter');
    await expect(reply.last()).toContainText('Look:');
    await expect(reply.last()).toContainText('<img src=x onerror=alert(1)>');
    await expect(reply.last().locator('strong')).toHaveText('bold');
    await expect(reply.last().locator('img')).toHaveCount(0);
    await expect(reply.last().locator('a')).toHaveCount(0);

    // The plan usage in the stream is an exact reading for the Home card.
    await openLive(page, '');
    await expect(page.getByTestId('home-usage')).toContainText('Session (5 hr) 50%');
    await expect(page.getByTestId('home-usage')).not.toContainText('*');

    // The Operator's own tools answer only with this chat's token.
    const { url } = JSON.parse(first!.args[first!.args.indexOf('--mcp-config') + 1]!).mcpServers.triglav;
    expect((await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(401);
    const tools = await operatorTools(first!.args);
    expect((await tools.listTools()).tools.map((t) => t.name)).toContain('overview');
    await tools.close();

    // Back in the chat the history is there, then a slow reply can be stopped.
    await page.goto(chatUrl);
    await expect(page.getByTestId('chat-client')).toHaveCount(3);
    await message.fill('slow please');
    await message.press('Enter');
    await expect(page.getByTestId('chat-partial')).toContainText('tick');
    await page.getByTestId('chat-stop').click();
    await expect(page.getByTestId('chat-stop')).toHaveCount(0);

    // The next message starts a new process that resumes the same conversation.
    await message.fill('after the stop');
    await message.press('Enter');
    await expect(reply.last()).toContainText('You said: after the stop. This is turn 1 of this process.');
    const all = launches(log);
    expect(all).toHaveLength(2);
    expect(all[1]!.args[all[1]!.args.indexOf('--resume') + 1]).toBe(first!.session);
  } finally {
    runner.kill();
  }
});

test('the Operator asks for changes, and nothing changes until the Client confirms', async ({ page, consoleErrors: _, agents }) => {
  const log = join(mkdtempSync(join(tmpdir(), 'operator-e2e-')), 'stub.log');
  const runner = startRunner(log);
  const { staff, parentId, identifier } = await staffWithJob('asks');
  agents.push(staff);
  const reply = page.getByTestId('chat-operator');
  try {
    await openLive(page, 'operator');
    await page.getByLabel('Message').fill('please pause the job');
    await page.getByTestId('chat-send').click();
    await expect(reply).toContainText('This is turn 1 of this process.');
    const tools = await operatorTools(launches(log)[0]!.args);
    const card = page.getByTestId('chat-action').last();

    // A request puts a card in the chat. Its text comes from Triglav's data, and nothing has changed yet.
    await tools.callTool({ name: 'propose_pause_job', arguments: { job_id: parentId, reason: 'testing a denial' } });
    await expect(card).toHaveAttribute('data-state', 'pending');
    await expect(card).toContainText(`Pause ${identifier}`);
    await expect(card).toContainText('Its reason: testing a denial');
    expect(await controlOf(parentId)).toBe('continue');

    // Deny: still nothing changes, and the Operator is told.
    await card.getByTestId('action-deny').click();
    await expect(card).toHaveAttribute('data-state', 'denied');
    await expect(reply.last()).toContainText('The Client denied your request');
    expect(await controlOf(parentId)).toBe('continue');

    // Confirm: it happens, the card says so, and the Operator hears the result.
    await tools.callTool({ name: 'propose_pause_job', arguments: { job_id: parentId } });
    await expect(page.getByTestId('chat-action')).toHaveCount(2);
    await card.getByTestId('action-confirm').click();
    await expect(card).toHaveAttribute('data-state', 'done');
    await expect(card).toContainText('Paused');
    await expect(reply.last()).toContainText('The Client confirmed your request');
    expect(await controlOf(parentId)).toBe('pause');

    // Something that happens on this machine goes through the host runner, which stops a Claude session.
    await tools.callTool({ name: 'propose_stop_session', arguments: { session: 'c6a5f9cb' } });
    await expect(page.getByTestId('chat-action')).toHaveCount(3);
    await card.getByTestId('action-confirm').click();
    await expect(card).toHaveAttribute('data-state', 'done');
    await expect(card).toContainText('Stopped staff-stub');
    expect(lines(log).filter((l) => l.stop)).toEqual([{ stop: 'c6a5f9cb' }]);

    // A made-up session id is refused before any card exists.
    const bad: any = await tools.callTool({ name: 'propose_stop_session', arguments: { session: '--all' } });
    expect(bad.isError).toBe(true);
    await expect(page.getByTestId('chat-action')).toHaveCount(3);
    await tools.close();
  } finally {
    runner.kill();
    await cleanup(parentId);
  }
});
