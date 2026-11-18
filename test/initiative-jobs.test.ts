import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { authenticate, registerAgent, type Agent } from '../src/agents.ts';
import { exec, query, queryOne } from '../src/db.ts';
import { emit } from '../src/events.ts';
import { ARCHITECT_WAKE_MS, flushArchitectWakes } from '../src/architect-wake.ts';
import { newId } from '../src/lib.ts';
import { applyRevision, importInitiative, initiativeByKey, storeRevision, versionOf } from '../src/initiatives.ts';
import { cardJobs, cardStatesOf, markGate, previewStart, queueGateChecks, recordGateOutput, staffDesign, startCard, startMilestone, GATE_CHECK_MS } from '../src/initiative-jobs.ts';
import { reassignStaffIn, registerJob, reopenForDelivery } from '../src/jobs.ts';
import { acceptEscalation, answerStaffQuestion, answersOfInitiative, currentVersionOf, escalate, openAnswers, recordQuoteOutput, reopenAnswer } from '../src/architect-answers.ts';
import { postMessage } from '../src/board.ts';
import { dismissBlocker, raiseBlocker, resolveBlocker } from '../src/blockers.ts';
import { dismissJobRequest, readJobRequest, retryJobRequest } from '../src/job-requests.ts';
import { expireStaleCards } from '../src/operator-actions.ts';
import { expireStaleLaunches, finishLaunch, nextLaunch } from '../src/telemetry.ts';
import { createTestCtx, TEST_DB_URL } from './helpers.ts';
import { tx } from '../src/context.ts';
import { checkpointHash } from '../src/card-state.ts';
import { threadOfInitiative } from '../src/architect.ts';

// Start, the merged check and manual marks against a real MySQL (ORCH_TEST_DATABASE_URL). Skipped otherwise.

function card(id: string, gates: unknown[], extra: Record<string, unknown> = {}) {
  return {
    kind: 'card',
    id,
    title: `Card ${id}`,
    repo: 'app',
    wave: 'W-1',
    deps: [],
    goal: `Goal of ${id}.`,
    scope: ['Scope one'],
    out: [],
    accept: ['Accept'],
    verify: ['Verify'],
    traps: [],
    safety: [],
    dod: [],
    gates,
    ...extra,
  };
}

// Card a is ready. Card b waits for a's merged PR and a closed decision. Card c waits for a client step. Card d is ready too.
function design() {
  return {
    format: 1,
    title: 'Jobs',
    blocks: [
      { kind: 'wave', id: 'W-1', title: 'First', when: 'now', jobs: ['a', 'b', 'c', 'd'] },
      { kind: 'open', id: 'O-host', title: 'Host', body: 'which host', closed: 'The app host, see D1.' },
      { kind: 'decision', id: 'D1', title: 'One', body: 'Use the app host.' },
      { kind: 'decision', id: 'D2', title: 'Two', body: 'Not listed by any card.' },
      { kind: 'checkpoint', id: 'CP-A', title: 'Client signs off', steps: ['Check the page'] },
      { kind: 'contract', id: 'C-api', title: 'API', body: 'The API shape.' },
      card('a', [], { decisions: ['D1'], contracts: ['C-api'], goal: 'Goal of a. Keeps C-api.' }),
      card('b', [{ kind: 'merged', job: 'a' }, { kind: 'decision', ref: 'O-host' }], { deps: ['a'] }),
      card('c', [{ kind: 'client_step', ref: 'CP-A' }]),
      card('d', []),
    ],
  };
}

const MERGED = (pr: number) => JSON.stringify({ state: 'MERGED', mergedAt: '2026-11-17T10:00:00Z', mergeCommit: { oid: 'b'.repeat(40) }, url: `https://github.com/owner/app/pull/${pr}` });
const OPEN = (pr: number) => JSON.stringify({ state: 'OPEN', mergedAt: null, mergeCommit: null, url: `https://github.com/owner/app/pull/${pr}` });

