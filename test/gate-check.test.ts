import { describe, expect, it } from 'vitest';
import {
  deployCompareArgs,
  deployRunListArgs,
  deployRunViewArgs,
  DeployedOutputSchema,
  latestCompletedRun,
  parsePrUrl,
  prBodyArgs,
  prViewArgs,
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

describe('the deployed run', () => {
  it('takes the newest finished push or workflow_dispatch run, never a pull_request run', () => {
    const list = [run({ databaseId: 11, event: 'pull_request' }), run({ databaseId: 10, status: 'in_progress', conclusion: null }), run({ databaseId: 9 })];
    expect(latestCompletedRun(list)).toMatchObject({ databaseId: 9 });
    expect(latestCompletedRun([run({ event: 'pull_request' })])).toBeNull();
  });

  it('proves the deploy when the job and step concluded success and the head contains the merge', () => {
    const out = DeployedOutputSchema.parse({ run: run(), view: view(), compare: { status: 'ahead' }, error: null });
    expect(provesDeployed(out, sameRepo)).toEqual({ ok: true, run_id: 9, head_sha: HEAD, compare_status: 'ahead' });
  });

  it('refuses a step or job that did not conclude success, a head that does not contain the merge, and another branch', () => {
    const base = { run: run(), compare: { status: 'ahead' as const }, error: null };
    expect(provesDeployed(DeployedOutputSchema.parse({ ...base, view: view({ jobs: [{ name: 'deploy-prod', conclusion: 'failure', steps: [] }] }) }), sameRepo).ok).toBe(false);
    expect(provesDeployed(DeployedOutputSchema.parse({ ...base, view: view({ jobs: [{ name: 'deploy-prod', conclusion: 'success', steps: [{ name: 'Deploy CDK stack', conclusion: 'failure' }] }] }) }), sameRepo).ok).toBe(false);
    expect(provesDeployed(DeployedOutputSchema.parse({ ...base, view: view(), compare: { status: 'behind' } }), sameRepo)).toMatchObject({ ok: false });
    expect(provesDeployed(DeployedOutputSchema.parse({ ...base, view: view({ headBranch: 'feature' }) }), sameRepo)).toMatchObject({ ok: false, reason: expect.stringContaining('not on main') });
    expect(provesDeployed(DeployedOutputSchema.parse({ run: null, view: null, compare: null, error: null }), sameRepo)).toMatchObject({ ok: false, reason: expect.stringContaining('newest 10') });
  });

  it('a cross-repo deploy cannot be compared, so its run must start after the merge of the source job', () => {
    const cross = { ...sameRepo, sameRepo: false, mergedAt: '2026-11-17T11:00:00Z' };
    const out = DeployedOutputSchema.parse({ run: run(), view: view(), compare: null, error: null });
    expect(provesDeployed(out, cross)).toEqual({ ok: true, run_id: 9, head_sha: HEAD, compare_status: null });
    expect(provesDeployed(out, { ...cross, mergedAt: '2026-11-17T13:00:00Z' })).toMatchObject({ ok: false, reason: expect.stringContaining('before the merge') });
  });
});
