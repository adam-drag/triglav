import { mkdirSync } from 'node:fs';
import { cleanup, expect, openLive, SimAgent, spawnSenior, test } from './fixtures.ts';

// Screenshots for README.md, taken from the throwaway :7401 stack with a seeded workspace.
// They are not part of the regular suite. Run them on a fresh stack (the tickets below are
// registered once per stack: `pnpm e2e:down` and `pnpm e2e:up` first):
//   README_SHOTS=docs/screenshots pnpm e2e e2e/readme-shots.spec.ts
const OUT = process.env.README_SHOTS;

test.use({ deviceScaleFactor: 2 });

/** A parent ticket with subtasks, planned and with the first subtask ready, owned by a new Staff agent. */
async function seedJob(nickname: string, id: string, title: string, subtasks: string[], criteria: string) {
  const staff = await SimAgent.register({ role: 'staff', nickname });
  const node = (suffix: string, t: string) => ({ id: `uuid-${id}${suffix}`, identifier: `${id}${suffix}`, title: t, description: `${t}.`, url: `https://linear.app/acme/issue/${id}${suffix}` });
  const job = await staff.call('register_job', {
    linear_issue: id,
    repo_path: '/tmp/e2e-repo',
    base_branch: 'main',
    ticket_snapshot: { ...node('', title), children: subtasks.map((t, i) => node(`-${i + 1}`, t)) },
  });
  const ids = job.subjob_ids as string[];
  for (const jobId of [job.job_id, ...ids]) {
    await staff.call('update_job', { job_id: jobId, status: 'planning' });
    await staff.call('update_job', { job_id: jobId, acceptance_criteria: criteria });
  }
  for (const jobId of ids.slice(0, 2)) await staff.call('update_job', { job_id: jobId, status: 'ready' });
  return { staff, parentId: job.job_id as string, ids };
}

test('readme screenshots', async ({ page, consoleErrors: _, agents }) => {
  test.skip(!OUT, 'set README_SHOTS to an output directory');
  mkdirSync(OUT!, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: 'dark' });

  const a = await seedJob('staff-billing', 'ACME-412', 'Add CSV export to the billing reports', ['Streaming CSV endpoint', 'Export button and download state', 'Docs and rate limit'], 'Exports of 100k rows stream without loading them into memory.\nThe button shows progress and a retry on failure.\nTests cover the endpoint and the button.');
  const b = await seedJob('staff-auth', 'ACME-398', 'Rotate session secrets without logging users out', ['Dual-key verification', 'Rotation job and runbook'], 'Old and new secret both verify during the overlap window.\nRotation can be rolled back.');
  const c = await seedJob('staff-search', 'ACME-377', 'Faster workspace search', ['Index the title and body', 'Highlight matches in results'], 'p95 search under 200 ms on the demo workspace.');
  const senior = (staff: SimAgent, jobId: string, nick: string) => spawnSenior(staff, jobId, nick);
  const s1 = await senior(a.staff, a.ids[0]!, 'senior-csv');
  const s2 = await senior(a.staff, a.ids[1]!, 'senior-button');
  const s3 = await senior(b.staff, b.ids[0]!, 'senior-keys');
  const s4 = await senior(c.staff, c.ids[0]!, 'senior-index');
  const r1 = await SimAgent.register({ role: 'researcher', nickname: 'Security', focus: 'auth, secrets, crypto' });
  const r2 = await SimAgent.register({ role: 'researcher', nickname: 'Performance', focus: 'queries, caching, streaming' });
  agents.push(a.staff, b.staff, c.staff, s1, s2, s3, s4, r1, r2);

  try {
    const progress = (s: SimAgent, note: string, worktree: string) => s.call('report_progress', { assignment_id: s.assignment!.id, attempt: s.assignment!.attempt, note, worktree_path: worktree });
    await progress(s1, 'Streaming endpoint written, 14 tests pass. Starting the rate limit.', '/tmp/e2e-repo-csv');
    await progress(s2, 'Button and progress state in place. Writing the retry test.', '/tmp/e2e-repo-button');
    await progress(s3, 'Verifier accepts both keys. Writing the rotation runbook.', '/tmp/e2e-repo-keys');
    await progress(s4, 'Index builds in 3.1 s on the demo workspace. Measuring p95.', '/tmp/e2e-repo-index');

    // A board discussion where researchers take sides.
    const proposal = await b.staff.call('post_message', { job_id: b.parentId, type: 'proposal', stance: 'inform', body: 'Proposal: keep both secrets valid for 24 hours after a rotation, then drop the old one.' });
    const threadId = proposal.thread_id as string;
    await r1.call('post_message', { thread_id: threadId, stance: 'support', reason: 'A 24 hour overlap covers the longest session we issue', body: 'Agree. Add an alert when the old key is still used after the window.', in_reply_to: proposal.message_id });
    await r2.call('post_message', { thread_id: threadId, stance: 'challenge', reason: 'Two verifications per request add latency on the hot path', body: 'Try the new key first and fall back to the old one only on a failure.', in_reply_to: proposal.message_id });

    // Two decisions that need the Client, one with researcher advice.
    const csv = await a.staff.call('raise_blocker', {
      job_id: a.parentId,
      kind: 'client_decision',
      context: 'The endpoint streams rows, so memory stays flat at any size. A test export of 4 million rows ran for 11 minutes and held a database connection the whole time.\n\nThe ticket does not say how large an export may be.',
      requested_decision: 'Cap CSV exports at 1 million rows, or allow unlimited exports for admins?',
      recommendation: 'Cap exports at 1 million rows for everyone and offer a scheduled export for larger sets.',
      recommendation_actionable: true,
      unblock_condition: 'Client answers in the dashboard',
    });
    await r2.call('advise_decision', { blocker_id: csv.blocker_id, advice: 'A cap protects the database. At 4 million rows the export held a connection for 11 minutes, and ten of those at once would starve the pool. I would cap at 1 million and queue larger exports to run off-peak.' });
    await b.staff.call('raise_blocker', {
      job_id: b.parentId,
      kind: 'client_decision',
      context: 'Rotation keeps both secrets valid for 24 hours, so no session breaks. Sessions older than 30 days were issued before the new expiry rule.',
      requested_decision: 'Should rotation also sign out sessions older than 30 days?',
      recommendation: 'Yes, sign them out. They are rare and they predate the current expiry rule.',
      unblock_condition: 'Client answers in the dashboard',
    });

    // Home, the first screen.
    await page.setViewportSize({ width: 1440, height: 980 });
    await openLive(page, '');
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${OUT}/home.png` });

    // The live map.
    await page.setViewportSize({ width: 1440, height: 900 });
    await openLive(page, 'live');
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${OUT}/activity.png`, clip: { x: 0, y: 190, width: 780, height: 500 } });

    // A decision, opened.
    await openLive(page, 'queue');
    await page.locator('[data-testid=queue-item] summary').first().click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${OUT}/decision.png`, clip: { x: 0, y: 52, width: 1440, height: 640 } });

    // The board thread.
    await openLive(page, `threads/${threadId}`);
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${OUT}/thread.png`, clip: { x: 220, y: 52, width: 1000, height: 500 } });

    // The review panel on the Models page.
    await openLive(page, 'models');
    const panel = page.getByTestId('review-panel');
    await expect(panel).toBeVisible();
    await panel.scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    await panel.locator('table').screenshot({ path: `${OUT}/review-panel.png` });
  } finally {
    await cleanup(a.parentId);
    await cleanup(b.parentId);
    await cleanup(c.parentId);
  }
});
