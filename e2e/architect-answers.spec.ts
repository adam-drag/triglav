import { expect, BASE, clientFetch, RUNNER_KEY, SimAgent, test } from './fixtures.ts';
import { ArchitectSim } from './architect-sim.ts';

// Flow d of the phase 3 plan, end to end on the :7401 stack. The Architect is a stub: it is a real MCP client of
// /architect/mcp with the token the runner would mint for its chat, and it calls the same tools a model does. The runner
// is played the same way as in initiative-jobs.spec.ts: the test takes the quote_check launch from /api/runner/next and
// answers it with the output of `git show` at the cited sha (the runner's own function is in test/runner-security.test.ts).

const SHA = 'c'.repeat(40);

const design = {
  format: 1,
  title: 'Architect e2e',
  blocks: [
    { kind: 'wave', id: 'W-1', title: 'Wave one', when: 'Now', jobs: ['a'] },
    { kind: 'decision', id: 'D1', title: 'App host', body: 'Links use the app host.' },
    {
      kind: 'card',
      id: 'a',
      title: 'PDF endpoint',
      repo: 'app',
      wave: 'W-1',
      deps: [],
      decisions: ['D1'],
      goal: 'Build the PDF endpoint.',
      scope: ['One change'],
      out: [],
      accept: ['It works'],
      verify: ['Run the tests'],
      traps: [],
      safety: [],
      dod: [],
      gates: [],
    },
  ],
};

