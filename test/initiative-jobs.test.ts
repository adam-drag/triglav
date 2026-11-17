import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authenticate, registerAgent, type Agent } from '../src/agents.ts';
import { exec, queryOne } from '../src/db.ts';
import { newId } from '../src/lib.ts';
import { importInitiative, initiativeByKey, versionOf } from '../src/initiatives.ts';
import { cardJobs, markGate, previewStart, queueGateChecks, recordGateOutput, startCard, GATE_CHECK_MS } from '../src/initiative-jobs.ts';
import { registerJob } from '../src/jobs.ts';
import { finishLaunch, nextLaunch } from '../src/telemetry.ts';
import { createTestCtx, TEST_DB_URL } from './helpers.ts';

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
      card('a', [], { decisions: ['D1'], goal: 'Goal of a. Keeps C-api.' }),
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

  async function room(cap?: number) {
    const key = `jobs-${++n}`;
    await importInitiative(env.ctx, {
      key,
      title: `Jobs ${n}`,
      repos: [{ slug: 'app', path: '/home/u/app', base: 'main', github: 'owner/app' }],
      source: 'a test',
      doc: design(),
      ...(cap ? { cap } : {}),
    });
    return key;
  }

  async function staff(): Promise<Agent> {
    const reg = await registerAgent(env.ctx, { role: 'staff', nickname: `jstaff-${++n}`, runtime: 'claude-code' });
    return authenticate(env.ctx, reg.session_token);
  }

  /** Starts a card, runs its staff_start launch the way the runner would, and has Staff register the job. */
  async function startAndRegister(s: Agent, key: string, cardKey: string) {
    const started = await startCard(env.ctx, key, cardKey);
    for (let l: any = await nextLaunch(env.ctx); l; l = await nextLaunch(env.ctx)) {
      if (l.kind !== 'staff_start') throw new Error(`unexpected launch ${l.kind}`);
      await finishLaunch(env.ctx, l.id, 'ok: started');
      if (l.request_id === started.request_id) break;
    }
    await registerJob(env.ctx, s, { requestId: started.request_id, title: `Job for ${cardKey}` });
    const row = await queryOne(env.ctx.pool, 'SELECT job_id FROM job_requests WHERE id = ?', [started.request_id]);
    return { ...started, job_id: String(row!.job_id) };
  }

  /** A delivery with a pull request, as report_delivery would store it. */
  async function deliver(jobId: string, prUrl: string) {
    await exec(env.ctx.pool, `INSERT INTO deliveries (id, job_id, assignment_id, attempt_number, reported_by, pr_url, head_sha, copilot_summary, ci_summary, reported_at) VALUES (?, ?, ?, 1, ?, ?, ?, '', '', ?)`, [
      newId('dlv'),
      jobId,
      newId('asg'),
      newId('agt'),
      prUrl,
      'c'.repeat(40),
      env.clock.now(),
    ]);
  }

  /** The one gate_check launch the check queued. */
  async function checkLaunch() {
    const l: any = await nextLaunch(env.ctx);
    expect(l?.kind).toBe('gate_check');
    return l;
  }

  const gateOf = (view: Awaited<ReturnType<typeof cardJobs>>, cardKey: string, gateKey: string) =>
    view.cards.find((c) => c.key === cardKey)!.gates.find((g) => g.key === gateKey)!;

  describe('Start', () => {
    it('refuses a card that waits for a merged gate, and says why', async () => {
      const key = await room();
      await expect(startCard(env.ctx, key, 'b')).rejects.toThrow(/cannot start/);
      const preview = await previewStart(env.ctx, key, 'b');
      expect(preview).toMatchObject({ state: 'locked', can_start: false });
      expect(preview.reasons).toContain('Open: a merged (Card a).');
    });

    it('starts a ready card with the prompt the preview showed, pinned to the design version it read', async () => {
      const key = await room();
      const preview = await previewStart(env.ctx, key, 'a');
      expect(preview.can_start).toBe(true);
      const started = await startCard(env.ctx, key, 'a');
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

    it('does not start a card twice while its job runs', async () => {
      const key = await room();
      await startCard(env.ctx, key, 'a');
      await expect(startCard(env.ctx, key, 'a')).rejects.toThrow(/cannot start: .*running/);
    });

    it('warns when the initiative is over its cap, and still starts the card', async () => {
      const key = await room(1);
      const s = await staff();
      await startAndRegister(s, key, 'a');
      const preview = await previewStart(env.ctx, key, 'd');
      expect(preview.cap).toEqual({ running: 1, cap: 1, over: true });
      expect(preview.warning).toMatch(/cap is 1/);
      expect(preview.can_start).toBe(true);
      await expect(startCard(env.ctx, key, 'd')).resolves.toMatchObject({ started_from_version: expect.any(Number) });
    });
  });

  describe('the merged check', () => {
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
      expect(gateOf(after, 'b', 'merged:a').evidence).toMatchObject({ merged_at: '2026-11-17T10:00:00Z', merge_commit: 'b'.repeat(40) });
      expect(after.cards.find((c) => c.key === 'b')!.state).toBe('ready');

      const i = await initiativeByKey(env.ctx.pool, key);
      const row = await queryOne(env.ctx.pool, 'SELECT trigger_kind, created_by FROM initiative_versions WHERE initiative_id = ? AND version = ?', [i.id, after.version]);
      expect(row).toMatchObject({ trigger_kind: 'event', created_by: 'scheduler' });
      const v = await versionOf(env.ctx.pool, i.id, after.version);
      const src = v.doc.blocks.find((b) => b.id === 'a') as { pr?: string; merged?: string };
      expect(src).toMatchObject({ pr: 'https://github.com/owner/app/pull/34', merged: '2026-11-17' });
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
      expect(await nextLaunch(env.ctx)).toBeNull();

      env.clock.advance(GATE_CHECK_MS / 1000 + 1);
      await queueGateChecks(env.ctx);
      const again = await checkLaunch();
      expect(again.id).not.toBe(launch.id);
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
  });

  describe('manual marks', () => {
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
  });
});
