import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { BASE, clientFetch, expect, openLive, RUNNER_KEY, test } from './fixtures.ts';

// The host runner, serving chats only, with a stub in place of `claude`. Its Architect worktrees go to a scratch folder.
function startRunner(stubLog: string, initiatives: string) {
  return spawn('node', ['scripts/runner.ts'], {
    env: { ...process.env, ORCH_URL: BASE, ORCH_RUNNER_KEY: RUNNER_KEY, ORCH_CLAUDE_BIN: resolve('e2e/stub-claude.mjs'), ORCH_RUNNER_CHAT_ONLY: '1', STUB_LOG: stubLog, ORCH_INITIATIVES_DIR: initiatives },
    stdio: 'ignore',
  });
}
type Launch = { args: string[]; session: string; cwd: string; mcp: { mcpServers: Record<string, { url: string; headers: Record<string, string> }> }; mode: string };
const launches = (log: string): Launch[] =>
  readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
    .filter((l) => l.session);

/** Seeds the public-template-pages design (v17) under a fresh key. Its repositories point nowhere, so the runner prepares no worktree. */
async function seed(): Promise<string> {
  const fixture = JSON.parse(readFileSync('e2e/fixtures/public-template-pages.json', 'utf8'));
  const key = `ptp-${Date.now().toString(36)}`;
  const repos = fixture.repos.map((r: { slug: string }) => ({ slug: r.slug, path: `/nonexistent-e2e/${r.slug}`, base: 'main' }));
  const res = await clientFetch(`${BASE}/api/initiatives`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...fixture, key, repos }) });
  expect(res.status).toBe(200);
  return key;
}

test('the Architect proposes a design revision, the Client confirms it, and the room shows the next version and its trigger', async ({ page, consoleErrors: _ }) => {
  const dir = mkdtempSync(join(tmpdir(), 'initiatives-e2e-'));
  const log = join(dir, 'stub.log');
  const runner = startRunner(log, join(dir, 'initiatives'));
  const key = await seed();
  try {
    await openLive(page, 'initiatives');
    await expect(page.getByRole('link', { name: 'Public template pages' }).first()).toBeVisible();
    await page.goto(`/#/initiatives/${key}`);
    await expect(page.getByTestId('room-version')).toHaveValue('17');
    await expect(page.locator('[data-testid="design-block"][data-id="D16"]')).toContainText('Template sharing works like sharing a Claude artifact.');
    await expect(page.getByTestId('updated-mark')).toHaveCount(0);

    // A message starts the Architect: read-only Claude Code, its one MCP server, no worktree it could not prepare.
    await page.getByLabel('Message').fill('Settle the host question');
    await page.getByTestId('chat-send').click();
    await expect(page.getByTestId('chat-client')).toHaveText('Settle the host question');
    const reply = page.getByTestId('chat-operator');
    await expect(reply).toContainText('You said: Settle the host question');
    await expect(page.getByTestId('chat-system').first()).toContainText('Code for the Architect: frontend: Not available');
    // Another spec can leave an Architect launch for its own initiative in the shared stack, so take this one's by its cwd.
    const launch = launches(log).find((l) => l.cwd === join(dir, 'initiatives', key));
    expect(launch!.args[launch!.args.indexOf('--setting-sources') + 1]).toBe('');
    expect(launch!.args[launch!.args.indexOf('--tools') + 1]).toBe('Read,Grep,Glob');
    expect(launch!.args[launch!.args.indexOf('--allowedTools') + 1]).toBe('mcp__initiative');
    expect(launch!.args[launch!.args.indexOf('--allowedTools') + 2]).toBe('--strict-mcp-config');
    expect(Object.keys(launch!.mcp.mcpServers)).toEqual(['initiative']);
    expect(launch!.mode).toBe('600');
    expect(launch!.cwd).toBe(join(dir, 'initiatives', key));
    expect(JSON.stringify(launch!.args)).not.toContain('orch_chat_');

    // The stub Architect proposes a revision with the tools and token it was started with.
    const { url, headers } = launch!.mcp.mcpServers.initiative!;
    const tools = new Client({ name: 'e2e', version: '0' });
    await tools.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
    const proposed: any = await tools.callTool({
      name: 'propose_design_revision',
      arguments: {
        ops: [
          { op: 'add', block: { kind: 'decision', id: 'D17', title: 'User links use the app host.', body: 'Closes O-host.' } },
          { op: 'update', id: 'O-host', set: { closed: 'The app host (D17).' } },
        ],
        summary: 'Settle the host for user links.',
        reason: 'The Client said so in the room.',
      },
    });
    expect(proposed.isError, JSON.stringify(proposed.content)).toBeFalsy();
    await tools.close();

    const card = page.getByTestId('chat-action').last();
    await expect(card).toHaveAttribute('data-state', 'pending');
    await expect(card).toContainText('The Architect asks to');
    await expect(card).toContainText(`Apply as design v18 of Public template pages (${key}):`);
    await expect(card).toContainText('Add decision D17 "User links use the app host."');
    await expect(card).toContainText('Close open decision O-host "Host for user links": The app host (D17).');
    await expect(page.getByTestId('room-version')).toHaveValue('17');
    // History shows the waiting change in full before the Client answers.
    await page.getByTestId('room-pending').click();
    const waiting = page.getByTestId('pending-revision');
    await waiting.locator('summary').click();
    await expect(waiting.locator('.diff-block')).toHaveCount(2);
    await expect(waiting).toContainText('The app host (D17).');
    await page.getByTestId('tab-design').click();

    await card.getByTestId('action-confirm').click();
    await expect(card).toHaveAttribute('data-state', 'done');
    await expect(card).toContainText('The design is now v18.');
    await expect(reply.last()).toContainText('The Client confirmed');

    // The Design tab shows v18 with the changed blocks marked.
    await expect(page.getByTestId('room-version')).toHaveValue('18');
    await expect(page.getByTestId('tab-design')).toHaveText('Design v18');
    await expect(page.locator('[data-testid="design-block"][data-id="D17"] [data-testid="updated-mark"]')).toHaveText('updated in v18');
    await expect(page.locator('[data-testid="design-block"][data-id="O-host"] [data-testid="updated-mark"]')).toHaveText('updated in v18');
    await expect(page.getByTestId('updated-mark')).toHaveCount(2);
    await expect(page.getByTestId('room-pending')).toHaveCount(0);

    // History shows the trigger, and the diff opens.
    await page.getByTestId('tab-history').click();
    const v18 = page.locator('[data-testid="history-row"][data-version="18"]');
    await expect(v18.getByTestId('history-trigger')).toHaveText('Confirmed in the room');
    await expect(v18).toContainText('Settle the host for user links.');
    await expect(v18).toContainText('Changed: D17, O-host');
    await expect(page.locator('[data-testid="history-row"][data-version="17"]').getByTestId('history-trigger')).toHaveText('Imported');
    await v18.locator('summary').click();
    await expect(v18.locator('.diff-block')).toHaveCount(2);

    // At phone width one pane shows at a time, with a toggle.
    await page.setViewportSize({ width: 390, height: 800 });
    await expect(page.getByTestId('pane-design')).toBeVisible();
    await page.getByTestId('pane-design').click();
    await expect(page.getByTestId('architect-pane')).toBeHidden();
    await expect(page.getByTestId('history')).toBeVisible();
    await page.getByTestId('pane-architect').click();
    await expect(page.getByTestId('architect-pane')).toBeVisible();
    await expect(page.getByTestId('history')).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    // The Models page has the Architect's row.
    await page.setViewportSize({ width: 1280, height: 800 });
    await openLive(page, 'models');
    await expect(page.locator('[data-testid="role-model"][data-role="architect"]')).toBeVisible();
  } finally {
    runner.kill();
  }
});

