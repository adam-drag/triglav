import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { authenticate, registerAgent } from '../src/agents.ts';
import { configOf, DEFAULT_PANEL, jobReviewsView, loadPanelConfig, panelSeats, recordReviewOutput, requestCodeReview, reviewsOverview, StoredPanel } from '../src/code-review.ts';
import { exec, parseJson, query, queryOne } from '../src/db.ts';
import { STAFF_WAKE_TYPES } from '../src/events.ts';
import { createSpawnTicket, registerJob, updateJob } from '../src/jobs.ts';
import { recordHostRuntimes, type Detected } from '../src/models.ts';
import { recordCopilotResult, requestCopilotReview } from '../src/review-gate.ts';
import { resetReviewPanel, reviewPanelView, setReviewPanel, validatePanel } from '../src/review-panel.ts';
import { buildServer } from '../src/server.ts';
import { nextLaunch } from '../src/telemetry.ts';
import { asClient, createTestCtx, issue, loginCookie, passGate, TEST_DB_URL, TEST_ENROLLMENT_KEY, TEST_RUNNER_KEY, testServerKeys } from './helpers.ts';

const seat = (runtime: string, model: string, effort: string) => ({ runtime, model, effort });
const det = (o: Partial<Detected> = {}): Detected => ({
  known: true,
  checked_at: new Date(),
  runtimes: [
    { runtime: 'codex', label: 'Codex', available: true, version: '1', models: [{ id: 'gpt-6.1-sol', label: 'S', efforts: ['low', 'high'] }, { id: 'gpt-6-luna', label: 'L', efforts: ['low'] }] },
    { runtime: 'claude-code', label: 'Claude Code', available: true, version: '2', models: [{ id: 'claude-sonnet-5-5', label: 'S', efforts: ['low', 'high'] }] },
  ],
  ...o,
});
const good = { strong: seat('codex', 'gpt-6.1-sol', 'high'), cheap: [seat('claude-code', 'claude-sonnet-5-5', 'low'), seat('codex', 'gpt-6-luna', 'low')] };

describe('review panel: seats and validation (no database)', () => {
  it('names the default panel the way the default seats are named, and keeps names unique', () => {
    expect(panelSeats(configOf(DEFAULT_PANEL))).toEqual(DEFAULT_PANEL);
    const many = panelSeats({ strong: good.strong, cheap: [seat('codex', 'gpt-6-luna', 'low'), seat('codex', 'gpt-6-luna', 'high'), seat('claude-code', 'a', 'low'), seat('codex', 'b', 'low')] } as any);
    expect(many.map((s) => s.seat)).toEqual(['strong', 'cheap-codex', 'cheap-codex-2', 'cheap-claude', 'cheap-codex-3']);
    expect(new Set(many.map((s) => s.seat)).size).toBe(many.length);
  });

  it('accepts a panel that the runner lists, with no cheap seat at all, and up to four', () => {
    expect(validatePanel(det(), good)).toEqual(good);
    expect(validatePanel(det(), { strong: good.strong, cheap: [] }).cheap).toEqual([]);
    expect(validatePanel(det(), { strong: good.strong, cheap: Array(4).fill(good.cheap[0]) }).cheap).toHaveLength(4);
  });

  it.each([
    ['no strong seat', { cheap: [] }, /one strong seat/],
    ['no cheap list', { strong: good.strong }, /list of seats/],
    ['five cheap seats', { strong: good.strong, cheap: Array(5).fill(good.cheap[0]) }, /at most 4 cheap seats, not 5/],
    ['an unknown runtime', { strong: seat('gemini', 'gpt-6.1-sol', 'high'), cheap: [] }, /Strong seat: the runtime must be claude-code or codex, not "gemini"/],
    ['a model the CLI does not list', { strong: good.strong, cheap: [seat('codex', 'gpt-9', 'low')] }, /Cheap seat 1: Codex does not offer the model "gpt-9".*gpt-6.1-sol, gpt-6-luna/],
    ['an effort the model does not accept', { strong: seat('codex', 'gpt-6-luna', 'high'), cheap: [] }, /Strong seat: .*does not accept the effort "high"/],
    ['a model with shell characters', { strong: seat('codex', 'x; rm -rf', 'high'), cheap: [] }, /model may only contain/],
    ['a seat that is not an object', { strong: 'codex', cheap: [] }, /must have a runtime/],
    ['an empty effort', { strong: seat('codex', 'gpt-6.1-sol', ''), cheap: [] }, /effort is required/],
    ['an effort the saved panel could not read back', { strong: seat('codex', 'gpt-6.1-sol', 'e'.repeat(21)), cheap: [] }, /effort is required \(at most 20 characters\)/],
    ['a model longer than the saved panel allows', { strong: seat('codex', 'm'.repeat(101), 'high'), cheap: [] }, /model is required \(at most 100 characters\)/],
  ])('refuses %s with a reason', (_n, input, reason) => {
    expect(() => validatePanel(det(), input)).toThrow(reason);
  });

  it('refuses a CLI that is known to be missing, and checks nothing when no list is known', () => {
    const missing = det({ runtimes: [{ runtime: 'codex', label: 'Codex', available: false, version: null, models: [] }, det().runtimes[1]!] });
    expect(() => validatePanel(missing, good)).toThrow(/Codex was not found on this machine/);
    // A stale or missing report changes nothing: any safe name passes, as it does for a role.
    expect(validatePanel(det({ known: false }), { strong: seat('codex', 'gpt-9', 'xhigh'), cheap: [] }).strong.model).toBe('gpt-9');
    const noList = det({ runtimes: det().runtimes.map((r) => ({ ...r, models: [] })) });
    expect(validatePanel(noList, { strong: seat('codex', 'gpt-9', 'xhigh'), cheap: [] }).strong.effort).toBe('xhigh');
    // What validatePanel accepts is what loadPanelConfig reads back, at the longest allowed values.
    const longest = { strong: seat('codex', 'm'.repeat(100), 'e'.repeat(20)), cheap: [] };
    expect(StoredPanel.safeParse(validatePanel(det({ known: false }), longest)).success).toBe(true);
  });
});

