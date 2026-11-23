import { expect, BASE, clientFetch, RUNNER_KEY, SimAgent, test } from './fixtures.ts';
import { ArchitectSim } from './architect-sim.ts';
import { mysql } from './initiative-runner.ts';

// The two client decisions the Architect settles by rule, end to end. The Architect is the stub MCP client of
// architect-answers.spec.ts. No runner runs here, because it would call the real gh: the test takes the host command
// from /api/runner/chat/next and reports gh's result, as the chat runner does.

const design = {
  format: 1,
  title: 'PR ready e2e',
  blocks: [
    { kind: 'wave', id: 'W-1', title: 'Wave one', when: 'Now', jobs: ['a'] },
    { kind: 'card', id: 'a', title: 'PDF endpoint', repo: 'app', wave: 'W-1', deps: [], goal: 'Build the PDF endpoint.', scope: ['One change'], out: [], accept: ['It works'], verify: ['Run the tests'], traps: [], safety: [], dod: [], gates: [] },
  ],
};

async function runnerCall(path: string, body: unknown = {}): Promise<any> {
  const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: { authorization: `Bearer ${RUNNER_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

test('in auto mode the Architect marks a PR ready without a Confirm and resolves the blocker, and it answers release notes for review', async ({ page, consoleErrors: _ }) => {
  const key = `prr-e2e-${Date.now().toString(36)}`;
  const seeded = await clientFetch(`${BASE}/api/initiatives`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key, title: `PR ready ${key}`, repos: [{ slug: 'app', path: `/nonexistent-e2e/${key}`, base: 'main', github: 'owner/app' }], source: 'e2e', doc: design }) });
  expect(seeded.status, await seeded.clone().text()).toBe(200);
  const chatId = String((await (await clientFetch(`${BASE}/api/initiatives/${key}`)).json()).initiative.chat_id);
  const started = await (await clientFetch(`${BASE}/api/initiatives/${key}/cards/a/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ started_from_version: 1 }) })).json();
  await runnerCall(`/api/runner/${started.launch_id}/done`, { result: 'ok: started' });
  const staff = await SimAgent.register({ role: 'staff', nickname: `prr-e2e-${Date.now().toString(36)}`, runtime: 'claude-code' });
  const jobId = String((await staff.call('register_job', { request_id: started.request_id, title: 'PDF endpoint' })).job_id);
  // The draft PR is in a review package that passed the local gate; nothing was delivered yet.
  await mysql(`INSERT INTO review_packages (id, assignment_id, attempt_number, job_id, round, summary, artifacts, validation, finding_dispositions, head_sha, gate_review_id, submitted_at) VALUES ('pkg_${key}', 'asg_${key}', 1, '${jobId}', 1, 's', '["PR: https://github.com/owner/app/pull/12"]', 'v', '[]', '${'c'.repeat(40)}', 'rev_${key}', NOW(3))`);
  const asked = await staff.call('raise_blocker', { job_id: jobId, kind: 'client_decision', requested_decision: 'Mark https://github.com/owner/app/pull/12 ready?', unblock_condition: 'The PR is ready for review.', routine: true });

  const architect = await ArchitectSim.connect((await runnerCall(`/api/runner/chat/${chatId}/token`)).token);
  expect((await clientFetch(`${BASE}/api/initiatives/${key}/auto-mode`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ on: true }) })).status).toBe(200);
  const ran = await architect.call('propose_action', { action: 'mark_pr_ready', job_id: jobId, blocker_id: asked.blocker_id });
  expect(ran).toMatchObject({ auto_mode: true, state: 'running' });

  // The runner's part: the host command for this chat, then gh's result.
  let host: any = null;
  for (let i = 0; i < 20 && !host; i++) {
    const { command } = await runnerCall('/api/runner/chat/next');
    if (command?.kind === 'host' && command.chat_id === chatId) host = JSON.parse(String(command.text));
  }
  expect(host).toMatchObject({ action: 'mark_pr_ready', repo: 'owner/app', pr: '12' });
  await runnerCall(`/api/runner/chat/${chatId}/events`, { events: [{ type: 'action_result', action_id: host.action_id, ok: true, text: 'Marked owner/app#12 ready for review.' }] });

  await page.goto(`/#/initiatives/${key}`);
  const card = page.getByTestId('chat-action').filter({ hasText: 'owner/app#12' });
  await expect(card).toHaveAttribute('data-auto', 'true');
  await expect(card).toContainText('The Architect ran this in auto mode, without a Confirm:');
  await expect(card).toContainText(`Done. Marked owner/app#12 ready for review. Resolved the blocker ${asked.blocker_id}.`);
  await expect(card.getByTestId('action-confirm')).toHaveCount(0);

  // Release notes: the Architect approves the block, the blocker resolves, and the answer waits in the list to review.
  const notes = await staff.call('raise_blocker', { job_id: jobId, kind: 'client_decision', requested_decision: 'Confirm the release notes of PR 12?', release_notes: '## Release notes\n**Type:** fix', unblock_condition: 'The block is confirmed.', routine: true });
  expect(await architect.call('answer_release_notes', { blocker_id: notes.blocker_id, verdict: 'approve' })).toMatchObject({ state: 'posted' });
  await page.reload();
  // With nothing for the Client to decide, the room's strip starts folded; open it.
  await expect(page.getByTestId('room-inbox-toggle')).toHaveAttribute('aria-expanded', 'false');
  await page.getByTestId('room-inbox-toggle').click();
  const review = page.getByTestId('room-inbox').getByTestId('initiative-review');
  // Nothing waits for the Client's decision, so the fold is open.
  await expect(review.getByTestId('initiative-review-toggle')).toHaveAttribute('aria-expanded', 'true');
  const row = review.getByTestId('answer-row').filter({ hasText: 'Release notes: approved, use the block as written.' });
  await expect(row.getByTestId('cited-fact')).toHaveText("No citation: release notes are the Architect's call by rule");
  await expect(row.getByTestId('answer-approve')).toBeVisible();
  await expect(row.getByTestId('answer-reopen')).toBeVisible();
});
