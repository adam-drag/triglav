import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { deployCompareArgs, deployRunListArgs, deployRunViewArgs, prBodyArgs, prViewArgs } from '../src/gate-check.ts';
import { BASE, clientFetch, expect, RUNNER_KEY, SimAgent } from './fixtures.ts';

// The phase 4 and phase 5 initiative e2e specs share these helpers (docs/plans/initiative-room.md). The test plays the host
// runner's part: it takes launches from /api/runner/next with the runner key, runs the stub gh with the argv the gate-check
// builders give, and posts the answer the way the runner does.

const HEAD = 'c'.repeat(40);
const run = promisify(execFile);

export function card(id: string, title: string, gates: unknown[], deps: string[] = [], extra: Record<string, unknown> = {}) {
  return {
    kind: 'card',
    id,
    title,
    repo: 'app',
    wave: 'W-1',
    deps,
    goal: `Build ${title.toLowerCase()}.`,
    scope: ['One change'],
    out: [],
    accept: ['It works'],
    verify: ['Run the tests'],
    traps: [],
    safety: [],
    dod: [],
    gates,
    ...extra,
  };
}

/** One call to the runner API, as the host runner makes it. */
export async function runnerCall(path: string, body: unknown = {}): Promise<any> {
  const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: { authorization: `Bearer ${RUNNER_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

/** Starts a card as the Client, with the design version the room shows, and returns the start (its launch and request). */
export async function startCard(key: string, cardKey: string): Promise<{ launch_id: string; request_id: string }> {
  const got = await (await clientFetch(`${BASE}/api/initiatives/${key}`)).json();
  const version = Number(got.initiative.current_version);
  const res = await clientFetch(`${BASE}/api/initiatives/${key}/cards/${cardKey}/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ started_from_version: version }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return res.json();
}

/** The runner reports the start's launch done, Staff registers the job, and the delivery of a pull request is recorded. */
export async function startAndDeliver(key: string, prNumber: number): Promise<string> {
  const start = await startCard(key, 'a');
  await runnerCall(`/api/runner/${start.launch_id}/done`, { result: 'ok: started' });
  const staff = await SimAgent.register({ role: 'staff', nickname: `phase4-${Date.now().toString(36)}`, runtime: 'claude-code' });
  const job = await staff.call('register_job', { request_id: start.request_id, title: 'PDF endpoint' });
  await staff.close();
  await deliver(job.job_id, `https://github.com/owner/app/pull/${prNumber}`);
  return job.job_id;
}

