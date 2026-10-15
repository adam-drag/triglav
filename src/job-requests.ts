/**
 * Job requests: the Client starts a job from the dashboard, from a ticket link or from a free prompt. The server
 * validates the shape of every field and stores the request. A `staff_start` launch carries only the request id to
 * the host runner, which starts a Staff agent. Staff reads the request over MCP (the Client's text is data, never
 * part of a command line) and calls register_job with the request id.
 */
import { tx, type Ctx } from './context.ts';
import { exec, query, queryOne, type Conn, type Row } from './db.ts';
import { effectiveRoleModel } from './models.ts';
import { emit } from './events.ts';
import { assertNoSecrets, conflict, forbidden, invalid, newId, notFound } from './lib.ts';
import { ownerIsLive, type Agent } from './agents.ts';
import { lockJob, reassignStaffIn } from './jobs.ts';

export const REQUEST_MODES = ['link', 'prompt'] as const;
export type RequestMode = (typeof REQUEST_MODES)[number];

export const MAX_URL = 2000;
export const MAX_PROMPT = 10_000;
export const MAX_PATH = 500;
export const MAX_BRANCH = 200;
/** Requests whose launch the runner has not carried out yet. More than this is a stuck runner or a flood. */
export const MAX_QUEUED_REQUESTS = 3;
/** A request id as the runner accepts it in a launch. Keep in step with scripts/staff-start.ts. */
export const REQUEST_ID = /^req_[0-9a-f]{16}$/;

// Same shapes the host runner checks again before it builds a command (scripts/runner.ts).
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const EFFORT = /^(low|medium|high|xhigh|max)$/;
// Codex lists more levels (up to "ultra"); its model list in Triglav decides which a role can hold.
const CODEX_EFFORT = /^[a-z]{1,20}$/;

export interface JobRequestInput {
  mode: string;
  url?: string | null;
  prompt?: string | null;
  repoPath: string;
  baseBranch?: string | null;
}

export interface CheckedRequest {
  mode: RequestMode;
  url: string | null;
  prompt: string | null;
  repoPath: string;
  baseBranch: string;
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** http or https only, no credentials in the URL, no whitespace or control characters. Returns the normalized URL. */
export function checkUrl(raw: string): string {
  const value = raw.trim();
  if (!value) throw invalid('Give the ticket URL.');
  if (value.length > MAX_URL) throw invalid(`The URL is longer than ${MAX_URL} characters.`);
  if (/\s/.test(value) || CONTROL.test(value)) throw invalid('The URL must not contain spaces or control characters.');
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw invalid('That is not a valid URL. Use a full address that starts with https://.');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw invalid('Only http and https URLs are accepted.');
  if (u.username || u.password) throw invalid('The URL must not contain a user name or password.');
  if (!u.hostname) throw invalid('The URL has no host name.');
  return u.href;
}

/**
 * An absolute path with plain characters only. The server runs in Docker and cannot see the host, so only the shape is
 * checked; the runner checks that the directory exists. A leading ~ is expanded here with the host's home directory
 * (ORCH_HOST_HOME, set by docker compose), so every agent gets the real path.
 */
export function checkRepoPath(raw: string, home = process.env.ORCH_HOST_HOME): string {
  let value = raw.trim();
  if (!value) throw invalid('Give the repository path.');
  if (value === '~' || value.startsWith('~/')) {
    if (!home?.startsWith('/')) throw invalid('The server does not know your home directory (ORCH_HOST_HOME), so ~ cannot be used. Give the full path.');
    value = home.replace(/\/+$/, '') + value.slice(1);
  }
  if (value.length > MAX_PATH) throw invalid(`The repository path is longer than ${MAX_PATH} characters.`);
  if (!value.startsWith('/')) throw invalid('The repository path must be absolute (start with /).');
  if (!/^\/[A-Za-z0-9._@+ \/-]*$/.test(value)) throw invalid('The repository path may only contain letters, digits, spaces and . _ @ + - /.');
  if (value.split('/').some((part) => part === '..')) throw invalid('The repository path must not contain "..".');
  return value.length > 1 ? value.replace(/\/+$/, '') : value;
}

/** A branch name git accepts that cannot be read as an option or a revision range. */
export function checkBranch(raw: string): string {
  const value = raw.trim();
  if (!value) throw invalid('Give the base branch.');
  if (value.length > MAX_BRANCH) throw invalid(`The base branch is longer than ${MAX_BRANCH} characters.`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(value)) throw invalid('The base branch may only contain letters, digits and . _ / -, and must start with a letter or digit.');
  if (value.includes('..') || value.includes('//') || value.endsWith('/') || value.endsWith('.') || value.endsWith('.lock') || value.split('/').some((p) => p.startsWith('.') || p.endsWith('.lock'))) {
    throw invalid('That is not a valid git branch name.');
  }
  return value;
}

export function checkRequest(input: JobRequestInput): CheckedRequest {
  if (input.mode !== 'link' && input.mode !== 'prompt') throw invalid('Mode must be "link" or "prompt".');
  const repoPath = checkRepoPath(input.repoPath);
  const baseBranch = checkBranch(input.baseBranch?.trim() ? input.baseBranch : 'main');
  if (input.mode === 'link') {
    if (input.prompt?.trim()) throw invalid('Link mode takes a URL, not prompt text.');
    const url = checkUrl(input.url ?? '');
    assertNoSecrets(url);
    return { mode: 'link', url, prompt: null, repoPath, baseBranch };
  }
  if (input.url?.trim()) throw invalid('Prompt mode takes prompt text, not a URL.');
  const prompt = (input.prompt ?? '').trim();
  if (!prompt) throw invalid('Write the prompt.');
  if (prompt.length > MAX_PROMPT) throw invalid(`The prompt is longer than ${MAX_PROMPT} characters.`);
  // Tabs and newlines are fine in a prompt; other control characters are not.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(prompt)) throw invalid('The prompt contains control characters.');
  assertNoSecrets(prompt);
  return { mode: 'prompt', url: null, prompt, repoPath, baseBranch };
}

/** True for linear.app and its subdomains: only those jobs are refreshed from Linear. */
export function isLinearUrl(url: string | null): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'linear.app' || host.endsWith('.linear.app');
  } catch {
    return false;
  }
}

