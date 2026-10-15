import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { authenticate, registerAgent, type Agent } from '../src/agents.ts';
import { answerFinding, failReviewRun, getCodeReview, recordReviewOutput, requestCodeReview, timeoutReviewRuns } from '../src/code-review.ts';
import { exec, query, queryOne } from '../src/db.ts';
import { readEvents, STAFF_WAKE_TYPES } from '../src/events.ts';
import { createSpawnTicket, registerJob, updateJob } from '../src/jobs.ts';
import { recordHostRuntimes } from '../src/models.ts';
import { recordCodexBudget } from '../src/research.ts';
import { buildServer } from '../src/server.ts';
import { expireStaleLaunches, nextLaunch } from '../src/telemetry.ts';
import { createTestCtx, issue, TEST_DB_URL, TEST_ENROLLMENT_KEY, TEST_RUNNER_KEY, testServerKeys } from './helpers.ts';

const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const WT = '/home/dev/wt';
const finding = (extra: object = {}) => ({ severity: 'P1', title: 'Crash on an empty list', body: 'The loop reads items[0] when the list is empty.', sites: [{ file: 'src/a.ts', line: 10 }], ...extra });
const claudeOut = (findings: object[]) => JSON.stringify({ type: 'result', is_error: false, structured_output: { findings }, usage: { input_tokens: 100, output_tokens: 10 }, total_cost_usd: 0.02 });
const codexOut = (findings: object[]) =>
  [JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ findings }) } }), JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 5000, cached_input_tokens: 4000, output_tokens: 300 } })].join('\n');

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
  async function runSeats(outputs: Record<string, { code?: number; stdout: string; stderr?: string }>) {
    const seen: any[] = [];
    for (;;) {
      const l: any = await nextLaunch(env.ctx);
      if (!l) break;
      expect(l.kind).toBe('code_review');
      seen.push(l);
      const row = await queryOne(env.ctx.pool, `SELECT seat FROM code_review_runs WHERE id = ?`, [l.run_id]);
      const o = outputs[row!.seat as string] ?? { stdout: '' };
      await recordReviewOutput(env.ctx, l.id, { code: o.code ?? 0, stdout: o.stdout, stderr: o.stderr ?? '', secs: 12 });
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
      ['cheap-codex', 'codex', 'gpt-6-luna', 'low'],
    ]);
    const launch: any = await nextLaunch(env.ctx);
    expect(Object.keys(launch).sort()).toEqual(['base_sha', 'cwd', 'effort', 'head_sha', 'id', 'kind', 'model', 'prompt', 'run_id', 'runtime']);
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
      'cheap-codex': { stdout: codexOut([]) },
    });
    const review = (await getCodeReview(env.ctx, senior, r.review_id)) as any;
    expect(review).toMatchObject({ status: 'done', verdict: 'changes', same_family: false, round: 1 });
    expect(review.findings.map((f: any) => [f.severity, f.reviewer_count, f.reviewers])).toEqual([['P1', 2, ['strong', 'cheap-claude']], ['P3', 1, ['strong']]]);
    expect(review.seats.map((s: any) => [s.seat, s.status, s.family])).toEqual([['strong', 'done', 'codex'], ['cheap-claude', 'done', 'claude'], ['cheap-codex', 'done', 'codex']]);
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

  it('lets the Senior answer findings and recomputes the verdict', async () => {
    const { staff, senior } = await setup();
    const r = await ask(senior);
    await runSeats({ strong: { stdout: codexOut([finding(), finding({ severity: 'P2', title: 'Missing test for the parser', body: 'No test covers the new branch.', sites: [{ file: 'src/p.ts', line: 80 }] })]) }, 'cheap-claude': { stdout: claudeOut([]) }, 'cheap-codex': { stdout: codexOut([]) } });
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
    await runSeats({ strong: { code: 1, stdout: '', stderr: 'usage limit reached' }, 'cheap-claude': { stdout: 'not json' }, 'cheap-codex': { stdout: codexOut([]) } });
    const review = (await getCodeReview(env.ctx, senior, r.review_id)) as any;
    expect(review).toMatchObject({ status: 'failed', verdict: 'failed' });
    expect(review.failure).toMatch(/strong .*usage limit reached/);
    expect(review.failure).toMatch(/cheap-claude .*not JSON/);
    expect(review.seats.map((s: any) => s.status)).toEqual(['failed', 'failed', 'done']);
    expect(review.blocking).toEqual([]);
    const event = await queryOne(env.ctx.pool, `SELECT payload FROM events WHERE type = 'code_review.finished' ORDER BY id DESC LIMIT 1`);
    expect(JSON.parse(JSON.stringify(event!.payload))).toMatchObject({ status: 'failed', verdict: 'failed' });
  });

  it('fails a run that does not report within the timeout, and one whose launch expired unpicked', async () => {
    const { senior } = await setup();
    const r = await ask(senior);
    const first: any = await nextLaunch(env.ctx);
    await recordReviewOutput(env.ctx, first.id, { code: 0, stdout: codexOut([]), stderr: '', secs: 1 });
    env.clock.advance(11 * 60);
    await expireStaleLaunches(env.ctx);
    // The two launches nobody picked are dropped after 10 minutes, and their seats fail with it.
    let review = (await getCodeReview(env.ctx, senior, r.review_id)) as any;
    expect(review).toMatchObject({ status: 'failed' });
    // Which seat the runner took first depends on launch order inside one millisecond, so compare the sorted statuses.
    expect(review.seats.map((s: any) => s.status).sort()).toEqual(['done', 'failed', 'failed']);

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
    expect(r.dropped.map((d: any) => d.seat)).toEqual(['cheap-codex']);
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
    expect(await query(env.ctx.pool, `SELECT id FROM launches WHERE kind = 'code_review' AND finished_at IS NULL`)).toHaveLength(3);
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
    await runSeats({ strong: { stdout: codexOut([finding()]) }, 'cheap-claude': { stdout: claudeOut([]) }, 'cheap-codex': { stdout: codexOut([]) } });
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

  it('counts a review round per job', async () => {
    const { senior } = await setup();
    const a = await ask(senior);
    await exec(env.ctx.pool, `UPDATE code_reviews SET status = 'done' WHERE id = ?`, [a.review_id]);
    const b = await ask(senior, { headSha: 'e'.repeat(40) });
    expect(b.round).toBe(2);
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
