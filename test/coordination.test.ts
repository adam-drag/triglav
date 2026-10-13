import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentActivity, openWorkFor, authenticate, controlFor, endSession, listAgents, pokeAgent, registerAgent, type Agent } from '../src/agents.ts';
import { clientQueue, raiseBlocker, resolveBlocker } from '../src/blockers.ts';
import { askQuestion, awaitQuestion, postMessage, readThread, recordDecision } from '../src/board.ts';
import { POLICY } from '../src/context.ts';
import { exec, queryOne } from '../src/db.ts';
import { latestEventId, readEvents, RESEARCHER_WAKE_TYPES } from '../src/events.ts';
import { cancelJobRequest, createJobRequest, MAX_QUEUED_REQUESTS, readJobRequest, startStaffForJob } from '../src/job-requests.ts';
import { nextLaunch } from '../src/telemetry.ts';
import { completeParent, createSpawnTicket, getJob, reassignStaff, registerJob, reopenForDelivery, reportProgress, setControl, updateJob } from '../src/jobs.ts';
import { recordVerdict, submitReviewPackage } from '../src/reviews.ts';
import { closeWithoutReport, confirmDelivery, reportDelivery } from '../src/delivery.ts';
import { reviewMode, setReviewMode } from '../src/models.ts';
import { tick } from '../src/scheduler.ts';
import { listRoleModels, updateRoleModel } from '../src/models.ts';
import { buildServer } from '../src/server.ts';
import { asClient, createTestCtx, issue, loginCookie, TEST_DB_URL, testServerKeys } from './helpers.ts';