/** Inserts the delivery a Senior would report, through the stack's own MySQL (the Senior flow is too long for this test). */
export async function deliver(jobId: string, prUrl: string) {
  const id = `dlv-p4-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const sql = `INSERT INTO deliveries (id, job_id, assignment_id, attempt_number, reported_by, pr_url, head_sha, copilot_status, copilot_summary, ci_summary, reported_at) VALUES ('${id}', '${jobId}', 'asg-e2e', 1, 'agt-e2e', '${prUrl}', '${HEAD}', 'DONE', 'clean', 'CI passed', NOW(3))`;
  await run('docker', ['compose', '-f', 'docker-compose.e2e.yml', 'exec', '-T', '-e', 'MYSQL_PWD=e2e-password', 'mysql', 'mysql', '-uorchestrator', 'orchestrator', '-e', sql]);
}

/** Runs the stub gh with one fixed argv and returns what it printed; the test checks the argv it logged. */
export async function stubGh(argv: string[], answer: unknown, dir: string): Promise<string> {
  const log = join(dir, `gh-${Math.random().toString(36).slice(2)}.log`);
  const text = typeof answer === 'string' ? answer : JSON.stringify(answer);
  const { stdout } = await run(process.execPath, [resolve('e2e/stub-gh.mjs'), ...argv], { env: { ...process.env, STUB_GH_LOG: log, STUB_GH_ANSWER: text } });
  expect(readFileSync(log, 'utf8').trim()).toBe(JSON.stringify(argv));
  return stdout;
}

/**
 * Answers the runner launches of one test until `done()` holds. A launch of another pull request, or of another merge commit,
 * is left alone. Each answer is built the way the runner builds it (src/gate-check.ts for the argv and the output's shape).
 */
export async function serveRunner(opts: { prNumber: number; mergeSha: string; dir: string; done: () => Promise<boolean>; timeoutMs: number }) {
  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    if (await opts.done()) return;
    const { launch } = await runnerCall('/api/runner/next');
    if (!launch) {
      await new Promise((r) => setTimeout(r, 1_000));
      continue;
    }
    if (launch.kind === 'pr_read') {
      // The body of any merged PR is read from the PR's own number, so the server checks the same number it asked for.
      const argv = prBodyArgs(launch.pr_number, launch.repo_slug);
      // The fields `gh pr view --json body,files,state,mergedAt,mergeCommit` prints: no url.
      const answer = { body: `Retry the export once after a failure. Read as data.`, files: [{ path: 'src/export.ts' }], state: 'MERGED', mergedAt: '2026-11-19T09:00:00Z', mergeCommit: { oid: opts.mergeSha } };
      const stdout = await stubGh(argv, answer, opts.dir);
      await runnerCall(`/api/runner/${launch.id}/pr-output`, { code: 0, stdout, stderr: '' });
      await runnerCall(`/api/runner/${launch.id}/done`, { result: `read PR ${launch.pr_number}` });
      continue;
    }
    if (launch.kind !== 'gate_check') continue;
    if (launch.check === 'deployed') {
      if (launch.merge_sha !== opts.mergeSha) continue;
      // The three calls of the deployed check, in the runner's order: run list, run view, then the comparison (same repository).
      const listArgv = deployRunListArgs(launch.repo_slug, launch.workflow, launch.base);
      const listed = await stubGh(listArgv, [{ databaseId: 9, headSha: HEAD, status: 'completed', conclusion: 'success', createdAt: '2026-11-19T10:00:00Z', headBranch: launch.base, event: 'push' }], opts.dir);
      const viewArgv = deployRunViewArgs(launch.repo_slug, 9);
      const view = await stubGh(viewArgv, { databaseId: 9, headBranch: launch.base, headSha: HEAD, status: 'completed', conclusion: 'success', createdAt: '2026-11-19T10:00:00Z', jobs: [{ name: launch.job, conclusion: 'success', steps: [{ name: launch.step, conclusion: 'success' }] }] }, opts.dir);
      const compareArgv = deployCompareArgs(launch.repo_slug, launch.merge_sha, HEAD);
      const compare = await stubGh(compareArgv, { status: 'ahead' }, opts.dir);
      const out = { runs: [{ run: JSON.parse(listed)[0], view: JSON.parse(view), compare: JSON.parse(compare) }], error: null };
      await runnerCall(`/api/runner/${launch.id}/gate-output`, { code: 0, stdout: JSON.stringify(out), stderr: '' });
      await runnerCall(`/api/runner/${launch.id}/done`, { result: 'checked the deploy' });
      continue;
    }
    if (launch.pr_number !== opts.prNumber) continue;
    const argv = prViewArgs(launch.pr_number, launch.repo_slug);
    const merged = JSON.stringify({ state: 'MERGED', mergedAt: '2026-11-19T09:00:00Z', mergeCommit: { oid: opts.mergeSha }, url: `https://github.com/${launch.repo_slug}/pull/${launch.pr_number}` });
    const stdout = await stubGh(argv, merged, opts.dir);
    await runnerCall(`/api/runner/${launch.id}/gate-output`, { code: 0, stdout, stderr: '' });
    await runnerCall(`/api/runner/${launch.id}/done`, { result: `checked PR ${launch.pr_number}` });
  }
  if (await opts.done()) return;
  throw new Error('the runner answers did not finish in time');
}

/** The card's state from the Jobs API, the same evaluator the tab uses. */
export async function stateOf(key: string, cardKey: string): Promise<string> {
  const jobs = await (await clientFetch(`${BASE}/api/initiatives/${key}/jobs`)).json();
  return String(jobs.cards.find((c: { key: string }) => c.key === cardKey).state);
}

/** Runs one SQL statement on the stack's MySQL and returns the first column of each row, as text. */
export async function mysql(sql: string): Promise<string[]> {
  const { stdout } = await run('docker', ['compose', '-f', 'docker-compose.e2e.yml', 'exec', '-T', '-e', 'MYSQL_PWD=e2e-password', 'mysql', 'mysql', '-uorchestrator', 'orchestrator', '-N', '-B', '-e', sql]);
  return stdout.trim() ? stdout.trim().split('\n') : [];
}