describe.skipIf(!TEST_DB_URL)('initiative jobs and gates', () => {
  let env: Awaited<ReturnType<typeof createTestCtx>>;
  let n = 0;
  beforeAll(async () => {
    env = await createTestCtx();
  });
  afterAll(async () => {
    await env?.close();
  });
  // One database serves the whole file. A test that stops early leaves a queued start or an unpicked launch, and the
  // next test would see it: the queue cap and nextLaunch count everything. Close those here, so each test starts clean.
  afterEach(async () => {
    await exec(env.ctx.pool, `UPDATE job_requests SET status = 'failed' WHERE status = 'queued'`);
    await exec(env.ctx.pool, `UPDATE launches SET finished_at = ? WHERE finished_at IS NULL`, [env.clock.now()]);
    // Gate checks are queued one at a time across the whole database. An earlier test's initiative with a merged gate
    // that is due again would take the slot, so each test leaves its initiative behind as archived (this file's own database).
    await exec(env.ctx.pool, `UPDATE initiatives SET status = 'archived' WHERE status = 'active'`);
  });

  async function room(cap?: number, extra: unknown[] = []) {
    const key = `jobs-${++n}`;
    const d = design();
    await importInitiative(env.ctx, {
      key,
      title: `Jobs ${n}`,
      repos: [{ slug: 'app', path: '/home/u/app', base: 'main', github: 'owner/app' }],
      source: 'a test',
      doc: { ...d, blocks: [...d.blocks, ...extra] },
      ...(cap ? { cap } : {}),
    });
    return key;
  }

  async function staff(): Promise<Agent> {
    const reg = await registerAgent(env.ctx, { role: 'staff', nickname: `jstaff-${++n}`, runtime: 'claude-code' });
    return authenticate(env.ctx, reg.session_token);
  }

  /** Start with the prompt the preview shows now, as the Client does when it confirms. */
  async function start(key: string, cardKey: string) {
    const preview = await previewStart(env.ctx, key, cardKey);
    return startCard(env.ctx, key, cardKey, preview.started_from_version);
  }

  /** Runs the staff_start launches up to the one of a request, the way the runner would, with the given result. */
  async function runLaunch(requestId: string, result: string) {
    for (let l: any = await nextLaunch(env.ctx); l; l = await nextLaunch(env.ctx)) {
      if (l.kind !== 'staff_start') throw new Error(`unexpected launch ${l.kind}`);
      await finishLaunch(env.ctx, l.id, result);
      if (l.request_id === requestId) return;
    }
    throw new Error(`no staff_start launch for request ${requestId}`);
  }

  /** Starts a card, runs its staff_start launch the way the runner would, and has Staff register the job. */
  async function startAndRegister(s: Agent, key: string, cardKey: string) {
    const started = await start(key, cardKey);
    await runLaunch(started.request_id, 'ok: started');
    await registerJob(env.ctx, s, { requestId: started.request_id, title: `Job for ${cardKey}` });
    const row = await queryOne(env.ctx.pool, 'SELECT job_id FROM job_requests WHERE id = ?', [started.request_id]);
    return { ...started, job_id: String(row!.job_id) };
  }

  /** A delivery with a pull request, as report_delivery would store it. */
  async function deliver(jobId: string, prUrl: string, head = 'c'.repeat(40)) {
    await exec(env.ctx.pool, `INSERT INTO deliveries (id, job_id, assignment_id, attempt_number, reported_by, pr_url, head_sha, copilot_summary, ci_summary, reported_at) VALUES (?, ?, ?, 1, ?, ?, ?, '', '', ?)`, [
      newId('dlv'),
      jobId,
      newId('asg'),
      newId('agt'),
      prUrl,
      head,
      env.clock.now(),
    ]);
  }

  /** The one gate_check launch the check queued. */
  async function checkLaunch() {
    const l: any = await nextLaunch(env.ctx);
    expect(l?.kind).toBe('gate_check');
    return l;
  }

  /** Gate checks queued for one initiative, whatever else the runner has to pick up. */
  async function gateCheckLaunches(key: string) {
    const i = await initiativeByKey(env.ctx.pool, key);
    const r = await queryOne(env.ctx.pool, `SELECT COUNT(*) AS n FROM launches l JOIN initiative_gates g ON g.id = l.run_id WHERE l.kind = 'gate_check' AND g.initiative_id = ?`, [i.id]);
    return Number(r?.n ?? 0);
  }

  const gateOf = (view: Awaited<ReturnType<typeof cardJobs>>, cardKey: string, gateKey: string) =>
    view.cards.find((c) => c.key === cardKey)!.gates.find((g) => g.key === gateKey)!;

  describe('Start', () => {
    it('refuses a card that waits for a merged gate, and says why', async () => {
      const key = await room();
      await expect(start(key, 'b')).rejects.toThrow(/cannot start/);
      const preview = await previewStart(env.ctx, key, 'b');
      expect(preview).toMatchObject({ state: 'locked', can_start: false });
      expect(preview.reasons).toContain('Open: a merged (Card a).');
    });

    it('starts a ready card with the prompt the preview showed, pinned to the design version it read', async () => {
      const key = await room();
      const preview = await previewStart(env.ctx, key, 'a');
      expect(preview.can_start).toBe(true);
      const started = await start(key, 'a');
      expect(started.started_from_version).toBe(preview.started_from_version);
      expect(started.started_from_version).toBe((await cardJobs(env.ctx, key)).version);
      const req = await queryOne(env.ctx.pool, 'SELECT kind, prompt, status FROM job_requests WHERE id = ?', [started.request_id]);
      expect(req).toMatchObject({ kind: 'implement', status: 'queued' });
      expect(req!.prompt).toBe(preview.prompt);
      expect(String(req!.prompt)).toContain('Goal\nGoal of a. Keeps C-api.');
      expect(String(req!.prompt)).toContain('D1 "One"\nUse the app host.');
      expect(String(req!.prompt)).toContain('C-api "API"');
      const link = await queryOne(env.ctx.pool, 'SELECT started_from_version FROM initiative_card_starts WHERE request_id = ?', [started.request_id]);
      expect(Number(link!.started_from_version)).toBe(started.started_from_version);
    });

    it('refuses a start whose design version moved since the preview', async () => {
      const key = await room();
      const preview = await previewStart(env.ctx, key, 'a');
      await markGate(env.ctx, key, 'c', 'client_step:CP-A', 'Checked the page.');
      await expect(startCard(env.ctx, key, 'a', preview.started_from_version)).rejects.toThrow(/the prompt changed/);
      expect((await start(key, 'a')).started_from_version).toBe(preview.started_from_version + 1);
    });

    it('a dismissed start holds nothing: its card is Ready again and it no longer counts toward the cap', async () => {
      const key = await room(1);
      const started = await start(key, 'a');
      await runLaunch(started.request_id, 'ok: started');
      expect((await previewStart(env.ctx, key, 'a')).state).toBe('running');
      expect((await previewStart(env.ctx, key, 'd')).cap.running).toBe(1);
      await dismissJobRequest(env.ctx, started.request_id);
      expect((await previewStart(env.ctx, key, 'a')).state).toBe('ready');
      expect((await previewStart(env.ctx, key, 'd')).cap.running).toBe(0);
    });

    it('refuses a retry that would link an identical start already queued, and changes nothing', async () => {
      const key = await room();
      const failed = await start(key, 'a');
      await runLaunch(failed.request_id, 'failed: the runner could not start Staff');
      const queued = await start(key, 'a');
      await expect(retryJobRequest(env.ctx, failed.request_id)).rejects.toThrow(/already queued/);
      expect(await queryOne(env.ctx.pool, 'SELECT status, dismissed_at FROM job_requests WHERE id = ?', [failed.request_id])).toMatchObject({ status: 'failed', dismissed_at: null });
      expect((await queryOne(env.ctx.pool, 'SELECT retry_of FROM job_requests WHERE id = ?', [queued.request_id]))!.retry_of).toBeNull();
    });

    it('refuses to register a job for a start the Client dismissed', async () => {
      const key = await room(1);
      const started = await start(key, 'a');
      await runLaunch(started.request_id, 'ok: started');
      await dismissJobRequest(env.ctx, started.request_id);
      const s = await staff();
      await expect(registerJob(env.ctx, s, { requestId: started.request_id, title: 'Job for a' })).rejects.toThrow(/dismissed/);
      expect(await readJobRequest(env.ctx, s, started.request_id)).toMatchObject({ next: 'The Client dismissed this request. Do not call register_job. End your session.' });
    });

    it('a retry of a failed start still belongs to its card: the card runs while the retry does', async () => {
      const key = await room();
      const started = await start(key, 'a');
      await runLaunch(started.request_id, 'failed: the runner could not start Staff');
      expect((await queryOne(env.ctx.pool, 'SELECT status FROM job_requests WHERE id = ?', [started.request_id]))!.status).toBe('failed');
      expect((await previewStart(env.ctx, key, 'a')).state).toBe('ready');

      const retry = await retryJobRequest(env.ctx, started.request_id);
      expect(retry.id).not.toBe(started.request_id);
      await expect(retryJobRequest(env.ctx, started.request_id)).rejects.toThrow(/already retried/);
      expect((await previewStart(env.ctx, key, 'd')).cap.running).toBe(1);
      expect((await previewStart(env.ctx, key, 'a')).state).toBe('running');
      await expect(start(key, 'a')).rejects.toThrow(/running/);

      await runLaunch(retry.id, 'ok: started');
      const s = await staff();
      await registerJob(env.ctx, s, { requestId: retry.id, title: 'Job for a' });
      const view = await cardJobs(env.ctx, key);
      expect(view.cards.find((c) => c.key === 'a')!.job_id).not.toBeNull();
      expect(view.cards.find((c) => c.key === 'a')!.state).toBe('running');
    });

    it('refuses to retry a failed start once the card was started again', async () => {
      const key = await room();
      const failed = await start(key, 'a');
      await runLaunch(failed.request_id, 'failed: the runner could not start Staff');
      env.clock.advance(60);
      const again = await start(key, 'a');
      await runLaunch(again.request_id, 'ok: started');
      await registerJob(env.ctx, await staff(), { requestId: again.request_id, title: 'Job for a' });
      await expect(retryJobRequest(env.ctx, failed.request_id)).rejects.toThrow(/superseded/);
      expect(Number((await queryOne(env.ctx.pool, 'SELECT COUNT(*) AS n FROM job_requests WHERE retry_of = ?', [failed.request_id]))!.n)).toBe(0);
    });

    it('does not start a card twice while its job runs', async () => {
      const key = await room();
      await start(key, 'a');
      await expect(start(key, 'a')).rejects.toThrow(/cannot start: .*running/);
    });

    it('warns when the initiative is over its cap, and still starts the card', async () => {
      const key = await room(1);
      const s = await staff();
      await startAndRegister(s, key, 'a');
      const preview = await previewStart(env.ctx, key, 'd');
      expect(preview.cap).toEqual({ running: 1, cap: 1, over: true });
      expect(preview.warning).toMatch(/cap is 1/);
      expect(preview.can_start).toBe(true);
      await expect(start(key, 'd')).resolves.toMatchObject({ started_from_version: expect.any(Number) });
    });
  });

  describe('the merged check', () => {
    it('stores nothing when the initiative is archived after the check was queued', async () => {
      const key = await room();
      const s = await staff();
      const a = await startAndRegister(s, key, 'a');
      await deliver(a.job_id, 'https://github.com/owner/app/pull/34');
      await queueGateChecks(env.ctx);
      const launch = await checkLaunch();
      const before = await cardJobs(env.ctx, key);
      await exec(env.ctx.pool, "UPDATE initiatives SET status = 'archived' WHERE `key` = ?", [key]);

      const out = await recordGateOutput(env.ctx, launch.id, { code: 0, stdout: MERGED(34), stderr: '' });
      expect(out).toMatchObject({ ok: true, recorded: false });
      await finishLaunch(env.ctx, launch.id, 'checked PR 34 of owner/app: answered');

      const after = await cardJobs(env.ctx, key);
      expect(after.version).toBe(before.version);
      expect(gateOf(after, 'b', 'merged:a')).toMatchObject({ met: false, evidence: null });
      const row = await queryOne(env.ctx.pool, `SELECT met_at, evidence FROM initiative_gates WHERE initiative_id = ? AND gate_key = 'merged:a'`, [(await initiativeByKey(env.ctx.pool, key)).id]);
      expect(row).toMatchObject({ met_at: null, evidence: null });
    });

    it('marks the gate from GitHub, writes an event version, and makes the dependent card Ready', async () => {
      const key = await room();
      const s = await staff();
      const a = await startAndRegister(s, key, 'a');
      const before = await cardJobs(env.ctx, key);
      expect(before.cards.find((c) => c.key === 'b')!.state).toBe('locked');

      await deliver(a.job_id, 'https://github.com/owner/app/pull/34');
      await queueGateChecks(env.ctx);
      const launch = await checkLaunch();
      expect(launch).toMatchObject({ pr_number: 34, repo_slug: 'owner/app', runtime: 'gh' });

      const out = await recordGateOutput(env.ctx, launch.id, { code: 0, stdout: MERGED(34), stderr: '' });
      expect(out).toMatchObject({ ok: true, recorded: true });
      await finishLaunch(env.ctx, launch.id, 'checked PR 34 of owner/app: answered');

      const after = await cardJobs(env.ctx, key);
      expect(after.version).toBe(before.version + 1);
      expect(gateOf(after, 'b', 'merged:a')).toMatchObject({ met: true, met_by: 'check', markable: true });
      expect(gateOf(after, 'b', 'merged:a').evidence).toMatchObject({ url: 'https://github.com/owner/app/pull/34', merged_at: '2026-11-17T10:00:00Z', merge_commit: 'b'.repeat(40) });
      expect(after.cards.find((c) => c.key === 'b')!.state).toBe('ready');
      // The Start prompt reads the PR and the merge time from the check's evidence, the only place they are kept now.
      const preview = await previewStart(env.ctx, key, 'b');
      expect(preview.can_start).toBe(true);
      expect(preview.prompt).toContain('- a "Card a": PR https://github.com/owner/app/pull/34, merged 2026-11-17T10:00:00Z');

      const i = await initiativeByKey(env.ctx.pool, key);
      const row = await queryOne(env.ctx.pool, 'SELECT trigger_kind, created_by FROM initiative_versions WHERE initiative_id = ? AND version = ?', [i.id, after.version]);
      expect(row).toMatchObject({ trigger_kind: 'event', created_by: 'scheduler' });
      const v = await versionOf(env.ctx.pool, i.id, after.version);
      // A check changes only the status line: the source card keeps no pr or merged (the PR is in the gate's evidence).
      const src = v.doc.blocks.find((b) => b.id === 'a') as { pr?: string; merged?: string };
      expect(src.pr).toBeUndefined();
      expect(src.merged).toBeUndefined();
      const prev = (await versionOf(env.ctx.pool, i.id, before.version)).doc.blocks as any[];
      const strip = (blocks: any[]) => blocks.filter((b) => b.id !== 'T-status');
      expect(strip(v.doc.blocks as any[])).toEqual(strip(prev));
      // The status line is the one thing the check writes: it names the gate, the PR and the merge.
      const status = v.doc.blocks.find((b) => b.id === 'T-status') as { body?: string };
      expect(status.body).toContain(`Gate met by check: b waits for a. PR https://github.com/owner/app/pull/34 merged at 2026-11-17T10:00:00Z, merge commit ${'b'.repeat(7)}.`);
    });

    it('does not mark a gate for an open pull request, and checks again only after the interval', async () => {
      const key = await room();
      const s = await staff();
      const a = await startAndRegister(s, key, 'a');
      await deliver(a.job_id, 'https://github.com/owner/app/pull/35');
      await queueGateChecks(env.ctx);
      const launch = await checkLaunch();
      const out = await recordGateOutput(env.ctx, launch.id, { code: 0, stdout: OPEN(35), stderr: '' });
      expect(out).toMatchObject({ ok: true, recorded: false });
      await finishLaunch(env.ctx, launch.id, 'checked PR 35 of owner/app: answered');

      const view = await cardJobs(env.ctx, key);
      expect(gateOf(view, 'b', 'merged:a')).toMatchObject({ met: false });
      expect(gateOf(view, 'b', 'merged:a').evidence).toMatchObject({ state: 'OPEN' });

      await queueGateChecks(env.ctx);
      expect(await gateCheckLaunches(key)).toBe(1);

      env.clock.advance(GATE_CHECK_MS / 1000 + 1);
      await queueGateChecks(env.ctx);
      expect(await gateCheckLaunches(key)).toBe(2);
    });

    it('marks the gate when the PR head moved after the delivery: the PR number from the delivery is the source of truth', async () => {
      const key = await room();
      const s = await staff();
      const a = await startAndRegister(s, key, 'a');
      await deliver(a.job_id, 'https://github.com/owner/app/pull/39');
      await queueGateChecks(env.ctx);
      const launch = await checkLaunch();
      await recordGateOutput(env.ctx, launch.id, { code: 0, stdout: MERGED(39), stderr: '' });
      const view = await cardJobs(env.ctx, key);
      expect(gateOf(view, 'b', 'merged:a').met).toBe(true);
      expect(gateOf(view, 'b', 'merged:a').evidence).toMatchObject({ state: 'MERGED', merged_at: '2026-11-17T10:00:00Z' });
      await finishLaunch(env.ctx, launch.id, 'checked');
    });

    it('queues no merged check for a job with several pull requests, so one merged PR cannot mark the gate', async () => {
      const key = await room();
      const s = await staff();
      const a = await startAndRegister(s, key, 'a');
      await deliver(a.job_id, 'https://github.com/owner/app/pull/39');
      await deliver(a.job_id, 'https://github.com/owner/app/pull/40');
      await queueGateChecks(env.ctx);
      expect(await gateCheckLaunches(key)).toBe(0);
      const view = await cardJobs(env.ctx, key);
      expect(gateOf(view, 'b', 'merged:a').met).toBe(false);
      expect(gateOf(view, 'b', 'merged:a').evidence).toMatchObject({ not_checked: expect.stringMatching(/more than one pull request/) });
    });

    it('waits until every subjob of the card job has finished before a merged PR can mark the gate', async () => {
      const key = await room();
      const s = await staff();
      const a = await startAndRegister(s, key, 'a');
      await deliver(a.job_id, 'https://github.com/owner/app/pull/43');
      const sub = newId('job');
      const now = env.clock.now();
      await exec(env.ctx.pool, `INSERT INTO jobs (id, parent_job_id, linear_issue_id, linear_identifier, linear_url, title, repo_path, base_branch, status, linear_snapshot, linear_fetched_at, created_at, updated_at) VALUES (?, ?, ?, ?, '', 'Subjob', '/home/u/app', 'main', 'in_progress', '{}', ?, ?, ?)`, [sub, a.job_id, sub, sub, now, now, now]);
      await queueGateChecks(env.ctx);
      expect(await gateCheckLaunches(key)).toBe(0);
      expect(gateOf(await cardJobs(env.ctx, key), 'b', 'merged:a').evidence).toMatchObject({ not_checked: expect.stringMatching(/subjob that is not finished/) });
      await exec(env.ctx.pool, `UPDATE jobs SET status = 'done' WHERE id = ?`, [sub]);
      await queueGateChecks(env.ctx);
      expect(await gateCheckLaunches(key)).toBe(1);
    });

    it('queues one merged check at a time, so checks cannot hold back the runner', async () => {
      const key = `jobs-${++n}`;
      const two = {
        format: 1,
        title: 'Two gates',
        blocks: [{ kind: 'wave', id: 'W-1', title: 'First', when: 'now', jobs: ['a', 'x', 'b', 'e'] }, card('a', []), card('x', []), card('b', [{ kind: 'merged', job: 'a' }]), card('e', [{ kind: 'merged', job: 'x' }])],
      };
      await importInitiative(env.ctx, { key, title: `Two gates ${n}`, repos: [{ slug: 'app', path: '/home/u/app', base: 'main', github: 'owner/app' }], source: 'a test', doc: two });
      const s = await staff();
      const a = await startAndRegister(s, key, 'a');
      const x = await startAndRegister(s, key, 'x');
      await deliver(a.job_id, 'https://github.com/owner/app/pull/44');
      await deliver(x.job_id, 'https://github.com/owner/app/pull/45');
      await queueGateChecks(env.ctx);
      expect(await gateCheckLaunches(key)).toBe(1);
      const first: any = await nextLaunch(env.ctx);
      expect(first?.kind).toBe('gate_check');
      await queueGateChecks(env.ctx);
      expect(await gateCheckLaunches(key)).toBe(1);
      await finishLaunch(env.ctx, first.id, 'checked');
      await queueGateChecks(env.ctx);
      expect(await gateCheckLaunches(key)).toBe(2);
    });

    it('a refusal is shown as not checked, and does not hold back the first check once the delivery exists', async () => {
      const key = await room();
      const s = await staff();
      const a = await startAndRegister(s, key, 'a');
      await queueGateChecks(env.ctx);
      expect(await gateCheckLaunches(key)).toBe(0);
      expect(gateOf(await cardJobs(env.ctx, key), 'b', 'merged:a').evidence).toMatchObject({ not_checked: expect.stringMatching(/no delivery/) });
      await deliver(a.job_id, 'https://github.com/owner/app/pull/39');
      await queueGateChecks(env.ctx);
      expect(await gateCheckLaunches(key)).toBe(1);
      // The queued check replaces the old refusal, so the Jobs tab does not show a stale reason while the check runs.
      expect(JSON.stringify(gateOf(await cardJobs(env.ctx, key), 'b', 'merged:a').evidence ?? {})).not.toContain('not_checked');
    });

    it('counts one pull request reported under two spellings once, so the check still runs', async () => {
      const key = await room();
      const s = await staff();
      const a = await startAndRegister(s, key, 'a');
      await deliver(a.job_id, 'https://github.com/owner/app/pull/39');
      await deliver(a.job_id, 'https://github.com/Owner/App/pull/39');
      await queueGateChecks(env.ctx);
      expect(await gateCheckLaunches(key)).toBe(1);
    });

    it('an answer for a source reopened while gh ran leaves the gate with no checked time, so no cooldown holds back its next check', async () => {
      const key = await room();
      const s = await staff();
      const a = await startAndRegister(s, key, 'a');
      await deliver(a.job_id, 'https://github.com/owner/app/pull/34');
      await exec(env.ctx.pool, "UPDATE jobs SET status = 'done' WHERE id = ?", [a.job_id]);
      await queueGateChecks(env.ctx);
      const launch = await checkLaunch();
      await reopenForDelivery(env.ctx, a.job_id, 'CI is red on the PR head');
      const out = await recordGateOutput(env.ctx, launch.id, { code: 0, stdout: MERGED(34), stderr: '' });
      expect(out).toMatchObject({ ok: true, recorded: false });
      const i = await initiativeByKey(env.ctx.pool, key);
      expect(gateOf(await cardJobs(env.ctx, key), 'b', 'merged:a')).toMatchObject({ met: false, evidence: { not_checked: expect.stringMatching(/reopened/) } });
      expect(await queryOne(env.ctx.pool, `SELECT checked_at FROM initiative_gates WHERE initiative_id = ? AND card_key = 'b' AND gate_key = 'merged:a'`, [i.id])).toMatchObject({ checked_at: null });
      await finishLaunch(env.ctx, launch.id, 'checked PR 34: the source was reopened');
    });

    it('an answer for a source that moved to another PR while gh ran is discarded without an error, and the new PR is checked at the next pass', async () => {
      const key = await room();
      const s = await staff();
      const a = await startAndRegister(s, key, 'a');
      await deliver(a.job_id, 'https://github.com/owner/app/pull/34');
      await exec(env.ctx.pool, "UPDATE jobs SET status = 'done' WHERE id = ?", [a.job_id]);
      await queueGateChecks(env.ctx);
      const launch = await checkLaunch();
      // A newer start replaces the job, so the card's source is now the new job's PR. The fake clock does not move by itself.
      await exec(env.ctx.pool, "UPDATE jobs SET status = 'cancelled' WHERE id = ?", [a.job_id]);
      env.clock.advance(60);
      const b = await startAndRegister(s, key, 'a');
      await deliver(b.job_id, 'https://github.com/owner/app/pull/44');
      await exec(env.ctx.pool, "UPDATE jobs SET status = 'done' WHERE id = ?", [b.job_id]);
      const out = await recordGateOutput(env.ctx, launch.id, { code: 0, stdout: MERGED(34), stderr: '' });
      expect(out).toMatchObject({ ok: true, recorded: false });
      const i = await initiativeByKey(env.ctx.pool, key);
      const gate = gateOf(await cardJobs(env.ctx, key), 'b', 'merged:a');
      expect(gate).toMatchObject({ met: false });
      expect(await queryOne(env.ctx.pool, `SELECT evidence FROM initiative_gates WHERE initiative_id = ? AND card_key = 'b' AND gate_key = 'merged:a'`, [i.id])).toMatchObject({ evidence: null });
      expect(await queryOne(env.ctx.pool, `SELECT checked_at FROM initiative_gates WHERE initiative_id = ? AND card_key = 'b' AND gate_key = 'merged:a'`, [i.id])).toMatchObject({ checked_at: null });
      await finishLaunch(env.ctx, launch.id, 'checked PR 34: the source moved to PR 44');
      await queueGateChecks(env.ctx);
      const next: any = await checkLaunch();
      expect(next.pr_number).toBe(44);
    });

    it('a launch from before migration 057, with no stored source, still marks its gate when the source is unchanged', async () => {
      const key = await room();
      const s = await staff();
      const a = await startAndRegister(s, key, 'a');
      await deliver(a.job_id, 'https://github.com/owner/app/pull/34');
      await exec(env.ctx.pool, "UPDATE jobs SET status = 'done' WHERE id = ?", [a.job_id]);
      await queueGateChecks(env.ctx);
      const launch = await checkLaunch();
      await exec(env.ctx.pool, 'UPDATE launches SET source_pr = NULL WHERE id = ?', [launch.id]);
      await recordGateOutput(env.ctx, launch.id, { code: 0, stdout: MERGED(34), stderr: '' });
      expect(gateOf(await cardJobs(env.ctx, key), 'b', 'merged:a')).toMatchObject({ met: true });
      await finishLaunch(env.ctx, launch.id, 'checked PR 34 of owner/app: merged');
    });

    it('a launch from before migration 057, with no stored source, discards the answer when the source moved, with no checked time, as a stored source does', async () => {
      const key = await room();
      const s = await staff();
      const a = await startAndRegister(s, key, 'a');
      await deliver(a.job_id, 'https://github.com/owner/app/pull/34');
      await exec(env.ctx.pool, "UPDATE jobs SET status = 'done' WHERE id = ?", [a.job_id]);
      await queueGateChecks(env.ctx);
      const launch = await checkLaunch();
      await exec(env.ctx.pool, "UPDATE jobs SET status = 'cancelled' WHERE id = ?", [a.job_id]);
      env.clock.advance(60);
      const b = await startAndRegister(s, key, 'a');
      await deliver(b.job_id, 'https://github.com/owner/app/pull/44');
      await exec(env.ctx.pool, "UPDATE jobs SET status = 'done' WHERE id = ?", [b.job_id]);
      await exec(env.ctx.pool, 'UPDATE launches SET source_pr = NULL WHERE id = ?', [launch.id]);
      await recordGateOutput(env.ctx, launch.id, { code: 0, stdout: MERGED(34), stderr: '' });
      const i = await initiativeByKey(env.ctx.pool, key);
      expect(gateOf(await cardJobs(env.ctx, key), 'b', 'merged:a')).toMatchObject({ met: false, evidence: null });
      expect(await queryOne(env.ctx.pool, `SELECT checked_at FROM initiative_gates WHERE initiative_id = ? AND card_key = 'b' AND gate_key = 'merged:a'`, [i.id])).toMatchObject({ checked_at: null });
      await finishLaunch(env.ctx, launch.id, 'checked PR 34: the source moved to PR 44');
    });

    it('refuses an answer about another pull request, and stores the reason without a mark', async () => {
      const key = await room();
      const s = await staff();
      const a = await startAndRegister(s, key, 'a');
      await deliver(a.job_id, 'https://github.com/owner/app/pull/36');
      await queueGateChecks(env.ctx);
      const launch = await checkLaunch();
      const out = await recordGateOutput(env.ctx, launch.id, { code: 0, stdout: MERGED(99), stderr: '' });
      expect(out).toMatchObject({ ok: true, recorded: false });
      const view = await cardJobs(env.ctx, key);
      expect(gateOf(view, 'b', 'merged:a').met).toBe(false);
      expect(gateOf(view, 'b', 'merged:a').evidence).toMatchObject({ error: 'The check answered for another pull request.' });
      await finishLaunch(env.ctx, launch.id, 'checked');
    });

    it('a second pull request delivered while the check runs refuses the output as not checked, and the answer is not used', async () => {
      const key = await room();
      const s = await staff();
      const a = await startAndRegister(s, key, 'a');
      await deliver(a.job_id, 'https://github.com/owner/app/pull/39');
      await queueGateChecks(env.ctx);
      const launch = await checkLaunch();
      await deliver(a.job_id, 'https://github.com/owner/app/pull/40');
      const out = await recordGateOutput(env.ctx, launch.id, { code: 0, stdout: MERGED(39), stderr: '' });
      expect(out).toMatchObject({ ok: true, recorded: false });
      const gate = gateOf(await cardJobs(env.ctx, key), 'b', 'merged:a');
      expect(gate.met).toBe(false);
      expect(gate.evidence).toMatchObject({ not_checked: expect.stringMatching(/more than one pull request/) });
      expect(gate.evidence).not.toHaveProperty('error');
      await finishLaunch(env.ctx, launch.id, 'checked');
    });

    it('a second pull request delivered before the runner picks the check cancels it, and the refusal is shown on the gate', async () => {
      const key = await room();
      const s = await staff();
      const a = await startAndRegister(s, key, 'a');
      await deliver(a.job_id, 'https://github.com/owner/app/pull/39');
      await queueGateChecks(env.ctx);
      await deliver(a.job_id, 'https://github.com/owner/app/pull/40');
      expect(await nextLaunch(env.ctx)).toBeFalsy();
      const gate = gateOf(await cardJobs(env.ctx, key), 'b', 'merged:a');
      expect(gate.met).toBe(false);
      expect(gate.evidence).toMatchObject({ not_checked: expect.stringMatching(/more than one pull request/) });
    });

    it('a refusal found when the runner picks a queued check does not hold back the next check', async () => {
      const key = await room();
      const s = await staff();
      const a = await startAndRegister(s, key, 'a');
      await deliver(a.job_id, 'https://github.com/owner/app/pull/39');
      await queueGateChecks(env.ctx);
      await deliver(a.job_id, 'https://github.com/owner/app/pull/40');
      expect(await nextLaunch(env.ctx)).toBeFalsy();
      await exec(env.ctx.pool, 'DELETE FROM deliveries WHERE pr_url = ?', ['https://github.com/owner/app/pull/40']);
      // The clock has not moved: the second check is queued at once, not after GATE_CHECK_MS.
      await queueGateChecks(env.ctx);
      expect(await gateCheckLaunches(key)).toBe(2);
    });

    it('queues nothing without a pull request, or with one in another repository', async () => {
      const key = await room();
      const s = await staff();
      const a = await startAndRegister(s, key, 'a');
      await queueGateChecks(env.ctx);
      expect(await nextLaunch(env.ctx)).toBeNull();
      await deliver(a.job_id, 'https://github.com/other/app/pull/37');
      await queueGateChecks(env.ctx);
      expect(await nextLaunch(env.ctx)).toBeNull();
    });

    it('records a failed check as evidence and marks nothing', async () => {
      const key = await room();
      const s = await staff();
      const a = await startAndRegister(s, key, 'a');
      await deliver(a.job_id, 'https://github.com/owner/app/pull/38');
      await queueGateChecks(env.ctx);
      const launch = await checkLaunch();
      await recordGateOutput(env.ctx, launch.id, { code: 4, stdout: '', stderr: 'gh: not logged in\nmore' });
      const view = await cardJobs(env.ctx, key);
      expect(gateOf(view, 'b', 'merged:a').met).toBe(false);
      expect(gateOf(view, 'b', 'merged:a').evidence).toMatchObject({ error: 'gh exited with 4: gh: not logged in' });
      await finishLaunch(env.ctx, launch.id, 'checked');
    });

    it('records nothing for a gate that a revision removed while its check ran, so a gate added later cannot inherit the answer', async () => {
      const key = await room();
      const s = await staff();
      const a = await startAndRegister(s, key, 'a');
      await deliver(a.job_id, 'https://github.com/owner/app/pull/34');
      await queueGateChecks(env.ctx);
      const launch = await checkLaunch();
      const i = await initiativeByKey(env.ctx.pool, key);
      const rev = await tx(env.ctx, (conn) => storeRevision(conn, env.ctx, i.id, [{ op: 'update', id: 'b', set: { gates: [{ kind: 'decision', ref: 'O-host' }] } }], 'Drops the merged gate of b.'));
      await applyRevision(env.ctx, rev.id);
      const before = await cardJobs(env.ctx, key);

      const out = await recordGateOutput(env.ctx, launch.id, { code: 0, stdout: MERGED(34), stderr: '' });
      expect(out).toMatchObject({ ok: true, recorded: false });
      expect((await cardJobs(env.ctx, key)).version).toBe(before.version);
      const row = await queryOne(env.ctx.pool, `SELECT met_at FROM initiative_gates WHERE initiative_id = ? AND card_key = 'b' AND gate_key = 'merged:a'`, [i.id]);
      expect(row?.met_at ?? null).toBeNull();
    });

    it('a replacement start clears the mark a check made for the card it replaces, so the dependent waits for the new job', async () => {
      const key = await room();
      const s = await staff();
      const a = await startAndRegister(s, key, 'a');
      await deliver(a.job_id, 'https://github.com/owner/app/pull/34');
      await queueGateChecks(env.ctx);
      const launch = await checkLaunch();
      await recordGateOutput(env.ctx, launch.id, { code: 0, stdout: MERGED(34), stderr: '' });
      await finishLaunch(env.ctx, launch.id, 'checked PR 34 of owner/app: merged');
      expect(gateOf(await cardJobs(env.ctx, key), 'b', 'merged:a')).toMatchObject({ met: true });

      await exec(env.ctx.pool, "UPDATE jobs SET status = 'cancelled' WHERE id = ?", [a.job_id]);
      await start(key, 'a');
      expect(gateOf(await cardJobs(env.ctx, key), 'b', 'merged:a')).toMatchObject({ met: false });
      const i = await initiativeByKey(env.ctx.pool, key);
      const row = await queryOne(env.ctx.pool, `SELECT met_by, met_at FROM initiative_gates WHERE initiative_id = ? AND card_key = 'b' AND gate_key = 'merged:a'`, [i.id]);
      expect(row).toMatchObject({ met_by: null, met_at: null });
    });

    it('reopening a done job clears the mark a check made for its card, so the dependent waits for the job to be merged again', async () => {
      const key = await room();
      const s = await staff();
      const a = await startAndRegister(s, key, 'a');
      await deliver(a.job_id, 'https://github.com/owner/app/pull/34');
      await queueGateChecks(env.ctx);
      const launch = await checkLaunch();
      await recordGateOutput(env.ctx, launch.id, { code: 0, stdout: MERGED(34), stderr: '' });
      await finishLaunch(env.ctx, launch.id, 'checked PR 34 of owner/app: merged');
      expect(gateOf(await cardJobs(env.ctx, key), 'b', 'merged:a')).toMatchObject({ met: true });

      await exec(env.ctx.pool, "UPDATE jobs SET status = 'done' WHERE id = ?", [a.job_id]);
      await reopenForDelivery(env.ctx, a.job_id, 'CI is red on the PR head');
      expect(gateOf(await cardJobs(env.ctx, key), 'b', 'merged:a')).toMatchObject({ met: false });
      // The PR is still merged. The next check must refuse the old delivery instead of marking the gate again.
      await queueGateChecks(env.ctx);
      expect(gateOf(await cardJobs(env.ctx, key), 'b', 'merged:a')).toMatchObject({ met: false, evidence: { not_checked: expect.stringMatching(/reopened/) } });
      const i = await initiativeByKey(env.ctx.pool, key);
      const row = await queryOne(env.ctx.pool, `SELECT met_by, met_at FROM initiative_gates WHERE initiative_id = ? AND card_key = 'b' AND gate_key = 'merged:a'`, [i.id]);
      expect(row).toMatchObject({ met_by: null, met_at: null });
    });

    it('reopening a subjob clears the mark its card got from the subjob PR, because the card job is the root of the start', async () => {
      const key = await room();
      const s = await staff();
      const a = await startAndRegister(s, key, 'a');
      const sub = newId('job');
      const now = env.clock.now();
      await exec(env.ctx.pool, `INSERT INTO jobs (id, parent_job_id, linear_issue_id, linear_identifier, linear_url, title, repo_path, base_branch, status, linear_snapshot, linear_fetched_at, created_at, updated_at) VALUES (?, ?, ?, ?, '', 'Subjob', '/home/u/app', 'main', 'done', '{}', ?, ?, ?)`, [sub, a.job_id, sub, sub, now, now, now]);
      await deliver(sub, 'https://github.com/owner/app/pull/44');
      await queueGateChecks(env.ctx);
      const launch = await checkLaunch();
      await recordGateOutput(env.ctx, launch.id, { code: 0, stdout: MERGED(44), stderr: '' });
      await finishLaunch(env.ctx, launch.id, 'checked PR 44 of owner/app: merged');
      expect(gateOf(await cardJobs(env.ctx, key), 'b', 'merged:a')).toMatchObject({ met: true });

      await reopenForDelivery(env.ctx, sub, 'CI is red on the PR head');
      expect(gateOf(await cardJobs(env.ctx, key), 'b', 'merged:a')).toMatchObject({ met: false });
    });

    it('reopening the job of a retried start clears the mark, because the card follows the retry', async () => {
      const key = await room();
      const started = await start(key, 'a');
      await runLaunch(started.request_id, 'failed: the runner could not start Staff');
      const retry = await retryJobRequest(env.ctx, started.request_id);
      await runLaunch(retry.id, 'ok: started');
      const s = await staff();
      await registerJob(env.ctx, s, { requestId: retry.id, title: 'Job for a' });
      const jobId = String((await queryOne(env.ctx.pool, 'SELECT job_id FROM job_requests WHERE id = ?', [retry.id]))!.job_id);
      await deliver(jobId, 'https://github.com/owner/app/pull/35');
      await exec(env.ctx.pool, "UPDATE jobs SET status = 'done' WHERE id = ?", [jobId]);
      await queueGateChecks(env.ctx);
      const launch = await checkLaunch();
      await recordGateOutput(env.ctx, launch.id, { code: 0, stdout: MERGED(35), stderr: '' });
      await finishLaunch(env.ctx, launch.id, 'checked PR 35 of owner/app: merged');
      expect(gateOf(await cardJobs(env.ctx, key), 'b', 'merged:a')).toMatchObject({ met: true });

      await reopenForDelivery(env.ctx, jobId, 'CI is red on the PR head');
      expect(gateOf(await cardJobs(env.ctx, key), 'b', 'merged:a')).toMatchObject({ met: false });
    });

    it('a delivery reported after a reopen lets the check mark the gate again', async () => {
      const key = await room();
      const s = await staff();
      const a = await startAndRegister(s, key, 'a');
      await deliver(a.job_id, 'https://github.com/owner/app/pull/34');
      await exec(env.ctx.pool, "UPDATE jobs SET status = 'done' WHERE id = ?", [a.job_id]);
      await queueGateChecks(env.ctx);
      const first = await checkLaunch();
      await recordGateOutput(env.ctx, first.id, { code: 0, stdout: MERGED(34), stderr: '' });
      await finishLaunch(env.ctx, first.id, 'checked PR 34 of owner/app: merged');
      await reopenForDelivery(env.ctx, a.job_id, 'CI is red on the PR head');

      env.clock.advance(60);
      await deliver(a.job_id, 'https://github.com/owner/app/pull/34');
      await exec(env.ctx.pool, "UPDATE jobs SET status = 'done' WHERE id = ?", [a.job_id]);
      await queueGateChecks(env.ctx);
      const second = await checkLaunch();
      await recordGateOutput(env.ctx, second.id, { code: 0, stdout: MERGED(34), stderr: '' });
      await finishLaunch(env.ctx, second.id, 'checked PR 34 of owner/app: merged');
      expect(gateOf(await cardJobs(env.ctx, key), 'b', 'merged:a')).toMatchObject({ met: true });
    });

    it('reopening a job that a newer start replaced leaves the mark the newer job got', async () => {
      const key = await room();
      const s = await staff();
      const a = await startAndRegister(s, key, 'a');
      await deliver(a.job_id, 'https://github.com/owner/app/pull/34');
      await exec(env.ctx.pool, "UPDATE jobs SET status = 'cancelled' WHERE id = ?", [a.job_id]);
      // The fake clock does not move by itself. Two starts at one instant would tie in latestStarts.
      env.clock.advance(60);
      const b = await startAndRegister(s, key, 'a');
      await deliver(b.job_id, 'https://github.com/owner/app/pull/35');
      await exec(env.ctx.pool, "UPDATE jobs SET status = 'done' WHERE id = ?", [b.job_id]);
      await queueGateChecks(env.ctx);
      const launch = await checkLaunch();
      await recordGateOutput(env.ctx, launch.id, { code: 0, stdout: MERGED(35), stderr: '' });
      await finishLaunch(env.ctx, launch.id, 'checked PR 35 of owner/app: merged');
      expect(gateOf(await cardJobs(env.ctx, key), 'b', 'merged:a')).toMatchObject({ met: true });

      await exec(env.ctx.pool, "UPDATE jobs SET status = 'done' WHERE id = ?", [a.job_id]);
      await reopenForDelivery(env.ctx, a.job_id, 'Closed by mistake');
      expect(gateOf(await cardJobs(env.ctx, key), 'b', 'merged:a')).toMatchObject({ met: true });
    });

    it('a delivery of another job of the card does not satisfy the reopen of a subjob', async () => {
      const key = await room();
      const s = await staff();
      const a = await startAndRegister(s, key, 'a');
      const sub = newId('job');
      const now = env.clock.now();
      await exec(env.ctx.pool, `INSERT INTO jobs (id, parent_job_id, linear_issue_id, linear_identifier, linear_url, title, repo_path, base_branch, status, linear_snapshot, linear_fetched_at, created_at, updated_at) VALUES (?, ?, ?, ?, '', 'Subjob', '/home/u/app', 'main', 'done', '{}', ?, ?, ?)`, [sub, a.job_id, sub, sub, now, now, now]);
      await deliver(sub, 'https://github.com/owner/app/pull/44');
      await queueGateChecks(env.ctx);
      const launch = await checkLaunch();
      await recordGateOutput(env.ctx, launch.id, { code: 0, stdout: MERGED(44), stderr: '' });
      await finishLaunch(env.ctx, launch.id, 'checked PR 44 of owner/app: merged');
      expect(gateOf(await cardJobs(env.ctx, key), 'b', 'merged:a')).toMatchObject({ met: true });

      await reopenForDelivery(env.ctx, sub, 'CI is red on the PR head');
      env.clock.advance(60);
      // The subjob is done again without a new delivery, and the root job reports the same PR after the reopen. Only the
      // reopen can refuse the check here.
      await exec(env.ctx.pool, "UPDATE jobs SET status = 'done' WHERE id = ?", [sub]);
      await deliver(a.job_id, 'https://github.com/owner/app/pull/44');
      await exec(env.ctx.pool, "UPDATE jobs SET status = 'done' WHERE id = ?", [a.job_id]);
      await queueGateChecks(env.ctx);
      expect(gateOf(await cardJobs(env.ctx, key), 'b', 'merged:a')).toMatchObject({ met: false, evidence: { not_checked: expect.stringMatching(/reopened/) } });
    });

    it('a retry of a failed start is refused once its card is no longer ready, because a gate of the card was reopened', async () => {
      const key = await room();
      await markGate(env.ctx, key, 'c', 'client_step:CP-A', 'Checked the page on the staging host.');
      const started = await start(key, 'c');
      await runLaunch(started.request_id, 'failed: the runner could not start Staff');
      const i = await initiativeByKey(env.ctx.pool, key);
      await exec(env.ctx.pool, `UPDATE initiative_gates SET met_at = NULL, met_by = NULL WHERE initiative_id = ? AND card_key = 'c' AND gate_key = 'client_step:CP-A'`, [i.id]);
      await expect(retryJobRequest(env.ctx, started.request_id)).rejects.toThrow(/not ready/);
      expect(await queryOne(env.ctx.pool, 'SELECT id FROM job_requests WHERE retry_of = ?', [started.request_id])).toBeUndefined();
    });

    it('a retry of a failed start is refused once its initiative is archived, with no retry queued', async () => {
      const key = await room();
      await markGate(env.ctx, key, 'c', 'client_step:CP-A', 'Checked the page on the staging host.');
      const started = await start(key, 'c');
      await runLaunch(started.request_id, 'failed: the runner could not start Staff');
      await exec(env.ctx.pool, "UPDATE initiatives SET status = 'archived' WHERE `key` = ?", [key]);
      await expect(retryJobRequest(env.ctx, started.request_id)).rejects.toThrow(/is archived/);
      expect(await queryOne(env.ctx.pool, 'SELECT id FROM job_requests WHERE retry_of = ?', [started.request_id])).toBeUndefined();
    });

    it('a start clears the refusal an open dependent gate got, so the next check runs against the new job at once', async () => {
      const key = await room();
      await queueGateChecks(env.ctx);
      expect(gateOf(await cardJobs(env.ctx, key), 'b', 'merged:a').evidence).toMatchObject({ not_checked: expect.stringMatching(/No job was started/) });
      const i = await initiativeByKey(env.ctx.pool, key);
      await exec(env.ctx.pool, `UPDATE initiative_gates SET checked_at = ? WHERE initiative_id = ? AND card_key = 'b' AND gate_key = 'merged:a'`, [env.clock.now(), i.id]);
      await start(key, 'a');
      expect(gateOf(await cardJobs(env.ctx, key), 'b', 'merged:a').evidence ?? null).toBeNull();
      expect(await queryOne(env.ctx.pool, `SELECT checked_at FROM initiative_gates WHERE initiative_id = ? AND card_key = 'b' AND gate_key = 'merged:a'`, [i.id])).toMatchObject({ checked_at: null });
    });

    it('reopening a job clears the refusal and the checked time of an open dependent gate', async () => {
      const key = await room();
      const s = await staff();
      const a = await startAndRegister(s, key, 'a');
      await deliver(a.job_id, 'https://github.com/owner/app/pull/34');
      await exec(env.ctx.pool, "UPDATE jobs SET status = 'done' WHERE id = ?", [a.job_id]);
      await queueGateChecks(env.ctx);
      const launch = await checkLaunch();
      const open = JSON.stringify({ state: 'OPEN', mergedAt: null, mergeCommit: null, url: 'https://github.com/owner/app/pull/34' });
      await recordGateOutput(env.ctx, launch.id, { code: 0, stdout: open, stderr: '' });
      await finishLaunch(env.ctx, launch.id, 'checked PR 34 of owner/app: open');
      const i = await initiativeByKey(env.ctx.pool, key);
      expect(await queryOne(env.ctx.pool, `SELECT checked_at FROM initiative_gates WHERE initiative_id = ? AND card_key = 'b' AND gate_key = 'merged:a'`, [i.id])).toMatchObject({ checked_at: expect.anything() });

      await reopenForDelivery(env.ctx, a.job_id, 'CI is red on the PR head');
      const after = await queryOne(env.ctx.pool, `SELECT checked_at, evidence, met_at FROM initiative_gates WHERE initiative_id = ? AND card_key = 'b' AND gate_key = 'merged:a'`, [i.id]);
      expect(after).toMatchObject({ checked_at: null, met_at: null });
      expect(after!.evidence ?? null).toBeNull();
    });

    it('reopening a subjob that is then cancelled does not block the root job from delivering the same PR', async () => {
      const key = await room();
      const s = await staff();
      const a = await startAndRegister(s, key, 'a');
      const sub = newId('job');
      const now = env.clock.now();
      await exec(env.ctx.pool, `INSERT INTO jobs (id, parent_job_id, linear_issue_id, linear_identifier, linear_url, title, repo_path, base_branch, status, linear_snapshot, linear_fetched_at, created_at, updated_at) VALUES (?, ?, ?, ?, '', 'Subjob', '/home/u/app', 'main', 'done', '{}', ?, ?, ?)`, [sub, a.job_id, sub, sub, now, now, now]);
      await deliver(sub, 'https://github.com/owner/app/pull/44');
      await reopenForDelivery(env.ctx, sub, 'Folded into the root PR');
      await exec(env.ctx.pool, "UPDATE jobs SET status = 'cancelled' WHERE id = ?", [sub]);

      env.clock.advance(60);
      await deliver(a.job_id, 'https://github.com/owner/app/pull/44');
      await exec(env.ctx.pool, "UPDATE jobs SET status = 'done' WHERE id = ?", [a.job_id]);
      await queueGateChecks(env.ctx);
      const launch = await checkLaunch();
      await recordGateOutput(env.ctx, launch.id, { code: 0, stdout: MERGED(44), stderr: '' });
      await finishLaunch(env.ctx, launch.id, 'checked PR 44 of owner/app: merged');
      expect(gateOf(await cardJobs(env.ctx, key), 'b', 'merged:a')).toMatchObject({ met: true });
    });

    it('a root reopened and then cancelled keeps its gate refused, so its old PR does not satisfy a dependent', async () => {
      const key = await room();
      const s = await staff();
      const a = await startAndRegister(s, key, 'a');
      await deliver(a.job_id, 'https://github.com/owner/app/pull/34');
      await exec(env.ctx.pool, "UPDATE jobs SET status = 'done' WHERE id = ?", [a.job_id]);
      await reopenForDelivery(env.ctx, a.job_id, 'CI is red on the PR head');
      await exec(env.ctx.pool, "UPDATE jobs SET status = 'cancelled' WHERE id = ?", [a.job_id]);

      env.clock.advance(60);
      await queueGateChecks(env.ctx);
      expect(gateOf(await cardJobs(env.ctx, key), 'b', 'merged:a')).toMatchObject({ met: false, evidence: { not_checked: expect.stringMatching(/reopened/) } });
    });

    it('a subjob reopened and then cancelled keeps the root gate refused until the root delivers after the reopen', async () => {
      const key = await room();
      const s = await staff();
      const a = await startAndRegister(s, key, 'a');
      const sub = newId('job');
      const now = env.clock.now();
      await exec(env.ctx.pool, `INSERT INTO jobs (id, parent_job_id, linear_issue_id, linear_identifier, linear_url, title, repo_path, base_branch, status, linear_snapshot, linear_fetched_at, created_at, updated_at) VALUES (?, ?, ?, ?, '', 'Subjob', '/home/u/app', 'main', 'done', '{}', ?, ?, ?)`, [sub, a.job_id, sub, sub, now, now, now]);
      await deliver(sub, 'https://github.com/owner/app/pull/44');
      await reopenForDelivery(env.ctx, sub, 'Folded into the root PR');
      await exec(env.ctx.pool, "UPDATE jobs SET status = 'cancelled' WHERE id = ?", [sub]);

      env.clock.advance(60);
      await queueGateChecks(env.ctx);
      expect(gateOf(await cardJobs(env.ctx, key), 'b', 'merged:a')).toMatchObject({ met: false, evidence: { not_checked: expect.stringMatching(/reopened/) } });
      expect(await gateCheckLaunches(key)).toBe(0);

      // The root delivers again after the reopen: the reopen refusal ends. The card now has two pull requests (the subjob's
      // 44 and the root's 46), which the automatic check does not cover, so the gate is refused for that reason instead.
      env.clock.advance(60);
      await deliver(a.job_id, 'https://github.com/owner/app/pull/46');
      await queueGateChecks(env.ctx);
      expect(await gateCheckLaunches(key)).toBe(0);
      expect(gateOf(await cardJobs(env.ctx, key), 'b', 'merged:a')).toMatchObject({ met: false, evidence: { not_checked: expect.stringMatching(/more than one pull request/) } });
    });

    it('checks the least recently checked gate first, so a gate later in the design is not starved by an earlier one', async () => {
      const key = `jobs-${++n}`;
      const two = {
        format: 1,
        title: 'Two gates',
        blocks: [{ kind: 'wave', id: 'W-1', title: 'First', when: 'now', jobs: ['a', 'x', 'b', 'e'] }, card('a', []), card('x', []), card('b', [{ kind: 'merged', job: 'a' }]), card('e', [{ kind: 'merged', job: 'x' }])],
      };
      await importInitiative(env.ctx, { key, title: `Two gates ${n}`, repos: [{ slug: 'app', path: '/home/u/app', base: 'main', github: 'owner/app' }], source: 'a test', doc: two });
      const s = await staff();
      const a = await startAndRegister(s, key, 'a');
      const x = await startAndRegister(s, key, 'x');
      await deliver(a.job_id, 'https://github.com/owner/app/pull/44');
      await deliver(x.job_id, 'https://github.com/owner/app/pull/45');
      await queueGateChecks(env.ctx);
      const first: any = await nextLaunch(env.ctx);
      expect(first?.kind).toBe('gate_check');
      await finishLaunch(env.ctx, first.id, 'checked');
      // The gate of b was checked a little over GATE_CHECK_MS ago, so it is due again. In document order it would go first.
      env.clock.advance(GATE_CHECK_MS / 1000 + 1);
      await queueGateChecks(env.ctx);
      const pending = await queryOne(env.ctx.pool, `SELECT g.gate_key FROM launches l JOIN initiative_gates g ON g.id = l.run_id WHERE l.kind = 'gate_check' AND l.finished_at IS NULL`);
      expect(pending?.gate_key).toBe('merged:x');
    });

    it('reads a delivery whose pull request URL has a trailing slash, a query or a fragment as that pull request', async () => {
      const key = await room();
      const s = await staff();
      const a = await startAndRegister(s, key, 'a');
      await deliver(a.job_id, 'https://github.com/owner/app/pull/34/?tab=files#discussion');
      await queueGateChecks(env.ctx);
      expect(await gateCheckLaunches(key)).toBe(1);
    });

    it('does not read a pull request URL with a subpath as a pull request', async () => {
      const key = await room();
      const s = await staff();
      const a = await startAndRegister(s, key, 'a');
      await deliver(a.job_id, 'https://github.com/owner/app/pull/34/files');
      await queueGateChecks(env.ctx);
      expect(await gateCheckLaunches(key)).toBe(0);
      expect(gateOf(await cardJobs(env.ctx, key), 'b', 'merged:a').evidence).toMatchObject({ not_checked: expect.stringMatching(/does not name a GitHub pull request/) });
    });
  });

  describe('Architect answers', () => {
    const threadOf = async (jobId: string) => String((await queryOne(env.ctx.pool, `SELECT id FROM threads WHERE job_id = ? AND kind = 'discussion' LIMIT 1`, [jobId]))!.id);
    const messagesOf = async (threadId: string) => Number((await queryOne(env.ctx.pool, 'SELECT COUNT(*) AS n FROM messages WHERE thread_id = ?', [threadId]))!.n);
    const architectOf = async (key: string) => (await initiativeByKey(env.ctx.pool, key)).id;

    it('posts a decision citation at once, as the Architect, and refuses a missing or unknown citation', async () => {
      const key = await room();
      const s = await staff();
      const a = await startAndRegister(s, key, 'a');
      const thread = await threadOf(a.job_id);
      const ini = await architectOf(key);
      await expect(answerStaffQuestion(env.ctx, ini, { job_id: a.job_id, thread_id: thread, answer: 'Use the app host.', citation: undefined })).rejects.toThrow(/needs a citation/);
      await expect(answerStaffQuestion(env.ctx, ini, { job_id: a.job_id, thread_id: thread, answer: 'x', citation: { decision: 'D99' } })).rejects.toThrow(/not in design version/);

      const before = await messagesOf(thread);
      const got: any = await answerStaffQuestion(env.ctx, ini, { job_id: a.job_id, thread_id: thread, answer: 'Use the app host.', citation: { decision: 'D1' } });
      expect(got.state).toBe('posted');
      expect(await messagesOf(thread)).toBe(before + 1);
      const m: any = await queryOne(env.ctx.pool, 'SELECT author, body FROM messages WHERE thread_id = ? ORDER BY id DESC LIMIT 1', [thread]);
      expect(m.author).not.toBe('client');
      expect(m.author).toBe((await queryOne(env.ctx.pool, 'SELECT architect_agent_id FROM initiatives WHERE id = ?', [ini]))!.architect_agent_id);
      expect(m.body).toMatch(/Answered from D1, design v1\./);
    });

    it('refuses a job of another initiative', async () => {
      const key = await room();
      const other = await room();
      const s = await staff();
      const a = await startAndRegister(s, key, 'a');
      const thread = await threadOf(a.job_id);
      await expect(answerStaffQuestion(env.ctx, await architectOf(other), { job_id: a.job_id, thread_id: thread, answer: 'x', citation: { decision: 'D1' } })).rejects.toThrow(/not a job of initiative/);
    });

    it('refuses a code quote that is only spaces, or shorter than eight characters, before any check runs', async () => {
      const key = await room();
      const s = await staff();
      const a = await startAndRegister(s, key, 'a');
      const thread = await threadOf(a.job_id);
      const ini = await architectOf(key);
      const at = { repo: 'app', path: 'src/x.ts', line: 2, sha: 'a'.repeat(40) };
      await expect(answerStaffQuestion(env.ctx, ini, { job_id: a.job_id, thread_id: thread, answer: 'x', citation: { code: { ...at, quote: '     ' } } })).rejects.toThrow(/at least 8 characters/);
      await expect(answerStaffQuestion(env.ctx, ini, { job_id: a.job_id, thread_id: thread, answer: 'x', citation: { code: { ...at, quote: 'x = 1;' } } })).rejects.toThrow(/at least 8 characters/);
      expect(await queryOne(env.ctx.pool, `SELECT id FROM launches WHERE kind = 'quote_check'`)).toBeFalsy();
    });

    it('gives an initiative with no Architect agent one at its first answer', async () => {
      const key = await room();
      const s = await staff();
      const a = await startAndRegister(s, key, 'a');
      const thread = await threadOf(a.job_id);
      const ini = await architectOf(key);
      await exec(env.ctx.pool, 'UPDATE initiatives SET architect_agent_id = NULL WHERE id = ?', [ini]);
      const got: any = await answerStaffQuestion(env.ctx, ini, { job_id: a.job_id, thread_id: thread, answer: 'Use the app host.', citation: { decision: 'D1' } });
      expect(got.state).toBe('posted');
      const agentId = (await queryOne(env.ctx.pool, 'SELECT architect_agent_id FROM initiatives WHERE id = ?', [ini]))!.architect_agent_id;
      expect(agentId).toBeTruthy();
      expect(await queryOne(env.ctx.pool, 'SELECT role FROM agents WHERE id = ?', [agentId])).toMatchObject({ role: 'architect' });
    });

    it('finds the card of a job whose newest request is a copy with no retry link to the card start', async () => {
      const key = await room();
      const s = await staff();
      const a = await startAndRegister(s, key, 'a');
      const thread = await threadOf(a.job_id);
      const ini = await architectOf(key);
      // A takeover or replacement request for the same job: a copy of the card's request with no retry_of.
      const cols = (await query(env.ctx.pool, `SELECT COLUMN_NAME AS c FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'job_requests'`)).map((r: any) => String(r.c));
      const row: any = await queryOne(env.ctx.pool, 'SELECT * FROM job_requests WHERE job_id = ? ORDER BY created_at DESC LIMIT 1', [a.job_id]);
      const copy: Record<string, unknown> = { ...row, id: newId('req'), retry_of: null, created_at: new Date(env.clock.now().getTime() + 1000) };
      await exec(env.ctx.pool, `INSERT INTO job_requests (${cols.map((c) => `\`${c}\``).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map((c) => copy[c] ?? null));
      const got: any = await answerStaffQuestion(env.ctx, ini, { job_id: a.job_id, thread_id: thread, answer: 'Use the app host.', citation: { decision: 'D1' } });
      expect(got.state).toBe('posted');
    });

    it('refuses a checking answer whose quote check finishes without reporting its output', async () => {
      const key = await room();
      const s = await staff();
      const a = await startAndRegister(s, key, 'a');
      const thread = await threadOf(a.job_id);
      const ini = await architectOf(key);
      const code = { repo: 'app', path: 'src/x.ts', line: 2, sha: 'a'.repeat(40), quote: 'const x = 1;' };
      await answerStaffQuestion(env.ctx, ini, { job_id: a.job_id, thread_id: thread, answer: 'Lost check.', citation: { code } });
      const launch: any = await nextLaunch(env.ctx);
      expect(launch).toMatchObject({ kind: 'quote_check' });
      const mid = await messagesOf(thread);
      await finishLaunch(env.ctx, launch.id, 'ok: read src/x.ts at aaaaaaaaaaaa: read');
      expect(await queryOne(env.ctx.pool, 'SELECT state, refusal FROM architect_answers WHERE answer = ?', ['Lost check.'])).toMatchObject({ state: 'refused', refusal: expect.stringMatching(/without reporting/) });
      expect(await messagesOf(thread)).toBe(mid);
    });

    it('refuses a checking answer whose quote check failed before it reported, and says why', async () => {
      const key = await room();
      const s = await staff();
      const a = await startAndRegister(s, key, 'a');
      const thread = await threadOf(a.job_id);
      const ini = await architectOf(key);
      const code = { repo: 'app', path: 'src/x.ts', line: 2, sha: 'a'.repeat(40), quote: 'const x = 1;' };
      await answerStaffQuestion(env.ctx, ini, { job_id: a.job_id, thread_id: thread, answer: 'Failed check.', citation: { code } });
      const launch: any = await nextLaunch(env.ctx);
      await finishLaunch(env.ctx, launch.id, 'failed: quote check with a bad path');
      expect(await queryOne(env.ctx.pool, 'SELECT state, refusal FROM architect_answers WHERE answer = ?', ['Failed check.'])).toMatchObject({ state: 'refused', refusal: 'The check failed: failed: quote check with a bad path' });
    });

    it('posts a quote-checked answer once when the runner reports its output twice', async () => {
      const key = await room();
      const s = await staff();
      const a = await startAndRegister(s, key, 'a');
      const thread = await threadOf(a.job_id);
      const ini = await architectOf(key);
      const code = { repo: 'app', path: 'src/x.ts', line: 2, sha: 'a'.repeat(40), quote: 'const x = 1;' };
      await answerStaffQuestion(env.ctx, ini, { job_id: a.job_id, thread_id: thread, answer: 'Once only.', citation: { code } });
      const launch: any = await nextLaunch(env.ctx);
      const before = await messagesOf(thread);
      const out = { code: 0, stdout: 'export {};\n  const x = 1;\n', stderr: '' };
      await recordQuoteOutput(env.ctx, launch.id, out);
      const again: any = await recordQuoteOutput(env.ctx, launch.id, out);
      expect(again).toMatchObject({ recorded: false });
      expect(await messagesOf(thread)).toBe(before + 1);
    });

    it('posts a quote-checked answer once when two outputs of the same launch arrive at the same time', async () => {
      const key = await room();
      const s = await staff();
      const a = await startAndRegister(s, key, 'a');
      const thread = await threadOf(a.job_id);
      const ini = await architectOf(key);
      const code = { repo: 'app', path: 'src/x.ts', line: 2, sha: 'b'.repeat(40), quote: 'const x = 1;' };
      await answerStaffQuestion(env.ctx, ini, { job_id: a.job_id, thread_id: thread, answer: 'Concurrent once.', citation: { code } });
      const launch: any = await nextLaunch(env.ctx);
      const before = await messagesOf(thread);
      const out = { code: 0, stdout: 'export {};\n  const x = 1;\n', stderr: '' };
      const results: any[] = await Promise.all([recordQuoteOutput(env.ctx, launch.id, out), recordQuoteOutput(env.ctx, launch.id, out)]);
      expect(results.filter((r) => r && r.recorded !== false)).toHaveLength(1);
      expect(results.filter((r) => r && r.recorded === false)).toHaveLength(1);
      expect(await messagesOf(thread)).toBe(before + 1);
    });

    it('two escalations of one question sent together raise one blocker, and one of them is reused', async () => {
      const key = await room();
      const s = await staff();
      const a = await startAndRegister(s, key, 'a');
      const ini = await architectOf(key);
      const esc = { job_id: a.job_id, question: 'Concurrent question?', recommendation: 'Use the app host.', why_client: 'It changes the host.', checked: 'D1 and O-host' };
      const results: any[] = await Promise.all([escalate(env.ctx, ini, esc), escalate(env.ctx, ini, esc)]);
      expect(results.map((r) => r.state).sort()).toEqual(['escalated', 'reused']);
      const blockers = await query(env.ctx.pool, `SELECT id FROM blockers WHERE job_id = ? AND requested_decision = ? AND resolved_at IS NULL AND dismissed_at IS NULL`, [a.job_id, 'Concurrent question?']);
      expect(blockers).toHaveLength(1);
    });

    it('checks a code citation with the runner: posts when the quote is on the line, refuses (and posts nothing) when it is not', async () => {
      const key = await room();
      const s = await staff();
      const a = await startAndRegister(s, key, 'a');
      const thread = await threadOf(a.job_id);
      const ini = await architectOf(key);
      const sha = 'a'.repeat(40);
      const code = { repo: 'app', path: 'src/x.ts', line: 2, sha, quote: 'const  x = 1;' };
      const good: any = await answerStaffQuestion(env.ctx, ini, { job_id: a.job_id, thread_id: thread, answer: 'It is 1.', citation: { code } });
      expect(good.state).toBe('checking');
      const launch: any = await nextLaunch(env.ctx);
      expect(launch).toMatchObject({ kind: 'quote_check', sha, path: 'src/x.ts' });
      const before = await messagesOf(thread);
      await recordQuoteOutput(env.ctx, launch.id, { code: 0, stdout: 'export {};\n  const x = 1;\n', stderr: '' });
      expect(await messagesOf(thread)).toBe(before + 1);
      expect(await queryOne(env.ctx.pool, 'SELECT state FROM architect_answers WHERE answer = ?', ['It is 1.'])).toMatchObject({ state: 'posted' });

      const bad: any = await answerStaffQuestion(env.ctx, ini, { job_id: a.job_id, thread_id: thread, answer: 'Wrong.', citation: { code: { ...code, quote: 'const x = 2;' } } });
      expect(bad.state).toBe('checking');
      const launch2: any = await nextLaunch(env.ctx);
      const mid = await messagesOf(thread);
      await recordQuoteOutput(env.ctx, launch2.id, { code: 0, stdout: 'export {};\n  const x = 1;\n', stderr: '' });
      expect(await messagesOf(thread)).toBe(mid);
      expect(await queryOne(env.ctx.pool, 'SELECT state, refusal FROM architect_answers WHERE answer = ?', ['Wrong.'])).toMatchObject({ state: 'refused', refusal: expect.stringMatching(/not on line 2/) });
    });
  });

  describe('Architect escalations and delegated answers', () => {
    const threadOf = async (jobId: string) => String((await queryOne(env.ctx.pool, `SELECT id FROM threads WHERE job_id = ? AND kind = 'discussion' LIMIT 1`, [jobId]))!.id);
    const blockerOf = async (id: string) => queryOne(env.ctx.pool, 'SELECT * FROM blockers WHERE id = ?', [id]);
    const architectOf = async (key: string) => (await initiativeByKey(env.ctx.pool, key)).id;
    const escalation = (jobId: string, question: string) => ({ job_id: jobId, question, recommendation: 'Use the app host.', why_client: 'It changes the host.', checked: 'D1 and O-host' });

    it('refuses a blocker_id of another job or a closed blocker, and takes the question from the blocker row', async () => {
      const key = await room();
      const s = await staff();
      const a = await startAndRegister(s, key, 'a');
      const other = await startAndRegister(s, key, 'd');
      const ini = await architectOf(key);
      const staffBlocker: any = await raiseBlocker(env.ctx, s, { jobId: a.job_id, kind: 'client_decision', requestedDecision: 'Which host, routed?', recommendation: 'The app host.', recommendationActionable: true, unblockCondition: 'The Client picks a host.' });
      const base = { recommendation: 'Use the app host.', why_client: 'It changes the host.', checked: 'D1' };
      // The question given is not used: the Inbox shows the blocker's own question, and a repeat reuses the blocker by id.
      expect(await escalate(env.ctx, ini, { ...base, job_id: a.job_id, blocker_id: staffBlocker.blocker_id, question: 'An unrelated question?' })).toMatchObject({ state: 'escalated', blocker_id: staffBlocker.blocker_id });
      expect(await escalate(env.ctx, ini, { ...base, job_id: a.job_id, blocker_id: staffBlocker.blocker_id, question: 'Another wording.' })).toMatchObject({ state: 'reused', blocker_id: staffBlocker.blocker_id });
      const row = ((await openAnswers(env.ctx, ini)) as any[]).find((r) => r.job_id === a.job_id && r.state === 'escalated');
      expect(row).toMatchObject({ question: 'Which host, routed?' });
      await expect(escalate(env.ctx, ini, { ...base, job_id: other.job_id, blocker_id: staffBlocker.blocker_id, question: 'Which host, routed?' })).rejects.toThrow(/is not an open client decision of job/);
      await resolveBlocker(env.ctx, { kind: 'client' }, { blockerId: staffBlocker.blocker_id, resolution: 'Done.' });
      await expect(escalate(env.ctx, ini, { ...base, job_id: a.job_id, blocker_id: staffBlocker.blocker_id, question: 'Which host, routed?' })).rejects.toThrow(/is not an open client decision of job/);
    });

    it('refuses a credential in an answer or in a quoted citation before any row or launch is written', async () => {
      const key = await room();
      const s = await staff();
      const a = await startAndRegister(s, key, 'a');
      const thread = await threadOf(a.job_id);
      const ini = await architectOf(key);
      const secret = 'token sk-' + 'a'.repeat(30);
      const code = { repo: 'app', path: 'src/x.ts', line: 2, sha: 'a'.repeat(40), quote: 'const x = 1;' };
      await expect(answerStaffQuestion(env.ctx, ini, { job_id: a.job_id, thread_id: thread, answer: secret, citation: { code } })).rejects.toThrow(/credential/);
      await expect(answerStaffQuestion(env.ctx, ini, { job_id: a.job_id, thread_id: thread, answer: 'It is 1.', citation: { code: { ...code, quote: secret } } })).rejects.toThrow(/credential/);
      expect(await queryOne(env.ctx.pool, 'SELECT id FROM architect_answers WHERE job_id = ?', [a.job_id])).toBeFalsy();
      expect(await queryOne(env.ctx.pool, 'SELECT l.id FROM launches l JOIN architect_answers a ON a.launch_id = l.id WHERE a.job_id = ?', [a.job_id])).toBeFalsy();
    });

    it('attaches an escalation to a routed Staff client decision: one blocker, reused on a repeat, and Accept resolves it', async () => {
      const key = await room();
      const s = await staff();
      const a = await startAndRegister(s, key, 'a');
      const ini = await architectOf(key);
      const staffBlocker: any = await raiseBlocker(env.ctx, s, { jobId: a.job_id, kind: 'client_decision', requestedDecision: 'Which host, routed?', recommendation: 'The app host.', recommendationActionable: true, unblockCondition: 'The Client picks a host.' });
      const routed = { job_id: a.job_id, blocker_id: staffBlocker.blocker_id, question: 'Which host, routed?', recommendation: 'Use the app host.', why_client: 'It changes the host.', checked: 'D1' };
      expect(await escalate(env.ctx, ini, routed)).toMatchObject({ state: 'escalated', blocker_id: staffBlocker.blocker_id });
      expect(await escalate(env.ctx, ini, routed)).toMatchObject({ state: 'reused', blocker_id: staffBlocker.blocker_id });
      const open = await query(env.ctx.pool, `SELECT id FROM blockers WHERE job_id = ? AND kind = 'client_decision' AND resolved_at IS NULL AND dismissed_at IS NULL`, [a.job_id]);
      expect(open).toHaveLength(1);
      const answerId = String((await queryOne(env.ctx.pool, `SELECT id FROM architect_answers WHERE blocker_id = ? AND state = 'escalated'`, [staffBlocker.blocker_id]))!.id);
      await acceptEscalation(env.ctx, answerId);
      expect(await blockerOf(staffBlocker.blocker_id)).toMatchObject({ resolved_at: expect.anything() });
    });

    it('an attached escalation keeps the why and the check, is reused without blocker_id, and the Architect cannot answer it', async () => {
      const key = await room();
      const s = await staff();
      const a = await startAndRegister(s, key, 'a');
      const ini = await architectOf(key);
      const staffBlocker: any = await raiseBlocker(env.ctx, s, { jobId: a.job_id, kind: 'client_decision', requestedDecision: 'Which host, routed?', recommendation: 'The app host.', recommendationActionable: true, unblockCondition: 'The Client picks a host.' });
      const routed = { job_id: a.job_id, blocker_id: staffBlocker.blocker_id, question: 'Which host, routed?', recommendation: 'Use the app host.', why_client: 'It changes the host.', checked: 'D1' };
      await escalate(env.ctx, ini, routed);
      expect(await escalate(env.ctx, ini, { ...routed, blocker_id: undefined })).toMatchObject({ state: 'reused', blocker_id: staffBlocker.blocker_id });
      const row = ((await openAnswers(env.ctx, ini)) as any[]).find((r) => r.job_id === a.job_id && r.state === 'escalated');
      expect(row).toMatchObject({ question: 'Which host, routed?', citation: { why_client: 'It changes the host.', checked: 'D1' } });
      await expect(answerStaffQuestion(env.ctx, ini, { job_id: a.job_id, blocker_id: staffBlocker.blocker_id, answer: 'Use D1.', citation: { decision: 'D1' } })).rejects.toThrow(/escalated to the Client/);
    });

    it('posts a decision answer from the design version read under the lock, and currentVersionOf returns that version', async () => {
      const key = await room();
      const s = await staff();
      const a = await startAndRegister(s, key, 'a');
      const thread = await threadOf(a.job_id);
      const ini = await architectOf(key);
      const current = Number((await queryOne(env.ctx.pool, 'SELECT current_version FROM initiatives WHERE id = ?', [ini]))!.current_version);
      expect((await currentVersionOf(env.ctx.pool, ini)).version).toBe(current);
      const got: any = await answerStaffQuestion(env.ctx, ini, { job_id: a.job_id, thread_id: thread, answer: 'The app host.', citation: { decision: 'D1' } });
      expect(got.state).toBe('posted');
      expect(String((await queryOne(env.ctx.pool, 'SELECT body FROM messages WHERE id = ?', [got.message_id]))!.body)).toContain(`design v${current}.`);
    });

    it('a code-cited answer is refused, not posted, when the Architect escalates its blocker while the check runs', async () => {
      const key = await room();
      const s = await staff();
      const a = await startAndRegister(s, key, 'a');
      const ini = await architectOf(key);
      const staffBlocker: any = await raiseBlocker(env.ctx, s, { jobId: a.job_id, kind: 'client_decision', requestedDecision: 'Which host, checked?', recommendation: 'The app host.', recommendationActionable: true, unblockCondition: 'The Client picks a host.' });
      const code = { repo: 'app', path: 'src/x.ts', line: 2, sha: 'a'.repeat(40), quote: 'const x = 1;' };
      const cited: any = await answerStaffQuestion(env.ctx, ini, { job_id: a.job_id, blocker_id: staffBlocker.blocker_id, answer: 'It is 1.', citation: { code } });
      expect(cited.state).toBe('checking');
      await escalate(env.ctx, ini, { job_id: a.job_id, blocker_id: staffBlocker.blocker_id, question: 'Which host, checked?', recommendation: 'Use the app host.', why_client: 'It changes the host.', checked: 'D1' });
      const launch: any = await nextLaunch(env.ctx);
      await recordQuoteOutput(env.ctx, launch.id, { code: 0, stdout: 'export {};\n  const x = 1;\n', stderr: '' });
      expect(await queryOne(env.ctx.pool, 'SELECT state, refusal FROM architect_answers WHERE id = ?', [cited.answer_id])).toMatchObject({ state: 'refused', refusal: expect.stringMatching(/escalated to the Client/) });
      expect(await blockerOf(staffBlocker.blocker_id)).toMatchObject({ resolved_at: null });
    });

    it('escalates once (a repeat reuses the open blocker), and Accept posts the Client answer and resolves the blocker in one click', async () => {
      const key = await room();
      const s = await staff();
      const a = await startAndRegister(s, key, 'a');
      const ini = await architectOf(key);
      const first: any = await escalate(env.ctx, ini, escalation(a.job_id, 'Which host?'));
      expect(first.state).toBe('escalated');
      const again: any = await escalate(env.ctx, ini, escalation(a.job_id, 'Which host?'));
      expect(again).toMatchObject({ state: 'reused', blocker_id: first.blocker_id });
      expect(await blockerOf(first.blocker_id)).toMatchObject({ kind: 'client_decision', responsible: 'client', raised_by: expect.any(String) });

      const row: any = await queryOne(env.ctx.pool, 'SELECT id FROM architect_answers WHERE blocker_id = ?', [first.blocker_id]);
      await acceptEscalation(env.ctx, row.id);
      expect(await blockerOf(first.blocker_id)).toMatchObject({ resolved_at: expect.anything(), resolved_by: 'client' });
      const m: any = await queryOne(env.ctx.pool, `SELECT author, body FROM messages WHERE thread_id = ? ORDER BY id DESC LIMIT 1`, [await threadOf(a.job_id)]);
      expect(m.author).toBe('client');
      expect(m.body).toMatch(/Use the app host\./);
    });

    it('a plain Client resolve of an escalation posts the Client answer and closes its row, and a later Accept is refused', async () => {
      const key = await room();
      const s = await staff();
      const a = await startAndRegister(s, key, 'a');
      const ini = await architectOf(key);
      const esc: any = await escalate(env.ctx, ini, escalation(a.job_id, 'Closed first?'));
      const row: any = await queryOne(env.ctx.pool, 'SELECT id FROM architect_answers WHERE blocker_id = ?', [esc.blocker_id]);
      await resolveBlocker(env.ctx, { kind: 'client' }, { blockerId: esc.blocker_id, resolution: 'Settled another way' });
      const thread = await threadOf(a.job_id);
      const before = Number((await queryOne(env.ctx.pool, 'SELECT COUNT(*) AS n FROM messages WHERE thread_id = ?', [thread]))!.n);
      await expect(acceptEscalation(env.ctx, row.id)).rejects.toThrow(/not an open escalation/);
      expect(Number((await queryOne(env.ctx.pool, 'SELECT COUNT(*) AS n FROM messages WHERE thread_id = ?', [thread]))!.n)).toBe(before);
      expect(await queryOne(env.ctx.pool, 'SELECT state, target, answer FROM architect_answers WHERE id = ?', [row.id])).toMatchObject({ state: 'posted', target: 'thread', answer: 'Settled another way' });
      await expect(reopenAnswer(env.ctx, row.id)).rejects.toThrow(/Only a posted answer to a client decision/);
      const posted: any = await queryOne(env.ctx.pool, `SELECT author, body, id FROM messages WHERE thread_id = ? AND author = 'client' AND type = 'reply' ORDER BY id DESC LIMIT 1`, [thread]);
      expect(posted).toMatchObject({ author: 'client' });
      expect(posted.body).toMatch(/Settled another way/);
      expect(await queryOne(env.ctx.pool, 'SELECT message_id FROM architect_answers WHERE id = ?', [row.id])).toMatchObject({ message_id: posted.id });
    });

    it('a dismissed escalation is not accepted: the Accept is refused and posts nothing', async () => {
      const key = await room();
      const s = await staff();
      const a = await startAndRegister(s, key, 'a');
      const esc: any = await escalate(env.ctx, await architectOf(key), escalation(a.job_id, 'Dismissed first?'));
      const row: any = await queryOne(env.ctx.pool, 'SELECT id FROM architect_answers WHERE blocker_id = ?', [esc.blocker_id]);
      await dismissBlocker(env.ctx, esc.blocker_id, 'No longer applies');
      const thread = await threadOf(a.job_id);
      const count = async () => Number((await queryOne(env.ctx.pool, 'SELECT COUNT(*) AS n FROM messages WHERE thread_id = ?', [thread]))!.n);
      const before = await count();
      await expect(acceptEscalation(env.ctx, row.id)).rejects.toThrow(/already closed, so nothing was posted|not an open escalation/);
      expect(await count()).toBe(before);
    });

    it('refuses a delegated answer to a client decision that is already closed, and posts nothing', async () => {
      const key = await room();
      const s = await staff();
      const a = await startAndRegister(s, key, 'a');
      const ini = await architectOf(key);
      const esc: any = await escalate(env.ctx, ini, escalation(a.job_id, 'Dismissed first?'));
      await dismissBlocker(env.ctx, esc.blocker_id, 'no longer needed');
      const thread = await threadOf(a.job_id);
      const before = Number((await queryOne(env.ctx.pool, 'SELECT COUNT(*) AS n FROM messages WHERE thread_id = ?', [thread]))!.n);
      await expect(answerStaffQuestion(env.ctx, ini, { job_id: a.job_id, blocker_id: esc.blocker_id, answer: 'late', citation: { decision: 'D1' } })).rejects.toThrow(/not an open client decision/);
      expect(Number((await queryOne(env.ctx.pool, 'SELECT COUNT(*) AS n FROM messages WHERE thread_id = ?', [thread]))!.n)).toBe(before);
    });

    it('answers a client decision Staff raised, with a citation, marked delegated; Reopen works until Staff replies, then is refused', async () => {
      const key = await room();
      const s = await staff();
      const a = await startAndRegister(s, key, 'a');
      const ini = await architectOf(key);
      const esc: any = await escalate(env.ctx, ini, escalation(a.job_id, 'Which host, for real?'));
      await expect(answerStaffQuestion(env.ctx, ini, { job_id: a.job_id, blocker_id: esc.blocker_id, answer: 'x', citation: { decision: 'D1' } })).rejects.toThrow(/cannot answer its own escalation/);
      const staffBlocker: any = await raiseBlocker(env.ctx, s, { jobId: a.job_id, kind: 'client_decision', requestedDecision: 'Which host, for real?', recommendation: 'The app host.', recommendationActionable: true, unblockCondition: 'The Client picks a host.' });
      const got: any = await answerStaffQuestion(env.ctx, ini, { job_id: a.job_id, blocker_id: staffBlocker.blocker_id, answer: 'The app host, as D1 says.', citation: { decision: 'D1' } });
      expect(got).toMatchObject({ state: 'posted', target: 'blocker' });
      const b: any = await blockerOf(staffBlocker.blocker_id);
      expect(b.resolved_at).toBeTruthy();
      expect(b.resolved_by).toBe((await queryOne(env.ctx.pool, 'SELECT architect_agent_id FROM initiatives WHERE id = ?', [ini]))!.architect_agent_id);

      // Reopen raises a new client decision, and the answer is listed again as an escalation until the Client acts.
      const reopened: any = await reopenAnswer(env.ctx, got.answer_id);
      expect(reopened).toMatchObject({ state: 'escalated', reopened: got.answer_id });
      expect(await blockerOf(reopened.blocker_id)).toMatchObject({ kind: 'client_decision', resolved_at: null });
      expect(await queryOne(env.ctx.pool, 'SELECT state FROM architect_answers WHERE id = ?', [got.answer_id])).toMatchObject({ state: 'reopened' });
      const listed: any = await queryOne(env.ctx.pool, 'SELECT id FROM architect_answers WHERE blocker_id = ?', [reopened.blocker_id]);
      expect(((await openAnswers(env.ctx, ini)) as any[]).find((r) => r.id === listed.id)).toMatchObject({ state: 'escalated' });

      // A second delegated answer: Staff replies on the thread, so Reopen is refused.
      const thread = await threadOf(a.job_id);
      const second: any = await raiseBlocker(env.ctx, s, { jobId: a.job_id, kind: 'client_decision', requestedDecision: 'Which queue?', recommendation: 'The default queue.', recommendationActionable: true, unblockCondition: 'The Client picks a queue.' });
      const t: any = await answerStaffQuestion(env.ctx, ini, { job_id: a.job_id, blocker_id: second.blocker_id, answer: 'Use D1.', citation: { decision: 'D1' } });
      await postMessage(env.ctx, { kind: 'agent', agent: s }, { jobId: a.job_id, threadId: thread, type: 'reply', stance: 'inform', body: 'Thanks, doing it.' });
      await expect(reopenAnswer(env.ctx, t.answer_id)).rejects.toThrow(/Staff has replied/);
    });

    it('refuses to reopen a delegated answer after the Staff that replied on its thread was replaced', async () => {
      const key = await room();
      const s = await staff();
      const a = await startAndRegister(s, key, 'a');
      const thread = await threadOf(a.job_id);
      const ini = await architectOf(key);
      const raised: any = await raiseBlocker(env.ctx, s, { jobId: a.job_id, kind: 'client_decision', requestedDecision: 'Which handover?', recommendation: 'The default.', recommendationActionable: true, unblockCondition: 'The Client picks.' });
      const got: any = await answerStaffQuestion(env.ctx, ini, { job_id: a.job_id, blocker_id: raised.blocker_id, answer: 'Use D1.', citation: { decision: 'D1' } });
      await postMessage(env.ctx, { kind: 'agent', agent: s }, { jobId: a.job_id, threadId: thread, type: 'reply', stance: 'inform', body: 'Before the handover.' });
      const next = await staff();
      await tx(env.ctx, (conn) => reassignStaffIn(conn, env.ctx, a.job_id, next.id));
      await expect(reopenAnswer(env.ctx, got.answer_id)).rejects.toThrow(/Staff has replied/);
      expect(((await openAnswers(env.ctx, ini)) as any[]).map((r) => r.id)).not.toContain(got.answer_id);
    });

    it('refuses to reopen an answer posted on a thread, because only a delegated answer to a client decision can be reopened', async () => {
      const key = await room();
      const s = await staff();
      const a = await startAndRegister(s, key, 'a');
      const thread = await threadOf(a.job_id);
      const ini = await architectOf(key);
      const plain: any = await answerStaffQuestion(env.ctx, ini, { job_id: a.job_id, thread_id: thread, answer: 'Thread answer.', citation: { decision: 'D1' } });
      expect(plain).toMatchObject({ state: 'posted', target: 'thread' });
      await expect(reopenAnswer(env.ctx, plain.answer_id)).rejects.toThrow(/Only a posted answer to a client decision/);
    });

    it('refuses a blocker answer from a job that is not the blocker\'s, and an escalation with a secret', async () => {
      const key = await room();
      const other = await room();
      const s = await staff();
      const a = await startAndRegister(s, key, 'a');
      const c = await startAndRegister(s, other, 'a');
      const ini = await architectOf(key);
      const esc: any = await escalate(env.ctx, ini, escalation(a.job_id, 'A question'));
      await expect(answerStaffQuestion(env.ctx, await architectOf(other), { job_id: c.job_id, blocker_id: esc.blocker_id, answer: 'x', citation: { decision: 'D1' } })).rejects.toThrow(/not an open client decision/);
      await expect(escalate(env.ctx, ini, { ...escalation(a.job_id, 'Another'), recommendation: 'token sk-' + 'a'.repeat(30) })).rejects.toThrow();
    });
  });

  it('a ready card the preview refuses carries its reason as start_block, and the Architect reads the same states', async () => {
    // Four decisions of 19,000 characters each, all named by card e, push its prompt past the 50,000 limit.
    const big = [11, 12, 13, 14].map((k) => ({ kind: 'decision', id: `D${k}`, title: `Big ${k}`, body: 'x'.repeat(19_000) }));
    const key = await room(undefined, [...big, card('e', [], { decisions: ['D11', 'D12', 'D13', 'D14'] })]);
    const jobs: any = await cardJobs(env.ctx, key);
    const e = jobs.cards.find((c: any) => c.key === 'e');
    expect(e.state).toBe('ready');
    expect(e.start_block).toMatch(/over the 50000 limit/);
    expect(jobs.cards.find((c: any) => c.key === 'a').start_block).toBeNull();
    expect((await previewStart(env.ctx, key, 'e')).can_start).toBe(false);
    // The Architect's get_initiative reads the same evaluator: the same states and reasons as the Jobs tab.
    const states = await cardStatesOf(env.ctx.pool, await initiativeByKey(env.ctx.pool, key));
    expect(states.map((c) => [c.key, c.state, c.start_block])).toEqual(jobs.cards.map((c: any) => [c.key, c.state, c.start_block]));
  });

  describe('Inbox', () => {
    it('lists an escalation in the Inbox, and keeps an accepted one there to Reopen', async () => {
      const key = await room();
      const s = await staff();
      const a = await startAndRegister(s, key, 'a');
      const ini = (await initiativeByKey(env.ctx.pool, key)).id;
      const esc: any = await escalate(env.ctx, ini, { job_id: a.job_id, question: 'Which host?', recommendation: 'Use the app host.', why_client: 'It changes the host.', checked: 'D1' });
      const answerId = String((await queryOne(env.ctx.pool, 'SELECT id FROM architect_answers WHERE blocker_id = ?', [esc.blocker_id]))!.id);
      const open: any[] = (await openAnswers(env.ctx)) as any[];
      expect(open.find((r) => r.id === answerId)).toMatchObject({ initiative_key: key, state: 'escalated' });
      // The Inbox row carries the question and the context the Client decides on, not only the recommendation.
      expect(open.find((r) => r.id === answerId)).toMatchObject({ question: 'Which host?', context: 'It changes the host.\nChecked: D1' });
      expect((await answersOfInitiative(env.ctx, ini)).find((r: any) => r.id === answerId)).toMatchObject({ state: 'escalated', target: 'blocker' });
      await acceptEscalation(env.ctx, answerId);
      // Accepted, it is posted and can still be reopened, so it stays in the Inbox as a Reopen item.
      expect(((await openAnswers(env.ctx)) as any[]).find((r) => r.id === answerId)).toMatchObject({ state: 'posted', target: 'blocker' });
    });

    it('a blocker closed elsewhere leaves the Inbox, and the Inbox lists only the initiative of the room', async () => {
      const key = await room();
      const other = await room();
      const s = await staff();
      const a = await startAndRegister(s, key, 'a');
      const c = await startAndRegister(s, other, 'a');
      const ini = (await initiativeByKey(env.ctx.pool, key)).id;
      const esc: any = await escalate(env.ctx, ini, { job_id: a.job_id, question: 'Which host?', recommendation: 'Use the app host.', why_client: 'It changes the host.', checked: 'D1' });
      const otherEsc: any = await escalate(env.ctx, (await initiativeByKey(env.ctx.pool, other)).id, { job_id: c.job_id, question: 'Which queue?', recommendation: 'Use the queue.', why_client: 'It changes the queue.', checked: 'D1' });
      const answerId = String((await queryOne(env.ctx.pool, 'SELECT id FROM architect_answers WHERE blocker_id = ?', [esc.blocker_id]))!.id);
      const otherAnswerId = String((await queryOne(env.ctx.pool, 'SELECT id FROM architect_answers WHERE blocker_id = ?', [otherEsc.blocker_id]))!.id);
      expect(((await openAnswers(env.ctx, ini)) as any[]).map((r) => r.id)).toEqual([answerId]);
      await resolveBlocker(env.ctx, { kind: 'client' }, { blockerId: esc.blocker_id, resolution: 'Settled in the room' });
      // The Client's answer is posted and closed, so the row leaves the Inbox, and the other initiative's escalation stays.
      expect(((await openAnswers(env.ctx, ini)) as any[]).map((r) => r.id)).toEqual([]);
      expect(((await openAnswers(env.ctx)) as any[]).find((r) => r.id === answerId)).toBeUndefined();
      // The other initiative's escalation is still open in the global Inbox.
      expect(((await openAnswers(env.ctx)) as any[]).find((r) => r.id === otherAnswerId)).toMatchObject({ state: 'escalated' });
    });
  });

  describe('Architect wakes', () => {
    const architectOf = async (key: string) => (await initiativeByKey(env.ctx.pool, key)).id;
    const chatOf = async (key: string) => String((await queryOne(env.ctx.pool, 'SELECT chat_id FROM initiatives WHERE `key` = ?', [key]))!.chat_id);
    const sendsOf = async (chatId: string) => (await query(env.ctx.pool, `SELECT text FROM chat_commands WHERE chat_id = ? AND kind = 'send' ORDER BY id`, [chatId])).map((r: any) => String(r.text));
    const messagesOf = async (threadId: string) => Number((await queryOne(env.ctx.pool, 'SELECT COUNT(*) AS n FROM messages WHERE thread_id = ?', [threadId]))!.n);
    const pendingOf = async (key: string) => (await queryOne(env.ctx.pool, 'SELECT architect_wake_pending FROM initiatives WHERE `key` = ?', [key]))!.architect_wake_pending;
    const staffPost = (s: Agent, jobId: string, threadId: string, excerpt: string) =>
      tx(env.ctx, (conn) => emit(conn, env.ctx, { type: 'refinement.staff_posted', jobId, threadId, actor: s.id, targets: [], payload: { type: 'discussion', excerpt } }));
    const threadOf = async (jobId: string) => String((await queryOne(env.ctx.pool, `SELECT id FROM threads WHERE job_id = ? AND kind = 'discussion' LIMIT 1`, [jobId]))!.id);

    it('refuses a checking answer whose quote check no runner picked up, in the expiry, and tells the Architect', async () => {
      const key = await room();
      const s = await staff();
      const a = await startAndRegister(s, key, 'a');
      const chat = await chatOf(key);
      const thread = await threadOf(a.job_id);
      const ini = await architectOf(key);
      const code = { repo: 'app', path: 'src/x.ts', line: 2, sha: 'a'.repeat(40), quote: 'const x = 1;' };
      const pending: any = await answerStaffQuestion(env.ctx, ini, { job_id: a.job_id, thread_id: thread, answer: 'Unpicked check.', citation: { code } });
      const mid = await messagesOf(thread);
      env.clock.advance(10 * 60 + 1);
      await expireStaleLaunches(env.ctx);
      expect(await queryOne(env.ctx.pool, 'SELECT state, refusal FROM architect_answers WHERE answer = ?', ['Unpicked check.'])).toMatchObject({ state: 'refused', refusal: expect.stringMatching(/no runner picked up/) });
      expect(await messagesOf(thread)).toBe(mid);
      const told = [...(await sendsOf(chat)), String((await pendingOf(key)) ?? '')].join('\n');
      expect(told).toContain(String(pending.answer_id));
      expect(told).toContain('no runner picked up');
    });

    it('refuses a checking answer whose quote check runner was lost, in the expiry, and tells the Architect', async () => {
      const key = await room();
      const s = await staff();
      const a = await startAndRegister(s, key, 'a');
      const chat = await chatOf(key);
      const thread = await threadOf(a.job_id);
      const ini = await architectOf(key);
      const code = { repo: 'app', path: 'src/x.ts', line: 2, sha: 'a'.repeat(40), quote: 'const x = 1;' };
      const pending: any = await answerStaffQuestion(env.ctx, ini, { job_id: a.job_id, thread_id: thread, answer: 'Lost runner check.', citation: { code } });
      const launch: any = await nextLaunch(env.ctx);
      expect(launch).toMatchObject({ kind: 'quote_check' });
      const mid = await messagesOf(thread);
      env.clock.advance(5 * 60 + 1);
      await expireStaleLaunches(env.ctx);
      expect(await queryOne(env.ctx.pool, 'SELECT state, refusal FROM architect_answers WHERE answer = ?', ['Lost runner check.'])).toMatchObject({ state: 'refused', refusal: expect.stringMatching(/did not report back/) });
      expect(await messagesOf(thread)).toBe(mid);
      const told = [...(await sendsOf(chat)), String((await pendingOf(key)) ?? '')].join('\n');
      expect(told).toContain(String(pending.answer_id));
      expect(told).toContain('did not report back');
    });

    it('tells the Architect when a quote check refuses its answer: the answer id and the reason', async () => {
      const key = await room();
      const s = await staff();
      const a = await startAndRegister(s, key, 'a');
      const chat = await chatOf(key);
      const thread = await threadOf(a.job_id);
      const ini = await architectOf(key);
      const code = { repo: 'app', path: 'src/x.ts', line: 2, sha: 'a'.repeat(40), quote: 'const x = 2;' };
      const pending: any = await answerStaffQuestion(env.ctx, ini, { job_id: a.job_id, thread_id: thread, answer: 'Wrong.', citation: { code } });
      const launch: any = await nextLaunch(env.ctx);
      await recordQuoteOutput(env.ctx, launch.id, { code: 0, stdout: 'export {};\n  const x = 1;\n', stderr: '' });
      const answerId = String(pending.answer_id);
      const told = [...(await sendsOf(chat)), String((await pendingOf(key)) ?? '')].join('\n');
      expect(told).toContain(answerId);
      expect(told).toContain('The quote is not on line 2');
    });

    it('a client decision wake names the job General thread, and caps a long question', async () => {
      const key = await room();
      const s = await staff();
      const a = await startAndRegister(s, key, 'a');
      const chat = await chatOf(key);
      const long = 'Which host? ' + 'x'.repeat(900);
      await raiseBlocker(env.ctx, s, { jobId: a.job_id, kind: 'client_decision', requestedDecision: long, recommendation: 'The app host.', recommendationActionable: true, unblockCondition: 'The Client picks a host.' });
      const sends = await sendsOf(chat);
      const told = sends.length ? sends.join('\n') : String(await pendingOf(key));
      expect(told).toContain(await threadOf(a.job_id));
      expect(told).not.toContain('x'.repeat(250));
      expect(told).toContain('x'.repeat(100));
    });

    it('wakes the Architect when Staff asks on a job while refining, and names the job and the question', async () => {
      const key = await room();
      const s = await staff();
      const a = await startAndRegister(s, key, 'a');
      const chat = await chatOf(key);
      await staffPost(s, a.job_id, await threadOf(a.job_id), 'Which host do we use?');
      const sends = await sendsOf(chat);
      expect(sends).toHaveLength(1);
      expect(sends[0]).toMatch(/^\[Triglav\] Staff asked on initiative/);
      expect(sends[0]).toContain(a.job_id);
      expect(sends[0]).toContain('Which host do we use?');
    });

    it('does not wake the Architect for a Senior question, and an escalation the Architect raised does not wake it either', async () => {
      const key = await room();
      const s = await staff();
      const a = await startAndRegister(s, key, 'a');
      const chat = await chatOf(key);
      const thread = await threadOf(a.job_id);
      await tx(env.ctx, (conn) => emit(conn, env.ctx, { type: 'question.opened', jobId: a.job_id, threadId: thread, actor: s.id, targets: [], payload: {} }));
      expect(await sendsOf(chat)).toHaveLength(0);
      await escalate(env.ctx, await architectOf(key), { job_id: a.job_id, question: 'Which host?', recommendation: 'Use the app host.', why_client: 'It changes the host.', checked: 'D1' });
      expect(await sendsOf(chat)).toHaveLength(0);
      expect(await pendingOf(key)).toBeNull();
    });

    it('does not wake the Architect for a progress post of Staff', async () => {
      const key = await room();
      const s = await staff();
      const a = await startAndRegister(s, key, 'a');
      const chat = await chatOf(key);
      const thread = await threadOf(a.job_id);
      await tx(env.ctx, (conn) => emit(conn, env.ctx, { type: 'refinement.staff_posted', jobId: a.job_id, threadId: thread, actor: s.id, targets: [], payload: { type: 'progress', excerpt: 'Read the repository.' } }));
      expect(await sendsOf(chat)).toHaveLength(0);
      expect(await pendingOf(key)).toBeNull();
    });

    it('batches a question inside the interval, and sends the batch when the interval is over', async () => {
      const key = await room();
      const s = await staff();
      const a = await startAndRegister(s, key, 'a');
      const chat = await chatOf(key);
      const thread = await threadOf(a.job_id);
      await staffPost(s, a.job_id, thread, 'First question.');
      expect(await sendsOf(chat)).toHaveLength(1);
      await staffPost(s, a.job_id, thread, 'Second question.');
      expect(await sendsOf(chat)).toHaveLength(1);
      expect(await pendingOf(key)).not.toBeNull();
      await flushArchitectWakes(env.ctx);
      expect(await sendsOf(chat)).toHaveLength(1);
      env.clock.advance(ARCHITECT_WAKE_MS / 1000 + 1);
      await flushArchitectWakes(env.ctx);
      const sends = await sendsOf(chat);
      expect(sends).toHaveLength(2);
      expect(sends[1]).toContain('Second question.');
      expect(await pendingOf(key)).toBeNull();
    });

    it('reads a thread of its own initiative for the Architect, and refuses a thread of another initiative', async () => {
      const key = await room();
      const other = await room();
      const s = await staff();
      const a = await startAndRegister(s, key, 'a');
      const thread = await threadOf(a.job_id);
      const ini = await architectOf(key);
      expect(String((await threadOfInitiative(env.ctx, ini, thread)).thread.id)).toBe(thread);
      await expect(threadOfInitiative(env.ctx, await architectOf(other), thread)).rejects.toThrow(/not on a job of your initiative/);
    });

    it('wakes the Architect for a client decision blocker that Staff raises', async () => {
      const key = await room();
      const s = await staff();
      const a = await startAndRegister(s, key, 'a');
      const chat = await chatOf(key);
      await raiseBlocker(env.ctx, s, { jobId: a.job_id, kind: 'client_decision', requestedDecision: 'Pick the queue.', recommendation: 'Use the existing queue.', recommendationActionable: true, unblockCondition: 'The Client picks a queue.' });
      const sends = await sendsOf(chat);
      expect(sends).toHaveLength(1);
      expect(sends[0]).toMatch(/client decision/);
      expect(sends[0]).toContain('Pick the queue.');
    });
  });

  describe('Staff get_design', () => {
    it('gives the Staff of a card job its initiative design, and refuses another Staff, a job no card started and another initiative', async () => {
      const key = await room();
      const s = await staff();
      const a = await startAndRegister(s, key, 'a');
      const got: any = await staffDesign(env.ctx, s.id, a.job_id, {});
      expect(got).toMatchObject({ initiative: key, card: 'a' });
      expect(got.blocks.length).toBeGreaterThan(0);

      const other = await staff();
      await expect(staffDesign(env.ctx, other.id, a.job_id, {})).rejects.toThrow(/Only the Staff/);
      await expect(staffDesign(env.ctx, s.id, a.job_id, { initiative: 'not-this-initiative' })).rejects.toThrow(/belongs to initiative/);

      const plain = newId('job');
      const now = env.clock.now();
      await exec(env.ctx.pool, `INSERT INTO jobs (id, parent_job_id, linear_issue_id, linear_identifier, linear_url, title, repo_path, base_branch, status, linear_snapshot, linear_fetched_at, created_at, updated_at, staff_agent_id) VALUES (?, NULL, ?, ?, '', 'Plain', '/home/u/app', 'main', 'in_progress', '{}', ?, ?, ?, ?)`, [plain, plain, plain, now, now, now, s.id]);
      await expect(staffDesign(env.ctx, s.id, plain, {})).rejects.toThrow(/not started from an initiative card/);
    });
  });

  describe('manual marks', () => {
    it('does not describe a gate the Client marked by hand as a merged PR, even when an earlier check left an open PR', async () => {
      const key = await room();
      const s = await staff();
      const a = await startAndRegister(s, key, 'a');
      await deliver(a.job_id, 'https://github.com/owner/app/pull/38');
      await queueGateChecks(env.ctx);
      const l = await checkLaunch();
      await recordGateOutput(env.ctx, l.id, { code: 0, stdout: OPEN(38), stderr: '' });
      await markGate(env.ctx, key, 'b', 'merged:a', 'Merged on GitHub, checked by hand.');
      const preview = await previewStart(env.ctx, key, 'b');
      expect(preview.can_start).toBe(true);
      expect(preview.prompt).toContain('- a "Card a": merged (the Client marked it)');
      expect(preview.prompt).not.toContain('pull/38');
    });

    it('marks a gate by hand only with a reason, once, and writes a client_edit version', async () => {
      const key = await room();
      const before = await cardJobs(env.ctx, key);
      await expect(markGate(env.ctx, key, 'b', 'merged:a', '  ')).rejects.toThrow(/Give the reason/);
      await expect(markGate(env.ctx, key, 'b', 'decision:O-host', 'It is the app host.')).rejects.toThrow(/follows the design/);

      const out = await markGate(env.ctx, key, 'b', 'merged:a', 'PR 34 is merged; checked in the browser.');
      expect(out).toMatchObject({ gate: 'merged:a', version: before.version + 1 });
      const after = await cardJobs(env.ctx, key);
      expect(gateOf(after, 'b', 'merged:a')).toMatchObject({ met: true, met_by: 'client', reason: 'PR 34 is merged; checked in the browser.' });
      expect(after.cards.find((c) => c.key === 'b')!.state).toBe('ready');

      const i = await initiativeByKey(env.ctx.pool, key);
      const row = await queryOne(env.ctx.pool, 'SELECT trigger_kind, created_by FROM initiative_versions WHERE initiative_id = ? AND version = ?', [i.id, out.version]);
      expect(row).toMatchObject({ trigger_kind: 'client_edit', created_by: 'client' });
      const v = await versionOf(env.ctx.pool, i.id, out.version);
      const status = v.doc.blocks.find((b) => b.id === 'T-status') as { body?: string };
      expect(status.body).toContain('Reason: PR 34 is merged; checked in the browser.');

      await expect(markGate(env.ctx, key, 'b', 'merged:a', 'again')).rejects.toThrow(/already met/);
      await queueGateChecks(env.ctx);
      expect(await nextLaunch(env.ctx)).toBeNull();
    });

    it('marks a client step gate, which then lets its card be Ready', async () => {
      const key = await room();
      expect((await cardJobs(env.ctx, key)).cards.find((c) => c.key === 'c')!.state).toBe('your_step');
      await markGate(env.ctx, key, 'c', 'client_step:CP-A', 'Checked the page on the staging host.');
      expect((await cardJobs(env.ctx, key)).cards.find((c) => c.key === 'c')!.state).toBe('ready');
    });

    it('starts a milestone once, and a card that waits for it is met from then on', async () => {
      const key = await room(undefined, [card('m', [{ kind: 'milestone', ref: 'B' }])]);
      expect(gateOf(await cardJobs(env.ctx, key), 'm', 'milestone:B')).toMatchObject({ met: false, label: 'Milestone B started' });
      await expect(startMilestone(env.ctx, key, 'Z')).rejects.toThrow(/No card waits for milestone Z/);
      await expect(startMilestone(env.ctx, key, 'a b/c')).rejects.toThrow(/not a milestone name/);

      const out = await startMilestone(env.ctx, key, 'B');
      expect(out).toMatchObject({ milestone: 'B' });
      const after = await cardJobs(env.ctx, key);
      expect(gateOf(after, 'm', 'milestone:B')).toMatchObject({ met: true, markable: false });
      expect(after.cards.find((c) => c.key === 'm')!.state).toBe('ready');
      await expect(startMilestone(env.ctx, key, 'B')).rejects.toThrow(/already started/);
      await expect(markGate(env.ctx, key, 'm', 'milestone:B', 'Started by hand.')).rejects.toThrow(/follows the design/);

      const i = await initiativeByKey(env.ctx.pool, key);
      expect(i.milestones_started).toEqual(['B']);
      const row = await queryOne(env.ctx.pool, 'SELECT trigger_kind, created_by FROM initiative_versions WHERE initiative_id = ? AND version = ?', [i.id, out.version]);
      expect(row).toMatchObject({ trigger_kind: 'client_edit', created_by: 'client' });
    });

    it('re-opens a client step mark when its checkpoint changes, and lets the Client mark it again', async () => {
      const key = await room();
      await markGate(env.ctx, key, 'c', 'client_step:CP-A', 'Checked the page.');
      expect(gateOf(await cardJobs(env.ctx, key), 'c', 'client_step:CP-A')).toMatchObject({ met: true, reopened: false });

      // The steps change in the current version, as a confirmed revision would change them.
      const i = await initiativeByKey(env.ctx.pool, key);
      const v = await versionOf(env.ctx.pool, i.id, i.current_version);
      const doc = structuredClone(v.doc);
      (doc.blocks.find((b) => b.id === 'CP-A') as { steps: string[] }).steps = ['Check the page twice'];
      await exec(env.ctx.pool, 'UPDATE initiative_versions SET doc = ? WHERE initiative_id = ? AND version = ?', [JSON.stringify(doc), i.id, i.current_version]);

      const reopened = await cardJobs(env.ctx, key);
      expect(gateOf(reopened, 'c', 'client_step:CP-A')).toMatchObject({ met: false, reopened: true });
      expect(reopened.cards.find((c) => c.key === 'c')!.state).toBe('your_step');
      await markGate(env.ctx, key, 'c', 'client_step:CP-A', 'Checked the new step.');
      expect(gateOf(await cardJobs(env.ctx, key), 'c', 'client_step:CP-A')).toMatchObject({ met: true, reopened: false });
    });

    it('adopts the checkpoint hash of a mark made before the column existed, without re-opening it', async () => {
      const key = await room();
      const i = await initiativeByKey(env.ctx.pool, key);
      await exec(env.ctx.pool, `INSERT INTO initiative_gates (id, initiative_id, card_key, gate_key, met_at, met_by, reason) VALUES (?, ?, 'c', 'client_step:CP-A', ?, 'client', 'Checked before.')`, [newId('gat'), i.id, env.ctx.clock.now()]);
      expect(gateOf(await cardJobs(env.ctx, key), 'c', 'client_step:CP-A')).toMatchObject({ met: true, reopened: false });
      const row = await queryOne(env.ctx.pool, `SELECT checkpoint_hash FROM initiative_gates WHERE initiative_id = ? AND gate_key = 'client_step:CP-A'`, [i.id]);
      expect(String(row!.checkpoint_hash)).toMatch(/^[0-9a-f]{64}$/);
    });

    it('adopts the hash of a legacy mark before a confirmed revision changes its steps, so the mark re-opens', async () => {
      const key = await room();
      const i = await initiativeByKey(env.ctx.pool, key);
      await exec(env.ctx.pool, `INSERT INTO initiative_gates (id, initiative_id, card_key, gate_key, met_at, met_by, reason) VALUES (?, ?, 'c', 'client_step:CP-A', ?, 'client', 'Checked before.')`, [newId('gat'), i.id, env.ctx.clock.now()]);
      const s = await tx(env.ctx, (conn) => storeRevision(conn, env.ctx, i.id, [{ op: 'update', id: 'CP-A', set: { steps: ['Check the page, again'] } }], 'Changes the sign-off steps.'));
      await applyRevision(env.ctx, s.id);
      expect(gateOf(await cardJobs(env.ctx, key), 'c', 'client_step:CP-A')).toMatchObject({ met: false, reopened: true });
      const row = await queryOne(env.ctx.pool, `SELECT checkpoint_hash FROM initiative_gates WHERE initiative_id = ? AND gate_key = 'client_step:CP-A'`, [i.id]);
      expect(String(row!.checkpoint_hash)).toBe(checkpointHash(['Check the page']));
    });

    it('refuses a milestone start and a hand mark on an archived initiative, as a start is refused', async () => {
      const key = await room(undefined, [card('m', [{ kind: 'milestone', ref: 'B' }])]);
      await exec(env.ctx.pool, "UPDATE initiatives SET status = 'archived' WHERE `key` = ?", [key]);
      await expect(startMilestone(env.ctx, key, 'B')).rejects.toThrow(/is archived/);
      await expect(markGate(env.ctx, key, 'c', 'client_step:CP-A', 'Checked on the host.')).rejects.toThrow(/is archived/);
      expect((await initiativeByKey(env.ctx.pool, key)).milestones_started).toEqual([]);
    });

    it('refuses to apply a stored revision once the initiative is archived', async () => {
      const key = await room();
      const i = await initiativeByKey(env.ctx.pool, key);
      const s = await tx(env.ctx, (conn) => storeRevision(conn, env.ctx, i.id, [{ op: 'update', id: 'CP-A', set: { steps: ['Check the page, again'] } }], 'Changes the sign-off steps.'));
      await exec(env.ctx.pool, "UPDATE initiatives SET status = 'archived' WHERE id = ?", [i.id]);
      await expect(applyRevision(env.ctx, s.id)).rejects.toThrow(/is archived/);
      expect((await initiativeByKey(env.ctx.pool, key)).current_version).toBe(i.current_version);
    });

    it('keeps every status line, newest first, and records a line that does not fit in the gate evidence', async () => {
      const key = await room();
      const i = await initiativeByKey(env.ctx.pool, key);
      const setStatus = async (body: string) => {
        const cur = await initiativeByKey(env.ctx.pool, key);
        const v = await versionOf(env.ctx.pool, i.id, cur.current_version);
        const doc = structuredClone(v.doc);
        doc.blocks = doc.blocks.filter((b) => b.id !== 'T-status');
        doc.blocks.push({ kind: 'text', id: 'T-status', title: 'Status', body });
        await exec(env.ctx.pool, 'UPDATE initiative_versions SET doc = ? WHERE initiative_id = ? AND version = ?', [JSON.stringify(doc), i.id, cur.current_version]);
      };
      const statusOf = async (version: number) => {
        const v = await versionOf(env.ctx.pool, i.id, version);
        return (v.doc.blocks.find((b) => b.id === 'T-status') as { body: string }).body;
      };

      await setStatus(Array.from({ length: 25 }, (_, n) => 'Old line ' + n).join('\n'));
      const out = await markGate(env.ctx, key, 'c', 'client_step:CP-A', 'Checked the page.');
      const lines = (await statusOf(out.version)).split('\n');
      expect(lines).toHaveLength(26);
      expect(lines[0]).toContain('Reason: Checked the page.');
      expect(lines[25]).toBe('Old line 24');

      // A block close to its limit takes no more lines: the mark still counts, and its gate records the skipped line.
      await setStatus('y'.repeat(19_990));
      const full = await markGate(env.ctx, key, 'b', 'merged:a', 'Merged, checked by hand.');
      expect(await statusOf(full.version)).toHaveLength(19_990);
      const row = await queryOne(env.ctx.pool, 'SELECT met_at, evidence FROM initiative_gates WHERE initiative_id = ? AND card_key = ? AND gate_key = ?', [i.id, 'b', 'merged:a']);
      expect(row!.met_at).not.toBeNull();
      expect(JSON.stringify(row!.evidence)).toContain('status_line_skipped');
    });
  });
});
