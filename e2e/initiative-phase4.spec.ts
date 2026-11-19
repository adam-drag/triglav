import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { deployCompareArgs, deployRunListArgs, deployRunViewArgs, prBodyArgs, prViewArgs } from '../src/gate-check.ts';
import { BASE, clientFetch, expect, RUNNER_KEY, SimAgent, test } from './fixtures.ts';
import { ArchitectSim } from './architect-sim.ts';

const run = promisify(execFile);

// Phase 4 of the initiative room, end to end on the :7401 stack (docs/plans/initiative-room.md). As in initiative-jobs.spec.ts,
// the test plays the host runner's part: it takes the launches it needs from /api/runner/next with the runner key, runs the
// stub gh with the argv the gate-check builders give, and posts the answer the way the runner does. The runner's own
// functions are tested in test/runner-security.test.ts. Specs run one at a time (playwright.config.ts), so each test answers
// only the launches of its own pull request and merge commit.

const HEAD = 'c'.repeat(40);

/** A design with a source card (a), a card that waits for its merged PR (b), and a card that waits for the deploy of a (c). */
function design(key: string, card_b_extra: Record<string, unknown> = {}) {
  return {
    format: 1,
    title: `Phase 4 ${key}`,
    blocks: [
      { kind: 'wave', id: 'W-1', title: 'Wave one', when: 'Now', jobs: ['a', 'b', 'c'] },
      card('a', 'PDF endpoint', []),
      card('b', 'Export button', [{ kind: 'merged', job: 'a' }], ['a'], card_b_extra),
      card('c', 'Release page', [{ kind: 'deployed', repo: 'app', after: 'a' }]),
    ],
  };
}

