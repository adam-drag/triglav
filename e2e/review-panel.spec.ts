import { BASE, cleanup, clientFetch, expect, openLive, RUNNER_KEY, spawnSenior, staffWithJob, test } from './fixtures.ts';

const runnerPost = (path: string, body: object) => fetch(`${BASE}${path}`, { method: 'POST', headers: { authorization: `Bearer ${RUNNER_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const put = (path: string, body: object) => clientFetch(`${BASE}${path}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const panel = () => clientFetch(`${BASE}/api/review-panel`).then((r) => r.json());

const claude = { version: '2.1.0 (Claude Code)', models: [{ id: 'claude-opus-5-5', label: 'Opus 5.5', efforts: ['low', 'high', 'max'] }, { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', efforts: ['low', 'high'] }] };
const codex = { version: 'codex-cli 0.1.0', models: [{ id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', efforts: ['low', 'high'] }, { id: 'gpt-6-luna', label: 'GPT-6-Luna', efforts: ['low'] }] };
const report = (body: object) => runnerPost('/api/runner/runtimes', body);
const unlisted = { 'claude-code': { version: claude.version, models: [] }, codex: { version: codex.version, models: [] } };

test('the Models page edits the review panel from the runner lists, saves it, refuses a bad one and resets to the default', async ({ page, consoleErrors }) => {
  await report({ 'claude-code': claude, codex });
  try {
    await openLive(page, 'models');
    const box = page.getByTestId('review-panel');
    await expect(box).toHaveAttribute('data-default', 'true');
    await expect(box.getByTestId('review-panel-state')).toHaveText('This is the default panel.');
    // The default panel: the strong seat on Codex, one cheap seat on Claude.
    await expect(box.getByTestId('review-panel-seat')).toHaveCount(2);
    await expect(box.getByLabel('strong seat model')).toHaveValue('gpt-6.1-sol');
    await expect(box.getByLabel('cheap seat 1 runtime')).toHaveValue('claude-code');
    // Models and efforts are the CLI's own lists.
    await expect(box.getByLabel('strong seat model').locator('option')).toHaveText(['GPT-6.1-Sol', 'GPT-6-Luna']);
    await expect(box.getByLabel('cheap seat 1 effort').locator('option')).toHaveText(['low', 'high']);
    await expect(box.getByRole('button', { name: 'Save panel' })).toBeDisabled();

    // Change the strong seat, add a cheap Codex seat.
    await box.getByLabel('strong seat runtime').selectOption('claude-code');
    await box.getByLabel('strong seat model').selectOption('claude-opus-5-5');
    await box.getByLabel('strong seat effort').selectOption('max');
    await box.getByRole('button', { name: 'Add a cheap seat' }).click();
    await expect(box.getByTestId('review-panel-seat')).toHaveCount(3);
    await box.getByLabel('cheap seat 2 runtime').selectOption('codex');
    await box.getByLabel('cheap seat 2 model').selectOption('gpt-6-luna');
    await expect(box.getByLabel('cheap seat 2 effort')).toHaveValue('low');
    await box.getByRole('button', { name: 'Save panel' }).click();
    await expect(box).toHaveAttribute('data-default', 'false');
    const saved = await panel();
    expect(saved.panel.strong).toEqual({ runtime: 'claude-code', model: 'claude-opus-5-5', effort: 'max' });
    expect(saved.panel.cheap.map((s: any) => [s.runtime, s.model, s.effort])).toEqual([['claude-code', 'claude-sonnet-5-5', 'low'], ['codex', 'gpt-6-luna', 'low']]);
    expect(saved.seats).toEqual(['strong', 'cheap-claude', 'cheap-codex']);

    // Five cheap seats are not allowed: the button stops at four, and the server refuses a fifth with a reason.
    for (let i = 0; i < 2; i++) await box.getByRole('button', { name: 'Add a cheap seat' }).click();
    await expect(box.getByTestId('review-panel-seat')).toHaveCount(5);
    await expect(box.getByRole('button', { name: 'Add a cheap seat' })).toBeDisabled();
    const five = await put('/api/review-panel', { strong: saved.panel.strong, cheap: Array(5).fill(saved.panel.cheap[0]) });
    expect(five.status).toBe(400);
    expect((await five.json()).message).toMatch(/at most 4 cheap seats/);
    const unknown = await put('/api/review-panel', { strong: { runtime: 'codex', model: 'gpt-6.1-solx', effort: 'low' }, cheap: [] });
    expect(unknown.status).toBe(400);
    // The browser logs each 400 as a console error; these two were caused on purpose.
    expect(consoleErrors.splice(0).every((e) => /status of 400/.test(e))).toBe(true);
    expect((await panel()).panel.cheap).toHaveLength(2);

    // A refusal from the server shows next to the buttons and keeps the draft.
    await report({ 'claude-code': { ...claude, models: claude.models.slice(1) }, codex });
    await box.getByRole('button', { name: 'Save panel' }).click();
    await expect(box.locator('.error')).toContainText('does not offer the model');
    expect(consoleErrors.splice(0).every((e) => /status of 400/.test(e))).toBe(true);
    await report({ 'claude-code': claude, codex });

    await box.getByRole('button', { name: 'Reset to default' }).click();
    await expect(box).toHaveAttribute('data-default', 'true');
    await expect(box.getByTestId('review-panel-seat')).toHaveCount(2);
    expect((await panel()).is_default).toBe(true);

    // Reset also throws away an edit that was never saved, when the server already holds the default.
    await box.getByLabel('strong seat model').selectOption('gpt-6-luna');
    await box.getByRole('button', { name: 'Add a cheap seat' }).click();
    await expect(box.getByTestId('review-panel-seat')).toHaveCount(3);
    await expect(box.getByRole('button', { name: 'Save panel' })).toBeEnabled();
    await box.getByRole('button', { name: 'Reset to default' }).click();
    await expect(box.getByTestId('review-panel-seat')).toHaveCount(2);
    await expect(box.getByLabel('strong seat model')).toHaveValue('gpt-6.1-sol');
    await expect(box.getByRole('button', { name: 'Save panel' })).toBeDisabled();
  } finally {
    await clientFetch(`${BASE}/api/review-panel/reset`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    await report(unlisted);
  }
});

test('the job page shows each local review round and each Copilot round, and reviewer text stays plain text', async ({ page, consoleErrors, agents }) => {
  const { staff, parentId, a } = await staffWithJob('panel');
  agents.push(staff);
  const evil = '<img src=x onerror="document.title=\'pwned\'"> [click](https://evil.example/x)';
  const sha = (c: string) => c.repeat(40);
  // The runner plays the host: it takes each queued reviewer launch and posts what the reviewer printed.
  const finishSeats = async (strongFindings: object[]) => {
    for (let i = 0; i < 20; i++) {
      const { launch } = await (await runnerPost('/api/runner/next', {})).json();
      if (!launch) break;
      if (launch.kind !== 'code_review') {
        await runnerPost(`/api/runner/${launch.id}/done`, { result: 'ok: started' });
        continue;
      }
      const strong = launch.model === 'gpt-6.1-sol';
      const findings = strong ? strongFindings : [];
      const stdout =
        launch.runtime === 'codex'
          ? [JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ findings }) } }), JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 460000, cached_input_tokens: 400000, output_tokens: 2500 } })].join('\n')
          : JSON.stringify({ type: 'result', is_error: false, structured_output: { findings: strong ? [] : [{ severity: 'P2', title: `Crash on empty input ${evil}`, body: 'The same crash, seen by the cheap seat.', sites: [{ file: 'src/a.ts', line: 12 }] }] }, usage: { input_tokens: 9000, output_tokens: 400 }, total_cost_usd: 0.0421 });
      await runnerPost(`/api/runner/${launch.id}/review-output`, { code: 0, stdout, stderr: '', secs: strong ? 71.4 : 12 });
    }
  };
  try {
    await report(unlisted);
    const senior = await spawnSenior(staff, a, 'senior-panel');
    agents.push(senior);
    const asg = senior.assignment!;
    const first = await senior.call('request_code_review', { worktree: '/tmp/e2e-repo', base_sha: sha('1'), head_sha: sha('2'), notes: 'Fixes the crash.' });
    expect(first.seats.map((s: any) => s.seat)).toEqual(['strong', 'cheap-claude']);
    await finishSeats([{ severity: 'P1', title: `Crash on empty input ${evil}`, body: `Reads items[0] on an empty list.\n${evil}`, sites: [{ file: 'src/a.ts', line: 10 }] }]);
    await senior.waitFor('code_review.finished');

    await openLive(page, `jobs/${a}`);
    const rounds = page.getByTestId('local-review');
    await expect(rounds).toHaveCount(1);
    const r1 = rounds.first();
    await expect(r1).toHaveAttribute('data-verdict', 'changes');
    await expect(r1).toContainText('Round 1');
    await expect(r1).toContainText(`${sha('1').slice(0, 8)}..${sha('2').slice(0, 8)}`);
    await expect(r1.getByTestId('review-seat')).toHaveCount(3);
    const strong = r1.locator('[data-testid=review-seat][data-seat=strong]');
    await expect(strong).toContainText('codex');
    await expect(strong).toContainText('gpt-6.1-sol');
    await expect(strong).toContainText('high');
    await expect(strong).toContainText('71 s');
    await expect(strong).toContainText('460.0k / 400.0k / 2.5k');
    await expect(r1.locator('[data-testid=review-seat][data-seat=cheap-claude]')).toContainText('$0.04');
    // Codex reports no cost, so the round's total says it is partial.
    await expect(r1.getByTestId('review-cost')).toHaveAttribute('data-partial', 'true');
    await expect(r1.getByTestId('review-cost')).toHaveText('$0.04 (partial: some seats report no cost)');
    await expect(r1.locator('[data-testid=review-seat][data-seat=cheap-claude]')).toContainText('claude');
    // Merged finding: severity, reviewers, sites and triage state. The two seats reported the same crash.
    const f = r1.getByTestId('review-finding');
    await expect(f).toHaveCount(1);
    await expect(f).toHaveAttribute('data-severity', 'P1');
    await expect(f).toHaveAttribute('data-blocking', 'true');
    await expect(f).toContainText('2 reviewers (strong, cheap-claude)');
    await expect(f).toContainText('src/a.ts:10');
    await expect(f).toContainText('Not triaged');
    // Reviewer text is plain: the tag and the link are text, never elements, and nothing ran.
    await expect(f).toContainText('<img src=x onerror=');
    await expect(f).toContainText('[click](https://evil.example/x)');
    await expect(page.getByTestId('code-reviews').locator('img, a, script')).toHaveCount(0);
    expect(await page.title()).not.toBe('pwned');

    // Answer it, then a second round on the fix delta runs with a one-seat panel, so one family covers every seat.
    const review = await senior.call('get_code_review', { review_id: first.review_id });
    await senior.call('answer_finding', { review_id: first.review_id, finding_id: review.findings[0].finding_id, triage: 'valid', reason: 'Fixed in the next commit.' });
    expect((await put('/api/review-panel', { strong: { runtime: 'codex', model: 'gpt-6.1-sol', effort: 'high' }, cheap: [] })).status).toBe(200);
    const second = await senior.call('request_code_review', { worktree: '/tmp/e2e-repo', base_sha: sha('2'), head_sha: sha('3') });
    expect(second.seats.map((s: any) => s.seat)).toEqual(['strong']);
    await finishSeats([]);
    await senior.waitFor('code_review.finished');
    await expect(rounds).toHaveCount(2);
    const r2 = rounds.nth(1);
    await expect(r2).toHaveAttribute('data-verdict', 'ok');
    await expect(r2).toContainText('Round 2');
    await expect(r2.getByTestId('same-family')).toContainText('One family (codex) covers every seat');
    await expect(r1.getByTestId('same-family')).toHaveCount(0);
    await expect(r1.getByTestId('review-finding')).toContainText('Triage: valid. Fixed in the next commit.');

    // The Copilot round the server counted (a made-up PR number: the throwaway stack never talks to GitHub).
    await senior.call('request_copilot_review', { assignment_id: asg.id, attempt: asg.attempt, pr: 77, head_sha: sha('3') });
    await senior.call('record_copilot_result', { assignment_id: asg.id, attempt: asg.attempt, pr: 77, round: 1, approval_recommended: false, findings: { P0: 0, P1: 1, P2: 2, P3: 3 }, previously_missed: 1 });
    // Copilot rounds raise no dashboard event, so the page shows them on the next refresh.
    await page.reload();
    const c = page.getByTestId('copilot-round');
    await expect(c).toHaveCount(1);
    await expect(c.locator('td')).toHaveText(['#77', '1', sha('3').slice(0, 8), 'no', '0', '1', '2', '3', '1']);
    expect(consoleErrors).toEqual([]);
  } finally {
    await clientFetch(`${BASE}/api/review-panel/reset`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    await cleanup(parentId);
  }
});