describe.skipIf(!TEST_DB_URL)('review panel: saved setting', () => {
  let env: Awaited<ReturnType<typeof createTestCtx>>;
  let n = 0;
  beforeAll(async () => {
    env = await createTestCtx();
  });
  afterAll(async () => {
    await env?.close();
  });
  beforeEach(async () => {
    const models = [{ id: 'gpt-6.1-sol', label: 's', efforts: ['low', 'high'] }, { id: 'gpt-6-luna', label: 'l', efforts: ['low'] }, { id: 'claude-sonnet-5-5', label: 'S', efforts: ['low', 'high'] }, { id: 'claude-opus-5-5', label: 'O', efforts: ['high'] }];
    await recordHostRuntimes(env.ctx, { codex: { version: '1', models }, 'claude-code': { version: '2', models } });
    await exec(env.ctx.pool, `DELETE FROM settings WHERE name = 'review_panel'`);
    await exec(env.ctx.pool, `UPDATE code_reviews SET status = 'failed' WHERE status = 'running'`);
    await exec(env.ctx.pool, `UPDATE launches SET finished_at = NOW(3), result = 'x' WHERE finished_at IS NULL`);
    await exec(env.ctx.pool, `UPDATE assignments SET status = 'open', owner_agent_id = NULL, lease_expires_at = NULL WHERE status = 'held'`);
  });

  const panelEvents = () => query(env.ctx.pool, `SELECT actor, payload FROM events WHERE type = 'review_panel.changed' ORDER BY id`);

  async function setup() {
    const staffReg = await registerAgent(env.ctx, { role: 'staff', nickname: `staff-${++n}`, runtime: 'test' });
    const staff = await authenticate(env.ctx, staffReg.session_token);
    const parent = issue(`RP-${++n}00`, 'Panel target', { children: [issue(`RP-${n}01`, 'Sub')] });
    env.linear.add(parent as any);
    const job = await registerJob(env.ctx, staff, { linearIssue: parent.identifier, repoPath: '/repo', baseBranch: 'main' });
    const [sub] = job.subjob_ids as [string];
    for (const id of [job.job_id, sub]) {
      await updateJob(env.ctx, staff, { jobId: id, status: 'planning' });
      await updateJob(env.ctx, staff, { jobId: id, acceptanceCriteria: 'Works' });
    }
    await updateJob(env.ctx, staff, { jobId: sub, status: 'ready' });
    const ticket = await createSpawnTicket(env.ctx, staff, { jobId: sub, role: 'senior', brief: 'Build it' });
    const reg = await registerAgent(env.ctx, { role: 'senior', nickname: `senior-${++n}`, runtime: 'test', spawnTicket: ticket.spawn_ticket });
    return { staff, senior: await authenticate(env.ctx, reg.session_token), jobId: sub };
  }
  const ask = (senior: Awaited<ReturnType<typeof setup>>['senior'], headSha: string) => requestCodeReview(env.ctx, senior, { worktree: '/home/dev/wt', baseSha: 'a'.repeat(40), headSha }) as Promise<any>;

  it('is the default panel until one is saved, and Reset removes the saved row', async () => {
    expect(await reviewPanelView(env.ctx)).toMatchObject({ is_default: true, panel: configOf(DEFAULT_PANEL), seats: ['strong', 'cheap-claude'], max_cheap_seats: 4 });
    const saved = await setReviewPanel(env.ctx, good);
    expect(saved).toMatchObject({ is_default: false, panel: good, seats: ['strong', 'cheap-claude', 'cheap-codex'] });
    expect(await queryOne(env.ctx.pool, `SELECT value FROM settings WHERE name = 'review_panel'`)).toBeTruthy();
    expect(await resetReviewPanel(env.ctx)).toMatchObject({ is_default: true });
    expect(await queryOne(env.ctx.pool, `SELECT value FROM settings WHERE name = 'review_panel'`)).toBeFalsy();
  });

  it('falls back to the default when the saved row cannot be read', async () => {
    await exec(env.ctx.pool, `INSERT INTO settings (name, value, updated_at) VALUES ('review_panel', '{"strong":1}', NOW(3))`);
    expect((await loadPanelConfig(env.ctx.pool)).saved).toBe(false);
    await exec(env.ctx.pool, `UPDATE settings SET value = 'not json' WHERE name = 'review_panel'`);
    expect((await loadPanelConfig(env.ctx.pool)).config).toEqual(configOf(DEFAULT_PANEL));
  });

  it('refuses an invalid panel with a reason and saves nothing', async () => {
    await expect(setReviewPanel(env.ctx, { strong: seat('codex', 'gpt-9', 'high'), cheap: [] })).rejects.toThrow(/does not offer the model "gpt-9"/);
    await expect(setReviewPanel(env.ctx, { cheap: [] })).rejects.toThrow(/strong seat/);
    await exec(env.ctx.pool, `DELETE FROM events WHERE type = 'review_panel.changed'`);
    await expect(setReviewPanel(env.ctx, { strong: seat('codex', 'gpt-9', 'high'), cheap: [] })).rejects.toThrow();
    expect(await queryOne(env.ctx.pool, `SELECT value FROM settings WHERE name = 'review_panel'`)).toBeFalsy();
    expect(await panelEvents()).toHaveLength(0);
  });

  it('emits review_panel.changed, which does not wake Staff', async () => {
    expect(STAFF_WAKE_TYPES.includes('review_panel.changed' as never)).toBe(false);
    await exec(env.ctx.pool, `DELETE FROM events WHERE type = 'review_panel.changed'`);
    await setReviewPanel(env.ctx, good);
    await resetReviewPanel(env.ctx);
    expect((await panelEvents()).map((e: any) => [e.actor, parseJson<any>(e.payload).reset ?? false])).toEqual([['client', false], ['client', true]]);
  });

  it('reads the saved panel when a review is requested, and a running review keeps its seats', async () => {
    const { senior } = await setup();
    await setReviewPanel(env.ctx, { strong: seat('claude-code', 'claude-opus-5-5', 'high'), cheap: [seat('claude-code', 'claude-sonnet-5-5', 'high'), seat('codex', 'gpt-6-luna', 'low')] });
    const first = await ask(senior, 'b'.repeat(40));
    // The Senior's runtime ("test") has no family, so the strong seat stays where the Client put it.
    expect(first.seats.map((s: any) => [s.seat, s.runtime, s.model, s.effort])).toEqual([
      ['strong', 'claude-code', 'claude-opus-5-5', 'high'],
      ['cheap-claude', 'claude-code', 'claude-sonnet-5-5', 'high'],
      ['cheap-codex', 'codex', 'gpt-6-luna', 'low'],
    ]);
    // Changing the panel while it runs does not touch the running review...
    await setReviewPanel(env.ctx, { strong: seat('codex', 'gpt-6.1-sol', 'low'), cheap: [] });
    const rows = await query(env.ctx.pool, `SELECT seat, model FROM code_review_runs WHERE review_id = ? ORDER BY seat`, [first.review_id]);
    expect(rows.map((r) => r.model).sort()).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5', 'gpt-6-luna']);
    // ...and the next request uses the new panel: just the strong seat.
    await exec(env.ctx.pool, `UPDATE code_reviews SET status = 'failed' WHERE id = ?`, [first.review_id]);
    const second = await ask(senior, 'c'.repeat(40));
    expect(second.seats.map((s: any) => [s.seat, s.runtime, s.model])).toEqual([['strong', 'codex', 'gpt-6.1-sol']]);
  });

  it('keeps the resolveSeats fallback when a saved seat cannot run where it was put', async () => {
    const { senior } = await setup();
    await setReviewPanel(env.ctx, good);
    // The runner now reports only Claude Code: the Codex seats move over and the twins are dropped.
    await recordHostRuntimes(env.ctx, { codex: null, 'claude-code': { version: '2', models: [{ id: 'claude-sonnet-5-5', label: 'S', efforts: ['low'] }, { id: 'claude-opus-5-5', label: 'O', efforts: ['high'] }] } });
    const r = await ask(senior, 'd'.repeat(40));
    expect(r.seats.map((s: any) => [s.seat, s.runtime])).toEqual([['strong', 'claude-code'], ['cheap-claude', 'claude-code']]);
    expect(r.dropped.map((d: any) => d.seat)).toEqual(['cheap-codex']);
  });

  it('shows the local rounds and the Copilot rounds of a job, in order, with the numbers the Senior and the runner reported', async () => {
    const { senior, jobId } = await setup();
    const r = await ask(senior, 'e'.repeat(40));
    for (let l: any = await nextLaunch(env.ctx); l; l = await nextLaunch(env.ctx)) {
      const row = await queryOne(env.ctx.pool, `SELECT seat, runtime FROM code_review_runs WHERE id = ?`, [l.run_id]);
      const findings = row!.seat === 'strong' ? [{ severity: 'P2', title: 'Crash <script>alert(1)</script>', body: '[link](javascript:x)', sites: [{ file: 'src/a.ts', line: 3 }] }] : [];
      const stdout = row!.runtime === 'codex'
        ? [JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ findings }) } }), JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 500, cached_input_tokens: 400, output_tokens: 30 } })].join('\n')
        : JSON.stringify({ type: 'result', is_error: false, structured_output: { findings }, usage: { input_tokens: 100, output_tokens: 10 }, total_cost_usd: 0.25 });
      await recordReviewOutput(env.ctx, l.id, { code: 0, stdout, stderr: '', secs: 7 });
    }
    const head = await passGate(env.ctx, jobId, senior.id, 'f'.repeat(40));
    await requestCopilotReview(env.ctx, senior, { assignmentId: (await queryOne(env.ctx.pool, `SELECT id FROM assignments WHERE job_id = ? AND owner_agent_id = ?`, [jobId, senior.id]))!.id as string, attempt: 1, pr: 9, headSha: head });
    const v = await jobReviewsView(env.ctx.pool, jobId);
    expect(v.local.map((x) => x.review_id)).toContain(r.review_id);
    const first = v.local.find((x) => x.review_id === r.review_id)!;
    expect(first).toMatchObject({ round: 1, status: 'done', verdict: 'changes', base_sha: 'a'.repeat(40), head_sha: 'e'.repeat(40) });
    expect(first.seats.map((s) => [s.seat, s.status, s.secs])).toEqual([['strong', 'done', 7], ['cheap-claude', 'done', 7]]);
    expect(first.seats.find((s) => s.seat === 'cheap-claude')!.tokens).toEqual({ in: 100, cached: null, out: 10, cost_usd: 0.25 });
    // Only Claude reports a cost, so the round's sum is partial.
    expect(first).toMatchObject({ cost_usd: 0.25, cost_partial: true });
    expect(first.findings).toHaveLength(1);
    // The text is stored and returned as it came: the dashboard shows it as plain text.
    expect(first.findings[0]).toMatchObject({ severity: 'P2', title: 'Crash <script>alert(1)</script>', body: '[link](javascript:x)', reviewers: ['strong'], reviewer_count: 1, triage: null });
    expect(v.copilot).toEqual([expect.objectContaining({ pr: 9, round: 1, head_sha: head, approval_recommended: null, p0: null, previously_missed: null })]);
    await recordCopilotResult(env.ctx, senior, { assignmentId: (await queryOne(env.ctx.pool, `SELECT id FROM assignments WHERE job_id = ? AND owner_agent_id = ?`, [jobId, senior.id]))!.id as string, attempt: 1, pr: 9, round: 1, approvalRecommended: true, findings: { P0: 0, P1: 1, P2: 2, P3: 3 }, previouslyMissed: 1 });
    expect((await jobReviewsView(env.ctx.pool, jobId)).copilot[0]).toMatchObject({ approval_recommended: true, p0: 0, p1: 1, p2: 2, p3: 3, previously_missed: 1 });

    // The Reviews page row has counts only, and a P2 the Senior answered invalid counts as disputed.
    const row = async () => (await reviewsOverview(env.ctx.pool)).find((x) => x.job_id === jobId)!;
    expect(await row()).toMatchObject({ local_rounds: 2, failed_reviews: 0, running: 0, last_verdict: 'ok', findings: 1, accepted: 0, disputed: 0, copilot_rounds: 1 });
    expect(await row()).not.toHaveProperty('body');
    // A DATETIME, not a string MySQL made from mixed types: a string would be read as local time in the browser.
    expect((await row()).last_at).toBeInstanceOf(Date);
    await exec(env.ctx.pool, `UPDATE code_review_findings SET triage = 'invalid', triage_reason = 'not reachable', triaged_by = ? WHERE review_id = ?`, [senior.id, r.review_id]);
    expect(await row()).toMatchObject({ findings: 1, accepted: 0, disputed: 1 });
    expect((await jobReviewsView(env.ctx.pool, jobId)).local.find((x) => x.review_id === r.review_id)!.findings[0]).toMatchObject({ triage: 'invalid', triaged_by: senior.id });
  });

  describe('routes', () => {
    it('are open to the Client session only: agent and runner keys, and no credential, are refused', async () => {
      const app = buildServer(env.ctx, { ...(await testServerKeys()), webDir: '/nonexistent' });
      const { jobId } = await setup();
      const routes: [string, string, object | undefined][] = [
        ['GET', '/api/review-panel', undefined],
        ['PUT', '/api/review-panel', good],
        ['POST', '/api/review-panel/reset', {}],
        ['GET', `/api/jobs/${jobId}/reviews`, undefined],
        ['GET', '/api/reviews', undefined],
      ];
      const call = (method: string, url: string, payload: object | undefined, headers: Record<string, string | undefined>) => app.inject({ method: method as 'GET', url, payload: payload ? JSON.stringify(payload) : undefined, headers: { 'content-type': 'application/json', ...headers } });
      for (const [method, url, payload] of routes) {
        for (const headers of [{} as Record<string, string>, { authorization: `Bearer ${TEST_ENROLLMENT_KEY}` }, { authorization: `Bearer ${TEST_RUNNER_KEY}` }]) {
          expect((await call(method, url, payload, headers)).statusCode, `${method} ${url} with ${JSON.stringify(headers)}`).toBe(401);
        }
      }
      expect(await queryOne(env.ctx.pool, `SELECT value FROM settings WHERE name = 'review_panel'`)).toBeFalsy();
      const cookie = await loginCookie(app);
      const client = asClient(app, cookie);
      expect((await client.inject({ method: 'GET', url: '/api/review-panel' })).json()).toMatchObject({ is_default: true });
      const bad = await client.inject({ method: 'PUT', url: '/api/review-panel', payload: { strong: seat('codex', 'gpt-9', 'high'), cheap: [] } });
      expect(bad.statusCode).toBe(400);
      expect(bad.json().message).toMatch(/gpt-9/);
      expect((await client.inject({ method: 'PUT', url: '/api/review-panel', payload: good })).json()).toMatchObject({ is_default: false });
      expect((await client.inject({ method: 'POST', url: '/api/review-panel/reset', payload: {} })).json()).toMatchObject({ is_default: true });
      expect((await client.inject({ method: 'GET', url: `/api/jobs/${jobId}/reviews` })).json()).toEqual({ local: [], copilot: [] });
      expect((await client.inject({ method: 'GET', url: '/api/jobs/job_nope/reviews' })).statusCode).toBe(404);
      expect(Array.isArray((await client.inject({ method: 'GET', url: '/api/reviews' })).json())).toBe(true);
      await app.close();
    });
  });
});