function card(id: string, title: string, gates: unknown[], deps: string[] = [], extra: Record<string, unknown> = {}) {
  return {
    kind: 'card',
    id,
    title,
    repo: 'app',
    wave: 'W-1',
    deps,
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

/** Seeds a room with the deploy settings of the repository (the deploy job and step the deployed gate checks). */
async function seed(prefix: string, card_b_extra: Record<string, unknown> = {}): Promise<string> {
  const key = `${prefix}-${Date.now().toString(36)}`;
  const repo = {
    slug: 'app',
    path: `/nonexistent-e2e/${key}`,
    base: 'main',
    github: 'owner/app',
    deploy: { workflow: 'deploy.yml', job: 'deploy-prod', step: 'Deploy CDK stack', note: 'e2e: the stub run of deploy.yml' },
  };
  const body = { key, title: `Phase 4 ${key}`, repos: [repo], source: 'e2e', doc: design(key, card_b_extra) };
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

/** Starts a card as the Client, with the design version the room shows, and returns the start (its launch and request). */
async function startCard(key: string, cardKey: string): Promise<{ launch_id: string; request_id: string }> {
  const got = await (await clientFetch(`${BASE}/api/initiatives/${key}`)).json();
  const version = Number(got.initiative.current_version);
  const res = await clientFetch(`${BASE}/api/initiatives/${key}/cards/${cardKey}/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ started_from_version: version }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return res.json();
}

/** The runner reports the start's launch done, Staff registers the job, and the delivery of a pull request is recorded. */
async function startAndDeliver(key: string, prNumber: number): Promise<string> {
  const start = await startCard(key, 'a');
  await runnerCall(`/api/runner/${start.launch_id}/done`, { result: 'ok: started' });
  const staff = await SimAgent.register({ role: 'staff', nickname: `phase4-${Date.now().toString(36)}`, runtime: 'claude-code' });
  const job = await staff.call('register_job', { request_id: start.request_id, title: 'PDF endpoint' });
  await staff.close();
  await deliver(job.job_id, `https://github.com/owner/app/pull/${prNumber}`);
  return job.job_id;
}

/** Inserts the delivery a Senior would report, through the stack's own MySQL (the Senior flow is too long for this test). */
async function deliver(jobId: string, prUrl: string) {
  const id = `dlv-p4-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const sql = `INSERT INTO deliveries (id, job_id, assignment_id, attempt_number, reported_by, pr_url, head_sha, copilot_status, copilot_summary, ci_summary, reported_at) VALUES ('${id}', '${jobId}', 'asg-e2e', 1, 'agt-e2e', '${prUrl}', '${HEAD}', 'DONE', 'clean', 'CI passed', NOW(3))`;
  await run('docker', ['compose', '-f', 'docker-compose.e2e.yml', 'exec', '-T', '-e', 'MYSQL_PWD=e2e-password', 'mysql', 'mysql', '-uorchestrator', 'orchestrator', '-e', sql]);
}

/** Runs the stub gh with one fixed argv and returns what it printed; the test checks the argv it logged. */
async function stubGh(argv: string[], answer: unknown, dir: string): Promise<string> {
  const log = join(dir, `gh-${Math.random().toString(36).slice(2)}.log`);
  const text = typeof answer === 'string' ? answer : JSON.stringify(answer);
  const { stdout } = await run(process.execPath, [resolve('e2e/stub-gh.mjs'), ...argv], { env: { ...process.env, STUB_GH_LOG: log, STUB_GH_ANSWER: text } });
  expect(readFileSync(log, 'utf8').trim()).toBe(JSON.stringify(argv));
  return stdout;
}

/**
 * Answers the runner launches of one test until `done()` holds. A launch of another pull request, or of another merge commit,
 * is left alone. Each answer is built the way the runner builds it (src/gate-check.ts for the argv and the output's shape).
 */
async function serveRunner(opts: { prNumber: number; mergeSha: string; dir: string; done: () => Promise<boolean>; timeoutMs: number }) {
  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    if (await opts.done()) return;
    const { launch } = await runnerCall('/api/runner/next');
    if (!launch) {
      await new Promise((r) => setTimeout(r, 1_000));
      continue;
    }
    if (launch.kind === 'pr_read') {
      // The body of any merged PR is read from the PR's own number, so the server checks the same number it asked for.
      const argv = prBodyArgs(launch.pr_number, launch.repo_slug);
      // The fields `gh pr view --json body,files,state,mergedAt,mergeCommit` prints: no url.
      const answer = { body: `Retry the export once after a failure. Read as data.`, files: [{ path: 'src/export.ts' }], state: 'MERGED', mergedAt: '2026-11-19T09:00:00Z', mergeCommit: { oid: opts.mergeSha } };
      const stdout = await stubGh(argv, answer, opts.dir);
      await runnerCall(`/api/runner/${launch.id}/pr-output`, { code: 0, stdout, stderr: '' });
      await runnerCall(`/api/runner/${launch.id}/done`, { result: `read PR ${launch.pr_number}` });
      continue;
    }
    if (launch.kind !== 'gate_check') continue;
    if (launch.check === 'deployed') {
      if (launch.merge_sha !== opts.mergeSha) continue;
      // The three calls of the deployed check, in the runner's order: run list, run view, then the comparison (same repository).
      const listArgv = deployRunListArgs(launch.repo_slug, launch.workflow, launch.base);
      const listed = await stubGh(listArgv, [{ databaseId: 9, headSha: HEAD, status: 'completed', conclusion: 'success', createdAt: '2026-11-19T10:00:00Z', headBranch: launch.base, event: 'push' }], opts.dir);
      const viewArgv = deployRunViewArgs(launch.repo_slug, 9);
      const view = await stubGh(viewArgv, { databaseId: 9, headBranch: launch.base, headSha: HEAD, status: 'completed', conclusion: 'success', createdAt: '2026-11-19T10:00:00Z', jobs: [{ name: launch.job, conclusion: 'success', steps: [{ name: launch.step, conclusion: 'success' }] }] }, opts.dir);
      const compareArgv = deployCompareArgs(launch.repo_slug, launch.merge_sha, HEAD);
      const compare = await stubGh(compareArgv, { status: 'ahead' }, opts.dir);
      const out = { runs: [{ run: JSON.parse(listed)[0], view: JSON.parse(view), compare: JSON.parse(compare) }], error: null };
      await runnerCall(`/api/runner/${launch.id}/gate-output`, { code: 0, stdout: JSON.stringify(out), stderr: '' });
      await runnerCall(`/api/runner/${launch.id}/done`, { result: 'checked the deploy' });
      continue;
    }
    if (launch.pr_number !== opts.prNumber) continue;
    const argv = prViewArgs(launch.pr_number, launch.repo_slug);
    const merged = JSON.stringify({ state: 'MERGED', mergedAt: '2026-11-19T09:00:00Z', mergeCommit: { oid: opts.mergeSha }, url: `https://github.com/${launch.repo_slug}/pull/${launch.pr_number}` });
    const stdout = await stubGh(argv, merged, opts.dir);
    await runnerCall(`/api/runner/${launch.id}/gate-output`, { code: 0, stdout, stderr: '' });
    await runnerCall(`/api/runner/${launch.id}/done`, { result: `checked PR ${launch.pr_number}` });
  }
  if (await opts.done()) return;
  throw new Error('the runner answers did not finish in time');
}

/** The card's state from the Jobs API, the same evaluator the tab uses. */
async function stateOf(key: string, cardKey: string): Promise<string> {
  const jobs = await (await clientFetch(`${BASE}/api/initiatives/${key}/jobs`)).json();
  return String(jobs.cards.find((c: { key: string }) => c.key === cardKey).state);
}

test('a deployed gate is checked from the runner answers and turns green, so the card that waits for it is Ready', async ({ page, consoleErrors: _ }) => {
  // Flow b of the phase 4 plan: the deploy of the merged source is proven from GitHub's run, the run's job and step, and
  // the compare with the merge commit, and the gate turns green.
  const dir = mkdtempSync(join(tmpdir(), 'phase4-b-'));
  const key = await seed('p4-deployed');
  const MERGE = 'd'.repeat(40);
  const cardOf = (title: string) => page.getByTestId('job-card').filter({ has: page.locator('strong', { hasText: title }) });

  await page.goto(`/#/initiatives/${key}`);
  await page.getByTestId('tab-jobs').click();
  await expect(cardOf('Release page').getByTestId('job-state')).toHaveText('Locked');

  await startAndDeliver(key, 41);
  // The loop stops when the server says card c is Ready, which only the proven deploy makes it.
  await serveRunner({ prNumber: 41, mergeSha: MERGE, dir, done: async () => (await stateOf(key, 'c')) === 'ready', timeoutMs: 170_000 });

  await page.reload();
  await page.getByTestId('tab-jobs').click();
  await expect(cardOf('Release page').getByTestId('job-state')).toHaveText('Ready');
  await expect(cardOf('Release page').getByTestId('gate-row').first()).toContainText('Met');
});

test('a merged PR is read once and the Architect proposes its follow-up, which the Client confirms in the room', async ({ page, consoleErrors: _ }) => {
  // Flow c, follow-up part, of the phase 4 plan: the merged gate turns green, the PR body is read once, the stub Architect
  // proposes the follow-up as a design revision, and the Client confirms it on the Confirm card.
  const dir = mkdtempSync(join(tmpdir(), 'phase4-c-'));
  const key = await seed('p4-followup');
  const MERGE = 'e'.repeat(40);

  await startAndDeliver(key, 42);
  // The loop stops when the read of this PR is stored as read (one row per initiative and PR).
  const readStates = () => mysql(`SELECT r.state FROM initiative_pr_reads r JOIN initiatives i ON i.id = r.initiative_id WHERE i.\`key\` = '${key}' AND r.pr_url LIKE '%/pull/42'`);
  await serveRunner({ prNumber: 42, mergeSha: MERGE, dir, done: async () => (await readStates()).includes('read'), timeoutMs: 170_000 });
  expect(await readStates()).toEqual(['read']);

  // The stub Architect reads the design and proposes the follow-up. Its token is the one the runner mints for its chat.
  const got = await (await clientFetch(`${BASE}/api/initiatives/${key}`)).json();
  const { token } = await runnerCall(`/api/runner/chat/${String(got.initiative.chat_id)}/token`);
  const architect = await ArchitectSim.connect(token);
  await architect.call('propose_design_revision', {
    ops: [{ op: 'update', id: 'b', set: { note: 'Retry the export once after a failure, as the merged PR says.' } }],
    summary: 'Add the retry note from the merged PR of card a.',
    reason: 'The PR body asks for one retry.',
  });

  // The Client sees the revision waiting in History, and confirms its Confirm card in the room's Architect chat.
  await page.goto(`/#/initiatives/${key}`);
  await page.getByTestId('tab-history').click();
  await expect(page.getByTestId('pending-revision')).toContainText('Add the retry note from the merged PR of card a.');
  // The version before the Confirm is read, so the test does not depend on how many versions the merged check added.
  const before = Number((await (await clientFetch(`${BASE}/api/initiatives/${key}`)).json()).initiative.current_version);
  await page.getByTestId('action-confirm').first().click();
  await expect.poll(async () => Number((await (await clientFetch(`${BASE}/api/initiatives/${key}`)).json()).initiative.current_version), { timeout: 30_000 }).toBe(before + 1);
  await page.reload();
  await page.getByTestId('tab-history').click();
  await expect(page.getByTestId('history')).toContainText('Add the retry note from the merged PR of card a.');
});

/** Runs one SQL statement on the stack's MySQL and returns the first column of each row, as text. */
async function mysql(sql: string): Promise<string[]> {
  const { stdout } = await run('docker', ['compose', '-f', 'docker-compose.e2e.yml', 'exec', '-T', '-e', 'MYSQL_PWD=e2e-password', 'mysql', 'mysql', '-uorchestrator', 'orchestrator', '-N', '-B', '-e', sql]);
  return stdout.trim() ? stdout.trim().split('\n') : [];
}
