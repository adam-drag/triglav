import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { prViewArgs } from '../src/gate-check.ts';
import { BASE, clientFetch, expect, RUNNER_KEY, SimAgent, test } from './fixtures.ts';
import { ArchitectSim } from './architect-sim.ts';

const run = promisify(execFile);

// The Jobs tab of a room, end to end on the :7401 stack. The test plays the host runner's part for the launches it needs:
// it takes them from /api/runner/next with the runner key, and it runs the stub gh the way the runner runs the real one
// (the argv comes from prViewArgs). The runner's own gateCheck function is not run here; see test/runner-security.test.ts.

const SHA = 'b'.repeat(40);

const design = {
  format: 1,
  title: 'Jobs e2e',
  blocks: [
    { kind: 'wave', id: 'W-1', title: 'Wave one', when: 'Now', jobs: ['a', 'b', 'c', 'd'] },
    { kind: 'open', id: 'O-host', title: 'Host', body: 'Which host the links use.', closed: 'The app host, see D1.' },
    { kind: 'decision', id: 'D1', title: 'App host', body: 'Links use the app host.' },
    { kind: 'checkpoint', id: 'CP-A', title: 'Sign-off', steps: ['Check the page in the browser'] },
    card('a', 'PDF endpoint', []),
    card('b', 'Export button', [{ kind: 'merged', job: 'a' }, { kind: 'decision', ref: 'O-host' }], ['a']),
    card('c', 'Sign-off page', [{ kind: 'client_step', ref: 'CP-A' }]),
    card('d', 'Docs', []),
  ],
};

function card(id: string, title: string, gates: unknown[], deps: string[] = [], extra: Record<string, unknown> = {}) {
  return {
    kind: 'card',
    id,
    title,
    repo: 'app',
    wave: 'W-1',
    deps,
    decisions: id === 'a' ? ['D1'] : undefined,
    goal: `Build ${title.toLowerCase()}.`,
    scope: ['One change'],
    out: [],
    accept: ['It works'],
    verify: ['Run the tests'],
    traps: [],
    safety: [],
    dod: [],
    gates,
    ...extra,
  };
}

