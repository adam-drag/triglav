import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { authenticate, registerAgent, type Agent } from '../src/agents.ts';
import { exec, queryOne } from '../src/db.ts';
import { newId } from '../src/lib.ts';
import { applyRevision, importInitiative, initiativeByKey, storeRevision, versionOf } from '../src/initiatives.ts';
import { cardJobs, markGate, previewStart, queueGateChecks, recordGateOutput, startCard, startMilestone, GATE_CHECK_MS } from '../src/initiative-jobs.ts';
import { registerJob, reopenForDelivery } from '../src/jobs.ts';
import { dismissJobRequest, readJobRequest, retryJobRequest } from '../src/job-requests.ts';
import { expireStaleCards } from '../src/operator-actions.ts';
import { finishLaunch, nextLaunch } from '../src/telemetry.ts';
import { createTestCtx, TEST_DB_URL } from './helpers.ts';
import { tx } from '../src/context.ts';
import { checkpointHash } from '../src/card-state.ts';

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