async function runnerCall(path: string, body: unknown = {}): Promise<any> {
  const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: { authorization: `Bearer ${RUNNER_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

async function seed(): Promise<{ key: string; chatId: string }> {
  const key = `arch-e2e-${Date.now().toString(36)}`;
  const body = { key, title: `Architect e2e ${key}`, repos: [{ slug: 'app', path: `/nonexistent-e2e/${key}`, base: 'main', github: 'owner/app' }], source: 'e2e', doc: design };
  const res = await clientFetch(`${BASE}/api/initiatives`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  expect(res.status, await res.clone().text()).toBe(200);
  const got = await (await clientFetch(`${BASE}/api/initiatives/${key}`)).json();
  return { key, chatId: String(got.initiative.chat_id) };
}

test('the Architect answers Staff from a decision and from a checked citation, refuses an uncited answer, escalates one the Client accepts in a click, and a delegated answer can be reopened', async ({ page, consoleErrors: _ }) => {
  const { key, chatId } = await seed();

  // Start the card and let Staff register its job, as in initiative-jobs.spec.ts.
  const version = 1;
  const started = await (await clientFetch(`${BASE}/api/initiatives/${key}/cards/a/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ started_from_version: version }) })).json();
  await runnerCall(`/api/runner/${started.launch_id}/done`, { result: 'ok: started' });
  const staff = await SimAgent.register({ role: 'staff', nickname: `arch-e2e-${Date.now().toString(36)}`, runtime: 'claude-code' });
  const job = await staff.call('register_job', { request_id: started.request_id, title: 'PDF endpoint' });
  const jobId = String(job.job_id);

  // The Architect's token, minted the way the runner mints it for its chat.
  const { token } = await runnerCall(`/api/runner/chat/${chatId}/token`);
  const architect = await ArchitectSim.connect(token);

  // 1. A question answered from decision D1.
  const q1 = await staff.call('post_message', { job_id: jobId, type: 'discussion', body: 'Which host do the links use?' });
  // The first question while refining wakes the Architect at once: its chat gets a send that names the question.
  let wake: any = null;
  for (let i = 0; i < 10 && !wake; i++) {
    const { command } = await runnerCall('/api/runner/chat/next');
    if (command?.kind === 'send' && String(command.text).includes('Which host do the links use?')) wake = command;
  }
  expect(wake, 'the first Staff question woke the Architect chat').toBeTruthy();
  const a1 = await architect.call('answer_staff_question', { job_id: jobId, thread_id: q1.thread_id, answer: 'Links use the app host.', citation: { decision: 'D1' } });
  expect(a1.state).toBe('posted');

  // 2. An uncited answer is refused, and nothing is posted.
  const q2 = await staff.call('post_message', { job_id: jobId, type: 'discussion', body: 'Where does the PDF code live?' });
  await expect(architect.call('answer_staff_question', { job_id: jobId, thread_id: q2.thread_id, answer: 'In the PDF module.' })).rejects.toThrow();

  // 3. A code citation: the runner checks the quote at the sha before the answer is posted.
  const cited = await architect.call('answer_staff_question', { job_id: jobId, thread_id: q2.thread_id, answer: 'In src/pdf.ts, line 3.', citation: { code: { repo: 'app', path: 'src/pdf.ts', line: 3, sha: SHA, quote: 'export function renderPdf' } } });
  expect(cited.state).toBe('checking');
  let check: any = null;
  for (let i = 0; i < 30 && !check; i++) {
    const { launch } = await runnerCall('/api/runner/next');
    if (launch?.kind === 'quote_check' && launch.sha === SHA && launch.path === 'src/pdf.ts') check = launch;
  }
  expect(check, 'the quote_check launch for the cited answer').toBeTruthy();
  expect(check).toMatchObject({ kind: 'quote_check', sha: SHA, path: 'src/pdf.ts' });
  await runnerCall(`/api/runner/${check.id}/quote-output`, { code: 0, stdout: 'import x from "y";\n\nexport function renderPdf(doc) {}\n', stderr: '' });
  const thread2 = await staff.call('get_thread', { thread_id: q2.thread_id });
  expect(JSON.stringify(thread2.messages)).toContain('In src/pdf.ts, line 3.');

  // 4. An escalation is a decision card in the Inbox, under its initiative and not again under Client decisions, with the
  // Architect's recommendation in the card. The room's strip lists the same card, open, and Accept posts the answer in one click.
  await architect.call('escalate', { job_id: jobId, question: 'Keep the old column order?', recommendation: 'Keep the old order.', why_client: 'It changes the file format.', checked: 'D1 and the export notes' });
  await page.goto('/#/queue');
  const group = page.locator(`[data-testid="initiative-group"][data-key="${key}"]`);
  await expect(group.getByTestId('queue-item').filter({ hasText: 'Keep the old column order?' })).toHaveCount(1);
  await expect(page.getByTestId('queue-item').filter({ hasText: 'Keep the old column order?' })).toHaveCount(1);
  await page.goto(`/#/initiatives/${key}`);
  await expect(page.getByTestId('room-inbox-toggle')).toHaveAttribute('aria-expanded', 'true');
  const decision = page.getByTestId('room-inbox').getByTestId('queue-item').filter({ hasText: 'Keep the old column order?' });
  await decision.locator('summary').click();
  await expect(decision.getByTestId('architect-rec')).toContainText('Keep the old order.');
  // A new blocker of the Architect's own carries why the Client decides as its problem.
  await expect(decision).toContainText('It changes the file format.');
  await decision.getByTestId('answer-accept').click();
  await expect(decision).toHaveCount(0);
  // Accepted, it is an answer to review: Reopen can take it back until Staff replies. The strip stays open while the Client works in it.
  const row = page.getByTestId('room-inbox').getByTestId('answer-row').filter({ hasText: 'Keep the old order.' });
  await expect(row).toContainText('Accepted by the Client');
  await expect(row.getByTestId('answer-reopen')).toBeVisible();

  // 5. A delegated answer: Staff raises a client decision and the Architect answers it with a citation.
  const raised = await staff.call('raise_blocker', { job_id: jobId, kind: 'client_decision', requested_decision: 'Pick the file name.', recommendation: 'Use export.csv.', recommendation_actionable: true, unblock_condition: 'The Client picks the name.' });
  const blocker = String(raised.blocker_id);
  // Later wakes inside three minutes are held and sent in one batch by the scheduler, so this flow does not wait for one.
  const delegated = await architect.call('answer_staff_question', { job_id: jobId, blocker_id: blocker, answer: 'Use export.csv.', citation: { decision: 'D1' } });
  expect(delegated.state).toBe('posted');

  // A second question waits for the Client next to the answer to review. The answers to review start folded, in the Inbox
  // and in the room, so the question stays on screen. The Client's open is kept for the initiative, in both places. The
  // Architect asks it: a Staff message would end the answer's Reopen window and take it off the list.
  const extra = await architect.call('escalate', { job_id: jobId, question: 'Name the sheet Sheet1?', recommendation: 'Use Sheet1.', why_client: 'It is in the file users open.', checked: 'D1' });
  await page.goto('/#/queue');
  const queueReview = group.getByTestId('initiative-review');
  await expect(queueReview.getByTestId('initiative-review-toggle')).toHaveAttribute('aria-expanded', 'false');
  await expect(queueReview).not.toContainText('Use export.csv.');
  await page.goto(`/#/initiatives/${key}`);
  const review = page.getByTestId('room-inbox').getByTestId('initiative-review');
  await expect(review.getByTestId('initiative-review-toggle')).toHaveAttribute('aria-expanded', 'false');
  await review.getByTestId('initiative-review-toggle').click();
  await expect(review).toContainText('Use export.csv.');
  await page.goto('/#/queue');
  await expect(queueReview.getByTestId('initiative-review-toggle')).toHaveAttribute('aria-expanded', 'true');
  await expect(queueReview).toContainText('Use export.csv.');
  const resolved = await clientFetch(`${BASE}/api/blockers/${extra.blocker_id}/resolve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ resolution: 'Use Sheet1.' }) });
  expect(resolved.ok).toBe(true);
  await page.goto(`/#/initiatives/${key}`);

  // 6. Nothing waits on answers to review, so a fresh room starts with the strip closed. Reopen takes the delegated answer
  // back: it becomes an escalation, a decision card with the answer as the Architect's recommendation.
  await page.reload();
  await expect(page.getByTestId('room-inbox-toggle')).toHaveAttribute('aria-expanded', 'false');
  await page.getByTestId('room-inbox-toggle').click();
  const delegatedRow = page.getByTestId('room-inbox').getByTestId('answer-row').filter({ hasText: 'Use export.csv.' });
  await delegatedRow.getByTestId('answer-reopen').click();
  await expect(delegatedRow).toHaveCount(0);
  const reopened = page.getByTestId('room-inbox').getByTestId('queue-item').filter({ hasText: 'Reopened answer: Use export.csv.' });
  await reopened.locator('summary').click();
  await expect(reopened.getByTestId('architect-rec')).toContainText('Use export.csv.');

  // Close what this flow leaves open, so the shared e2e stack's Home and Inbox do not carry it into later specs. The Client
  // accepts the reopened answer, and Staff replies on the General thread, which ends every Reopen window (a later Staff message).
  await reopened.getByTestId('answer-accept').click();
  await expect(page.getByTestId('room-inbox').getByTestId('answer-row').filter({ hasText: 'Use export.csv.' })).toContainText('Accepted by the Client');
  const general = (await staff.call('get_job', { job_id: jobId })).threads.find((t: { title: string }) => t.title === 'General');
  await staff.call('post_message', { job_id: jobId, thread_id: general.id, type: 'discussion', body: 'The Architect flow is done.' });
  await staff.close();
});