/**
 * Stores a request and queues the launch that starts Staff. A repeated click on an identical request that is still
 * waiting returns the first one.
 */
export async function createJobRequest(ctx: Ctx, input: JobRequestInput) {
  const r = checkRequest(input);
  return tx(ctx, async (conn) => {
    const staff = await startableStaffModel(ctx, conn);
    const now = ctx.clock.now();
    const same = await queryOne(
      conn,
      `SELECT id, launch_id FROM job_requests WHERE status IN ('queued', 'started') AND dismissed_at IS NULL AND mode = ? AND repo_path = ? AND base_branch = ? AND source_url <=> ? AND prompt <=> ? AND created_at > ? FOR UPDATE`,
      [r.mode, r.repoPath, r.baseBranch, r.url, r.prompt, new Date(now.getTime() - 10 * 60_000)],
    );
    if (same) return { id: same.id as string, launch_id: same.launch_id as string, already_queued: true };
    await assertQueueRoom(conn);
    const queuedRequest = await queueStaffStart(conn, ctx, staff, { mode: r.mode, url: r.url, prompt: r.prompt, repoPath: r.repoPath, baseBranch: r.baseBranch, jobId: null });
    await emit(conn, ctx, { type: 'job_request.created', actor: 'client', payload: { request_id: queuedRequest.id, mode: r.mode } });
    return { ...queuedRequest, already_queued: false };
  });
}

/** Refuses a new request while too many wait for the runner: a takeover counts like any other start. */
async function assertQueueRoom(conn: Conn) {
  const queued = await queryOne(conn, `SELECT COUNT(*) AS n FROM job_requests WHERE status = 'queued'`);
  if (Number(queued?.n) >= MAX_QUEUED_REQUESTS) throw conflict(`${MAX_QUEUED_REQUESTS} job requests are already waiting for the runner. Is node scripts/runner.ts running?`);
}

