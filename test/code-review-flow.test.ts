import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { authenticate, registerAgent, type Agent } from '../src/agents.ts';
import { raiseBlocker, resolveBlocker } from '../src/blockers.ts';
import { answerFinding, failReviewRun, getCodeReview, recordReviewOutput, requestCodeReview, timeoutReviewRuns } from '../src/code-review.ts';
import { exec, query, queryOne } from '../src/db.ts';
import { readEvents, STAFF_WAKE_TYPES } from '../src/events.ts';
import { createSpawnTicket, registerJob, updateJob } from '../src/jobs.ts';
import { recordHostRuntimes, setReviewMode } from '../src/models.ts';
import { gateAt, recordCopilotResult, requestCopilotReview, workState } from '../src/review-gate.ts';
import { submitReviewPackage } from '../src/reviews.ts';
import { recordCodexBudget } from '../src/research.ts';
import { buildServer } from '../src/server.ts';
import { expireStaleLaunches, nextLaunch } from '../src/telemetry.ts';
import { createTestCtx, issue, passGate, TEST_DB_URL, TEST_ENROLLMENT_KEY, TEST_RUNNER_KEY, testServerKeys } from './helpers.ts';

const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const WT = '/home/dev/wt';
const finding = (extra: object = {}) => ({ severity: 'P1', title: 'Crash on an empty list', body: 'The loop reads items[0] when the list is empty.', sites: [{ file: 'src/a.ts', line: 10 }], ...extra });
const claudeOut = (findings: object[], resolved?: unknown) => JSON.stringify({ type: 'result', is_error: false, structured_output: { findings, ...(resolved === undefined ? {} : { resolved }) }, usage: { input_tokens: 100, output_tokens: 10 }, total_cost_usd: 0.02 });
const codexOut = (findings: object[], resolved?: unknown) =>
  [JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ findings, ...(resolved === undefined ? {} : { resolved }) }) } }), JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 5000, cached_input_tokens: 4000, output_tokens: 300 } })].join('\n');

