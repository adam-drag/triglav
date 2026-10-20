import { BASE, cleanup, clientFetch, expect, openLive, RUNNER_KEY, spawnSenior, staffWithJob, test } from './fixtures.ts';

const runnerPost = (path: string, body: object) => fetch(`${BASE}${path}`, { method: 'POST', headers: { authorization: `Bearer ${RUNNER_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const put = (path: string, body: object) => clientFetch(`${BASE}${path}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const panel = () => clientFetch(`${BASE}/api/review-panel`).then((r) => r.json());

const claude = { version: '2.1.0 (Claude Code)', models: [{ id: 'claude-opus-5-5', label: 'Opus 5.5', efforts: ['low', 'high', 'max'] }, { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', efforts: ['low', 'high'] }, { id: 'claude-haiku-5-5', label: 'Haiku 5.5', efforts: ['low', 'medium'] }] };
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
    // The default panel: the strong seat on Codex, one cheap seat on Claude, the contracts and integrity lenses on Haiku in shadow mode.
    await expect(box.getByTestId('review-panel-seat')).toHaveCount(4);
    await expect(box.getByLabel('lens seat 1 lens')).toHaveValue('contracts');
    await expect(box.getByLabel('lens seat 2 lens')).toHaveValue('integrity');
    await expect(box.getByLabel('lens seat 1 model')).toHaveValue('claude-haiku-5-5');
    await expect(box.getByLabel('lens seat 1 effort')).toHaveValue('medium');
    await expect(box.getByLabel('lens seat 2 shadow')).toBeChecked();
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
    await expect(box.getByTestId('review-panel-seat')).toHaveCount(5);
    await box.getByLabel('cheap seat 2 runtime').selectOption('codex');
    await box.getByLabel('cheap seat 2 model').selectOption('gpt-6-luna');
    await expect(box.getByLabel('cheap seat 2 effort')).toHaveValue('low');
    await box.getByRole('button', { name: 'Save panel' }).click();
    await expect(box).toHaveAttribute('data-default', 'false');
    const saved = await panel();
    expect(saved.panel.strong).toEqual({ runtime: 'claude-code', model: 'claude-opus-5-5', effort: 'max' });
    expect(saved.panel.cheap.map((s: any) => [s.runtime, s.model, s.effort])).toEqual([['claude-code', 'claude-sonnet-5-5', 'low'], ['codex', 'gpt-6-luna', 'low']]);
    expect(saved.seats).toEqual(['strong', 'cheap-claude', 'cheap-codex', 'lens-contracts', 'lens-integrity']);
    expect(saved.panel.lenses.map((s: any) => [s.lens, s.model, s.effort, s.shadow])).toEqual([['contracts', 'claude-haiku-5-5', 'medium', true], ['integrity', 'claude-haiku-5-5', 'medium', true]]);

    // Five cheap seats are not allowed: the button stops at four, and the server refuses a fifth with a reason. The lens seats go first, to stay under six seats.
    await box.getByRole('button', { name: 'remove lens seat 2' }).click();
    await box.getByRole('button', { name: 'remove lens seat 1' }).click();
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
    await expect(box.getByTestId('review-panel-seat')).toHaveCount(4);
    expect((await panel()).is_default).toBe(true);

    // Reset also throws away an edit that was never saved, when the server already holds the default.
    await box.getByLabel('strong seat model').selectOption('gpt-6-luna');
    await box.getByRole('button', { name: 'Add a cheap seat' }).click();
    await expect(box.getByTestId('review-panel-seat')).toHaveCount(5);
    await expect(box.getByRole('button', { name: 'Save panel' })).toBeEnabled();
    await box.getByRole('button', { name: 'Reset to default' }).click();
    await expect(box.getByTestId('review-panel-seat')).toHaveCount(4);
    await expect(box.getByLabel('strong seat model')).toHaveValue('gpt-6.1-sol');
    await expect(box.getByRole('button', { name: 'Save panel' })).toBeDisabled();
  } finally {
    await clientFetch(`${BASE}/api/review-panel/reset`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    await report(unlisted);
  }
});

test('the Models page repeats the strong seat, names the members, and stops at six seats in total', async ({ page, consoleErrors }) => {
  await report({ 'claude-code': claude, codex });
  try {
    await openLive(page, 'models');
    const box = page.getByTestId('review-panel');
    await expect(box.getByLabel('strong seat count')).toHaveValue('1');
    await expect(box.getByTestId('review-panel-members')).toContainText('The strong seat runs once.');
    await expect(box.getByTestId('review-panel-members')).toContainText('The panel starts 4 of at most 6 seats.');

    // Two members: the names are strong and strong-2, and the panel on the server has the count.
    await box.getByLabel('strong seat count').selectOption('2');
    await expect(box.getByTestId('review-panel-members')).toContainText('The strong seat runs 2 times, as strong, strong-2.');
    await expect(box.getByTestId('review-panel-members')).toContainText('The panel starts 5 of at most 6 seats.');
    await box.getByRole('button', { name: 'Save panel' }).click();
    await expect(box).toHaveAttribute('data-default', 'false');
    const saved = await panel();
    expect(saved.panel.strong).toEqual({ runtime: 'codex', model: 'gpt-6.1-sol', effort: 'high', count: 2 });
    expect(saved.seats).toEqual(['strong', 'strong-2', 'cheap-claude', 'lens-contracts', 'lens-integrity']);
    expect(saved.max_strong_count).toBe(4);
    expect(saved.max_panel_seats).toBe(6);

    // Changing the runtime, the model or the effort of the strong seat keeps the count.
    await box.getByLabel('strong seat runtime').selectOption('claude-code');
    await expect(box.getByLabel('strong seat count')).toHaveValue('2');
    await box.getByLabel('strong seat model').selectOption('claude-opus-5-5');
    await box.getByLabel('strong seat effort').selectOption('max');
    await expect(box.getByLabel('strong seat count')).toHaveValue('2');
    await box.getByLabel('strong seat runtime').selectOption('codex');
    await box.getByLabel('strong seat model').selectOption('gpt-6.1-sol');
    await box.getByLabel('strong seat effort').selectOption('high');
    await expect(box.getByLabel('strong seat count')).toHaveValue('2');
    await expect(box.getByRole('button', { name: 'Save panel' })).toBeDisabled();

    // One cheap seat more makes six seats: the count cannot go up and no cheap or lens seat can be added.
    await box.getByRole('button', { name: 'Add a cheap seat' }).click();
    await expect(box.getByTestId('review-panel-members')).toContainText('The panel starts 6 of at most 6 seats.');
    await expect(box.getByRole('button', { name: 'Add a cheap seat' })).toBeDisabled();
    await expect(box.getByRole('button', { name: 'Add a lens seat' })).toBeDisabled();
    // The added cheap seat is a copy of the first one: it would be dropped as a repeat, and the estimate says so.
    await expect(box.getByTestId('review-panel-expected')).toContainText('1 seat(s) repeat an earlier seat of the same kind and lens and do not run');
    // Playwright does not report an <option> as disabled, so the attribute is read.
    const option = (n: number) => box.getByLabel('strong seat count').locator(`option[value="${n}"]`);
    await expect(option(3)).toHaveAttribute('disabled', '');
    await expect(option(4)).toHaveAttribute('disabled', '');
    await expect(option(2)).not.toHaveAttribute('disabled');
    await expect(option(1)).not.toHaveAttribute('disabled');

    // The server holds the same bounds: a count of 3 with four cheap seats, and a count of 5, are refused with a reason.
    const strong = { runtime: 'codex', model: 'gpt-6.1-sol', effort: 'high' };
    const cheap = Array(4).fill({ runtime: 'claude-code', model: 'claude-sonnet-5-5', effort: 'low' });
    const over = await put('/api/review-panel', { strong: { ...strong, count: 3 }, cheap });
    expect(over.status).toBe(400);
    expect((await over.json()).message).toMatch(/at most 6 seats in total/);
    const five = await put('/api/review-panel', { strong: { ...strong, count: 5 }, cheap: [] });
    expect(five.status).toBe(400);
    expect((await five.json()).message).toMatch(/count must be a whole number from 1 to 4/);
    expect(consoleErrors.splice(0).every((e) => /status of 400/.test(e))).toBe(true);
    expect((await panel()).panel.strong.count).toBe(2);

    // Back to one member: the count leaves the saved panel, and Save is enabled only for the cheap seats added above.
    await box.getByLabel('strong seat count').selectOption('1');
    await expect(box.getByTestId('review-panel-members')).toContainText('The strong seat runs once.');
    await box.getByRole('button', { name: 'Reset to default' }).click();
    await expect(box).toHaveAttribute('data-default', 'true');
    await expect(box.getByLabel('strong seat count')).toHaveValue('1');
    expect((await panel()).panel.strong.count).toBeUndefined();
  } finally {
    await clientFetch(`${BASE}/api/review-panel/reset`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    await report(unlisted);
  }
});

test('the Models page adds, edits and removes lens seats and their shadow flag, and the server checks them', async ({ page, consoleErrors }) => {
  await report({ 'claude-code': claude, codex });
  try {
    await openLive(page, 'models');
    const box = page.getByTestId('review-panel');
    // Remove the contracts lens; a new lens seat takes the first lens not in the panel, on the default lens model, in shadow mode.
    await box.getByRole('button', { name: 'remove lens seat 1' }).click();
    await expect(box.getByTestId('review-panel-seat')).toHaveCount(3);
    await expect(box.getByLabel('lens seat 1 lens')).toHaveValue('integrity');
    await box.getByRole('button', { name: 'Add a lens seat' }).click();
    await expect(box.getByLabel('lens seat 2 lens')).toHaveValue('contracts');
    await expect(box.getByLabel('lens seat 2 model')).toHaveValue('claude-haiku-5-5');
    await expect(box.getByLabel('lens seat 2 shadow')).toBeChecked();
    // Edit: integrity leaves shadow mode, contracts moves to Sonnet low, then a third seat is a second contracts lens.
    await box.getByLabel('lens seat 1 shadow').uncheck();
    await box.getByLabel('lens seat 2 model').selectOption('claude-sonnet-5-5');
    await box.getByLabel('lens seat 2 effort').selectOption('low');
    await box.getByRole('button', { name: 'Add a lens seat' }).click();
    await box.getByLabel('lens seat 3 lens').selectOption('contracts');
    await box.getByRole('button', { name: 'Save panel' }).click();
    await expect(box).toHaveAttribute('data-default', 'false');
    const saved = await panel();
    expect(saved.panel.lenses.map((s: any) => [s.lens, s.runtime, s.model, s.effort, s.shadow])).toEqual([
      ['integrity', 'claude-code', 'claude-haiku-5-5', 'medium', false],
      ['contracts', 'claude-code', 'claude-sonnet-5-5', 'low', true],
      ['contracts', 'claude-code', 'claude-haiku-5-5', 'medium', true],
    ]);
    expect(saved.seats).toEqual(['strong', 'cheap-claude', 'lens-integrity', 'lens-contracts', 'lens-contracts-2']);
    // The page reads the saved panel back as it was saved.
    await page.reload();
    await expect(box.getByLabel('lens seat 1 shadow')).not.toBeChecked();
    await expect(box.getByLabel('lens seat 3 lens')).toHaveValue('contracts');

    // The server refuses a lens it does not know and a shadow flag that is not a boolean, with a reason, and keeps the saved panel.
    const strong = { runtime: 'codex', model: 'gpt-6.1-sol', effort: 'high' };
    const lens = { runtime: 'claude-code', model: 'claude-haiku-5-5', effort: 'medium' };
    const unknown = await put('/api/review-panel', { strong, cheap: [], lenses: [{ ...lens, lens: 'security', shadow: true }] });
    expect(unknown.status).toBe(400);
    expect((await unknown.json()).message).toMatch(/the lens must be contracts or integrity/);
    const flag = await put('/api/review-panel', { strong, cheap: [], lenses: [{ ...lens, lens: 'contracts', shadow: 'yes' }] });
    expect(flag.status).toBe(400);
    expect((await flag.json()).message).toMatch(/shadow must be true or false/);
    expect(consoleErrors.splice(0).every((e) => /status of 400/.test(e))).toBe(true);
    expect((await panel()).panel.lenses).toHaveLength(3);
    // The panel route is the Client's: the runner key does not open it.
    const asRunner = await fetch(`${BASE}/api/review-panel`, { method: 'PUT', headers: { authorization: `Bearer ${RUNNER_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ strong, cheap: [] }) });
    expect(asRunner.status).toBe(401);

    // All lens seats removed: the saved panel has none and runs none.
    for (let i = 3; i >= 1; i--) await box.getByRole('button', { name: `remove lens seat ${i}` }).click();
    await box.getByRole('button', { name: 'Save panel' }).click();
    await expect.poll(async () => (await panel()).seats).toEqual(['strong', 'cheap-claude']);
    expect(consoleErrors).toEqual([]);
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
  const finishSeats = async (strongFindings: object[], strongResolved?: object[]) => {
    for (let i = 0; i < 20; i++) {
      const { launch } = await (await runnerPost('/api/runner/next', {})).json();
      if (!launch) break;
      if (launch.kind !== 'code_review') {
        await runnerPost(`/api/runner/${launch.id}/done`, { result: 'ok: started' });
        continue;
      }
      const strong = launch.model === 'gpt-6.1-sol';
      const findings = strong ? strongFindings : [];
      // Both lens seats (Haiku) report the same P1 on another line: a shadow finding, shown and never blocking.
      const lens = launch.model === 'claude-haiku-5-5';
      const stdout = lens
        ? JSON.stringify({ type: 'result', is_error: false, structured_output: { findings: [{ severity: 'P1', title: "A retry makes a new id the page never follows", body: "The page keeps the old id.", sites: [{ file: "src/retry.ts", line: 40 }] }] }, usage: { input_tokens: 3000, output_tokens: 100 }, total_cost_usd: 0.001 })
        : launch.runtime === 'codex'
          ? [JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ findings, ...(strong && strongResolved ? { resolved: strongResolved } : {}) }) } }), JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 460000, cached_input_tokens: 400000, output_tokens: 2500 } })].join('\n')
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
    expect(first.seats.map((s: any) => [s.seat, s.model, s.effort, s.lens, s.shadow])).toEqual([
      ['strong', 'gpt-6.1-sol', 'high', null, false],
      ['cheap-claude', 'claude-sonnet-5-5', 'low', null, false],
      ['lens-contracts', 'claude-haiku-5-5', 'medium', 'contracts', true],
      ['lens-integrity', 'claude-haiku-5-5', 'medium', 'integrity', true],
    ]);
    // Besides the crash, the strong seat writes a P3 whose only site is outside the worktree (it keeps no site) and an entry with no title (rejected).
    await finishSeats([
      { severity: 'P1', title: `Crash on empty input ${evil}`, body: `Reads items[0] on an empty list.\n${evil}`, sites: [{ file: 'src/a.ts', line: 10 }] },
      { severity: 'P3', title: 'Reads a file above the root', body: 'Opens a parent path.', sites: [{ file: '../outside.ts', line: 1 }] },
      { severity: 'P2', body: 'An entry without a title.' },
    ]);
    await senior.waitFor('code_review.finished');

    await openLive(page, `jobs/${a}`);
    const rounds = page.getByTestId('local-review');
    await expect(rounds).toHaveCount(1);
    const r1 = rounds.first();
    await expect(r1).toHaveAttribute('data-verdict', 'changes');
    await expect(r1).toContainText('Round 1');
    await expect(r1).toContainText(`${sha('1').slice(0, 8)}..${sha('2').slice(0, 8)}`);
    await expect(r1.getByTestId('review-seat')).toHaveCount(4);
    const strong = r1.locator('[data-testid=review-seat][data-seat=strong]');
    await expect(strong.getByTestId('seat-lens')).toHaveText('generalist');
    await expect(r1.locator('[data-testid=review-seat][data-seat=lens-integrity] [data-testid=seat-lens]')).toHaveText('integrity, shadow');
    // The shadow finding is shown, marked, and does not block; the verdict is changes only for the crash.
    const shadowFinding = r1.locator('[data-testid=review-finding][data-shadow=true]');
    await expect(shadowFinding).toHaveCount(1);
    await expect(shadowFinding).toHaveAttribute('data-blocking', 'false');
    await expect(shadowFinding.getByTestId('finding-shadow')).toHaveText('Shadow, never blocks:');
    await expect(shadowFinding.locator('[data-testid=finding-source][data-seat=lens-contracts]')).toContainText('(contracts lens, shadow)');
    await expect(strong).toContainText('codex');
    await expect(strong).toContainText('gpt-6.1-sol');
    await expect(strong).toContainText('high');
    await expect(strong).toContainText('71 s');
    await expect(strong).toContainText('460.0k / 400.0k / 2.5k');
    // Most Clients run on a subscription, so the job page shows no dollar cost.
    await expect(r1).not.toContainText('$');
    await expect(r1.locator('[data-testid=review-seat][data-seat=cheap-claude]')).toContainText('claude');
    // The seat table shows what the panel asked for next to what ran, and each seat's rejected and no-site counts.
    await expect(strong.getByTestId('seat-requested')).toHaveText('codex gpt-6.1-sol high');
    await expect(strong.getByTestId('seat-rejected')).toHaveText('1');
    await expect(strong.getByTestId('seat-zero-site')).toHaveText('1');
    await expect(r1.locator('[data-testid=review-seat][data-seat=cheap-claude] [data-testid=seat-rejected]')).toHaveText('0');
    // Output that could not all be used gets a warning with the per-seat counts and the findings that kept no site.
    const warn = r1.getByTestId('review-incomplete');
    await expect(warn).toContainText('Some reviewer output could not be used. This round may be missing findings.');
    await expect(warn.getByTestId('incomplete-seat')).toHaveText(['strong: 1 entry rejected by the parser, 1 finding with no valid site']);
    await expect(warn.getByTestId('zero-site-finding')).toHaveText(['strong #1 P3 Reads a file above the root']);
    // Never described as complete or verified.
    await expect(page.getByTestId('code-reviews')).not.toContainText(/complete|verified/i);
    await expect(r1.getByTestId('review-finding')).toHaveCount(3);
    // Merged finding: severity, reviewers, sites and triage state. The two seats reported the same crash.
    const f = r1.locator('[data-testid=review-finding][data-severity=P1][data-shadow=false]');
    await expect(f).toHaveAttribute('data-blocking', 'true');
    await expect(f).toContainText('2 reviewers (strong, cheap-claude)');
    await expect(f).toContainText('src/a.ts:10');
    await expect(f).toContainText('Not triaged');
    // Each seat's own report stays readable behind the merged finding: its title, body and sites.
    await f.getByTestId('finding-sources').locator('summary').click();
    const sources = f.getByTestId('finding-source');
    await expect(sources).toHaveCount(2);
    await expect(f.locator('[data-testid=finding-source][data-seat=strong]')).toContainText('Reads items[0] on an empty list.');
    await expect(f.locator('[data-testid=finding-source][data-seat=strong]')).toContainText('src/a.ts:10');
    await expect(f.locator('[data-testid=finding-source][data-seat=cheap-claude]')).toContainText('The same crash, seen by the cheap seat.');
    await expect(f.locator('[data-testid=finding-source][data-seat=cheap-claude]')).toContainText('src/a.ts:12');
    // Reviewer text is plain: the tag and the link are text, never elements, and nothing ran.
    await expect(f).toContainText('<img src=x onerror=');
    await expect(f).toContainText('[click](https://evil.example/x)');
    await expect(page.getByTestId('code-reviews').locator('img, a, script')).toHaveCount(0);
    expect(await page.title()).not.toBe('pwned');

    // Answer it, then a second round on the fix delta runs with a one-seat panel, so one family covers every seat.
    const review = await senior.call('get_code_review', { review_id: first.review_id });
    // The lens seats' P1 is a shadow finding with the same severity and seat count: pick the blocking one.
    const crash = review.findings.find((x: any) => x.severity === 'P1' && !x.shadow);
    await senior.call('answer_finding', { review_id: first.review_id, finding_id: crash.finding_id, triage: 'valid', reason: 'Fixed in the next commit.' });
    expect((await put('/api/review-panel', { strong: { runtime: 'codex', model: 'gpt-6.1-sol', effort: 'high' }, cheap: [] })).status).toBe(200);
    const second = await senior.call('request_code_review', { worktree: '/tmp/e2e-repo', base_sha: sha('2'), head_sha: sha('3') });
    expect(second.seats.map((s: any) => s.seat)).toEqual(['strong']);
    // The reviewer cannot settle the crash, and also answers an id it was not asked about, which is dropped and counted.
    await finishSeats([], [{ id: crash.finding_id, status: 'unknown' }, { id: 'fnd_not_asked', status: 'fixed' }]);
    await senior.waitFor('code_review.finished');
    await expect(rounds).toHaveCount(2);
    const r2 = rounds.nth(1);
    await expect(r2).toHaveAttribute('data-verdict', 'ok');
    await expect(r2).toContainText('Round 2');
    await expect(r2.getByTestId('same-family')).toContainText('One family (codex) covers every seat');
    await expect(r1.getByTestId('same-family')).toHaveCount(0);
    await expect(r1.locator('[data-testid=review-finding][data-severity=P1][data-shadow=false]')).toContainText('Triage: valid. Fixed in the next commit.');
    const item = r2.getByTestId('review-resolved-item');
    await expect(item).toHaveAttribute('data-status', 'unknown');
    await expect(item).toContainText(': unknown');
    await expect(item).toContainText('unknown to strong');
    await expect(r2.getByTestId('resolved-dropped')).toContainText('strong 1');

    // The Copilot round the server counted (a made-up PR number: the throwaway stack never talks to GitHub).
    await senior.call('request_copilot_review', { assignment_id: asg.id, attempt: asg.attempt, pr: 77, head_sha: sha('3') });
    await senior.call('record_copilot_result', { assignment_id: asg.id, attempt: asg.attempt, pr: 77, round: 1, approval_recommended: false, findings: { P0: 0, P1: 1, P2: 2, P3: 3 }, previously_missed: 1 });
    // Copilot rounds raise no dashboard event, so the page shows them on the next refresh.
    await page.reload();
    const c = page.getByTestId('copilot-round');
    await expect(c).toHaveCount(1);
    await expect(c.locator('td')).toHaveText(['#77', '1', sha('3').slice(0, 8), 'no', '0', '1', '2', '3', '1']);

    // The Reviews page lists the job with counts, and its rounds read as a short conversation in plain text.
    await page.goto(`/#/reviews/${a}`);
    const row = page.locator(`[data-testid=reviews-row][data-job-id="${a}"]`);
    await expect(row).toHaveAttribute('data-disputed', '0');
    await expect(row.locator('td').nth(2)).toHaveText('2');
    await expect(row.locator('td').nth(3)).toHaveText('ok');
    await expect(row.locator('td').nth(4)).toHaveText('3 · 1 accepted · 1 shadow');
    await expect(row.locator('td').nth(5)).toHaveText('1');
    const rr = page.getByTestId('review-rounds');
    await expect(rr.getByTestId('review-round')).toHaveCount(2);
    await expect(rr.getByTestId('round-finding')).toHaveCount(3);
    await expect(rr.locator('[data-testid=round-finding][data-shadow=true]')).toContainText('Only shadow seats reported it, so it never blocks and needs no answer.');
    const rf = rr.getByTestId('round-finding').filter({ hasText: 'P1 Crash on empty input' });
    await expect(rf).toHaveAttribute('data-disputed', 'false');
    await expect(rf).toContainText('P1 Crash on empty input <img src=x onerror=');
    await expect(rf).toContainText('accepted it: Fixed in the next commit.');
    await expect(rr.getByTestId('review-round').nth(1)).toContainText('The reviewers found nothing to change.');
    await expect(rr.getByTestId('review-copilot-round')).toContainText('Copilot round 1 on PR #77');
    await expect(rr.locator('img, script')).toHaveCount(0);
    await expect(rr.locator('a', { hasText: 'click' })).toHaveCount(0);
    // A click on the row folds the rounds away.
    await row.click();
    await expect(rr).toHaveCount(0);
    expect(await page.title()).not.toBe('pwned');
    // The Models page now has finished runs to average: the default panel is the Codex strong seat (460.0k in, 2.5k out per run), the Claude cheap seat (9.0k in, 400 out) and two Haiku lens seats (3.0k in, 100 out each).
    // The panel is the default again (the one-seat panel saved above is the Client's to keep or not; this page reads what is saved).
    await clientFetch(`${BASE}/api/review-panel/reset`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    await openLive(page, 'models');
    const expected = page.getByTestId('review-panel-expected');
    await expect(expected).toContainText('about 475.0k input tokens and 3.1k output tokens');
    await expect(expected).toHaveAttribute('data-unknown', '0');
    // A repeat member counts again: three strong members, the cheap seat and the two lens seats.
    await page.getByLabel('strong seat count').selectOption('3');
    await expect(expected).toContainText('about 1.4M input tokens');
    // A model with no finished run is left out and said so.
    await page.getByLabel('cheap seat 1 runtime').selectOption('codex');
    await page.getByLabel('cheap seat 1 model').fill('gpt-6-luna');
    await expect(expected).toContainText('1 of 6 seats have no finished run yet');
    expect(consoleErrors).toEqual([]);
  } finally {
    await clientFetch(`${BASE}/api/review-panel/reset`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    await cleanup(parentId);
  }
});
