import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BASE, clientFetch, expect, openCard, test } from './fixtures.ts';
import { ArchitectSim } from './architect-sim.ts';
import { card, mysql, runnerCall, serveRunner, startAndDeliver, stateOf } from './initiative-runner.ts';

// Phase 4 of the initiative room, end to end on the :7401 stack (docs/plans/initiative-room.md). As in initiative-jobs.spec.ts,
// the test plays the host runner's part: it takes the launches it needs from /api/runner/next with the runner key, runs the
// stub gh with the argv the gate-check builders give, and posts the answer the way the runner does. The runner's own
// functions are tested in test/runner-security.test.ts. Specs run one at a time (playwright.config.ts), so each test answers
// only the launches of its own pull request and merge commit.

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

test('a deployed gate is checked from the runner answers and turns green, so the card that waits for it is Ready', async ({ page, consoleErrors: _ }) => {
  // Flow b of the phase 4 plan: the deploy of the merged source is proven from GitHub's run, the run's job and step, and
  // the compare with the merge commit, and the gate turns green.
  const dir = mkdtempSync(join(tmpdir(), 'phase4-b-'));
  const key = await seed('p4-deployed');
  const MERGE = 'd'.repeat(40);
  const cardOf = (title: string) => openCard(page, title);

  await page.goto(`/#/initiatives/${key}`);
  await page.getByTestId('tab-plan').click();
  await expect((await cardOf('Release page')).getByTestId('job-state')).toHaveText('Locked');

  await startAndDeliver(key, 41);
  // The loop stops when the server says card c is Ready, which only the proven deploy makes it.
  await serveRunner({ prNumber: 41, mergeSha: MERGE, dir, done: async () => (await stateOf(key, 'c')) === 'ready', timeoutMs: 170_000 });

  await page.reload();
  await page.getByTestId('tab-plan').click();
  await expect((await cardOf('Release page')).getByTestId('job-state')).toHaveText('Ready');
  await expect((await cardOf('Release page')).getByTestId('gate-row').first()).toContainText('Met');
});

test('a merged PR is read once and the Architect proposes its follow-up, which the Client confirms in the room', async ({ page, consoleErrors: _ }) => {
  // Flow c, follow-up part, of the phase 4 plan: the merged gate turns green, the PR body is read once, the stub Architect
  // proposes the follow-up as a design revision, and the Client confirms it on the Confirm card.
  const dir = mkdtempSync(join(tmpdir(), 'phase4-c-'));
  const key = await seed('p4-followup');
  const MERGE = 'e'.repeat(40);

  await startAndDeliver(key, 42);
  // The loop stops when the read of this PR is stored as read (one row per initiative and PR), and when card c is Ready. The
  // merge also queues the deploy check of c, and the server runs one gate check at a time: a check left picked here holds up
  // every later check of the stack, so this test answers it too.
  const readStates = () => mysql(`SELECT r.state FROM initiative_pr_reads r JOIN initiatives i ON i.id = r.initiative_id WHERE i.\`key\` = '${key}' AND r.pr_url LIKE '%/pull/42'`);
  await serveRunner({ prNumber: 42, mergeSha: MERGE, dir, done: async () => (await readStates()).includes('read') && (await stateOf(key, 'c')) === 'ready', timeoutMs: 170_000 });
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