test('a block name in code or bold in an Architect reply links to that block on the Design tab', async ({ page, consoleErrors: _ }) => {
  const dir = mkdtempSync(join(tmpdir(), 'initiatives-e2e-'));
  const runner = startRunner(join(dir, 'stub.log'), join(dir, 'initiatives'));
  const key = await seed();
  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`/#/initiatives/${key}`);
    await expect(page.getByTestId('room-version')).toHaveValue('17');
    // The stub Architect repeats the message, so its reply carries the names as code, bold and plain text.
    await page.getByLabel('Message').fill('Look at `W-3`, **D16**, D15 and `nope`');
    await page.getByTestId('chat-send').click();
    const reply = page.getByTestId('chat-operator');
    await expect(reply).toContainText('You said: Look at');
    await expect(reply.locator('.block-link')).toHaveText(['W-3', 'D16']);
    await expect(reply.locator('code', { hasText: 'nope' })).not.toHaveClass(/block-link/);

    // A click scrolls the design pane to the block and flashes it.
    const wave = page.locator('[data-testid="design-block"][data-id="W-3"]');
    await reply.locator('.block-link', { hasText: 'W-3' }).click();
    await expect(wave).toBeInViewport();
    await expect(wave).toHaveClass(/flash/);

    // Enter on a focused link does the same.
    const decision = page.locator('[data-testid="design-block"][data-id="D16"]');
    await reply.locator('.block-link', { hasText: 'D16' }).focus();
    await page.keyboard.press('Enter');
    await expect(decision).toBeInViewport();
    await expect(decision).toHaveClass(/flash/);

    // At phone width with the chat shown, the design is hidden, so the names are not links.
    await page.setViewportSize({ width: 390, height: 800 });
    await page.getByTestId('pane-architect').click();
    await expect(reply.locator('.block-link')).toHaveCount(0);
  } finally {
    await page.setViewportSize({ width: 1280, height: 800 });
    runner.kill();
  }
});