/** The Staff model and runtime a dashboard start needs, or the reason it cannot start. */
async function startableStaffModel(ctx: Ctx, conn: Conn) {
  const staff = await effectiveRoleModel(ctx, conn, 'staff');
  if (!staff) throw invalid('No model is configured for Staff. Set it on the Models page.');
  if (staff.runtime !== 'claude-code' && staff.runtime !== 'codex') throw invalid(`Staff is set to run on ${staff.runtime}. Starting Staff from the dashboard works with claude-code and codex; change it on the Models page.`);
  if (!MODEL.test(staff.model) || !(staff.runtime === 'codex' ? CODEX_EFFORT : EFFORT).test(staff.effort)) throw invalid('The Staff model or effort on the Models page contains characters the runner refuses. Fix it there.');
  return staff;
}

/** Inserts the request and the staff_start launch that carries its id. `jobId` is set for a takeover of an existing job. */
async function queueStaffStart(
  conn: Conn,
  ctx: Ctx,
  staff: { runtime: string; model: string; effort: string },
  r: { mode: string; url: string | null; prompt: string | null; repoPath: string; baseBranch: string; jobId: string | null },
) {
  const now = ctx.clock.now();
  const id = `req_${newId('x').slice(2)}`;
  const launchId = newId('lch');
  await exec(conn, `INSERT INTO job_requests (id, mode, source_url, prompt, repo_path, base_branch, status, launch_id, job_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`, [
    id, r.mode, r.url, r.prompt, r.repoPath, r.baseBranch, launchId, r.jobId, now, now,
  ]);
  await exec(conn, `INSERT INTO launches (id, agent_id, kind, run_id, ticket, session_id, cwd, runtime, model, effort, requested_at) VALUES (?, NULL, 'staff_start', ?, NULL, NULL, ?, ?, ?, ?, ?)`, [
    launchId, id, r.repoPath, staff.runtime, staff.model, staff.effort, now,
  ]);
  return { id, launch_id: launchId };
}

/**
 * The Client starts a new Staff for a job whose owner is unavailable. It is a staff_start launch like any other; the
 * request carries the job id, and the new Staff takes the job over when it reads the request (`readJobRequest`).
 */
export async function startStaffForJob(ctx: Ctx, jobId: string) {
  return tx(ctx, async (conn) => {
    const job = await queryOne(conn, `SELECT id, parent_job_id, linear_identifier, repo_path, base_branch FROM jobs WHERE id = ? FOR UPDATE`, [jobId]);
    if (!job) throw notFound(`Job ${jobId}`);
    if (job.parent_job_id) throw invalid('Start a new Staff for the parent job; its subjobs follow.');
    const owner = await queryOne(conn, `SELECT id FROM blockers WHERE job_id = ? AND kind = 'unavailable_owner' AND resolved_at IS NULL`, [jobId]);
    if (!owner) throw conflict(`Job ${jobId} has an available Staff owner, so no new Staff is started.`);
    const open = await queryOne(conn, `SELECT id, launch_id FROM job_requests WHERE job_id = ? AND mode = 'takeover' AND status IN ('queued', 'started') AND created_at > ?`, [jobId, new Date(ctx.clock.now().getTime() - 10 * 60_000)]);
    if (open) return { id: open.id as string, launch_id: open.launch_id as string, already_queued: true };
    await assertQueueRoom(conn);
    const staff = await startableStaffModel(ctx, conn);
    const queued = await queueStaffStart(conn, ctx, staff, { mode: 'takeover', url: null, prompt: `Take over ${job.linear_identifier}`, repoPath: job.repo_path as string, baseBranch: job.base_branch as string, jobId });
    await emit(conn, ctx, { type: 'job_request.created', jobId, actor: 'client', payload: { request_id: queued.id, mode: 'takeover' } });
    return { ...queued, already_queued: false };
  });
}

