import { describe, expect, it } from 'vitest';
import {
  callTimeoutMs,
  deployCompareArgs,
  deployRunListArgs,
  deployRunViewArgs,
  DeployedOutputSchema,
  decidingRun,
  parsePrUrl,
  parseRunList,
  prBodyArgs,
  prViewArgs,
  readCompare,
  readRunView,
  provesDeployed,
} from '../src/gate-check.ts';

// The argv of every gh call of the merged and deployed checks is fixed (src/gate-check.ts). These tests pin each one, and the
// rules that decide when GitHub's answer proves a deploy.

const MERGE = 'b'.repeat(40);
const HEAD = 'c'.repeat(40);

const run = (over: Record<string, unknown> = {}) => ({ databaseId: 9, headSha: HEAD, status: 'completed', conclusion: 'success', createdAt: '2026-11-17T12:00:00Z', headBranch: 'main', event: 'push', ...over });
const view = (over: Record<string, unknown> = {}) => ({
  databaseId: 9,
  headSha: HEAD,
  headBranch: 'main',
  status: 'completed',
  conclusion: 'success',
  createdAt: '2026-11-17T12:00:00Z',
  jobs: [{ name: 'deploy-prod', conclusion: 'success', steps: [{ name: 'Deploy CDK stack', conclusion: 'success' }, { name: 'Datadog', conclusion: 'failure' }] }],
  ...over,
});
const sameRepo = { job: 'deploy-prod', step: 'Deploy CDK stack', base: 'main', sameRepo: true, mergedAt: null };

describe('gh argv (fixed, pinned)', () => {
  it('the merged check and the PR body read take exactly these arguments', () => {
    expect(prViewArgs(34, 'owner/app')).toEqual(['pr', 'view', '34', '-R', 'owner/app', '--json', 'state,mergedAt,mergeCommit,url']);
    expect(prBodyArgs(34, 'owner/app')).toEqual(['pr', 'view', '34', '-R', 'owner/app', '--json', 'body,files,state,mergedAt,mergeCommit']);
  });

  it('the deployed check takes run list, run view and compare with fixed fields', () => {
    expect(deployRunListArgs('owner/app', 'deploy.yml', 'main')).toEqual([
      'run', 'list', '-R', 'owner/app', '--workflow', 'deploy.yml', '--branch', 'main', '--limit', '10', '--json', 'databaseId,headSha,status,conclusion,createdAt,headBranch,event',
    ]);
    expect(deployRunViewArgs('owner/app', 9)).toEqual(['run', 'view', '9', '-R', 'owner/app', '--json', 'databaseId,headBranch,headSha,status,conclusion,createdAt,jobs']);
    expect(deployCompareArgs('owner/app', MERGE, HEAD)).toEqual(['api', `repos/owner/app/compare/${MERGE}...${HEAD}`]);
  });

  it('a run whose view cannot be read refuses the check, so an older success cannot decide for it', () => {
    const view = (databaseId: number, createdAt: string) => ({
      databaseId,
      headSha: HEAD,
      headBranch: 'main',
      status: 'completed',
      conclusion: 'success',
      createdAt,
      jobs: [{ name: 'deploy-prod', conclusion: 'success', steps: [{ name: 'Deploy', conclusion: 'success' }] }],
    });
    const newest = { databaseId: 12, headSha: HEAD, status: 'completed', conclusion: 'success', createdAt: '2026-11-17T13:00:00Z', headBranch: 'main', event: 'push' };
    const older = { ...newest, databaseId: 11, createdAt: '2026-11-17T12:00:00Z' };
    expect(DeployedOutputSchema.safeParse({ runs: [{ run: newest, view: null, compare: null }, { run: older, view: view(11, older.createdAt), compare: null }], error: null }).success).toBe(false);
    const readable = DeployedOutputSchema.parse({ runs: [{ run: newest, view: view(12, newest.createdAt), compare: null }, { run: older, view: view(11, older.createdAt), compare: null }], error: null });
    expect(decidingRun(readable, 'deploy-prod')?.run.databaseId).toBe(12);
  });

  it('readRunView and readCompare keep only the fields the server reads', () => {
    const raw = JSON.stringify({
      databaseId: 9,
      headSha: HEAD,
      headBranch: 'main',
      status: 'completed',
      conclusion: 'success',
      createdAt: '2026-11-17T12:00:00Z',
      url: 'https://github.com/owner/app/actions/runs/9',
      jobs: [{ name: 'deploy-prod', conclusion: 'success', url: 'x', steps: [{ name: 'Deploy', conclusion: 'success', number: 3 }] }],
    });
    expect(readRunView(raw)).toEqual({
      databaseId: 9,
      headSha: HEAD,
      headBranch: 'main',
      status: 'completed',
      conclusion: 'success',
      createdAt: '2026-11-17T12:00:00Z',
      jobs: [{ name: 'deploy-prod', conclusion: 'success', steps: [{ name: 'Deploy', conclusion: 'success' }] }],
    });
    expect(readRunView('not json')).toBeNull();
    expect(readCompare(JSON.stringify({ status: 'ahead', files: [], commits: [] }))).toEqual({ status: 'ahead' });
    expect(readCompare('{"status":"surprising"}')).toBeNull();
  });

  it('refuses every value that is not the shape the argv expects', () => {
    expect(() => prBodyArgs(34, '--repo=evil/x')).toThrow();
    expect(() => prBodyArgs(34, 'owner/app; rm')).toThrow();
    expect(() => prBodyArgs(0, 'owner/app')).toThrow();
    expect(() => prBodyArgs(1.5, 'owner/app')).toThrow();
    expect(() => deployRunListArgs('owner/app', '../deploy.yml', 'main')).toThrow();
    expect(() => deployRunListArgs('owner/app', 'deploy.yml', '--json')).toThrow();
    expect(() => deployRunListArgs('owner/app', 'deploy.yml', '../main')).toThrow();
    expect(() => deployRunViewArgs('owner/app', 0)).toThrow();
    expect(() => deployCompareArgs('owner/app', 'abc', HEAD)).toThrow();
    expect(() => deployCompareArgs('owner/app', MERGE, `${HEAD}-x`)).toThrow();
    expect(() => deployCompareArgs('-X/owner', MERGE, HEAD)).toThrow();
  });

  it('reads a PR URL only in the github.com form, with a number', () => {
    expect(parsePrUrl('https://github.com/owner/app/pull/34')).toEqual({ slug: 'owner/app', number: 34 });
    expect(parsePrUrl('https://gitlab.com/owner/app/pull/34')).toBeNull();
    expect(parsePrUrl('https://github.com/owner/app/pull/x')).toBeNull();
    expect(parsePrUrl('--repo https://github.com/owner/app/pull/34')).toBeNull();
    expect(parsePrUrl('https://github.com/@owner/app/pull/34')).toBeNull();
  });
});

