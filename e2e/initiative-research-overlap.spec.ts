import { BASE, clientFetch, expect, openCard, test } from './fixtures.ts';
import { card, mysql, startCard } from './initiative-runner.ts';

// Research linked to an initiative (criterion 1) and the file overlap warning on Start (criterion 6), on the e2e stack.
// The rows a runner or a Senior would write go in through the stack's MySQL, as the other initiative specs do.

test.use({ locale: 'en-US' });

const SHA = 'a'.repeat(40);
const tag = Date.now().toString(36);

/** A room with a repository that points nowhere, and the given card blocks. */
async function room(key: string, path: string, cards: { id: string }[]): Promise<void> {
  const wave = { kind: 'wave', id: 'W-1', title: 'Wave one', when: 'Now', jobs: cards.map((c) => c.id) };
  const doc = { format: 1, title: `Research ${key}`, blocks: [wave, ...cards] };
  const body = { key, title: `Research ${key}`, repos: [{ slug: 'app', path, base: 'main', github: 'owner/app' }], source: 'e2e', doc };
  const res = await clientFetch(`${BASE}/api/initiatives`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  expect(res.status, await res.clone().text()).toBe(200);
}

/** A research job on a repository, with one report version. */
async function researchJob(path: string, id: string, summary: string): Promise<void> {
  const now = 'NOW(3)';
  await mysql(
    `INSERT INTO jobs (id, parent_job_id, linear_issue_id, linear_identifier, linear_url, title, repo_path, base_branch, status, linear_snapshot, linear_fetched_at, created_at, updated_at, kind) VALUES ('${id}', NULL, '${id}', '${id}', '', 'Research ${id}', '${path}', 'main', 'report_ready', '{}', ${now}, ${now}, ${now}, 'research')`,
  );
  await mysql(`INSERT INTO job_reports (id, job_id, version, summary, body, author_agent_id, created_at) VALUES ('rpt_${id}', '${id}', 1, '${summary}', 'The staging host is on port 8080.', 'agt_e2e', ${now})`);
}

test('a research job is linked from the Research tab, listed with its version, and unlinked; the routes need a Client session', async ({ page }) => {
  const key = `rep-e2e-${tag}`;
  const path = `/nonexistent-e2e/${key}`;
  await room(key, path, [card('a', 'Only card', [])]);
  const job = `job_rep${tag}`;
  await researchJob(path, job, 'Staging port check');

  // The route is a Client-session route: without a session it is refused.
  const anon = await fetch(`${BASE}/api/initiatives/${key}/reports`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ job_id: job }) });
  expect(anon.status).toBe(401);

  await page.goto(`/#/initiatives/${key}`);
  await page.getByTestId('tab-research').click();
  await expect(page.getByTestId('candidate-report')).toContainText(`Research ${job}`);
  await page.getByTestId('link-report').click();

  await expect(page.getByTestId('linked-report')).toContainText(`Research ${job}`);
  await expect(page.getByTestId('linked-report-version')).toContainText('v1: Staging port check');
  await expect(page.getByTestId('candidate-report')).toHaveCount(0);

  await page.getByTestId('unlink-report').click();
  await expect(page.getByTestId('linked-report')).toHaveCount(0);
  await expect(page.getByTestId('candidate-report')).toContainText(`Research ${job}`);
});

test('Start shows a file overlap warning with the paths and the job, and Start still works', async ({ page }) => {
  const key = `ovl-e2e-${tag}`;
  const path = `/nonexistent-e2e/${key}`;
  await room(key, path, [
    card('a', 'First change', [], [], { scope: ['Change src/lib/store.ts.'] }),
    card('b', 'Second change', [], [], { scope: ['Change src/lib/store.ts and docs/x.md.'] }),
  ]);

  // Card a is started; its job is a running implement job of this repository that a review has already listed.
  const start = await startCard(key, 'a');
  const job = `job_ovl${tag}`;
  await mysql(
    `INSERT INTO jobs (id, parent_job_id, linear_issue_id, linear_identifier, linear_url, title, repo_path, base_branch, status, linear_snapshot, linear_fetched_at, created_at, updated_at, kind) VALUES ('${job}', NULL, '${job}', '${job}', '', 'First change job', '${path}', 'main', 'in_progress', '{}', NOW(3), NOW(3), NOW(3), 'implement')`,
  );
  await mysql(`UPDATE job_requests SET job_id = '${job}' WHERE id = '${start.request_id}'`);
  const review = `crv_ovl${tag}`;
  const run = `crr_ovl${tag}`;
  await mysql(
    `INSERT INTO code_reviews (id, job_id, requested_by, worktree, base_sha, head_sha, round_no, status, verdict, created_at, finished_at) VALUES ('${review}', '${job}', 'x', '/wt', '${'0'.repeat(40)}', '${SHA}', 1, 'done', 'ok', NOW(3), NOW(3))`,
  );
  await mysql(
    `INSERT INTO code_review_runs (id, review_id, seat, seat_kind, runtime, family, model, effort, status, finished_at) VALUES ('${run}', '${review}', 'strong', 'strong', 'codex', 'codex', 'm', 'high', 'done', NOW(3))`,
  );
  const rules = JSON.stringify({ commit: SHA, source: 'origin', files: [], omitted: [], omitted_more: 0, changed: [], changed_more: 0 });
  const changed = JSON.stringify({ paths: ['src/lib/store.ts', 'test/unrelated.ts'], more: 0 });
  await mysql(`INSERT INTO code_review_run_deltas (run_id, rules, changed_paths) VALUES ('${run}', '${rules}', '${changed}')`);

  await page.goto(`/#/initiatives/${key}`);
  await page.getByTestId('tab-plan').click();
  const cardOf = (title: string) => openCard(page, title);
  await (await cardOf('Second change')).getByTestId('card-start').click();

  const overlap = page.getByTestId('overlap-warning');
  await expect(overlap).toContainText(job);
  await expect(overlap).toContainText(SHA.slice(0, 12));
  await expect(overlap.locator('code', { hasText: 'src/lib/store.ts' })).toHaveCount(1);
  await expect(overlap.locator('code', { hasText: 'test/unrelated.ts' })).toHaveCount(0);
  await expect(page.getByText('This is a warning. Start still works.')).toBeVisible();

  // The warning does not block Start.
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && /\/cards\/b\/start$/.test(new URL(r.url()).pathname));
  await page.getByTestId('start-confirm-button').click();
  const res = await started;
  expect(res.status(), await res.text()).toBe(200);
  await expect(page.getByTestId('start-confirm')).toHaveCount(0);
});