/** Queue a replacement for an active Staff. The runner stops its background session before starting the new one. */
export async function replaceStaffForJob(ctx: Ctx, jobId: string) {
  return tx(ctx, async (conn) => {
    const job = await queryOne(conn, `SELECT id, parent_job_id, linear_identifier, repo_path, base_branch, staff_agent_id FROM jobs WHERE id = ? FOR UPDATE`, [jobId]);
    if (!job) throw notFound(`Job ${jobId}`);
    if (job.parent_job_id) throw invalid('Reassign the parent job; its subjobs follow.');
    if (!job.staff_agent_id) throw conflict('This job has no Staff agent to replace.');
    const other = await queryOne(conn, `SELECT linear_identifier FROM jobs WHERE staff_agent_id = ? AND id <> ? AND parent_job_id IS NULL AND status NOT IN ('done', 'cancelled') LIMIT 1`, [job.staff_agent_id, jobId]);
    if (other) throw conflict(`This Staff also owns ${other.linear_identifier}, and stopping it would stop that job too. Reassign ${other.linear_identifier} first, or restart this Staff from its card.`);
    const old = await queryOne(conn, `SELECT a.runtime, s.transcript_session, s.transcript_cwd FROM agents a JOIN agent_sessions s ON s.agent_id = a.id WHERE a.id = ? AND s.ended_at IS NULL ORDER BY s.started_at DESC LIMIT 1`, [job.staff_agent_id]);
    if (old?.runtime !== 'claude-code' || !old.transcript_session || old.transcript_cwd !== job.repo_path) throw conflict('The current Staff has no Claude background session that the runner can stop.');
    const open = await queryOne(conn, `SELECT id FROM job_requests WHERE job_id = ? AND mode = 'replace' AND status IN ('queued', 'started')`, [jobId]);
    if (open) throw conflict('A replacement Staff is already starting for this job.');
    await assertQueueRoom(conn);
    const staff = await startableStaffModel(ctx, conn);
    const queued = await queueStaffStart(conn, ctx, staff, { mode: 'replace', url: null, prompt: `Take over ${job.linear_identifier}`, repoPath: job.repo_path as string, baseBranch: job.base_branch as string, jobId });
    await exec(conn, `UPDATE launches SET kind = 'staff_replace', agent_id = ?, session_id = ? WHERE id = ?`, [job.staff_agent_id, old.transcript_session, queued.launch_id]);
    await emit(conn, ctx, { type: 'job_request.created', jobId, actor: 'client', payload: { request_id: queued.id, mode: 'replace' } });
    return queued;
  });
}

/** Marks the request of a staff_start launch started or failed once the runner has reported. */
export async function settleRequestOfLaunch(conn: Conn, ctx: Ctx, launch: Row, result: string) {
  if (!['staff_start', 'staff_replace'].includes(String(launch.kind)) || !launch.run_id) return;
  const ok = result.startsWith('ok');
  await exec(conn, `UPDATE job_requests SET status = ?, error = ?, updated_at = ? WHERE id = ? AND status = 'queued'`, [ok ? 'started' : 'failed', ok ? null : result.slice(0, 2000), ctx.clock.now(), launch.run_id]);
}

/** A started Staff that has not read its job request this long after the runner reported is stuck. */
export const START_GRACE_MS = 3 * 60_000;
const UNREGISTERED = 'The Staff session started but did not reach Triglav within 3 minutes and did not read its job request. It is probably idle without the orchestrator tools; its transcript says why.';

/**
 * A runner that reports `ok` only means the background session exists. When that session never calls Triglav (seen
 * 2026-10-14: its first turn said it had no get_guide tool, then it idled), the request would stay `started` for ever.
 *
 * Mark it failed so the card stops spinning, and queue the same request once more. A second failure is left to the
 * Client, so a persistent fault does not start Staff sessions in a loop.
 *
 * Only a request that no Staff has read (staff_agent_id is null) counts. A Staff that read it may need longer than the
 * grace period before register_job, and failing it would start a second Staff for the same request.
 */