describe('the time budget of a deployed check', () => {
  it('gives each call at most 60 s, never more than the time left, and no timeout once the deadline has passed', () => {
    const deadline = 1_000_000;
    expect(callTimeoutMs(deadline, deadline - 500_000, 60_000)).toBe(60_000);
    expect(callTimeoutMs(deadline, deadline - 20_000, 60_000)).toBe(20_000);
    expect(callTimeoutMs(deadline, deadline - 1, 60_000)).toBe(1);
    expect(callTimeoutMs(deadline, deadline, 60_000)).toBeNull();
    expect(callTimeoutMs(deadline, deadline + 5, 60_000)).toBeNull();
  });
});

describe('the deployed run', () => {
  type RunOver = Partial<{ databaseId: number; headSha: string; status: string; conclusion: string | null; createdAt: string; headBranch: string; event: string }>;
  // One run `gh run list` named, with its view and its comparison with the merge commit (null for a cross-repo deploy).
  const entry = (runOver: RunOver = {}, viewOver: Record<string, unknown> = {}, compare: { status: 'ahead' | 'identical' | 'behind' | 'diverged' } | null = { status: 'ahead' }) => {
    const id = runOver.databaseId ?? 9;
    return { run: run({ ...runOver, databaseId: id }), view: view({ databaseId: id, headSha: runOver.headSha ?? HEAD, ...viewOver }), compare };
  };
  const out = (...entries: ReturnType<typeof entry>[]) => DeployedOutputSchema.parse({ runs: entries, error: null });
  // The shape of pages run 44257118210 on 2026-11-19: the run is waiting on staging and its prod job concluded success.
  // An unfinished job carries an empty conclusion, as gh prints it ("").
  const pagesJobs = (prod: string, staging = '') => [
    { name: 'build', conclusion: 'success', steps: [] },
    { name: 'deploy / deploy-staging', conclusion: staging, steps: [] },
    { name: 'deploy / deploy-prod', conclusion: prod, steps: [{ name: 'Run echo Doing prod deploy', conclusion: prod ? 'success' : '' }, { name: 'Run cdk deploy', conclusion: prod }] },
  ];
  const pagesRun = { databaseId: 44257118210, headSha: HEAD, status: 'waiting', conclusion: null };
  const pages = { job: 'deploy / deploy-prod', step: 'Run cdk deploy', base: 'main', sameRepo: true, mergedAt: null };

  it('takes the newest push or workflow_dispatch run in which the named job completed, never a pull_request run', () => {
    const list = out(entry({ databaseId: 11, event: 'pull_request' }), entry({ databaseId: 10, status: 'in_progress', conclusion: null }, { jobs: pagesJobs('') }), entry({ databaseId: 9 }));
    expect(decidingRun(list, 'deploy-prod')).toMatchObject({ run: { databaseId: 9 } });
    expect(decidingRun(out(entry({ event: 'pull_request' })), 'deploy-prod')).toBeNull();
  });

  it('reads the run list in the expected shape, and refuses anything else', () => {
    expect(parseRunList(JSON.stringify([run()]))).toEqual([run()]);
    expect(parseRunList('not json')).toBeNull();
    expect(parseRunList(JSON.stringify({ runs: [] }))).toBeNull();
    expect(parseRunList(JSON.stringify(Array.from({ length: 11 }, () => run())))).toBeNull();
  });

  it('proves the pages deploy from the real shape: the run waits on staging, and its prod job and step concluded success', () => {
    const o = out(entry(pagesRun, { status: 'waiting', conclusion: null, jobs: pagesJobs('success') }));
    expect(provesDeployed(o, pages)).toEqual({ ok: true, run_id: 44257118210, head_sha: HEAD, compare_status: 'ahead' });
  });

  it('a newer run whose prod job failed wins over an older success', () => {
    const o = out(entry({ databaseId: 2, headSha: 'd'.repeat(40) }, { jobs: pagesJobs('failure') }), entry({ databaseId: 1 }, { jobs: pagesJobs('success') }));
    expect(provesDeployed(o, pages)).toMatchObject({ ok: false, reason: expect.stringContaining('did not conclude success') });
  });

  it('a newer run whose prod job still waits is skipped, so the older success decides', () => {
    const o = out(entry({ databaseId: 2, headSha: 'd'.repeat(40), status: 'waiting', conclusion: null }, { status: 'waiting', conclusion: null, jobs: pagesJobs('') }), entry({ databaseId: 1 }, { jobs: pagesJobs('success') }));
    expect(provesDeployed(o, pages)).toEqual({ ok: true, run_id: 1, head_sha: HEAD, compare_status: 'ahead' });
  });

  it('matches the job name exactly: mesh prints its matrix value in the name, so the bare name does not match', () => {
    const meshJobs = [{ name: 'deploy / deploy-prod (20.15.0)', conclusion: 'success', steps: [{ name: 'Run cdk deploy', conclusion: 'success' }] }];
    const o = out(entry({ databaseId: 42133966055, status: 'waiting', conclusion: null }, { status: 'waiting', conclusion: null, jobs: meshJobs }));
    expect(provesDeployed(o, pages)).toMatchObject({ ok: false, reason: expect.stringContaining('None of the newest 1') });
    expect(provesDeployed(o, { ...pages, job: 'deploy / deploy-prod (20.15.0)' })).toMatchObject({ ok: true, run_id: 42133966055 });
  });

  it('a named job that gh prints with an empty conclusion has not completed, so its run is skipped', () => {
    const o = out(entry({ databaseId: 2, headSha: 'd'.repeat(40), status: 'waiting', conclusion: null }, { status: 'waiting', conclusion: null, jobs: [{ name: 'deploy / deploy-prod', conclusion: '', steps: [] }] }), entry({ databaseId: 1 }, { jobs: pagesJobs('success') }));
    expect(decidingRun(o, pages.job)).toMatchObject({ run: { databaseId: 1 } });
    expect(provesDeployed(o, pages)).toMatchObject({ ok: true, run_id: 1 });
  });

  it('refuses a run with no listed run, a run whose named job never completed, and an empty list', () => {
    expect(provesDeployed(out(), pages)).toMatchObject({ ok: false, reason: expect.stringContaining('listed no run') });
    expect(provesDeployed(out(entry(pagesRun, { status: 'waiting', conclusion: null, jobs: pagesJobs('') })), pages)).toMatchObject({ ok: false, reason: expect.stringContaining('newest 1') });
    expect(provesDeployed(DeployedOutputSchema.parse({ runs: [], error: 'gh failed' }), pages)).toEqual({ ok: false, reason: 'gh failed' });
  });

  it('refuses a view that is not the run listed, another branch, a failed step, a head that does not contain the merge, and a pull_request run', () => {
    expect(provesDeployed(out(entry({}, { databaseId: 8 })), sameRepo)).toMatchObject({ ok: false, reason: expect.stringContaining('not the run listed') });
    expect(provesDeployed(out(entry({}, { headBranch: 'feature' })), sameRepo)).toMatchObject({ ok: false, reason: expect.stringContaining('not on main') });
    expect(provesDeployed(out(entry({}, { jobs: [{ name: 'deploy-prod', conclusion: 'success', steps: [{ name: 'Deploy CDK stack', conclusion: 'failure' }] }] })), sameRepo).ok).toBe(false);
    expect(provesDeployed(out(entry({}, {}, { status: 'behind' })), sameRepo)).toMatchObject({ ok: false, reason: expect.stringContaining('does not contain the merge') });
    expect(provesDeployed(out(entry({ event: 'pull_request' })), sameRepo)).toMatchObject({ ok: false });
  });

  it('a cross-repo deploy cannot be compared, so its run must start after the merge of the source job', () => {
    const cross = { ...sameRepo, sameRepo: false, mergedAt: '2026-11-17T11:00:00Z' };
    const o = out(entry({}, {}, null));
    expect(provesDeployed(o, cross)).toEqual({ ok: true, run_id: 9, head_sha: HEAD, compare_status: null });
    expect(provesDeployed(o, { ...cross, mergedAt: '2026-11-17T13:00:00Z' })).toMatchObject({ ok: false, reason: expect.stringContaining('before the merge') });
  });
});