/** Seeds the design under a fresh key. The repository has a GitHub slug, and its path points nowhere (nothing reads it here). */
async function seed(): Promise<string> {
  const key = `jobs-e2e-${Date.now().toString(36)}`;
  const body = { key, title: `Jobs e2e ${key}`, repos: [{ slug: 'app', path: `/nonexistent-e2e/${key}`, base: 'main', github: 'owner/app' }], source: 'e2e', doc: design };
  const res = await clientFetch(`${BASE}/api/initiatives`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  expect(res.status, await res.clone().text()).toBe(200);
  return key;
}

/** A room with one ready card whose prompt is over the limit: four decisions of 19,000 characters, all named by card e. */
async function seedBig(): Promise<string> {
  const key = `jobs-big-${Date.now().toString(36)}`;
  const big = [11, 12, 13, 14].map((k) => ({ kind: 'decision', id: `D${k}`, title: `Big ${k}`, body: 'x'.repeat(19_000) }));
  const doc = {
    format: 1,
    title: 'Jobs big',
    blocks: [{ kind: 'wave', id: 'W-1', title: 'Wave one', when: 'Now', jobs: ['e'] }, ...big, card('e', 'Big prompt', [], [], { decisions: ['D11', 'D12', 'D13', 'D14'] })],
  };
  const body = { key, title: `Jobs big ${key}`, repos: [{ slug: 'app', path: `/nonexistent-e2e/${key}`, base: 'main', github: 'owner/app' }], source: 'e2e', doc };
  const res = await clientFetch(`${BASE}/api/initiatives`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  expect(res.status, await res.clone().text()).toBe(200);
  return key;
}

/** One call to the runner API, as the host runner makes it. */
async function runnerCall(path: string, body: unknown = {}): Promise<any> {
  const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: { authorization: `Bearer ${RUNNER_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

/** Inserts the delivery a Senior would report. The Senior flow is too long for this test, so the row goes in through the stack's own MySQL. */
async function deliver(jobId: string, prUrl: string) {
  const id = `dlv-e2e-${Date.now().toString(36)}`;
  const sql = `INSERT INTO deliveries (id, job_id, assignment_id, attempt_number, reported_by, pr_url, head_sha, copilot_status, copilot_summary, ci_summary, reported_at) VALUES ('${id}', '${jobId}', 'asg-e2e', 1, 'agt-e2e', '${prUrl}', '${SHA}', 'DONE', 'clean', 'CI passed', NOW(3))`;
  await run('docker', ['compose', '-f', 'docker-compose.e2e.yml', 'exec', '-T', '-e', 'MYSQL_PWD=e2e-password', 'mysql', 'mysql', '-uorchestrator', 'orchestrator', '-e', sql]);
}

test('a room shows its cards, starts a ready card with its prompt, and a merged check turns the gate green', async ({ page, consoleErrors: _ }) => {
  const dir = mkdtempSync(join(tmpdir(), 'jobs-e2e-'));
  const ghLog = join(dir, 'gh.log');
  const key = await seed();
  const jobs = () => page.locator('[data-testid="job-card"]');
  // The title sits in the card's own heading (strong), so a gate label that names another card's title does not match.
  const cardOf = (title: string) => jobs().filter({ has: page.locator('strong', { hasText: title }) });

  await page.goto(`/#/initiatives/${key}`);
  await page.getByTestId('tab-jobs').click();
  await expect(cardOf('PDF endpoint').getByTestId('job-state')).toHaveText('Ready');
  await expect(cardOf('Export button').getByTestId('job-state')).toHaveText('Locked');
  await expect(cardOf('Export button')).toContainText('1 open gate before this card can start.');
  await expect(cardOf('Sign-off page').getByTestId('job-state')).toHaveText('Your step');

  // Start: the confirm shows the prompt the server built, and the card runs once it is sent.
  await cardOf('PDF endpoint').getByTestId('card-start').click();
  await expect(page.getByTestId('start-prompt')).toContainText('Build pdf endpoint.');
  await expect(page.getByTestId('start-prompt')).toContainText('D1 "App host"');
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && /\/cards\/a\/start$/.test(new URL(r.url()).pathname));
  await page.getByTestId('start-confirm-button').click();
  const startBody = await (await started).json();
  await expect(cardOf('PDF endpoint').getByTestId('job-started')).toContainText('Started a job from design version');
  await expect(cardOf('PDF endpoint').getByTestId('job-state')).toHaveText('Running (starting)');

  // The runner reports this start's launch started (by its id, so other tests' launches stay alone); Staff then registers
  // the job through MCP.
  expect(startBody.launch_id).toBeTruthy();
  await runnerCall(`/api/runner/${startBody.launch_id}/done`, { result: 'ok: started' });
  const staff = await SimAgent.register({ role: 'staff', nickname: `jobs-e2e-${Date.now().toString(36)}`, runtime: 'claude-code' });
  const job = await staff.call('register_job', { request_id: startBody.request_id, title: 'PDF endpoint' });
  await staff.close();

  // The delivery exists, so the scheduler queues the merged check. The test takes that launch and answers for it.
  await deliver(job.job_id, 'https://github.com/owner/app/pull/34');
  let check: any = null;
  await expect
    .poll(
      async () => {
        check = (await runnerCall('/api/runner/next')).launch;
        return check?.kind ?? null;
      },
      { timeout: 90_000, intervals: [2_000] },
    )
    .toBe('gate_check');
  expect(check).toMatchObject({ pr_number: 34, repo_slug: 'owner/app', runtime: 'gh' });
  const argv = prViewArgs(check.pr_number, check.repo_slug);
  const merged = JSON.stringify({ state: 'MERGED', mergedAt: '2026-11-17T10:00:00Z', mergeCommit: { oid: SHA }, url: 'https://github.com/owner/app/pull/34' });
  const { stdout } = await run(process.execPath, [resolve('e2e/stub-gh.mjs'), ...argv], { env: { ...process.env, STUB_GH_LOG: ghLog, STUB_GH_ANSWER: merged } });
  expect(readFileSync(ghLog, 'utf8').trim()).toBe(JSON.stringify(argv));
  await runnerCall(`/api/runner/${check.id}/gate-output`, { code: 0, stdout, stderr: '' });
  await runnerCall(`/api/runner/${check.id}/done`, { result: 'checked PR 34 of owner/app: answered' });

  // The gate is green with the check as its source, and the card that waits for it is Ready.
  await page.reload();
  await page.getByTestId('tab-jobs').click();
  await expect(cardOf('Export button').getByTestId('job-state')).toHaveText('Ready');
  await expect(cardOf('Export button').getByTestId('gate-row').first()).toContainText('Met');
  await expect(cardOf('Export button').getByTestId('gate-row').first()).toContainText('checked on GitHub');
  await expect(cardOf('Export button').getByTestId('gate-row').first()).toContainText(`merge commit ${SHA.slice(0, 7)}`);

  // A Client mark needs a reason, and then the client-step card is Ready.
  await cardOf('Sign-off page').getByTestId('gate-mark').click();
  await page.getByTestId('gate-reason').fill('Checked the page in the browser.');
  await page.getByTestId('gate-mark-submit').click();
  await expect(cardOf('Sign-off page').getByTestId('job-state')).toHaveText('Ready');

  // The History shows the design versions the check and the mark wrote, with their lines.
  await page.getByTestId('tab-history').click();
  await expect(page.getByTestId('history')).toContainText('Gate met by check: b waits for a');
  await expect(page.getByTestId('history')).toContainText('Gate marked met by the Client: c waits for Your step CP-A');
});

test('what can I start now matches the Jobs tab: the Architect, the pill, the card and the start preview agree', async ({ page, consoleErrors: _ }) => {
  // Flow a of the phase 3 plan. The Jobs tab reads GET /api/initiatives/:key/jobs; the Start button reads the preview; the
  // Architect reads the same states in get_initiative. All three come from the same evaluator, so they must agree, and only
  // a Ready card can start.
  const key = await seed();
  const jobs = await (await clientFetch(`${BASE}/api/initiatives/${key}/jobs`)).json();
  const titles: Record<string, string> = { a: 'PDF endpoint', b: 'Export button', c: 'Sign-off page', d: 'Docs' };
  const pillText: Record<string, string> = { ready: 'Ready', locked: 'Locked', your_step: 'Your step' };
  const stateOf = (k: string) => String(jobs.cards.find((c: { key: string }) => c.key === k).state);

  expect(stateOf('a')).toBe('ready');
  expect(stateOf('b')).toBe('locked');
  expect(stateOf('c')).toBe('your_step');
  expect(stateOf('d')).toBe('ready');

  // The stub Architect, with the token the runner mints for the initiative's chat, reads the same states.
  const got = await (await clientFetch(`${BASE}/api/initiatives/${key}`)).json();
  const { token } = await runnerCall(`/api/runner/chat/${String(got.initiative.chat_id)}/token`);
  const architect = await ArchitectSim.connect(token);
  const info = await architect.call('get_initiative', {});
  expect(info.cards.map((c: { key: string; state: string }) => [c.key, c.state])).toEqual(jobs.cards.map((c: { key: string; state: string }) => [c.key, c.state]));
  const startable = info.cards.filter((c: { state: string; start_block: string | null }) => c.state === 'ready' && c.start_block === null).map((c: { key: string }) => c.key);
  expect(startable).toEqual(['a', 'd']);

  for (const k of Object.keys(titles)) {
    const preview = await (await clientFetch(`${BASE}/api/initiatives/${key}/cards/${k}/start`)).json();
    expect(preview.state, `preview state of card ${k}`).toBe(stateOf(k));
    expect(preview.can_start, `can_start of card ${k}`).toBe(startable.includes(k));
  }
  const lockedPreview = await (await clientFetch(`${BASE}/api/initiatives/${key}/cards/b/start`)).json();
  expect(lockedPreview.reasons.some((r: string) => r.startsWith('Open: '))).toBe(true);

  await page.goto(`/#/initiatives/${key}`);
  await page.getByTestId('tab-jobs').click();
  const cardOf = (title: string) => page.getByTestId('job-card').filter({ has: page.locator('strong', { hasText: title }) });
  for (const k of Object.keys(titles)) {
    const card = cardOf(titles[k]!);
    await expect(card.getByTestId('job-state')).toHaveText(pillText[stateOf(k)]!);
    await expect(card).toHaveAttribute('data-state', stateOf(k));
    // Start is offered exactly on the cards the preview would start.
    await expect(card.getByTestId('card-start')).toHaveCount(startable.includes(k) ? 1 : 0);
  }

  // A ready card whose prompt is over the limit: the Jobs tab shows the reason in place of Start, and the preview refuses it.
  const bigKey = await seedBig();
  await page.goto(`/#/initiatives/${bigKey}`);
  await page.getByTestId('tab-jobs').click();
  const big = cardOf('Big prompt');
  await expect(big.getByTestId('job-state')).toHaveText('Ready');
  await expect(big.getByTestId('job-start-block')).toContainText('over the 50000 limit');
  await expect(big.getByTestId('card-start')).toHaveCount(0);
  const bigPreview = await (await clientFetch(`${BASE}/api/initiatives/${bigKey}/cards/e/start`)).json();
  expect(bigPreview.can_start).toBe(false);
});