export async function failUnregisteredStarts(ctx: Ctx) {
  const cutoff = new Date(ctx.clock.now().getTime() - START_GRACE_MS);
  const stuck = await query(ctx.pool, `SELECT id FROM job_requests WHERE status = 'started' AND staff_agent_id IS NULL AND dismissed_at IS NULL AND updated_at < ?`, [cutoff]);
  for (const { id } of stuck) {
    const r = await tx(ctx, async (conn) => {
      const row = await queryOne(conn, `SELECT id, mode, job_id, source_url, prompt, repo_path, base_branch, status, staff_agent_id, dismissed_at FROM job_requests WHERE id = ? FOR UPDATE`, [id]);
      if (!row || row.status !== 'started' || row.staff_agent_id || row.dismissed_at) return null;
      await exec(conn, `UPDATE job_requests SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`, [UNREGISTERED, ctx.clock.now(), id]);
      // The dashboard refetches on new events only, so a failure with no event stays invisible away from the New job page.
      await emit(conn, ctx, { type: 'job_request.failed', jobId: (row.job_id as string | null) ?? undefined, actor: 'scheduler', payload: { request_id: id, mode: row.mode } });
      const earlier = await queryOne(conn, `SELECT COUNT(*) AS n FROM job_requests WHERE id <> ? AND error = ? AND repo_path = ? AND job_id <=> ? AND prompt <=> ? AND source_url <=> ? AND updated_at > ?`, [
        id, UNREGISTERED, row.repo_path, row.job_id, row.prompt, row.source_url, new Date(ctx.clock.now().getTime() - 30 * 60_000),
      ]);
      return Number(earlier?.n) === 0 ? row : null;
    });
    if (!r || r.mode === 'replace') continue;
    try {
      if (r.mode === 'takeover') await startStaffForJob(ctx, r.job_id as string);
      else await retryJobRequest(ctx, id);
    } catch {
      // The Client sees the failed request and decides; a refused retry (queue full, owner back) needs no second report.
    }
  }
}

/**
 * The newest 20 requests, plus the newest takeover of every job that still has an open unavailable-owner blocker: its
 * card needs the outcome however many other requests followed.
 */
export async function listJobRequests(ctx: Ctx) {
  return query(
    ctx.pool,
    `SELECT r.id, r.mode, r.source_url, r.prompt, r.repo_path, r.base_branch, r.status, r.error, r.job_id, r.created_at, r.updated_at, r.dismissed_at,
       l.picked_at, l.finished_at, l.result, j.linear_identifier AS job_identifier, j.title AS job_title
     FROM job_requests r LEFT JOIN launches l ON l.id = r.launch_id LEFT JOIN jobs j ON j.id = r.job_id
     WHERE r.id IN (SELECT id FROM (SELECT id FROM job_requests ORDER BY created_at DESC LIMIT 20) newest)
       OR r.id IN (
         SELECT r2.id FROM job_requests r2
         JOIN (SELECT job_id, MAX(created_at) AS latest FROM job_requests WHERE mode = 'takeover' GROUP BY job_id) t ON t.job_id = r2.job_id AND t.latest = r2.created_at
         WHERE r2.mode = 'takeover' AND EXISTS (SELECT 1 FROM blockers b WHERE b.job_id = r2.job_id AND b.kind = 'unavailable_owner' AND b.resolved_at IS NULL)
       )
     ORDER BY r.created_at DESC`,
  );
}

/** The Client has seen a request that did not start, or that never registered a job, and is done with it. */
export async function dismissJobRequest(ctx: Ctx, id: string) {
  return tx(ctx, async (conn) => {
    const r = await queryOne(conn, `SELECT id, job_id, status FROM job_requests WHERE id = ? FOR UPDATE`, [id]);
    if (!r) throw notFound(`Job request ${id}`);
    if (r.job_id) throw conflict(`Job request ${id} already became a job.`);
    if (r.status === 'queued') throw conflict('The runner has not tried this request yet.');
    await exec(conn, `UPDATE job_requests SET dismissed_at = ? WHERE id = ? AND dismissed_at IS NULL`, [ctx.clock.now(), id]);
    return { ok: true };
  });
}

/**
 * The Client takes back a request the runner has not picked up yet, for example one with the wrong repository. Its
 * launch is closed in the same transaction, so the runner never starts it; one the runner already took is refused,
 * because a Staff may be starting.
 */