// Runs against a real MySQL: set ORCH_TEST_DATABASE_URL (see README). Skipped otherwise.
describe.skipIf(!TEST_DB_URL)('local code review', () => {
  let env: Awaited<ReturnType<typeof createTestCtx>>;
  let n = 0;
  beforeAll(async () => {
    env = await createTestCtx();
  });
  afterAll(async () => {
    await env?.close();
  });
  beforeEach(async () => {
    // Every test starts with both CLIs reported, Codex idle, and no review open.
    const models = [{ id: 'gpt-6.1-sol', label: 's', efforts: ['high'] }, { id: 'gpt-6-luna', label: 'l', efforts: ['low'] }, { id: 'claude-sonnet-5-5', label: 'S', efforts: ['low'] }, { id: 'claude-opus-5-5', label: 'O', efforts: ['high'] }];
    await recordHostRuntimes(env.ctx, { codex: { version: '1', models }, 'claude-code': { version: '2', models } });
    await exec(env.ctx.pool, `DELETE FROM codex_budget`);
    await recordCodexBudget(env.ctx.pool, { used: 10, windowMin: 300, resetsAt: new Date(env.clock.now().getTime() + 3_600_000), weekly: 5, weeklyResetsAt: null, at: env.clock.now() });
    await exec(env.ctx.pool, `UPDATE code_reviews SET status = 'failed' WHERE status = 'running'`);
    await exec(env.ctx.pool, `UPDATE launches SET finished_at = NOW(3), result = 'x' WHERE finished_at IS NULL`);
    // The Seniors of earlier tests no longer count against the cap of four.
    await exec(env.ctx.pool, `UPDATE assignments SET status = 'open', owner_agent_id = NULL, lease_expires_at = NULL WHERE status = 'held'`);
  });

  async function setup() {
    const staffReg = await registerAgent(env.ctx, { role: 'staff', nickname: `staff-${++n}`, runtime: 'test' });
    const staff = await authenticate(env.ctx, staffReg.session_token);
    const parent = issue(`CR-${++n}00`, 'Review target', { children: [issue(`CR-${n}01`, 'Sub')] });
    env.linear.add(parent as any);
    const job = await registerJob(env.ctx, staff, { linearIssue: parent.identifier, repoPath: '/repo', baseBranch: 'main' });
    const [sub] = job.subjob_ids as [string];
    for (const id of [job.job_id, sub]) {
      await updateJob(env.ctx, staff, { jobId: id, status: 'planning' });
      await updateJob(env.ctx, staff, { jobId: id, acceptanceCriteria: 'Handles an empty list' });
    }
    await updateJob(env.ctx, staff, { jobId: sub, status: 'ready' });
    const ticket = await createSpawnTicket(env.ctx, staff, { jobId: sub, role: 'senior', brief: 'Build it' });
    const reg = await registerAgent(env.ctx, { role: 'senior', nickname: `senior-${++n}`, runtime: 'test', spawnTicket: ticket.spawn_ticket });
    return { staff, senior: await authenticate(env.ctx, reg.session_token), jobId: sub };
  }
  const ask = (senior: Agent, extra: object = {}) => requestCodeReview(env.ctx, senior, { worktree: WT, baseSha: BASE, headSha: HEAD, notes: 'Handles the empty list.', ...extra }) as Promise<any>;

  /** The runner takes every queued launch of a review and posts an output for each seat. */
  async function runSeats(outputs: Record<string, { code?: number; stdout: string; stderr?: string; ranges?: unknown; rules?: unknown }>) {
    const seen: any[] = [];
    for (;;) {
      const l: any = await nextLaunch(env.ctx);
      if (!l) break;
      expect(l.kind).toBe('code_review');
      seen.push(l);
      const row = await queryOne(env.ctx.pool, `SELECT seat FROM code_review_runs WHERE id = ?`, [l.run_id]);
      const o = outputs[row!.seat as string] ?? { stdout: '' };
      await recordReviewOutput(env.ctx, l.id, { code: o.code ?? 0, stdout: o.stdout, stderr: o.stderr ?? '', secs: 12, ranges: o.ranges, rules: o.rules });
    }
    return seen;
  }

  it('queues one launch per seat with the shas and a server-built prompt, and never a command', async () => {
    const { senior } = await setup();
    const r = await ask(senior);
    expect(r).toMatchObject({ status: 'running', round: 1, same_family: false });
    expect(r.seats.map((s: any) => [s.seat, s.runtime, s.model, s.effort])).toEqual([
      ['strong', 'codex', 'gpt-6.1-sol', 'high'],
      ['cheap-claude', 'claude-code', 'claude-sonnet-5-5', 'low'],
    ]);
    const launch: any = await nextLaunch(env.ctx);
    expect(Object.keys(launch).sort()).toEqual(['answers_resolved', 'base_branch', 'base_sha', 'cwd', 'effort', 'expect_ancestor', 'expect_merge_base', 'head_sha', 'id', 'kind', 'model', 'prompt', 'run_id', 'runtime', 'seat']);
    expect(launch.seat).toMatch(/^(strong|cheap-claude)$/);
    // The three launches share one timestamp, so which one the runner takes first is not fixed.
    expect(launch).toMatchObject({ kind: 'code_review', cwd: WT, base_sha: BASE, head_sha: HEAD });
    expect(['codex', 'claude-code']).toContain(launch.runtime);
    expect(launch.prompt).toContain('Handles an empty list');
    expect(launch.prompt).toContain('Handles the empty list.');
    expect(launch.prompt).toContain('Ticket CR-');
    expect((await queryOne(env.ctx.pool, `SELECT status FROM code_review_runs WHERE id = ?`, [launch.run_id]))?.status).toBe('running');
  });

  it('merges the findings of the seats, tells only the Senior, and keeps Staff asleep', async () => {
    const { staff, senior, jobId } = await setup();
    const before = (await queryOne(env.ctx.pool, `SELECT COALESCE(MAX(id), 0) AS id FROM events`))!.id as number;
    const r = await ask(senior);
    await runSeats({
      strong: { stdout: codexOut([finding(), finding({ severity: 'P3', title: 'Typo in a comment', body: 'Misspelled.', sites: [{ file: 'src/b.ts', line: 3 }] })]) },
      'cheap-claude': { stdout: claudeOut([finding({ severity: 'P2', title: 'Crash on empty list', body: 'items[0] is read when the list is empty.' })]) },
    });
    const review = (await getCodeReview(env.ctx, senior, r.review_id)) as any;
    expect(review).toMatchObject({ status: 'done', verdict: 'changes', same_family: false, round: 1 });
    expect(review.findings.map((f: any) => [f.severity, f.reviewer_count, f.reviewers])).toEqual([['P1', 2, ['strong', 'cheap-claude']], ['P3', 1, ['strong']]]);
    expect(review.seats.map((s: any) => [s.seat, s.status, s.family])).toEqual([['strong', 'done', 'codex'], ['cheap-claude', 'done', 'claude']]);
    expect(review.seats[0].tokens).toEqual({ in: 5000, cached: 4000, out: 300, cost_usd: null });
    expect(review.seats[1].tokens.cost_usd).toBe(0.02);
    expect(review.blocking).toHaveLength(1);

    const mine = (await readEvents(env.ctx.pool, senior.id, { cursor: before, scope: 'owned' })).events.filter((e) => e.type === 'code_review.finished');
    expect(mine).toHaveLength(1);
    expect(mine[0]!.payload).toMatchObject({ review_id: r.review_id, job_id: jobId, verdict: 'changes', status: 'done', findings: { P1: 1, P3: 1 } });
    const staffs = (await readEvents(env.ctx.pool, staff.id, { cursor: before, scope: 'owned' })).events;
    expect(staffs.some((e) => e.type === 'code_review.finished')).toBe(false);
    expect(STAFF_WAKE_TYPES).not.toContain('code_review.finished');
    const every = (await readEvents(env.ctx.pool, staff.id, { cursor: before, scope: 'owned', types: [...STAFF_WAKE_TYPES] })).events;
    expect(every.some((e) => e.type === 'code_review.finished')).toBe(false);
  });

  it('keeps each raw report behind a merged finding, the requested model per seat, and shows incomplete output', async () => {
    const { senior } = await setup();
    const r = await ask(senior);
    await runSeats({
      // A finding with only invalid sites keeps no site; an entry without a title is rejected by the parser.
      strong: { stdout: codexOut([finding(), finding({ severity: 'P2', title: 'Reads outside the worktree', body: 'Opens a path above the root.', sites: [{ file: '../../etc/x', line: 1 }] }), { severity: 'P2', body: 'no title' }]) },
      'cheap-claude': { stdout: claudeOut([finding({ severity: 'P2', title: 'Crash on empty list', body: 'items[0] is read when the list is empty.', sites: [{ file: 'src/a.ts', line: 12 }] })]) },
    });
    const review = (await getCodeReview(env.ctx, senior, r.review_id)) as any;
    const runIds = Object.fromEntries((await query(env.ctx.pool, `SELECT id, seat FROM code_review_runs WHERE review_id = ?`, [r.review_id])).map((x) => [x.seat, x.id]));
    const crash = review.findings.find((f: any) => f.severity === 'P1');
    // The merged finding has the lead's text; each source keeps its own seat, index, severity, text and sites.
    expect(crash.sources).toEqual([
      { run_id: runIds.strong, seat: 'strong', index: 0, severity: 'P1', title: 'Crash on an empty list', body: 'The loop reads items[0] when the list is empty.', sites: [{ file: 'src/a.ts', line: 10 }] },
      { run_id: runIds['cheap-claude'], seat: 'cheap-claude', index: 0, severity: 'P2', title: 'Crash on empty list', body: 'items[0] is read when the list is empty.', sites: [{ file: 'src/a.ts', line: 12 }] },
    ]);
    expect(crash.omitted_sites).toBe(0);
    // The seats show what the panel asked for next to what ran, and their own rejected and zero-site counts.
    expect(review.seats.map((s: any) => [s.seat, s.requested, s.model, s.rejected, s.zero_site])).toEqual([
      ['strong', { runtime: 'codex', model: 'gpt-6.1-sol', effort: 'high' }, 'gpt-6.1-sol', 1, 1],
      ['cheap-claude', { runtime: 'claude-code', model: 'claude-sonnet-5-5', effort: 'low' }, 'claude-sonnet-5-5', 0, 0],
    ]);
    expect(review.incomplete).toEqual({ seats: [{ seat: 'strong', rejected: 1, zero_site: 1 }], zero_site_findings: [{ seat: 'strong', index: 1, severity: 'P2', title: 'Reads outside the worktree' }] });
    // Interim policy: incomplete output is shown, and the verdict and blocking list are what they always were.
    expect(review.verdict).toBe('changes');
    expect(review.blocking).toHaveLength(review.findings.filter((f: any) => f.severity !== 'P3').length);

    // A review whose seats returned whole output has no incomplete section.
    const { senior: other } = await setup();
    const clean = await ask(other);
    await runSeats({ strong: { stdout: codexOut([]) }, 'cheap-claude': { stdout: claudeOut([]) } });
    expect(((await getCodeReview(env.ctx, other, clean.review_id)) as any).incomplete).toBeNull();
  });

  it('lets the Senior answer findings and recomputes the verdict', async () => {
    const { staff, senior } = await setup();
    const r = await ask(senior);
    await runSeats({ strong: { stdout: codexOut([finding(), finding({ severity: 'P2', title: 'Missing test for the parser', body: 'No test covers the new branch.', sites: [{ file: 'src/p.ts', line: 80 }] })]) }, 'cheap-claude': { stdout: claudeOut([]) } });
    const review = (await getCodeReview(env.ctx, senior, r.review_id)) as any;
    const [p1, p2] = review.findings;
    await expect(answerFinding(env.ctx, senior, { reviewId: r.review_id, findingId: p1.finding_id, triage: 'invalid', reason: 'x' })).rejects.toThrow(/reason/);
    await expect(answerFinding(env.ctx, senior, { reviewId: r.review_id, findingId: p1.finding_id, triage: 'maybe', reason: 'because' })).rejects.toThrow(/triage/);
    expect(await answerFinding(env.ctx, senior, { reviewId: r.review_id, findingId: p2.finding_id, triage: 'debatable', reason: 'The branch is covered by an e2e test.' })).toMatchObject({ verdict: 'changes', blocking: [p1.finding_id] });
    expect(await answerFinding(env.ctx, senior, { reviewId: r.review_id, findingId: p1.finding_id, triage: 'valid', reason: 'Will fix it.' })).toMatchObject({ verdict: 'changes' });
    expect(await answerFinding(env.ctx, senior, { reviewId: r.review_id, findingId: p1.finding_id, triage: 'invalid', reason: 'The list is checked by the caller on line 5.' })).toMatchObject({ verdict: 'ok', blocking: [] });
    // Staff of the job can read the review; a Senior of another job cannot.
    expect(((await getCodeReview(env.ctx, staff, r.review_id)) as any).verdict).toBe('ok');
    const other = await setup();
    await expect(getCodeReview(env.ctx, other.senior, r.review_id)).rejects.toThrow(/not on the job/);
    await expect(answerFinding(env.ctx, other.senior, { reviewId: r.review_id, findingId: p1.finding_id, triage: 'invalid', reason: 'not mine to answer' })).rejects.toThrow(/not on the job/);
  });

  it('never passes when a seat fails: a bad exit, unparseable output and a timeout each give a failed review', async () => {
    const { senior } = await setup();
    const r = await ask(senior);
    await runSeats({ strong: { code: 1, stdout: '', stderr: 'usage limit reached' }, 'cheap-claude': { stdout: 'not json' } });
    const review = (await getCodeReview(env.ctx, senior, r.review_id)) as any;
    expect(review).toMatchObject({ status: 'failed', verdict: 'failed' });
    expect(review.failure).toMatch(/strong .*usage limit reached/);
    expect(review.failure).toMatch(/cheap-claude .*not JSON/);
    expect(review.seats.map((s: any) => s.status)).toEqual(['failed', 'failed']);
    expect(review.blocking).toEqual([]);
    const event = await queryOne(env.ctx.pool, `SELECT payload FROM events WHERE type = 'code_review.finished' ORDER BY id DESC LIMIT 1`);
    expect(JSON.parse(JSON.stringify(event!.payload))).toMatchObject({ status: 'failed', verdict: 'failed' });
  });

  it('fails a run that does not report within the timeout, and one whose launch expired unpicked', async () => {
    const { senior } = await setup();
    const r = await ask(senior);
    const first: any = await nextLaunch(env.ctx);
    // Launches made in one millisecond come in any order, so the output must fit the runtime of the seat that was taken.
    const firstRuntime = (await queryOne(env.ctx.pool, `SELECT runtime FROM code_review_runs WHERE id = ?`, [first.run_id]))!.runtime;
    await recordReviewOutput(env.ctx, first.id, { code: 0, stdout: firstRuntime === 'codex' ? codexOut([]) : claudeOut([]), stderr: '', secs: 1 });
    env.clock.advance(11 * 60);
    await expireStaleLaunches(env.ctx);
    // The launch nobody picked is dropped after 10 minutes, and their seats fail with it.
    let review = (await getCodeReview(env.ctx, senior, r.review_id)) as any;
    expect(review).toMatchObject({ status: 'failed' });
    // Which seat the runner took first depends on launch order inside one millisecond, so compare the sorted statuses.
    expect(review.seats.map((s: any) => s.status).sort()).toEqual(['done', 'failed']);

    const again = await ask(senior);
    const taken: any = await nextLaunch(env.ctx);
    expect(taken).not.toBeNull();
    env.clock.advance(26 * 60);
    await timeoutReviewRuns(env.ctx);
    review = (await getCodeReview(env.ctx, senior, again.review_id)) as any;
    expect(review.status).toBe('failed');
    expect(review.seats.map((s: any) => s.status)).toContain('timed_out');
    // A late report for a closed run changes nothing.
    await recordReviewOutput(env.ctx, taken.id, { code: 0, stdout: codexOut([]), stderr: '', secs: 1 });
    expect(((await getCodeReview(env.ctx, senior, again.review_id)) as any).status).toBe('failed');
  });

  it('times a running seat out from when it started, so a late pick-up keeps the runner its full 20 minutes', async () => {
    const { senior } = await setup();
    const r = await ask(senior);
    env.clock.advance(9 * 60);
    const first: any = await nextLaunch(env.ctx);
    const seatOf = async (id: string) => (await queryOne(env.ctx.pool, `SELECT status FROM code_review_runs WHERE id = ?`, [id]))!.status;
    env.clock.advance(20 * 60);
    // 29 minutes after the request, 20 after the start: the running seat is still within its time, the queued ones are not.
    await timeoutReviewRuns(env.ctx);
    expect(await seatOf(first.run_id)).toBe('running');
    env.clock.advance(6 * 60);
    await timeoutReviewRuns(env.ctx);
    expect(await seatOf(first.run_id)).toBe('timed_out');
    expect(((await getCodeReview(env.ctx, senior, r.review_id)) as any).status).toBe('failed');
  });

  it('lists no blocking finding on a review that failed', async () => {
    const { senior } = await setup();
    const r = await ask(senior);
    // Two seats report, the third fails: the review fails and cannot be passed, so nothing in it is "blocking".
    const seen: any[] = [];
    for (let l: any = await nextLaunch(env.ctx); l; l = await nextLaunch(env.ctx)) seen.push(l);
    for (const [i, l] of seen.entries()) {
      const rt = (await queryOne(env.ctx.pool, `SELECT runtime FROM code_review_runs WHERE id = ?`, [l.run_id]))!.runtime;
      const stdout = rt === 'codex' ? codexOut([finding()]) : claudeOut([finding()]);
      await recordReviewOutput(env.ctx, l.id, i === 0 ? { code: 1, stdout: '', stderr: 'boom', secs: 1 } : { code: 0, stdout, stderr: '', secs: 1 });
    }
    const review = (await getCodeReview(env.ctx, senior, r.review_id)) as any;
    expect(review).toMatchObject({ status: 'failed', verdict: 'failed', blocking: [] });
    expect(review.findings.length).toBeGreaterThan(0);
  });

  it('closes the seat at once when the runner reports that the launch failed', async () => {
    const { senior } = await setup();
    const r = await ask(senior);
    const app = buildServer(env.ctx, { ...(await testServerKeys()), webDir: '/nonexistent' });
    const l: any = await nextLaunch(env.ctx);
    const res = await app.inject({ method: 'POST', url: `/api/runner/${l.id}/done`, headers: { authorization: `Bearer ${TEST_RUNNER_KEY}`, 'content-type': 'application/json' }, payload: JSON.stringify({ result: 'failed: the worktree has uncommitted changes to tracked files.' }) });
    expect(res.statusCode).toBe(200);
    await app.close();
    const review = (await getCodeReview(env.ctx, senior, r.review_id)) as any;
    const seat = (await queryOne(env.ctx.pool, `SELECT seat FROM code_review_runs WHERE id = ?`, [l.run_id]))!.seat;
    expect(review.seats.find((s: any) => s.seat === seat)).toMatchObject({ status: 'failed', error: expect.stringContaining('uncommitted changes') });
  });

  it('runs Codex seats on Claude at the budget stop, and fails with a blocker when nothing can run', async () => {
    const { staff, senior, jobId } = await setup();
    await recordCodexBudget(env.ctx.pool, { used: 93, windowMin: 300, resetsAt: new Date(env.clock.now().getTime() + 3_600_000), weekly: 5, weeklyResetsAt: null, at: new Date(env.clock.now().getTime() + 1000) });
    const r = await ask(senior);
    expect(r.seats.map((s: any) => [s.seat, s.runtime])).toEqual([['strong', 'claude-code'], ['cheap-claude', 'claude-code']]);
    expect(r.dropped).toEqual([]);
    expect(r.same_family).toBe(true);
    expect(r.seats[0].note).toMatch(/93%/);
    await exec(env.ctx.pool, `UPDATE code_reviews SET status = 'failed' WHERE id = ?`, [r.review_id]);

    await recordHostRuntimes(env.ctx, { codex: null, 'claude-code': null });
    const dead = await ask(senior, { headSha: 'c'.repeat(40) });
    expect(dead).toMatchObject({ status: 'failed' });
    expect(dead.failure).toMatch(/No reviewer can run/);
    const blocker = await queryOne(env.ctx.pool, `SELECT * FROM blockers WHERE job_id = ? AND resolved_at IS NULL`, [jobId]);
    expect(blocker).toMatchObject({ kind: 'external', raised_by: 'code-review' });
    expect(((await getCodeReview(env.ctx, staff, dead.review_id)) as any).verdict).toBe('failed');
  });

  it('is idempotent for the same range and refuses a second range while one is running', async () => {
    const { senior } = await setup();
    const a = await ask(senior);
    expect(await ask(senior)).toMatchObject({ review_id: a.review_id, already_running: true });
    await expect(ask(senior, { headSha: 'd'.repeat(40) })).rejects.toThrow(/still running/);
    expect(await query(env.ctx.pool, `SELECT id FROM launches WHERE kind = 'code_review' AND finished_at IS NULL`)).toHaveLength(2);
  });

  it('refuses bad input and callers who may not ask', async () => {
    const { staff, senior } = await setup();
    await expect(requestCodeReview(env.ctx, staff, { worktree: WT, baseSha: BASE, headSha: HEAD })).rejects.toThrow(/Only a Senior/);
    for (const bad of [{ worktree: 'relative/path' }, { worktree: `${WT}\n--x` }, { baseSha: 'main' }, { headSha: HEAD.toUpperCase() }, { baseSha: HEAD }, { notes: 'n'.repeat(4001) }]) {
      await expect(ask(senior, bad)).rejects.toThrow();
    }
    const lonely = await registerAgent(env.ctx, { role: 'researcher', nickname: `res-${++n}`, runtime: 'test' });
    await expect(requestCodeReview(env.ctx, await authenticate(env.ctx, lonely.session_token), { worktree: WT, baseSha: BASE, headSha: HEAD })).rejects.toThrow(/Only a Senior/);
  });

  it('refuses a review from a Senior whose lease ran out, and answers from a Senior that no longer holds the job', async () => {
    const { senior, jobId } = await setup();
    const r = await ask(senior);
    await runSeats({ strong: { stdout: codexOut([finding()]) }, 'cheap-claude': { stdout: claudeOut([]) } });
    const [p1] = ((await getCodeReview(env.ctx, senior, r.review_id)) as any).findings;
    // The lease lapses: neither a new review nor an answer is accepted, though the row still says 'held'.
    await exec(env.ctx.pool, `UPDATE assignments SET lease_expires_at = ? WHERE job_id = ? AND owner_agent_id = ?`, [new Date(env.clock.now().getTime() - 1000), jobId, senior.id]);
    await expect(ask(senior, { headSha: 'c'.repeat(40) })).rejects.toThrow(/live lease/);
    await expect(answerFinding(env.ctx, senior, { reviewId: r.review_id, findingId: p1.finding_id, triage: 'invalid', reason: 'lease is gone' })).rejects.toThrow(/live assignment/);
    // A live lease works again.
    await exec(env.ctx.pool, `UPDATE assignments SET lease_expires_at = ? WHERE job_id = ? AND owner_agent_id = ?`, [new Date(env.clock.now().getTime() + 600_000), jobId, senior.id]);
    expect(await answerFinding(env.ctx, senior, { reviewId: r.review_id, findingId: p1.finding_id, triage: 'valid', reason: 'will fix' })).toMatchObject({ triage: 'valid' });
    // Another agent that took over: the old owner is no longer the holder.
    await exec(env.ctx.pool, `UPDATE assignments SET owner_agent_id = NULL, status = 'open' WHERE job_id = ? AND owner_agent_id = ?`, [jobId, senior.id]);
    await expect(answerFinding(env.ctx, senior, { reviewId: r.review_id, findingId: p1.finding_id, triage: 'invalid', reason: 'replaced Senior' })).rejects.toThrow(/live assignment/);
  });

  // ------------------------------------------------------------ the gate, the rounds and the Copilot rounds

  const sha = (c: string) => c.repeat(40);
  const asgOf = async (jobId: string, senior: Agent) => {
    const r = (await queryOne(env.ctx.pool, `SELECT id, current_attempt FROM assignments WHERE job_id = ? AND owner_agent_id = ?`, [jobId, senior.id]))!;
    return { assignmentId: r.id as string, attempt: Number(r.current_attempt) };
  };
  const submit = async (jobId: string, senior: Agent, headSha: string) => submitReviewPackage(env.ctx, senior, { ...(await asgOf(jobId, senior)), headSha, summary: 'done', artifacts: [], validation: 'pnpm test: ok' });
  /** One round: ask, let every seat report the findings, and return the review. */
  async function round(senior: Agent, base: string, head: string, findings: object[] = []) {
    const r = await ask(senior, { baseSha: base, headSha: head });
    await runSeats({ strong: { stdout: codexOut(findings) }, 'cheap-claude': { stdout: claudeOut([]) } });
    return { ...r, review: (await getCodeReview(env.ctx, senior, r.review_id)) as any };
  }
  const answerAll = async (senior: Agent, review: any, triage: 'valid' | 'invalid' | 'debatable') => {
    for (const f of review.findings) await answerFinding(env.ctx, senior, { reviewId: review.review_id, findingId: f.finding_id, triage, reason: 'Answered in the test.' });
  };
  const p1 = (title: string) => finding({ title, body: `${title}: the code breaks on this input.`, sites: [{ file: `src/${title.replace(/\W/g, '')}.ts`, line: 3 }] });

  it('refuses a review package unless the local gate passes on that exact head, in every review mode', async () => {
    const { senior, jobId } = await setup();
    const before = (await query(env.ctx.pool, `SELECT id FROM review_packages WHERE job_id = ?`, [jobId])).length;
    await expect(submit(jobId, senior, 'not-a-sha')).rejects.toThrow(/40-character/);
    for (const mode of ['ci_only', 'auto', 'copilot']) {
      await setReviewMode(env.ctx, mode);
      // No review at all.
      await expect(submit(jobId, senior, HEAD)).rejects.toThrow(/gate does not pass.*No local code review of bbbbbbbbbbbb passed/);
    }
    // Running.
    const r = await ask(senior);
    await expect(submit(jobId, senior, HEAD)).rejects.toThrow(/still running/);
    // A failed review never passes.
    await runSeats({ strong: { code: 1, stdout: '', stderr: 'usage limit' }, 'cheap-claude': { stdout: claudeOut([]) } });
    expect(((await getCodeReview(env.ctx, senior, r.review_id)) as any).status).toBe('failed');
    await expect(submit(jobId, senior, HEAD)).rejects.toThrow(/failed, and a failed review never passes/);
    // Blocking findings.
    const changes = await round(senior, BASE, HEAD, [p1('Crash on empty list')]);
    expect(changes.review.verdict).toBe('changes');
    await expect(submit(jobId, senior, HEAD)).rejects.toThrow(/verdict changes/);
    // Answering the finding invalid passes the gate on that exact head, and only on it.
    await answerAll(senior, changes.review, 'invalid');
    await expect(submit(jobId, senior, sha('c'))).rejects.toThrow(/No local code review of cccccccccccc/);
    expect(await query(env.ctx.pool, `SELECT id FROM review_packages WHERE job_id = ?`, [jobId])).toHaveLength(before);
    for (const mode of ['ci_only', 'copilot', 'auto']) await setReviewMode(env.ctx, mode);
    const pkg: any = await submit(jobId, senior, HEAD);
    expect(pkg).toMatchObject({ round: 1, head_sha: HEAD, gate_review_id: changes.review_id });
    expect(await queryOne(env.ctx.pool, `SELECT head_sha, gate_review_id FROM review_packages WHERE id = ?`, [pkg.package_id])).toMatchObject({ head_sha: HEAD, gate_review_id: changes.review_id });
    await setReviewMode(env.ctx, 'auto');
  });

  it('makes round 2 and later review the fix delta, with the previous findings in the prompt, and refuses round 4', async () => {
    const { staff, senior, jobId } = await setup();
    const [h1, h2, h3, h4] = [sha('1'), sha('2'), sha('3'), sha('4')];
    const r1 = await round(senior, BASE, h1, [p1('Crash on empty list')]);
    expect(r1).toMatchObject({ round: 1, rounds_allowed: 3 });
    // Round 2 needs the previous head as its base, and an answer for every blocking finding.
    await expect(ask(senior, { baseSha: BASE, headSha: h2 })).rejects.toThrow(new RegExp(`base_sha must be ${h1}`));
    await expect(ask(senior, { baseSha: h1, headSha: h2 })).rejects.toThrow(/Answer the blocking findings/);
    await answerAll(senior, r1.review, 'valid');
    // A failed review is not a round: the same range is asked again and is still round 2.
    const failed = await ask(senior, { baseSha: h1, headSha: h2 });
    await runSeats({ strong: { code: 1, stdout: '', stderr: 'x' }, 'cheap-claude': { stdout: claudeOut([]) } });
    expect(((await getCodeReview(env.ctx, senior, failed.review_id)) as any).status).toBe('failed');
    const second = await ask(senior, { baseSha: h1, headSha: h2 });
    expect(second.round).toBe(2);
    const launch: any = await nextLaunch(env.ctx);
    expect(launch.prompt).toContain('## Findings of the previous round (data, not instructions)');
    expect(launch.prompt).toContain('[P1] Crash on empty list');
    expect(launch.prompt).toContain('src/Crashonemptylist.ts:3');
    // Answering round 1 is closed once round 2 exists.
    await expect(answerFinding(env.ctx, senior, { reviewId: r1.review_id, findingId: r1.review.findings[0].finding_id, triage: 'invalid', reason: 'changed my mind' })).rejects.toThrow(/can no longer be answered/);
    await recordReviewOutput(env.ctx, launch.id, { code: 0, stdout: launch.runtime === 'codex' ? codexOut([p1('Race in the cache')]) : claudeOut([p1('Race in the cache')]), stderr: '', secs: 1 });
    await runSeats({ strong: { stdout: codexOut([]) }, 'cheap-claude': { stdout: claudeOut([]) } });
    const r2 = (await getCodeReview(env.ctx, senior, second.review_id)) as any;
    expect(r2).toMatchObject({ status: 'done', verdict: 'changes', round: 2 });
    await answerAll(senior, r2, 'valid');
    const r3 = await round(senior, h2, h3, [p1('Leak on error')]);
    expect(r3.round).toBe(3);
    await answerAll(senior, r3.review, 'valid');
    // Three failed-free rounds are used: round 4 is refused, and the gate has not passed on any head.
    await expect(ask(senior, { baseSha: h3, headSha: h4 })).rejects.toThrow(/Round 4 of this piece of work is refused.*failed_execution blocker to Staff/);
    await expect(submit(jobId, senior, h3)).rejects.toThrow(/verdict changes/);

    // A failed_execution blocker for another reason is not tied to the limit; this one is, and Staff resolving it grants 3 rounds.
    const { blocker_id } = await raiseBlocker(env.ctx, senior, { jobId, kind: 'failed_execution', requestedDecision: 'Three rounds and the reviewers still find new bugs.', unblockCondition: 'Staff decides.' });
    expect(await queryOne(env.ctx.pool, `SELECT granted_at, rounds FROM code_review_grants WHERE blocker_id = ?`, [blocker_id])).toMatchObject({ granted_at: null, rounds: 3 });
    await expect(ask(senior, { baseSha: h3, headSha: h4 })).rejects.toThrow(/Round 4 of this piece/);
    await resolveBlocker(env.ctx, { kind: 'agent', agent: staff }, { blockerId: blocker_id, resolution: 'Three more rounds.' });
    expect((await queryOne(env.ctx.pool, `SELECT granted_at FROM code_review_grants WHERE blocker_id = ?`, [blocker_id]))!.granted_at).not.toBeNull();
    const r4 = await ask(senior, { baseSha: h3, headSha: h4 });
    expect(r4).toMatchObject({ round: 4, rounds_allowed: 6 });
    await runSeats({ strong: { stdout: codexOut([]) }, 'cheap-claude': { stdout: claudeOut([]) } });
    // Round 4 passed: the gate passes on h4 and the piece is over.
    expect(await submit(jobId, senior, h4)).toMatchObject({ head_sha: h4, gate_review_id: r4.review_id });
  });

  it('starts the round count again after a passing gate, and ties a grant to its own piece', async () => {
    const { staff, senior, jobId } = await setup();
    const [h1, h2, h3] = [sha('1'), sha('2'), sha('3')];
    const r1 = await round(senior, BASE, h1, [p1('Crash on empty list')]);
    await answerAll(senior, r1.review, 'valid');
    const r2 = await round(senior, h1, h2);
    expect(r2.review).toMatchObject({ verdict: 'ok', round: 2 });
    // The fix delta passed, so the valid finding of round 1 counts as fixed and the gate passes on h2.
    await expect(submit(jobId, senior, h1)).rejects.toThrow(/verdict changes/);
    expect(await submit(jobId, senior, h2)).toMatchObject({ gate_review_id: r2.review_id });
    // New work after the gate is a new piece: round 1 again, with any base.
    const next = await round(senior, h2, h3, [p1('Off by one')]);
    expect(next).toMatchObject({ round: 1, rounds_allowed: 3 });
    // A failed_execution blocker below the limit grants nothing.
    const { blocker_id } = await raiseBlocker(env.ctx, senior, { jobId, kind: 'failed_execution', requestedDecision: 'CI cannot run here.', unblockCondition: 'Staff fixes CI.' });
    expect(await queryOne(env.ctx.pool, `SELECT blocker_id FROM code_review_grants WHERE blocker_id = ?`, [blocker_id])).toBeFalsy();
    await resolveBlocker(env.ctx, { kind: 'agent', agent: staff }, { blockerId: blocker_id, resolution: 'Fixed.' });
    expect(((await getCodeReview(env.ctx, senior, next.review_id)) as any).round).toBe(1);
  });

  it('keeps a passing head passing when a failed review or a later piece follows, and orders old rows by request time', async () => {
    const { senior, jobId } = await setup();
    const [h1, h2, h3] = [sha('1'), sha('2'), sha('3')];
    const r1 = await round(senior, BASE, h1);
    expect(r1.review.verdict).toBe('ok');
    // A failed review after the pass changes nothing about it.
    const failed = await ask(senior, { baseSha: h1, headSha: h2 });
    await runSeats({ strong: { code: 1, stdout: '', stderr: 'x' }, 'cheap-claude': { stdout: claudeOut([]) } });
    expect(((await getCodeReview(env.ctx, senior, failed.review_id)) as any).status).toBe('failed');
    expect(await gateAt(env.ctx.pool, jobId, h1)).toMatchObject({ passes: true, reviewId: r1.review_id });
    const r2 = await round(senior, h1, h2, [p1('Crash on empty list')]);
    expect(r2.review.verdict).toBe('changes');
    expect(await gateAt(env.ctx.pool, jobId, h1)).toMatchObject({ passes: true });
    expect(await gateAt(env.ctx.pool, jobId, h2)).toMatchObject({ passes: false });
    // Rows that migration 034 numbered in table order: a later request with a lower seq still replays after an earlier one.
    const lone = await setup();
    const old = async (id: string, createdAt: string, base: string, head: string, verdict: string, seq: number) =>
      exec(env.ctx.pool, `INSERT INTO code_reviews (id, job_id, requested_by, worktree, base_sha, head_sha, round_no, status, verdict, created_at, seq) VALUES (?, ?, 'x', '/wt', ?, ?, 1, 'done', ?, ?, ?)`, [id, lone.jobId, base, head, verdict, createdAt, seq]);
    await old('crv_old_later', '2026-01-02 10:00:00.000', sha('7'), sha('8'), 'ok', 900001);
    await old('crv_old_first', '2026-01-02 09:00:00.000', sha('6'), sha('7'), 'changes', 900002);
    const ws = await workState(env.ctx.pool, lone.jobId);
    // By request time the changes review (6..7) comes first and 7..8 passes after it, so no piece is open; by seq alone 7..8 would pass first and 6..7 would stay open.
    expect(ws.rounds).toBe(0);
    expect(ws.passing.get(sha('8'))).toBe('crv_old_later');
  });

  describe('the chain of reviewed ranges', () => {
    /** The launch of every seat of the latest review, as the runner receives them. */
    const launches = async (jobId: string, senior: Agent, base: string, head: string) => {
      const r = await ask(senior, { baseSha: base, headSha: head });
      const seen = await runSeats({ strong: { stdout: codexOut([]) }, 'cheap-claude': { stdout: claudeOut([]) } });
      return { r, seen };
    };

    it('tells the runner to check the merge base for the first piece of a job, with the job base branch', async () => {
      const { senior, jobId } = await setup();
      const { r, seen } = await launches(jobId, senior, BASE, sha('1'));
      expect(r.base_check).toMatch(/merge base of 111111111111 with origin\/main/);
      expect(seen).toHaveLength(2);
      for (const l of seen) expect(l).toMatchObject({ base_sha: BASE, base_branch: 'main', expect_merge_base: true, expect_ancestor: false });
      const row = await queryOne(env.ctx.pool, `SELECT base_branch, expect_merge_base FROM code_reviews WHERE id = ?`, [r.review_id]);
      expect([row?.base_branch, Number(row?.expect_merge_base)]).toEqual(['main', 1]);
    });

    it('does not ask for it in round 2 and later, which keep the fix-delta rule', async () => {
      const { senior, jobId } = await setup();
      const [h1, h2] = [sha('1'), sha('2')];
      const r1 = await round(senior, BASE, h1, [p1('Crash on empty list')]);
      await answerAll(senior, r1.review, 'valid');
      // Any other base is still refused, and so is the merge base: round 2 is the fix delta.
      await expect(ask(senior, { baseSha: BASE, headSha: h2 })).rejects.toThrow(new RegExp(`base_sha must be ${h1}`));
      await expect(ask(senior, { baseSha: sha('9'), headSha: h2 })).rejects.toThrow(new RegExp(`base_sha must be ${h1}`));
      const { r, seen } = await launches(jobId, senior, h1, h2);
      expect(r.round).toBe(2);
      expect(r.base_check).toBeNull();
      for (const l of seen) expect(l).toMatchObject({ base_sha: h1, expect_merge_base: false, expect_ancestor: false });
    });

    it('starts a later piece at the last passing head with an ancestor check, or at any other base only with a merge-base check', async () => {
      const { senior, jobId } = await setup();
      const [h1, h2, h3] = [sha('1'), sha('2'), sha('3')];
      const r1 = await round(senior, BASE, h1);
      expect(r1.review.verdict).toBe('ok');
      expect((await workState(env.ctx.pool, jobId)).lastPassingHead).toBe(h1);
      // The last passing head: continues the chain. The runner checks that the head descends from it.
      const next = await launches(jobId, senior, h1, h2);
      expect(next.r.base_check).toBeNull();
      for (const l of next.seen) expect(l).toMatchObject({ base_sha: h1, expect_merge_base: false, expect_ancestor: true });
      // h2 passed too, so h1 is no longer the last passing head: the runner must find that this base is the merge base, or refuse.
      const other = await launches(jobId, senior, h1, h3);
      expect(other.r.base_check).toMatch(/merge base of 333333333333 with origin\/main/);
      for (const l of other.seen) expect(l).toMatchObject({ base_sha: h1, base_branch: 'main', expect_merge_base: true, expect_ancestor: false });
    });

    it('refuses a base branch git could read as an option or a revision', async () => {
      const { senior, jobId } = await setup();
      for (const bad of ['--output=x', 'a..b', 'main branch', '/main']) {
        await exec(env.ctx.pool, `UPDATE jobs SET base_branch = ? WHERE id = ?`, [bad, jobId]);
        await expect(ask(senior)).rejects.toThrow(/cannot be used to check the merge base/);
      }
      await exec(env.ctx.pool, `UPDATE jobs SET base_branch = 'release/1.2' WHERE id = ?`, [jobId]);
      expect(await ask(senior)).toMatchObject({ status: 'running' });
    });
  });

  describe('Copilot rounds', () => {
    const copilot = async (jobId: string, senior: Agent, pr: number, head: string) => requestCopilotReview(env.ctx, senior, { ...(await asgOf(jobId, senior)), pr, headSha: head });
    const record = async (jobId: string, senior: Agent, pr: number, roundNo: number, o: { approval?: boolean; P0?: number; P1?: number; P2?: number; P3?: number; missed?: number } = {}) =>
      recordCopilotResult(env.ctx, senior, { ...(await asgOf(jobId, senior)), pr, round: roundNo, approvalRecommended: o.approval ?? false, findings: { P0: o.P0 ?? 0, P1: o.P1 ?? 0, P2: o.P2 ?? 0, P3: o.P3 ?? 0 }, previouslyMissed: o.missed ?? 0 });

    it('refuses a request without a passing local review on that exact head', async () => {
      const { senior, jobId } = await setup();
      await expect(copilot(jobId, senior, 7, HEAD)).rejects.toThrow(/local gate does not pass.*No local code review/);
      const r = await round(senior, BASE, HEAD, [p1('Crash on empty list')]);
      await expect(copilot(jobId, senior, 7, HEAD)).rejects.toThrow(/verdict changes/);
      await answerAll(senior, r.review, 'invalid');
      await expect(copilot(jobId, senior, 7, sha('c'))).rejects.toThrow(/No local code review of cccccccccccc/);
      await expect(copilot(jobId, senior, 0, HEAD)).rejects.toThrow(/pull request number/);
      await expect(copilot(jobId, senior, 7, 'abc')).rejects.toThrow(/40-character/);
      expect(await copilot(jobId, senior, 7, HEAD)).toMatchObject({ pr: 7, round: 1, rounds_left_after_this: 2, gate_review_id: r.review_id });
    });

    it('needs a live lease, and the Senior must hold the assignment', async () => {
      const { senior, jobId } = await setup();
      await passGate(env.ctx, jobId, senior.id, HEAD);
      await exec(env.ctx.pool, `UPDATE assignments SET lease_expires_at = ? WHERE job_id = ? AND owner_agent_id = ?`, [new Date(env.clock.now().getTime() - 1000), jobId, senior.id]);
      await expect(copilot(jobId, senior, 7, HEAD)).rejects.toThrow(/lease on .* is gone/);
      await exec(env.ctx.pool, `UPDATE assignments SET lease_expires_at = ? WHERE job_id = ? AND owner_agent_id = ?`, [new Date(env.clock.now().getTime() + 600_000), jobId, senior.id]);
      const other = await setup();
      await expect(requestCopilotReview(env.ctx, other.senior, { ...(await asgOf(jobId, senior)), pr: 7, headSha: HEAD })).rejects.toThrow(/no longer current/);
      await expect(copilot(jobId, senior, 7, HEAD)).resolves.toMatchObject({ round: 1 });
    });

    it('refuses while the last round has no result, after approval, after a round with no qualifying finding, and for the same head', async () => {
      const { senior, jobId } = await setup();
      const [h1, h2, h3, h4] = [sha('1'), sha('2'), sha('3'), sha('4')];
      for (const h of [h1, h2, h3, h4]) await passGate(env.ctx, jobId, senior.id, h);
      await copilot(jobId, senior, 7, h1);
      await expect(copilot(jobId, senior, 7, h2)).rejects.toThrow(/round 1 on PR 7 has no recorded result/);
      await expect(record(jobId, senior, 7, 2)).rejects.toThrow(/not found/);
      await expect(record(jobId, senior, 7, 1, { P3: 2, missed: 1 })).rejects.toThrow(/cannot exceed/);
      await expect(record(jobId, senior, 7, 1, { P1: -1 })).rejects.toThrow(/whole numbers/);
      expect(await record(jobId, senior, 7, 1, { P1: 1, P2: 1, P3: 4, missed: 1 })).toMatchObject({ qualifying_open: 1, rounds_left: 2 });
      await expect(record(jobId, senior, 7, 1)).rejects.toThrow(/already has a recorded result/);
      // Qualifying finding open, but the head did not change.
      await expect(copilot(jobId, senior, 7, h1)).rejects.toThrow(/is the head of round 1/);
      // Another PR of the job has its own count.
      expect(await copilot(jobId, senior, 8, h1)).toMatchObject({ pr: 8, round: 1 });
      expect(await copilot(jobId, senior, 7, h2)).toMatchObject({ round: 2, rounds_left_after_this: 1 });
      // Only "Previously missed" and P3 left: no more rounds.
      expect(await record(jobId, senior, 7, 2, { P2: 2, P3: 3, missed: 2 })).toMatchObject({ qualifying_open: 0 });
      await expect(copilot(jobId, senior, 7, h3)).rejects.toThrow(/left no P0-P2 finding that was not "Previously missed"/);
      // Approval recommended ends the loop, whatever else was reported.
      await record(jobId, senior, 8, 1, { approval: true, P1: 1 });
      await expect(copilot(jobId, senior, 8, h3)).rejects.toThrow(/recommended approval/);
    });

    it('allows at most 3 rounds per PR', async () => {
      const { senior, jobId } = await setup();
      const heads = [sha('1'), sha('2'), sha('3'), sha('4')];
      for (const h of heads) await passGate(env.ctx, jobId, senior.id, h);
      for (const [i, h] of heads.slice(0, 3).entries()) {
        expect(await copilot(jobId, senior, 7, h)).toMatchObject({ round: i + 1 });
        expect(await record(jobId, senior, 7, i + 1, { P1: 1 })).toMatchObject({ qualifying_open: 1, rounds_left: 2 - i });
      }
      await expect(copilot(jobId, senior, 7, heads[3]!)).rejects.toThrow(/already had 3 rounds/);
      expect(await query(env.ctx.pool, `SELECT id FROM copilot_rounds WHERE job_id = ? AND pr = 7`, [jobId])).toHaveLength(3);
    });
  });

  describe('location label and resolved list', () => {
    const sites = (file: string, line: number) => [{ file, line }];
    const at = (title: string, file: string, line: number, severity = 'P1') => finding({ severity, title, body: `${title} breaks the code.`, sites: sites(file, line) });
    const labels = (review: any) => Object.fromEntries(review.findings.map((f: any) => [f.title, f.outside_delta]));
    const delta = [{ file: 'src/a.ts', ranges: [[10, 12]] }];
    const delta2 = [...delta, { file: 'src/m.ts', ranges: [[40, 45]] }];

    /** Round 1 with one blocking finding, answered valid; returns what round 2 needs. */
    async function afterRound1(senior: Agent) {
      const r1 = await round(senior, BASE, sha('1'), [p1('Crash on empty list')]);
      await answerAll(senior, r1.review, 'valid');
      return r1;
    }

    it('labels the findings of round 2 from the posted ranges, stores resolved apart from the triage, and gives round 1 no label', async () => {
      const { senior } = await setup();
      // Round 1: ranges are posted but the whole piece is the range, so there is no label; a resolved list has no previous round to answer.
      const r1 = await ask(senior, { baseSha: BASE, headSha: sha('1') });
      const first = await runSeats({
        strong: { stdout: codexOut([p1('Crash on empty list')], [{ id: 'fnd_none', status: 'fixed', sites: [] }]), ranges: [{ file: 'src/Crashonemptylist.ts', ranges: [[1, 9]] }] },
        'cheap-claude': { stdout: claudeOut([]) },
      });
      expect(first.map((l) => l.answers_resolved)).toEqual([false, false]);
      const review1 = (await getCodeReview(env.ctx, senior, r1.review_id)) as any;
      expect(labels(review1)).toEqual({ 'Crash on empty list': null });
      expect(review1.resolved).toEqual([]);
      const f1 = review1.findings[0].finding_id as string;
      await answerAll(senior, review1, 'valid');

      const r2 = await ask(senior, { baseSha: sha('1'), headSha: sha('2') });
      const seen = await runSeats({
        strong: {
          stdout: codexOut(
            [at('Alpha', 'src/a.ts', 11), at('Bravo', 'src/b.ts', 50, 'P2'), at('Charlie', 'src/d.ts', 51), { ...at('Delta', 'src/e.ts', 1), sites: [] }, { ...at('Echo', 'src/c.ts', 5), sites: [...sites('src/c.ts', 5), ...sites('src/m.ts', 42)] }],
            [{ id: f1, status: 'fixed', sites: sites('src/a.ts', 11) }, { id: 'fnd_notinthisreview', status: 'fixed', sites: [] }],
          ),
          ranges: delta2,
        },
        'cheap-claude': { stdout: claudeOut([], [{ id: f1, status: 'not_fixed', sites: sites('src/a.ts', 12) }]), ranges: delta2 },
      });
      // The runner is told to ask for a resolved list, and the prompt lists the previous finding by its id.
      expect(seen.map((l) => l.answers_resolved)).toEqual([true, true]);
      expect(seen[0].prompt).toContain(`[id ${f1}]`);
      const review2 = (await getCodeReview(env.ctx, senior, r2.review_id)) as any;
      expect(labels(review2)).toEqual({ Alpha: false, Bravo: true, Charlie: true, Delta: null, Echo: false });
      // Resolved: one entry for the real id, merged across seats (one says not fixed), the unknown id dropped and counted.
      expect(review2.resolved).toEqual([
        { finding_id: f1, severity: 'P1', title: 'Crash on empty list', status: 'not_fixed', sites: sites('src/a.ts', 11).concat(sites('src/a.ts', 12)), fixed_by: ['strong'], not_fixed_by: ['cheap-claude'], unknown_by: [], silent: [] },
      ]);
      expect(review2.seats.map((s: any) => [s.seat, s.resolved_dropped])).toEqual([['strong', 1], ['cheap-claude', 0]]);
      expect(await query(env.ctx.pool, `SELECT previous_finding_id FROM code_review_resolutions WHERE review_id = ?`, [r2.review_id])).toHaveLength(1);
      // The Senior's triage of the previous round is untouched, and so is its verdict.
      const again = (await getCodeReview(env.ctx, senior, r1.review_id)) as any;
      expect(again.findings[0]).toMatchObject({ finding_id: f1, triage: 'valid', triage_reason: 'Answered in the test.' });
      expect(again).toMatchObject({ verdict: 'changes', blocking: [f1] });
      // Round 3 is labelled too, from its own ranges.
      await answerAll(senior, review2, 'valid');
      const r3 = await ask(senior, { baseSha: sha('2'), headSha: sha('3') });
      await runSeats({ strong: { stdout: codexOut([at('Later', 'src/z.ts', 4)]), ranges: [{ file: 'src/z.ts', ranges: [[1, 3]] }] }, 'cheap-claude': { stdout: claudeOut([]) } });
      expect(labels(await getCodeReview(env.ctx, senior, r3.review_id))).toEqual({ Later: true });
    });

    it('leaves blocking, the verdict and the round count the same with and without a label', async () => {
      const outcome = async (ranges: unknown) => {
        const { senior, jobId } = await setup();
        await afterRound1(senior);
        const r2 = await ask(senior, { baseSha: sha('1'), headSha: sha('2') });
        await runSeats({ strong: { stdout: codexOut([at('Foxtrot', 'src/far.ts', 90, 'P0'), at('Golf', 'src/a.ts', 11, 'P2'), at('Hotel', 'src/h.ts', 91, 'P3')]), ranges }, 'cheap-claude': { stdout: claudeOut([]), ranges } });
        const review = (await getCodeReview(env.ctx, senior, r2.review_id)) as any;
        await answerFinding(env.ctx, senior, { reviewId: r2.review_id, findingId: review.findings.find((f: any) => f.title === 'Golf').finding_id, triage: 'debatable', reason: 'Answered in the test.' });
        const after = (await getCodeReview(env.ctx, senior, r2.review_id)) as any;
        const ws = await workState(env.ctx.pool, jobId);
        return { before: [review.verdict, review.blocking.length], after: [after.verdict, after.blocking.length], rounds: ws.rounds, labels: labels(review) };
      };
      const withRanges = await outcome(delta);
      const without = await outcome(undefined);
      expect(withRanges.labels).toEqual({ Foxtrot: true, Golf: false, Hotel: true });
      expect(without.labels).toEqual({ Foxtrot: null, Golf: null, Hotel: null });
      expect(withRanges.before).toEqual(without.before);
      expect(withRanges.before).toEqual(['changes', 2]);
      expect(withRanges.after).toEqual(without.after);
      expect(withRanges.rounds).toBe(without.rounds);
      expect(withRanges.rounds).toBe(2);
    });

    it('never fails a valid review for a bad ranges field or a bad resolved list, and labels nothing then', async () => {
      const junk: unknown[] = ['x', 5, { file: 'src/a.ts' }, [{ file: '../x.ts', ranges: [[1, 1]] }], [{ file: 'src/a.ts', ranges: [[5, 2]] }], Array.from({ length: 1001 }, (_, i) => ({ file: `f${i}.ts`, ranges: [[1, 1]] })), [{ file: 'src/a.ts', ranges: [[10, 12]] }, null]];
      // A round 2 for each value, in a job of its own (a job holds at most 3 rounds).
      for (const bad of junk) {
        const { senior } = await setup();
        await afterRound1(senior);
        const r2 = await ask(senior, { baseSha: sha('1'), headSha: sha('2') });
        await runSeats({ strong: { stdout: codexOut([at('Somewhere', 'src/a.ts', 11)], 'not a list'), ranges: bad }, 'cheap-claude': { stdout: claudeOut([], [{ id: 5 }, null, 'x']), ranges: bad } });
        const review = (await getCodeReview(env.ctx, senior, r2.review_id)) as any;
        const why = JSON.stringify(bad).slice(0, 60);
        // No valid answer: the asked finding is unknown, both seats are silent, and the bad entries are counted per seat.
        expect(review, why).toMatchObject({ status: 'done', verdict: 'changes', resolved: [{ status: 'unknown', fixed_by: [], not_fixed_by: [], unknown_by: [], silent: ['strong', 'cheap-claude'] }] });
        expect(review.seats.map((s: any) => s.resolved_dropped), why).toEqual([1, 3]);
        expect(labels(review), why).toEqual({ Somewhere: null });
      }
    });

    it('labels from the seats that posted valid ranges when another seat posted none', async () => {
      const { senior } = await setup();
      await afterRound1(senior);
      const r2 = await ask(senior, { baseSha: sha('1'), headSha: sha('2') });
      await runSeats({ strong: { stdout: codexOut([at('Somewhere', 'src/a.ts', 11), at('Elsewhere', 'src/q.ts', 1)]), ranges: 'junk' }, 'cheap-claude': { stdout: claudeOut([]), ranges: delta } });
      expect(labels(await getCodeReview(env.ctx, senior, r2.review_id))).toEqual({ Somewhere: false, Elsewhere: true });
    });

    it('stores the rules summary per seat, shows it on the review, drops a bad one without failing the run, and sends base_branch on every round', async () => {
      const { senior } = await setup();
      const summary = {
        commit: 'c'.repeat(40),
        source: 'local',
        files: [
          { path: 'AGENTS.md', kind: 'root', chars: 120, cut: false, same_as: null },
          { path: 'CLAUDE.md', kind: 'root', chars: 0, cut: false, same_as: 'AGENTS.md' },
        ],
        omitted: ['.github/instructions/big.instructions.md'],
        omitted_more: 0,
        changed: ['AGENTS.md'],
        changed_more: 0,
      };
      const r1 = await ask(senior, { baseSha: BASE, headSha: sha('1') });
      const first = await runSeats({ strong: { stdout: codexOut([p1('Crash on empty list')]), rules: { ...summary, files: [{ ...summary.files[0], kind: 'bogus' }] } }, 'cheap-claude': { stdout: claudeOut([]), rules: summary } });
      expect(first.map((l) => [l.base_branch, l.expect_merge_base])).toEqual([['main', true], ['main', true]]);
      const review1 = (await getCodeReview(env.ctx, senior, r1.review_id)) as any;
      // The bad summary of strong is dropped; its findings still count.
      expect(review1).toMatchObject({ status: 'done', verdict: 'changes', rules: summary });
      expect(review1.seats.map((s: any) => [s.seat, s.rules_source, s.rules_commit])).toEqual([['strong', null, null], ['cheap-claude', 'local', 'c'.repeat(40)]]);
      await answerAll(senior, review1, 'valid');
      // Round 2 checks no merge base, but the runner still needs the branch to read the rules at the merge base.
      await ask(senior, { baseSha: sha('1'), headSha: sha('2') });
      const second = await runSeats({ strong: { stdout: codexOut([]) }, 'cheap-claude': { stdout: claudeOut([]) } });
      expect(second.map((l) => [l.base_branch, l.expect_merge_base])).toEqual([['main', false], ['main', false]]);
    });

    it('takes ranges through the runner route, and a bad one does not fail the report', async () => {
      const app = buildServer(env.ctx, { ...(await testServerKeys()), webDir: '/nonexistent' });
      const post = async (id: string, body: object) => app.inject({ method: 'POST', url: `/api/runner/${id}/review-output`, headers: { authorization: `Bearer ${TEST_RUNNER_KEY}`, 'content-type': 'application/json' }, payload: JSON.stringify(body) });
      const { senior } = await setup();
      await afterRound1(senior);
      const r2 = await ask(senior, { baseSha: sha('1'), headSha: sha('2') });
      const launches: any[] = [];
      for (let l: any = await nextLaunch(env.ctx); l; l = await nextLaunch(env.ctx)) launches.push(l);
      expect(launches).toHaveLength(2);
      const out = (l: any) => (l.runtime === 'codex' ? codexOut([at('Somewhere', 'src/a.ts', 11)]) : claudeOut([]));
      expect((await post(launches[0].id, { code: 0, stdout: out(launches[0]), stderr: '', secs: 1, ranges: { not: 'a list' } })).statusCode).toBe(200);
      expect((await post(launches[1].id, { code: 0, stdout: out(launches[1]), stderr: '', secs: 1, ranges: delta, rules: { commit: 'not a sha' } })).statusCode).toBe(200);
      const review = (await getCodeReview(env.ctx, senior, r2.review_id)) as any;
      expect(review.status).toBe('done');
      expect(await query(env.ctx.pool, `SELECT run_id FROM code_review_run_deltas`)).not.toHaveLength(0);
      // Only the valid one was stored: a bad value is not kept anywhere.
      const stored = await query(env.ctx.pool, `SELECT d.ranges FROM code_review_run_deltas d JOIN code_review_runs r ON r.id = d.run_id WHERE r.review_id = ?`, [r2.review_id]);
      expect(stored).toHaveLength(1);
      await app.close();
    });
  });

  it('serves the output route to the runner key only', async () => {
    const app = buildServer(env.ctx, { ...(await testServerKeys()), webDir: '/nonexistent' });
    const payload = JSON.stringify({ code: 0, stdout: '', stderr: '', secs: 1 });
    const post = (headers: Record<string, string>) => app.inject({ method: 'POST', url: '/api/runner/lch_0000000000000000/review-output', headers: { 'content-type': 'application/json', ...headers }, payload });
    expect((await post({})).statusCode).toBe(401);
    expect((await post({ authorization: `Bearer ${TEST_ENROLLMENT_KEY}` })).statusCode).toBe(401);
    expect((await post({ authorization: `Bearer ${TEST_RUNNER_KEY}` })).statusCode).toBe(200);
    const bad = await app.inject({ method: 'POST', url: '/api/runner/lch_0000000000000000/review-output', headers: { authorization: `Bearer ${TEST_RUNNER_KEY}`, 'content-type': 'application/json' }, payload: JSON.stringify({ code: 0, stdout: 'x'.repeat(600_001), stderr: '', secs: 1 }) });
    expect(bad.statusCode).toBe(400);
    await app.close();
  });

  it('ignores an output for a launch that is not a code review', async () => {
    await recordReviewOutput(env.ctx, 'lch_doesnotexist0000', { code: 0, stdout: '{}', stderr: '', secs: 1 });
    await failReviewRun(env.ctx, 'crr_doesnotexist0000', 'gone');
  });
});