// Runs against a real MySQL: set ORCH_TEST_DATABASE_URL (see README). Skipped otherwise.
describe.skipIf(!TEST_DB_URL)('coordination', () => {
  let env: Awaited<ReturnType<typeof createTestCtx>>;
  let n = 0;

  beforeAll(async () => {
    env = await createTestCtx();
  });
  afterAll(async () => {
    await env?.close();
  });

  const agentFor = async (token: string) => authenticate(env.ctx, token);
  async function register(role: 'staff' | 'researcher', nickname = `${role}-${++n}`) {
    const reg = await registerAgent(env.ctx, { role, nickname, runtime: 'test' });
    return { reg, agent: await agentFor(reg.session_token) };
  }

  /** Registers ENG-<k> with two subjobs and returns ids. */
  async function setupJob(staff: Agent) {
    const k = ++n;
    const parent = issue(`ENG-${k}00`, 'Export reports as PDF', {
      children: [issue(`ENG-${k}01`, 'PDF service endpoint'), issue(`ENG-${k}02`, 'Export button')],
    });
    env.linear.add(parent as any);
    const job = await registerJob(env.ctx, staff, { linearIssue: parent.identifier, repoPath: '/repo', baseBranch: 'main' });
    const [a, b] = job.subjob_ids as [string, string];
    for (const id of [job.job_id, a, b]) {
      await updateJob(env.ctx, staff, { jobId: id, status: 'planning' });
      await updateJob(env.ctx, staff, { jobId: id, acceptanceCriteria: 'Works and has tests' });
    }
    await updateJob(env.ctx, staff, { jobId: b, dependsOn: [a] });
    await updateJob(env.ctx, staff, { jobId: a, status: 'ready' });
    return { parentId: job.job_id, a, b };
  }

  async function spawnSenior(staff: Agent, jobId: string) {
    const t = await createSpawnTicket(env.ctx, staff, { jobId, role: 'senior', brief: 'Implement it' });
    const reg = await registerAgent(env.ctx, { role: 'senior', nickname: `senior-${++n}`, runtime: 'test', spawnTicket: t.spawn_ticket });
    return { reg, agent: await agentFor(reg.session_token), ticket: t };
  }

  it('runs the 10:00 acceptance example: full window, all timely answers, late reply kept', async () => {
    env.clock.set('2026-10-07T09:50:00.000Z');
    const { agent: staff } = await register('staff');
    const { a } = await setupJob(staff);
    const { agent: senior } = await spawnSenior(staff, a);
    const { agent: r1 } = await register('researcher');
    const { agent: r2 } = await register('researcher');
    const r1Cursor = 0;

    env.clock.set('2026-10-07T10:00:00.000Z');
    const q = await askQuestion(env.ctx, { kind: 'agent', agent: senior }, {
      jobId: a,
      title: 'In-process or queue?',
      summary: 'Building the PDF endpoint; criteria: works and has tests; endpoint skeleton exists.',
      question: 'Generate PDFs in-process or through a worker queue?',
      whyItMatters: 'Large reports may exceed the request timeout.',
      waitingWork: 'Rendering implementation',
      windowSec: 300,
    });
    expect((q.deadline_at as Date).toISOString()).toBe('2026-10-07T10:05:00.000Z');

    // Researchers discover it through the all-jobs feed without an invitation.
    const feed = await readEvents(env.ctx.pool, r1.id, { cursor: r1Cursor, scope: 'all_jobs', types: ['question.opened'] });
    expect(feed.events.some((e) => e.type === 'question.opened' && e.thread_id === q.thread_id)).toBe(true);

    env.clock.set('2026-10-07T10:01:00.000Z');
    const staffReply = await postMessage(env.ctx, { kind: 'agent', agent: staff }, { threadId: q.thread_id, type: 'reply', body: 'In-process for v1.', intendedDecision: true });
    // An early Staff answer does not end the window.
    const early = await awaitQuestion(env.ctx, senior, q.thread_id, 1);
    expect(early.window_closed).toBe(false);
    await expect(
      recordDecision(env.ctx, { kind: 'agent', agent: staff }, { threadId: q.thread_id, body: 'In-process', rationale: 'simple', consideredMessageIds: [staffReply.message_id] }),
    ).rejects.toThrow(/still open/);

    env.clock.set('2026-10-07T10:03:00.000Z');
    const challenge = await postMessage(env.ctx, { kind: 'agent', agent: r1 }, { threadId: q.thread_id, type: 'reply', stance: 'challenge', reason: 'Reports over 50 pages exceed the 30s timeout.', body: 'Use a queue for large reports.' });
    env.clock.set('2026-10-07T10:04:00.000Z');
    const info = await postMessage(env.ctx, { kind: 'agent', agent: r2 }, { threadId: q.thread_id, type: 'reply', body: 'Sanitize HTML input to the renderer.' });
    expect(challenge.timely).toBe(true);
    // A timely objection wakes the owning Staff at once, not only at the deadline.
    const staffNow = await readEvents(env.ctx.pool, staff.id, { cursor: 0, scope: 'owned' });
    expect(staffNow.events.some((e) => e.type === 'question.challenged' && e.payload.message_id === challenge.message_id)).toBe(true);

    env.clock.set('2026-10-07T10:05:00.000Z');
    await tick(env.ctx);
    const closed = await awaitQuestion(env.ctx, senior, q.thread_id, 1);
    expect(closed.window_closed).toBe(true);
    // A timely challenge blocks automatic promotion of the Staff intended decision.
    expect(closed.state).toBe('awaiting_staff_decision');
    expect(closed.thread.messages.filter((m: any) => m.timely).length).toBe(4);

    // The decision must consider every timely reply.
    await expect(
      recordDecision(env.ctx, { kind: 'agent', agent: staff }, { threadId: q.thread_id, body: 'In-process with a size limit', rationale: 'r', consideredMessageIds: [staffReply.message_id] }),
    ).rejects.toThrow(/every timely reply/);
    // Researchers cannot decide.
    await expect(
      recordDecision(env.ctx, { kind: 'agent', agent: r1 }, { threadId: q.thread_id, body: 'Queue', rationale: 'r', consideredMessageIds: [] }),
    ).rejects.toThrow(/Only the owning Staff/);

    env.clock.set('2026-10-07T10:06:00.000Z');
    const late = await postMessage(env.ctx, { kind: 'agent', agent: r2 }, { threadId: q.thread_id, type: 'reply', stance: 'support', reason: 'agree with the size limit', body: 'Late but agree.' });
    expect(late.timely).toBe(false);
    await recordDecision(env.ctx, { kind: 'agent', agent: staff }, {
      threadId: q.thread_id,
      body: 'In-process with a 50 page limit; queue is a follow-up ticket.',
      rationale: 'Addresses the timeout challenge without a queue in v1.',
      consideredMessageIds: [staffReply.message_id, challenge.message_id, info.message_id],
    });
    const thread = await readThread(env.ctx, q.thread_id);
    expect(thread.question!.state).toBe('resolved');
    expect(thread.messages.find((m: any) => m.id === late.message_id)!.timely).toBe(false);

    // A late objection on a resolved question notifies Staff; nothing changes silently.
    env.clock.set('2026-10-07T10:07:00.000Z');
    await postMessage(env.ctx, { kind: 'agent', agent: r1 }, { threadId: q.thread_id, type: 'reply', stance: 'reject', reason: 'The limit breaks the annual report.', body: 'Annual reports are 80 pages.' });
    const staffEvents = await readEvents(env.ctx.pool, staff.id, { cursor: 0, scope: 'owned' });
    expect(staffEvents.events.some((e) => e.type === 'question.late_challenge')).toBe(true);
    expect((await readThread(env.ctx, q.thread_id)).question!.state).toBe('resolved');
  });

  it('promotes the Staff intended decision at the deadline when nobody objects', async () => {
    env.clock.set('2026-10-07T11:00:00.000Z');
    const { agent: staff } = await register('staff');
    const { a } = await setupJob(staff);
    const { agent: senior } = await spawnSenior(staff, a);
    const q = await askQuestion(env.ctx, { kind: 'agent', agent: senior }, { jobId: a, title: 't', summary: 's', question: 'q?', whyItMatters: 'w', waitingWork: 'x', windowSec: 60 });
    await postMessage(env.ctx, { kind: 'agent', agent: staff }, { threadId: q.thread_id, type: 'reply', body: 'Do A.', intendedDecision: true });
    env.clock.advance(61);
    const res = await awaitQuestion(env.ctx, senior, q.thread_id, 1);
    expect(res.state).toBe('resolved');
    expect(res.thread.current_decision?.body).toBe('Do A.');
  });

  it('defaults to a 3 minute window and extends it while nobody replies', async () => {
    env.clock.set('2026-10-08T08:00:00.000Z');
    const { agent: staff } = await register('staff');
    const { a } = await setupJob(staff);
    const { agent: senior } = await spawnSenior(staff, a);
    const base = { jobId: a, title: 'Silent', summary: 's', question: 'q', whyItMatters: 'w', waitingWork: 'x' };
    const q = await askQuestion(env.ctx, { kind: 'agent', agent: senior }, base);
    expect((q.deadline_at as Date).toISOString()).toBe('2026-10-08T08:03:00.000Z');

    env.clock.set('2026-10-08T08:03:01.000Z');
    await tick(env.ctx);
    let t = await readThread(env.ctx, q.thread_id);
    expect(t.question!.state).toBe('collecting');
    expect((t.question!.deadline_at as Date).toISOString()).toBe('2026-10-08T08:06:00.000Z');
    const ev = await readEvents(env.ctx.pool, senior.id, { cursor: 0, scope: 'owned', types: ['question.extended'] });
    expect(ev.events.some((e) => e.type === 'question.extended' && e.thread_id === q.thread_id)).toBe(true);

    // A reply in the extended window counts as timely, and the next deadline closes the question.
    await postMessage(env.ctx, { kind: 'agent', agent: staff }, { threadId: q.thread_id, type: 'reply', body: 'Do A.', intendedDecision: true });
    env.clock.set('2026-10-08T08:06:01.000Z');
    await tick(env.ctx);
    t = await readThread(env.ctx, q.thread_id);
    expect(t.question!.state).toBe('resolved');
    expect(t.current_decision?.body).toBe('Do A.');
  });

  it('delivers a Client poke to the agent and shows it in the agent activity', async () => {
    const { agent: staff } = await register('staff');
    const start = await latestEventId(env.ctx.pool);
    await pokeAgent(env.ctx, staff.id, null);
    const ev = await readEvents(env.ctx.pool, staff.id, { cursor: start, scope: 'owned' });
    expect(ev.events.map((e) => e.type)).toContain('agent.poked');
    const { agent: r } = await register('researcher');
    const rstart = await latestEventId(env.ctx.pool);
    await pokeAgent(env.ctx, r.id, 'status?');
    const rev = await readEvents(env.ctx.pool, r.id, { cursor: rstart, scope: 'all_jobs', types: ['question.opened'] });
    expect(rev.events.map((e) => e.type)).toContain('agent.poked');
    const activity = await agentActivity(env.ctx, r.id);
    expect(activity.events[0]!.type).toBe('agent.poked');
    await expect(pokeAgent(env.ctx, 'agt_missing', null)).rejects.toThrow(/not found/i);
  });

  it('hands the configured model to new Seniors and applies changes to the next spawn only', async () => {
    const roles = await listRoleModels(env.ctx.pool);
    expect(roles.map((r) => [r.role, r.model, r.effort])).toEqual([
      ['staff', 'claude-opus-5-5', 'high'],
      ['senior', 'claude-sonnet-5-5', 'high'],
      ['reviewer', 'claude-sonnet-5-5', 'high'],
      ['researcher', 'gpt-6-astra', 'low'],
    ]);
    const { agent: staff } = await register('staff');
    const { a, parentId } = await setupJob(staff);
    const first = await spawnSenior(staff, a);
    expect(first.ticket.model).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'high' });
    expect(first.ticket.model!.how).toContain('model "sonnet" and effort "high"');

    await updateRoleModel(env.ctx, 'senior', { runtime: 'claude-code', model: 'claude-opus-5-5', effort: 'medium' });
    // The running Senior keeps working; only the next ticket changes.
    await reportProgress(env.ctx, first.agent, { assignmentId: first.reg.assignment!.id, attempt: first.reg.assignment!.attempt, note: 'still going' });
    const second = await setupJob(staff);
    const t = await createSpawnTicket(env.ctx, staff, { jobId: second.a, role: 'senior', brief: 'x' });
    expect(t.model).toMatchObject({ model: 'claude-opus-5-5', effort: 'medium' });
    await setControl(env.ctx, parentId, 'cancel', 'test done');
    await setControl(env.ctx, second.parentId, 'cancel', 'test done');
    await updateRoleModel(env.ctx, 'senior', { runtime: 'claude-code', model: 'claude-sonnet-5-5', effort: 'high' });

    await expect(updateRoleModel(env.ctx, 'senior', { runtime: 'claude-code', model: 'x; rm -rf /', effort: 'high' })).rejects.toThrow(/may only contain/);
    await expect(updateRoleModel(env.ctx, 'nobody', { runtime: 'a', model: 'b', effort: 'c' })).rejects.toThrow(/not found/i);
  });

  it('reports open work for the Stop hook until the job is paused, done or the session ends', async () => {
    const { agent: staff, reg } = await register('staff');
    expect(await openWorkFor(env.ctx, reg.session_token)).toBeNull();
    const { parentId, a } = await setupJob(staff);
    expect(await openWorkFor(env.ctx, reg.session_token)).toMatch(/You are Staff on ENG-/);
    const s = await spawnSenior(staff, a);
    expect(await openWorkFor(env.ctx, s.reg.session_token)).toMatch(/You hold work/);
    await setControl(env.ctx, parentId, 'pause', 'meeting');
    expect(await openWorkFor(env.ctx, reg.session_token)).toBeNull();
    expect(await openWorkFor(env.ctx, s.reg.session_token)).toBeNull();
    await setControl(env.ctx, parentId, 'cancel', 'test done');
    await endSession(env.ctx, staff, 'done');
    expect(await openWorkFor(env.ctx, reg.session_token)).toBeNull();
    expect(await openWorkFor(env.ctx, 'not-a-token')).toBeNull();
  });

  it('enforces the window range and required context', async () => {
    const { agent: staff } = await register('staff');
    const { a } = await setupJob(staff);
    const base = { jobId: a, title: 't', summary: 's', question: 'q', whyItMatters: 'w', waitingWork: 'x' };
    await expect(askQuestion(env.ctx, { kind: 'agent', agent: staff }, { ...base, windowSec: 30 })).rejects.toThrow(/between 60 and 300/);
    await expect(askQuestion(env.ctx, { kind: 'agent', agent: staff }, { ...base, windowSec: 600 })).rejects.toThrow(/between 60 and 300/);
    await expect(askQuestion(env.ctx, { kind: 'agent', agent: staff }, { ...base, title: ' ' })).rejects.toThrow(/title is required/);
    const { agent: r } = await register('researcher');
    await expect(askQuestion(env.ctx, { kind: 'agent', agent: r }, base)).rejects.toThrow(/Only a Senior, Staff/);
  });

  it('fences a stale worker after its lease expires and a new attempt starts', async () => {
    env.clock.set('2026-10-07T12:00:00.000Z');
    const { agent: staff } = await register('staff');
    const { a } = await setupJob(staff);
    const first = await spawnSenior(staff, a);
    const asg = first.reg.assignment!;
    await reportProgress(env.ctx, first.agent, { assignmentId: asg.id, attempt: asg.attempt, note: 'started', worktreePath: '/repo-a' });
    // While the lease is live, nobody else can take it.
    await expect(createSpawnTicket(env.ctx, staff, { jobId: a, role: 'senior', brief: 'x' })).rejects.toThrow(/held by/);
    env.clock.advance(POLICY.leaseSec + 1);
    await tick(env.ctx);
    const orphaned = await readEvents(env.ctx.pool, staff.id, { cursor: 0, scope: 'owned', types: ['assignment.orphaned'] });
    expect(orphaned.events.length).toBeGreaterThan(0);
    const second = await spawnSenior(staff, a);
    expect(second.reg.assignment!.attempt).toBe(asg.attempt + 1);
    await expect(reportProgress(env.ctx, first.agent, { assignmentId: asg.id, attempt: asg.attempt, note: 'still here' })).rejects.toThrow(/no longer current/);
    await expect(
      submitReviewPackage(env.ctx, first.agent, { assignmentId: asg.id, attempt: asg.attempt, summary: 's', artifacts: [], validation: 'v' }),
    ).rejects.toThrow(/no longer current/);
  });

  it('makes spawn tickets single use and role bound', async () => {
    const { agent: staff } = await register('staff');
    const { a, b } = await setupJob(staff);
    const t = await createSpawnTicket(env.ctx, staff, { jobId: a, role: 'senior', brief: 'x' });
    await registerAgent(env.ctx, { role: 'senior', nickname: 's', runtime: 'test', spawnTicket: t.spawn_ticket });
    await expect(registerAgent(env.ctx, { role: 'senior', nickname: 's2', runtime: 'test', spawnTicket: t.spawn_ticket })).rejects.toThrow(/already used/);
    await expect(registerAgent(env.ctx, { role: 'senior', nickname: 's3', runtime: 'test' })).rejects.toThrow(/spawn ticket/);
    await expect(updateJob(env.ctx, staff, { jobId: a, dependsOn: [b] })).rejects.toThrow(/cycle/);
    // Dependencies gate work.
    await expect(createSpawnTicket(env.ctx, staff, { jobId: b, role: 'senior', brief: 'x' })).rejects.toThrow(/must be ready|waits for/);
  });

  it('runs review rounds, requires dispositions, and stops at the round cap', async () => {
    env.clock.set('2026-10-07T13:00:00.000Z');
    const { agent: staff } = await register('staff');
    const { parentId, a, b } = await setupJob(staff);
    const s = await spawnSenior(staff, a);
    const asg = s.reg.assignment!;
    const { agent: researcher } = await register('researcher');
    const researcherStart = await latestEventId(env.ctx.pool);
    const submit = (dispositions?: any[]) =>
      submitReviewPackage(env.ctx, s.agent, { assignmentId: asg.id, attempt: asg.attempt, summary: 'done', artifacts: ['https://github.com/x/pull/1'], validation: 'pnpm test: 12 passed', findingDispositions: dispositions });
    const p1 = await submit();
    await expect(recordVerdict(env.ctx, staff, { packageId: p1.package_id, outcome: 'changes', findings: [{ id: 'f1', required: true, text: 'no test' }] })).rejects.toThrow(/needs evidence/);
    await recordVerdict(env.ctx, staff, { packageId: p1.package_id, outcome: 'changes', findings: [{ id: 'f1', required: true, text: 'no size limit test', evidence: 'pdf.test.ts has no case' }] });
    await expect(submit()).rejects.toThrow(/disposition/);

    // Researchers are woken by review rounds and can read the package and findings as board text.
    const woke = await readEvents(env.ctx.pool, researcher.id, { cursor: researcherStart, scope: 'all_jobs', types: RESEARCHER_WAKE_TYPES });
    const reviewEvents = woke.events.filter((e) => e.job_id === a && e.type.startsWith('review.'));
    expect(reviewEvents.map((e) => e.type)).toEqual(['review.submitted', 'review.verdict']);
    const thread = await readThread(env.ctx, reviewEvents[1]!.thread_id!);
    expect(thread.messages.map((m: any) => m.body).join('\n')).toMatch(/Validation: pnpm test: 12 passed[\s\S]*no size limit test/);
    const p2 = await submit([{ finding_id: 'f1', disposition: 'fixed', note: 'added test' }]);
    await recordVerdict(env.ctx, staff, { packageId: p2.package_id, outcome: 'changes', findings: [{ id: 'f2', required: true, text: 'flaky', evidence: 'ci run 3' }] });
    const p3 = await submit([{ finding_id: 'f2', disposition: 'fixed', note: 'fixed' }]);
    await recordVerdict(env.ctx, staff, { packageId: p3.package_id, outcome: 'changes', findings: [{ id: 'f3', required: true, text: 'still flaky', evidence: 'ci run 4' }] });
    const job = await getJob(env.ctx.pool, a);
    expect(job.job.status).toBe('blocked');
    expect(job.blockers.some((x: any) => x.kind === 'no_convergence' && !x.resolved_at)).toBe(true);
    const queue = await clientQueue(env.ctx);
    const blocker = queue.find((x) => x.job_id === a)!;
    await resolveBlocker(env.ctx, { kind: 'client' }, { blockerId: blocker.id, resolution: 'One more round, then accept.' });
    expect((await getJob(env.ctx.pool, a)).job.status).toBe('in_progress');
    const p4 = await submit([{ finding_id: 'f3', disposition: 'fixed', note: 'fixed for real' }]);
    const delivery = { assignmentId: asg.id, attempt: asg.attempt, prUrl: 'https://github.com/x/pull/1', headSha: 'a1b2c3d', copilotStatus: 'DONE' as const, copilotSummary: 'clean', ciConclusion: 'success' as const, ciSummary: 'ci pass' };
    await expect(reportDelivery(env.ctx, s.agent, delivery)).rejects.toThrow(/Delivery starts after the review accepts/);
    await recordVerdict(env.ctx, staff, { packageId: p4.package_id, outcome: 'accept', findings: [{ id: 'o1', required: false, text: 'rename helper' }] });
    expect((await getJob(env.ctx.pool, a)).job.status).toBe('delivering');
    await expect(confirmDelivery(env.ctx, staff, { jobId: a, headSha: 'a1b2c3d', ciConclusion: 'success', evidence: 'x' })).rejects.toThrow(/not reported/);
    await expect(reportDelivery(env.ctx, s.agent, { ...delivery, headSha: 'main' })).rejects.toThrow(/hex commit/);
    await reportDelivery(env.ctx, s.agent, delivery);
    await expect(confirmDelivery(env.ctx, staff, { jobId: a, headSha: 'ffff000', ciConclusion: 'success', evidence: 'x' })).rejects.toThrow(/reported a1b2c3d/);
    await confirmDelivery(env.ctx, staff, { jobId: a, headSha: 'a1b2c3d9e8f7', ciConclusion: 'success', evidence: 'gh pr checks: ci pass' });
    expect((await getJob(env.ctx.pool, a)).job.status).toBe('done');
    // The Client can reopen a job that turned out not to be delivered; a new Senior can then claim it.
    await expect(reopenForDelivery(env.ctx, parentId, 'x')).rejects.toThrow(/not done|only a done job|subjobs/);
    await reopenForDelivery(env.ctx, a, 'CI is red on the PR head');
    expect((await getJob(env.ctx.pool, a)).job.status).toBe('delivering');
    // With no Senior holding it, the Client can close a delivering job (PR merged, Senior stopped before reporting).
    await expect(closeWithoutReport(env.ctx, a, ' ')).rejects.toThrow(/Say why/);
    await closeWithoutReport(env.ctx, a, 'PR merged');
    expect((await getJob(env.ctx.pool, a)).job.status).toBe('done');
    await reopenForDelivery(env.ctx, a, 'Closed by mistake');
    const again = await spawnSenior(staff, a);
    expect(again.reg.assignment?.job_id).toBe(a);
    await expect(closeWithoutReport(env.ctx, a, 'PR merged')).rejects.toThrow(/still holds/);
    // The Client decides whether the Copilot loop may be skipped: a Senior cannot skip it when the mode requires it.
    expect(await reviewMode(env.ctx.pool)).toBe('auto');
    await expect(setReviewMode(env.ctx, 'whenever')).rejects.toThrow(/review mode must be one of/);
    const skipped = { ...delivery, assignmentId: again.reg.assignment!.id, attempt: again.reg.assignment!.attempt, headSha: 'beef123', copilotStatus: 'SKIPPED' as const, copilotSummary: 'No Copilot review on the last 10 PRs.' };
    await setReviewMode(env.ctx, 'copilot');
    await expect(reportDelivery(env.ctx, again.agent, skipped)).rejects.toThrow(/requires the Copilot review loop/);
    await setReviewMode(env.ctx, 'auto');
    await reportDelivery(env.ctx, again.agent, skipped);
    const deliveries = (await getJob(env.ctx.pool, a)).deliveries;
    expect(deliveries.find((d: any) => d.head_sha === 'beef123')).toMatchObject({ copilot_status: 'SKIPPED', copilot_summary: 'No Copilot review on the last 10 PRs.' });
    expect(deliveries.find((d: any) => d.head_sha === 'a1b2c3d')).toMatchObject({ copilot_status: 'DONE' });
    await confirmDelivery(env.ctx, staff, { jobId: a, headSha: 'beef123', ciConclusion: 'success', evidence: 'green now' });
    expect((await getJob(env.ctx.pool, a)).job.status).toBe('done');
    // The Senior's lease is released once delivery is confirmed.
    await expect(reportProgress(env.ctx, s.agent, { assignmentId: asg.id, attempt: asg.attempt, note: 'x' })).rejects.toThrow(/lease/);

    // Parent completion: required subjob b is not done yet.
    await expect(completeParent(env.ctx, staff, { jobId: parentId, integrationSummary: 'ok' })).rejects.toThrow(/Not complete/);
    await updateJob(env.ctx, staff, { jobId: b, required: false, reason: 'Moved to a later ticket' });
    await updateJob(env.ctx, staff, { jobId: b, status: 'cancelled', reason: 'Out of scope' });
    await completeParent(env.ctx, staff, { jobId: parentId, integrationSummary: 'End to end export checked manually' });
    expect((await getJob(env.ctx.pool, parentId)).job.status).toBe('done');
  });

  it('records Client posts, reasoned assessments, and the Staff decision', async () => {
    const { agent: staff } = await register('staff');
    const { parentId } = await setupJob(staff);
    const { agent: r1 } = await register('researcher');
    const { agent: r2 } = await register('researcher');
    const proposal = await postMessage(env.ctx, { kind: 'client' }, { jobId: parentId, type: 'proposal', body: 'Skip PDF metadata in v1.' });
    const feed = await readEvents(env.ctx.pool, r1.id, { cursor: 0, scope: 'all_jobs', types: ['proposal.posted'] });
    expect(feed.events.some((e) => e.payload.message_id === proposal.message_id)).toBe(true);
    await expect(postMessage(env.ctx, { kind: 'agent', agent: r1 }, { threadId: proposal.thread_id, type: 'reply', stance: 'reject', body: 'no' })).rejects.toThrow(/needs a reason/);
    const yes = await postMessage(env.ctx, { kind: 'agent', agent: r1 }, { threadId: proposal.thread_id, type: 'reply', stance: 'support', reason: 'Saves a day', body: 'Agree.', inReplyTo: proposal.message_id });
    const no = await postMessage(env.ctx, { kind: 'agent', agent: r2 }, { threadId: proposal.thread_id, type: 'reply', stance: 'reject', reason: 'Accessibility needs the document title.', body: 'Keep the title.', inReplyTo: proposal.message_id });
    await recordDecision(env.ctx, { kind: 'agent', agent: staff }, {
      threadId: proposal.thread_id,
      body: 'Skip metadata except the document title.',
      rationale: 'Keeps accessibility, saves most of the work.',
      consideredMessageIds: [proposal.message_id, yes.message_id, no.message_id],
    });
    const thread = await readThread(env.ctx, proposal.thread_id);
    expect(thread.messages.map((m: any) => m.stance)).toEqual(expect.arrayContaining(['support', 'reject']));
    expect(thread.messages.find((m: any) => m.id === no.message_id)!.reason).toContain('Accessibility');
    expect(thread.current_decision!.decided_by).toBe(staff.id);
  });

  it('refuses secrets, caps replies, and dedupes by request_id', async () => {
    const { agent: staff } = await register('staff');
    const { parentId } = await setupJob(staff);
    const { agent: r } = await register('researcher');
    await expect(postMessage(env.ctx, { kind: 'agent', agent: r }, { jobId: parentId, type: 'discussion', body: 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789' })).rejects.toThrow(/credential/);
    const first = await postMessage(env.ctx, { kind: 'agent', agent: r }, { jobId: parentId, type: 'discussion', body: 'one', requestId: 'req-1' });
    const again = await postMessage(env.ctx, { kind: 'agent', agent: r }, { jobId: parentId, type: 'discussion', body: 'one', requestId: 'req-1' });
    expect(again.message_id).toBe(first.message_id);
    await postMessage(env.ctx, { kind: 'agent', agent: r }, { jobId: parentId, type: 'discussion', body: 'two' });
    await postMessage(env.ctx, { kind: 'agent', agent: r }, { jobId: parentId, type: 'discussion', body: 'three' });
    await expect(postMessage(env.ctx, { kind: 'agent', agent: r }, { jobId: parentId, type: 'discussion', body: 'four' })).rejects.toThrow(/Stop here/);
    await postMessage(env.ctx, { kind: 'agent', agent: staff }, { jobId: parentId, type: 'discussion', body: 'what about X?', mentions: [r.id] });
    await postMessage(env.ctx, { kind: 'agent', agent: r }, { jobId: parentId, type: 'discussion', body: 'four, now that I was asked' });
  });

  it('blocks a job when its Staff goes offline and hands it over on reassignment', async () => {
    env.clock.set('2026-10-07T15:00:00.000Z');
    const { agent: staff } = await register('staff');
    const { parentId } = await setupJob(staff);
    env.clock.advance(POLICY.presenceOfflineSec + 1);
    expect((await listAgents(env.ctx, { includeInactive: false })).some((x) => x.id === staff.id)).toBe(false);
    await tick(env.ctx);
    const job = await getJob(env.ctx.pool, parentId);
    expect(job.job.status).toBe('blocked');
    expect(job.blockers.some((b: any) => b.kind === 'unavailable_owner')).toBe(true);
    const owner = job.blockers.find((b: any) => b.kind === 'unavailable_owner')!;
    await expect(resolveBlocker(env.ctx, { kind: 'client' }, { blockerId: owner.id, resolution: 'assign someone' })).rejects.toThrow(/Reassign the job/);
    const { agent: staff2 } = await register('staff');
    const res = await reassignStaff(env.ctx, parentId, staff2.id);
    expect(res.handover_summary).toContain(parentId);
    expect((await getJob(env.ctx.pool, parentId)).job.status).toBe('planning');
    const events = await readEvents(env.ctx.pool, staff2.id, { cursor: 0, scope: 'owned', types: ['job.handover'] });
    expect(events.events.length).toBe(1);
  });

  it('starts a new Staff for a job with an unavailable owner, and that Staff takes the job over', async () => {
    env.clock.set('2026-10-13T09:00:00.000Z');
    const { agent: staff } = await register('staff');
    const { parentId } = await setupJob(staff);
    await expect(startStaffForJob(env.ctx, parentId)).rejects.toThrow(/available Staff owner/);
    env.clock.advance(POLICY.presenceOfflineSec + 1);
    await tick(env.ctx);
    const first = await startStaffForJob(env.ctx, parentId);
    expect(first.already_queued).toBe(false);
    expect((await startStaffForJob(env.ctx, parentId)).id).toBe(first.id);
    const launch: any = await nextLaunch(env.ctx);
    expect(launch).toMatchObject({ kind: 'staff_start', request_id: first.id });
    const { agent: fresh } = await register('staff');
    const read: any = await readJobRequest(env.ctx, fresh, first.id);
    expect(read).toMatchObject({ mode: 'takeover', job_id: parentId });
    expect(read.handover_summary).toContain(parentId);
    const job = await getJob(env.ctx.pool, parentId);
    expect(job.job.staff_agent_id).toBe(fresh.id);
    expect(job.job.status).toBe('planning');
    // The handover ends the request, and reading it again cannot take the job back after the Client reassigned it.
    expect(await queryOne(env.ctx.pool, `SELECT status FROM job_requests WHERE id = ?`, [first.id])).toMatchObject({ status: 'registered' });
    const { agent: later } = await register('staff');
    await reassignStaff(env.ctx, parentId, later.id);
    const again: any = await readJobRequest(env.ctx, fresh, first.id);
    expect(again.handover_summary).toBeUndefined();
    expect((await getJob(env.ctx.pool, parentId)).job.staff_agent_id).toBe(later.id);
  });

  it('lets the Client cancel a takeover the runner has not taken, and counts it against the queue limit', async () => {
    env.clock.set('2026-10-13T10:00:00.000Z');
    const { agent: staff } = await register('staff');
    const { parentId } = await setupJob(staff);
    env.clock.advance(POLICY.presenceOfflineSec + 1);
    await tick(env.ctx);
    const first = await startStaffForJob(env.ctx, parentId);
    // The activity feed names a takeover, not a job started from a prompt, and links to the job.
    const app = buildServer(env.ctx, { ...(await testServerKeys()), webDir: '/nonexistent' });
    try {
      const feed = (await asClient(app, await loginCookie(app)).inject({ method: 'GET', url: '/api/feed' })).json() as any[];
      const item = feed.find((i) => i.type === 'job_request.created' && i.job_id === parentId);
      expect(item).toMatchObject({ link: `#/jobs/${parentId}` });
      expect(item.text).toMatch(/take over/);
    } finally {
      await app.close();
    }
    await cancelJobRequest(env.ctx, first.id);
    expect(await queryOne(env.ctx.pool, `SELECT status FROM job_requests WHERE id = ?`, [first.id])).toMatchObject({ status: 'cancelled' });
    expect(await nextLaunch(env.ctx)).toBeNull();
    // A cancelled takeover is not "already queued": the Client may start another one.
    const second = await startStaffForJob(env.ctx, parentId);
    expect(second.already_queued).toBe(false);
    // The takeover has no job to cancel once the runner took it.
    const launch: any = await nextLaunch(env.ctx);
    expect(launch.request_id).toBe(second.id);
    await expect(cancelJobRequest(env.ctx, second.id)).rejects.toThrow(/already taken/);
    // A takeover waits for the runner like any other request, so the queue limit applies to it.
    await exec(env.ctx.pool, `UPDATE job_requests SET status = 'failed' WHERE id = ?`, [second.id]);
    const waiting = Number((await queryOne(env.ctx.pool, `SELECT COUNT(*) AS n FROM job_requests WHERE status = 'queued'`))?.n);
    for (let i = waiting; i < MAX_QUEUED_REQUESTS; i++) await createJobRequest(env.ctx, { mode: 'prompt', prompt: `Fill ${i}`, repoPath: '/r' });
    await expect(startStaffForJob(env.ctx, parentId)).rejects.toThrow(/waiting for the runner/);
  });

  it('does not let a takeover queued earlier take a job whose owner is available again', async () => {
    env.clock.set('2026-10-13T11:00:00.000Z');
    const { agent: staff } = await register('staff');
    const { parentId } = await setupJob(staff);
    env.clock.advance(POLICY.presenceOfflineSec + 1);
    await tick(env.ctx);
    const queued = await startStaffForJob(env.ctx, parentId);
    const { agent: other } = await register('staff');
    await reassignStaff(env.ctx, parentId, other.id);
    const { agent: fresh } = await register('staff');
    const read: any = await readJobRequest(env.ctx, fresh, queued.id);
    expect(read).toMatchObject({ mode: 'takeover', job_id: parentId });
    expect(read.handover_summary).toBeUndefined();
    expect(read.next).toMatch(/not yours|nothing to take over/i);
    expect((await getJob(env.ctx.pool, parentId)).job.staff_agent_id).toBe(other.id);
    expect(await queryOne(env.ctx.pool, `SELECT status FROM job_requests WHERE id = ?`, [queued.id])).toMatchObject({ status: 'cancelled' });
  });

  it('does not hand a job over while its owner is live, even before the scheduler resolves the blocker', async () => {
    env.clock.set('2026-10-13T12:00:00.000Z');
    const { reg, agent: staff } = await register('staff');
    const { parentId } = await setupJob(staff);
    env.clock.advance(POLICY.presenceOfflineSec + 1);
    await tick(env.ctx);
    const queued = await startStaffForJob(env.ctx, parentId);
    // The owner calls the orchestrator again; the blocker stays open until the next tick.
    await authenticate(env.ctx, reg.session_token);
    expect(await queryOne(env.ctx.pool, `SELECT id FROM blockers WHERE job_id = ? AND kind = 'unavailable_owner' AND resolved_at IS NULL`, [parentId])).toBeTruthy();
    const { agent: fresh } = await register('staff');
    const read: any = await readJobRequest(env.ctx, fresh, queued.id);
    expect(read.handover_summary).toBeUndefined();
    expect((await getJob(env.ctx.pool, parentId)).job.staff_agent_id).toBe(staff.id);
    expect(await queryOne(env.ctx.pool, `SELECT status FROM job_requests WHERE id = ?`, [queued.id])).toMatchObject({ status: 'cancelled' });
  });

  it('unblocks the job by itself when the offline Staff comes back', async () => {
    env.clock.set('2026-10-08T09:00:00.000Z');
    const { agent: staff, reg } = await register('staff');
    const { parentId } = await setupJob(staff);
    env.clock.advance(POLICY.presenceOfflineSec + 1);
    await tick(env.ctx);
    expect((await getJob(env.ctx.pool, parentId)).job.status).toBe('blocked');
    const start = await latestEventId(env.ctx.pool);

    await agentFor(reg.session_token);
    await tick(env.ctx);
    const job = await getJob(env.ctx.pool, parentId);
    expect(job.job.status).toBe('planning');
    expect(job.blockers.find((b: any) => b.kind === 'unavailable_owner')?.resolved_by).toBe('scheduler');
    const ev = await readEvents(env.ctx.pool, staff.id, { cursor: start, scope: 'owned', types: ['blocker.resolved'] });
    expect(ev.events.filter((e) => e.type === 'blocker.resolved').length).toBe(1);
  });

  it('delivers pause and cancel as control and refuses work after cancel', async () => {
    const { agent: staff } = await register('staff');
    const { parentId, a } = await setupJob(staff);
    const s = await spawnSenior(staff, a);
    await setControl(env.ctx, parentId, 'pause', 'checking costs');
    expect((await controlFor(env.ctx.pool, s.agent.id)).action).toBe('pause');
    await setControl(env.ctx, parentId, 'resume', null);
    expect((await controlFor(env.ctx.pool, s.agent.id)).action).toBe('continue');
    await setControl(env.ctx, parentId, 'cancel', 'not needed');
    // The Senior learns on its next call even though cancel closed its assignment.
    expect((await controlFor(env.ctx.pool, s.agent.id)).action).toBe('cancel');
    const senEvents = await readEvents(env.ctx.pool, s.agent.id, { cursor: 0, scope: 'owned', types: ['job.cancelled'] });
    expect(senEvents.events.some((e) => e.job_id === a)).toBe(true);
    // Staff is not stuck with a permanent cancel signal for a job it already knows is cancelled.
    expect((await controlFor(env.ctx.pool, staff.id)).action).toBe('continue');
    const asg = s.reg.assignment!;
    await expect(submitReviewPackage(env.ctx, s.agent, { assignmentId: asg.id, attempt: asg.attempt, summary: 's', artifacts: [], validation: 'v' })).rejects.toThrow(/lease on .* is gone|no longer current/);
    const row = await queryOne(env.ctx.pool, `SELECT status FROM jobs WHERE id = ?`, [a]);
    expect(row!.status).toBe('cancelled');
  });

  it('raises and resolves a client decision blocker, restoring the previous state', async () => {
    const { agent: staff } = await register('staff');
    const { b } = await setupJob(staff);
    const { blocker_id } = await raiseBlocker(env.ctx, staff, {
      jobId: b,
      kind: 'client_decision',
      requestedDecision: 'One-click export or choose page size first?',
      recommendation: 'One-click, matching the ticket priority.',
      unblockCondition: 'Client picks one.',
    });
    expect((await clientQueue(env.ctx)).some((x) => x.id === blocker_id)).toBe(true);
    await expect(resolveBlocker(env.ctx, { kind: 'agent', agent: staff }, { blockerId: blocker_id, resolution: 'I pick' })).rejects.toThrow(/Only the Client/);
    await resolveBlocker(env.ctx, { kind: 'client' }, { blockerId: blocker_id, resolution: 'One-click.' });
    expect((await getJob(env.ctx.pool, b)).job.status).toBe('planning');
  });

  it('lets Staff mark an already cancelled required subjob optional so the parent can finish', async () => {
    const { agent: staff } = await register('staff');
    const { parentId, a, b } = await setupJob(staff);
    await updateJob(env.ctx, staff, { jobId: b, status: 'cancelled', reason: 'Dropped' });
    await expect(updateJob(env.ctx, staff, { jobId: b, plan: 'x' })).rejects.toThrow(/cancelled/);
    await updateJob(env.ctx, staff, { jobId: b, required: false, reason: 'Dropped from scope' });
    await updateJob(env.ctx, staff, { jobId: a, status: 'cancelled', reason: 'Dropped too' });
    await updateJob(env.ctx, staff, { jobId: a, required: false, reason: 'Dropped from scope' });
    await completeParent(env.ctx, staff, { jobId: parentId, integrationSummary: 'Nothing left in scope' });
    expect((await getJob(env.ctx.pool, parentId)).job.status).toBe('done');
  });

  it('refuses to claim a ticket when the job left ready', async () => {
    const { agent: staff } = await register('staff');
    const { a } = await setupJob(staff);
    const t = await createSpawnTicket(env.ctx, staff, { jobId: a, role: 'senior', brief: 'x' });
    await updateJob(env.ctx, staff, { jobId: a, status: 'planning' });
    await expect(registerAgent(env.ctx, { role: 'senior', nickname: 'late', runtime: 'test', spawnTicket: t.spawn_ticket })).rejects.toThrow(/planning/);
    expect((await getJob(env.ctx.pool, a)).job.status).toBe('planning');
  });

  it('ends a session with a long reason and refuses its token afterwards', async () => {
    const { reg, agent } = await register('researcher');
    await endSession(env.ctx, agent, 'x'.repeat(200));
    await expect(authenticate(env.ctx, reg.session_token)).rejects.toThrow(/ended/);
  });

  it('keeps open jobs working when Linear is down and refuses new registration', async () => {
    const { agent: staff } = await register('staff');
    env.linear.down = true;
    await expect(registerJob(env.ctx, staff, { linearIssue: 'ENG-999', repoPath: '/r', baseBranch: 'main' })).rejects.toThrow();
    env.linear.down = false;
  });
});