export async function cancelJobRequest(ctx: Ctx, id: string) {
  return tx(ctx, async (conn) => {
    const r = await queryOne(conn, `SELECT id, mode, job_id, status, launch_id FROM job_requests WHERE id = ? FOR UPDATE`, [id]);
    if (!r) throw notFound(`Job request ${id}`);
    // A takeover carries its job id from the start; for any other request a job id means a job was registered.
    if (r.job_id && r.mode !== 'takeover' && r.mode !== 'replace') throw conflict(`Job request ${id} already became a job. Cancel the job instead.`);
    if (r.status !== 'queued') throw conflict(`Job request ${id} is no longer waiting for the runner, so it is not cancelled.`);
    const l = await queryOne(conn, `SELECT picked_at, finished_at FROM launches WHERE id = ? FOR UPDATE`, [r.launch_id]);
    if (l?.picked_at || l?.finished_at) throw conflict('The runner has already taken this request.');
    const now = ctx.clock.now();
    await exec(conn, `UPDATE launches SET finished_at = ?, result = 'cancelled by the Client' WHERE id = ?`, [now, r.launch_id]);
    await exec(conn, `UPDATE job_requests SET status = 'cancelled', updated_at = ?, dismissed_at = ? WHERE id = ?`, [now, now, id]);
    await emit(conn, ctx, { type: 'job_request.cancelled', actor: 'client', payload: { request_id: id } });
    return { ok: true };
  });
}

/**
 * Queues a request that failed again, with the same fields, and dismisses the failed one. Only a failed request can be
 * retried: one that started may have a Staff running, and a second one would work on the same job.
 */
export async function retryJobRequest(ctx: Ctx, id: string) {
  const r = await queryOne(ctx.pool, `SELECT mode, source_url, prompt, repo_path, base_branch, status FROM job_requests WHERE id = ?`, [id]);
  if (!r) throw notFound(`Job request ${id}`);
  if (r.status !== 'failed') throw conflict(`Job request ${id} did not fail, so it is not retried.`);
  if (r.mode === 'replace') throw conflict('Start another replacement from the job page so the current owner is checked again.');
  const again = await createJobRequest(ctx, { mode: r.mode as RequestMode, url: r.source_url as string | null, prompt: r.prompt as string | null, repoPath: r.repo_path as string, baseBranch: r.base_branch as string });
  await exec(ctx.pool, `UPDATE job_requests SET dismissed_at = ? WHERE id = ? AND dismissed_at IS NULL`, [ctx.clock.now(), id]);
  return again;
}

/**
 * Staff: the request named in its start prompt. The first Staff to read it claims it, so another Staff cannot
 * register a job for it. The Client's URL and prompt are returned as data.
 */
export async function readJobRequest(ctx: Ctx, agent: Agent, requestId: string) {
  if (agent.role !== 'staff') throw forbidden('Only a Staff agent reads job requests.');
  if (!REQUEST_ID.test(requestId)) throw invalid('That is not a job request id.');
  return tx(ctx, async (conn) => {
    const r = await queryOne(conn, `SELECT * FROM job_requests WHERE id = ? FOR UPDATE`, [requestId]);
    if (!r) throw notFound(`Job request ${requestId}`);
    if (r.staff_agent_id && r.staff_agent_id !== agent.id) throw forbidden(`Job request ${requestId} is already taken by another Staff agent.`);
    if (r.status === 'failed' && !r.staff_agent_id) {
      // failUnregisteredStarts gave up on this Staff and may have queued another one. Reading it now would start a second Staff on the same request.
      return { id: r.id as string, mode: r.mode as string, job_id: (r.job_id as string | null) ?? null, next: 'This request timed out and was failed, and another Staff may have been started for it. Do not call register_job. End your session.' };
    }
    if ((r.mode === 'takeover' || r.mode === 'replace') && r.status === 'registered') {
      // Handed over already. A second read must not take the job back after the Client reassigned it.
      return {
        id: r.id as string,
        mode: r.mode as string,
        job_id: r.job_id as string,
        next: 'This takeover is finished: the job was handed to you when you first read the request. Check who owns it now with get_job. Do not call register_job.',
      };
    }
    if (r.mode === 'replace') {
      const launch = await queryOne(conn, `SELECT agent_id FROM launches WHERE id = ?`, [r.launch_id]);
      const job = await lockJob(conn, r.job_id as string);
      if (r.status === 'cancelled' || job.staff_agent_id !== launch?.agent_id) {
        return { id: r.id as string, mode: 'replace', job_id: r.job_id as string, next: 'The job was reassigned or this request was cancelled. Do not take it over. End your session.' };
      }
    }
    if (r.mode === 'takeover' && (r.status === 'cancelled' || !r.staff_agent_id)) {
      // The takeover may have waited for the runner while the owner came back or the Client reassigned the job. The
      // blocker that asked for it is then resolved, and this Staff must not take the job from its current owner.
      const open = await queryOne(conn, `SELECT id FROM blockers WHERE job_id = ? AND kind = 'unavailable_owner' AND resolved_at IS NULL`, [r.job_id]);
      // The blocker is resolved on the next scheduler tick after the owner returns, so it can still be open while the
      // owner is live. The owner's session is checked here, under lock, before any handover.
      const job = await lockJob(conn, r.job_id as string);
      const returned = r.status !== 'cancelled' && !!open && (await ownerIsLive(conn, ctx, job.staff_agent_id as string | null));
      if (r.status === 'cancelled' || !open || returned) {
        const now = ctx.clock.now();
        if (r.status !== 'cancelled') {
          await exec(conn, `UPDATE job_requests SET status = 'cancelled', error = ?, staff_agent_id = ?, updated_at = ?, dismissed_at = ? WHERE id = ?`, ['The job has an available owner again, so this takeover was dropped.', agent.id, now, now, requestId]);
        }
        return {
          id: r.id as string,
          mode: 'takeover',
          job_id: r.job_id as string,
          next: 'The job is not yours: its owner is available again, or the Client reassigned it or cancelled this request. There is nothing to take over. Do not call register_job. End your session.',
        };
      }
    }
    if (!r.staff_agent_id) await exec(conn, `UPDATE job_requests SET staff_agent_id = ?, updated_at = ? WHERE id = ?`, [agent.id, ctx.clock.now(), requestId]);
    if (r.mode === 'takeover' || r.mode === 'replace') {
      // The job already exists: the first Staff to read the request becomes its owner.
      const handed = await reassignStaffIn(conn, ctx, r.job_id as string, agent.id);
      // The handover is the whole job of this request: no register_job follows, so it ends here like a registered job.
      await exec(conn, `UPDATE job_requests SET status = 'registered', updated_at = ? WHERE id = ?`, [ctx.clock.now(), requestId]);
      return {
        id: r.id as string,
        mode: r.mode as string,
        job_id: handed.job_id,
        handover_summary: handed.handover_summary,
        next: 'The job is yours now. Read the handover summary, check the job with get_job, and continue where the previous Staff stopped. Do not call register_job.',
      };
    }
    return {
      id: r.id as string,
      mode: r.mode as RequestMode,
      source_url: r.source_url as string | null,
      prompt: r.prompt as string | null,
      repo_path: r.repo_path as string,
      base_branch: r.base_branch as string,
      status: r.status as string,
      job_id: r.job_id as string | null,
      next:
        r.mode === 'link'
          ? 'Read the ticket at source_url with whatever MCP you have, then call register_job with request_id and ticket_snapshot (and ticket, the Linear identifier, for a Linear URL).'
          : 'Call register_job with request_id and a short title. The job starts in refining: propose goal, scope, non-goals and criteria, and ask your open questions on the General thread.',
    };
  });
}

/** Loads and locks the request for register_job, and checks the caller may register it. */
export async function lockRequestForRegistration(conn: Conn, agent: Agent, requestId: string): Promise<Row> {
  if (!REQUEST_ID.test(requestId)) throw invalid('That is not a job request id.');
  const r = await queryOne(conn, `SELECT * FROM job_requests WHERE id = ? FOR UPDATE`, [requestId]);
  if (!r) throw notFound(`Job request ${requestId}`);
  if (r.job_id) throw conflict(`Job request ${requestId} is already registered as job ${r.job_id}.`);
  if (r.staff_agent_id && r.staff_agent_id !== agent.id) throw forbidden(`Job request ${requestId} is taken by another Staff agent.`);
  if (r.status === 'failed' && !r.staff_agent_id) throw conflict(`Job request ${requestId} timed out and was failed, and another Staff may have been started for it. Do not register a job. End your session.`);
  return r;
}
