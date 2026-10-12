import type { PoolConnection } from 'mysql2/promise';
import type { Agent } from './agents.ts';
import { POLICY, tx, type Ctx } from './context.ts';
import { exec, json, parseJson, query, queryOne, type Conn, type Row } from './db.ts';
import { emit } from './events.ts';
import { addSeconds, assertNoSecrets, conflict, forbidden, invalid, newId, newSecret, notFound, sha256, TICKET_PREFIX } from './lib.ts';
import { createHash } from 'node:crypto';
import { linearTreeSchema, type LinearIssue, type LinearTree } from './linear.ts';
import { effectiveRoleModel, startHint } from './models.ts';
import { isLinearUrl, lockRequestForRegistration } from './job-requests.ts';

export const JOB_STATUSES = ['queued', 'refining', 'planning', 'ready', 'in_progress', 'in_review', 'delivering', 'blocked', 'done', 'cancelled'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export const CLOSED: JobStatus[] = ['done', 'cancelled'];

export const CLIENT = 'client';

export async function lockJob(conn: Conn, jobId: string): Promise<Row> {
  const job = await queryOne(conn, `SELECT * FROM jobs WHERE id = ? FOR UPDATE`, [jobId]);
  if (!job) throw notFound(`Job ${jobId}`);
  return job;
}

export function requireStaffOf(agent: Agent, job: Row): void {
  if (agent.role !== 'staff' || job.staff_agent_id !== agent.id) {
    throw forbidden(`Only the owning Staff agent of job ${job.id} may do this.`);
  }
}

export async function setStatus(conn: Conn, ctx: Ctx, job: Row, to: JobStatus, actor: string, extra: Record<string, unknown> = {}) {
  const from = job.status as JobStatus;
  if (from === to) return;
  await exec(conn, `UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?`, [to, ctx.clock.now(), job.id]);
  job.status = to;
  await emit(conn, ctx, {
    type: 'job.status',
    jobId: job.id,
    actor,
    targets: job.staff_agent_id ? [job.staff_agent_id] : [],
    payload: { from, to, ...extra },
  });
}

export async function generalThreadId(conn: Conn, jobId: string): Promise<string> {
  const row = await queryOne(conn, `SELECT id FROM threads WHERE job_id = ? AND kind = 'discussion' ORDER BY created_at LIMIT 1`, [jobId]);
  if (!row) throw notFound(`General thread for job ${jobId}`);
  return row.id;
}

export type JobSource = 'linear' | 'link' | 'prompt';

/** http(s) URLs only: a snapshot is written by an agent, and the dashboard links to it. */
const safeUrl = (u: string | null | undefined) => (u && /^https?:\/\/\S+$/i.test(u) ? u : '');

async function insertJob(
  conn: PoolConnection,
  ctx: Ctx,
  issue: LinearIssue,
  opts: { parentJobId: string | null; repoPath: string; baseBranch: string; staffId: string; source: JobSource; status: JobStatus; issueKey?: string },
): Promise<string> {
  const now = ctx.clock.now();
  const id = newId('job');
  await exec(
    conn,
    `INSERT INTO jobs (id, parent_job_id, linear_issue_id, linear_identifier, linear_url, title, repo_path, base_branch, staff_agent_id,
       status, source, linear_snapshot, linear_state, linear_updated_at, linear_fetched_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      opts.parentJobId,
      opts.issueKey ?? issue.id,
      issue.identifier,
      safeUrl(issue.url),
      issue.title,
      opts.repoPath,
      opts.baseBranch,
      opts.staffId,
      opts.status,
      opts.source,
      json(issue),
      issue.state ?? null,
      issue.updatedAt ? new Date(issue.updatedAt) : null,
      now,
      now,
      now,
    ],
  );
  await exec(conn, `INSERT INTO threads (id, job_id, kind, title, created_by, created_at) VALUES (?, ?, 'discussion', 'General', ?, ?)`, [
    newId('thr'),
    id,
    opts.staffId,
    now,
  ]);
  return id;
}

/** Key for jobs whose ticket is not in Linear: ids from different trackers can clash, so they are derived from the URL. */
const linkKey = (...parts: string[]) => `link:${createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 40)}`;

/**
 * Registers a ticket and its direct sub-issues as jobs owned by the calling Staff agent.
 *
 * Without a request, `ticket` (or the older `linearIssue`) is a Linear identifier. With a Linear key the orchestrator
 * fetches the tree itself; without one Staff supplies the snapshot it read through Linear MCP.
 *
 * With a request from the dashboard (request_id) the repository and base branch come from the request. A link request
 * for a Linear URL behaves like the case above; any other URL needs the snapshot Staff read with whatever MCP it has,
 * and the job is never refreshed from Linear. A prompt request creates a job from the prompt in status "refining".
 */
export async function registerJob(
  ctx: Ctx,
  agent: Agent,
  input: { ticket?: string; linearIssue?: string; requestId?: string; title?: string; repoPath?: string; baseBranch?: string; snapshot?: unknown },
) {
  if (agent.role !== 'staff') throw forbidden('Only a Staff agent may register a job.');
  const ticket = input.ticket ?? input.linearIssue;
  if (!input.requestId) {
    if (!ticket) throw invalid('Give ticket (the ticket identifier), or request_id for a job request from the dashboard.');
    if (!input.repoPath) throw invalid('Give repo_path.');
  }
  // The ticket is read before the transaction: a slow Linear must not hold the write lock.
  const pre = input.requestId ? await queryOne(ctx.pool, `SELECT mode, source_url FROM job_requests WHERE id = ?`, [input.requestId]) : null;
  if (input.requestId && !pre) throw notFound(`Job request ${input.requestId}`);
  const sourceOf = (r: Row | null | undefined): JobSource => (!r ? 'linear' : r.mode === 'prompt' ? 'prompt' : isLinearUrl(r.source_url as string | null) ? 'linear' : 'link');
  const wantSource = sourceOf(pre);
  let fetched: LinearTree | null = null;
  if (wantSource === 'linear' && ctx.linear) {
    const id = ticket ?? /\/issue\/([A-Za-z0-9]+-\d+)/.exec(pre?.source_url ?? '')?.[1];
    if (!id) throw invalid('Give ticket: the Linear identifier of the ticket at the URL, for example ENG-123.');
    fetched = await ctx.linear.fetchTree(id);
  }
  return tx(ctx, async (conn) => {
    const request = input.requestId ? await lockRequestForRegistration(conn, agent, input.requestId) : null;
    if (request && input.repoPath && input.repoPath !== request.repo_path) throw invalid(`repo_path differs from the request (${request.repo_path}). Leave it out; the request decides.`);
    if (request && input.baseBranch && input.baseBranch !== request.base_branch) throw invalid(`base_branch differs from the request (${request.base_branch}). Leave it out; the request decides.`);
    const repoPath = (request?.repo_path ?? input.repoPath) as string;
    const baseBranch = (request?.base_branch ?? input.baseBranch ?? 'main') as string;
    const source = sourceOf(request);
    const opts = { repoPath, baseBranch, staffId: agent.id, source };

    let tree: LinearTree;
    let snapshotSource: 'linear' | 'agent';
    let keyOf = (issue: { id: string }): string => issue.id;
    if (request?.mode === 'prompt') {
      const title = input.title?.trim();
      if (!title) throw invalid('Give title: a short title for the job, in your own words.');
      assertNoSecrets(title);
      const short = String(request.id).slice(4, 10).toUpperCase();
      tree = { id: `prompt:${request.id}`, identifier: `PRM-${short}`, title: title.slice(0, 500), description: request.prompt as string, url: '', state: null, updatedAt: null, children: [] };
      snapshotSource = 'agent';
    } else if (fetched) {
      tree = fetched;
      snapshotSource = 'linear';
    } else {
      if (!input.snapshot) {
        throw invalid(
          source === 'link'
            ? 'This ticket is not in Linear. Read it (and its sub-issues, if it has any) with whatever MCP you have and pass them as ticket_snapshot.'
            : 'The orchestrator has no Linear API key. Read the ticket and its sub-issues with Linear MCP and pass them as ticket_snapshot.',
        );
      }
      tree = linearTreeSchema.parse(input.snapshot);
      snapshotSource = 'agent';
      if (source === 'link') {
        const root = request!.source_url as string;
        if (!safeUrl(tree.url)) tree.url = root;
        keyOf = (issue) => (issue === tree ? linkKey(root) : linkKey(root, issue.id));
      }
    }
    const rootKey = keyOf(tree);
    const existing = await queryOne(conn, `SELECT id, staff_agent_id FROM jobs WHERE linear_issue_id = ?`, [rootKey]);
    if (existing) throw conflict(`Ticket ${tree.identifier} is already registered as job ${existing.id}.`);
    const { children = [], ...root } = tree;
    const parentId = await insertJob(conn, ctx, { ...root }, { ...opts, parentJobId: null, status: source === 'prompt' ? 'refining' : 'queued', issueKey: rootKey });
    const childIds: string[] = [];
    for (const child of children) {
      const key = keyOf(child);
      const dup = await queryOne(conn, `SELECT id FROM jobs WHERE linear_issue_id = ?`, [key]);
      if (dup) throw conflict(`Sub-issue ${child.identifier} is already registered as job ${dup.id}.`);
      childIds.push(await insertJob(conn, ctx, child, { ...opts, parentJobId: parentId, status: 'queued', issueKey: key }));
    }
    if (request) {
      await exec(conn, `UPDATE job_requests SET job_id = ?, staff_agent_id = ?, status = 'registered', updated_at = ? WHERE id = ?`, [parentId, agent.id, ctx.clock.now(), request.id]);
    }
    await emit(conn, ctx, {
      type: 'job.registered',
      jobId: parentId,
      actor: agent.id,
      payload: { identifier: root.identifier, title: root.title, children: children.map((c) => c.identifier), source: snapshotSource, job_source: source, request_id: request?.id ?? null },
    });
    return { job_id: parentId, subjob_ids: childIds, snapshot_source: snapshotSource, job_source: source, status: source === 'prompt' ? 'refining' : 'queued' };
  });
}

const STAFF_TRANSITIONS: Partial<Record<JobStatus, JobStatus[]>> = {
  queued: ['planning'],
  planning: ['ready'],
  ready: ['planning'],
};

export async function updateJob(
  ctx: Ctx,
  agent: Agent,
  input: {
    jobId: string;
    plan?: string;
    acceptanceCriteria?: string;
    dependsOn?: string[];
    required?: boolean;
    reason?: string;
    status?: JobStatus;
  },
) {
  return tx(ctx, async (conn) => {
    const job = await lockJob(conn, input.jobId);
    requireStaffOf(agent, job);
    // A cancelled required subjob would block its parent forever, so Staff may still mark it optional.
    const onlyRequired = Object.keys(input).every((k) => ['jobId', 'required', 'reason'].includes(k) || (input as Record<string, unknown>)[k] === undefined);
    if (CLOSED.includes(job.status) && !(job.status === 'cancelled' && onlyRequired && input.required !== undefined)) {
      throw conflict(`Job ${job.id} is ${job.status}.`);
    }
    assertNoSecrets(input.plan, input.acceptanceCriteria, input.reason);
    const now = ctx.clock.now();
    if (input.plan !== undefined) await exec(conn, `UPDATE jobs SET plan = ?, updated_at = ? WHERE id = ?`, [input.plan, now, job.id]);
    if (input.acceptanceCriteria !== undefined) {
      await exec(conn, `UPDATE jobs SET acceptance_criteria = ?, updated_at = ? WHERE id = ?`, [input.acceptanceCriteria, now, job.id]);
      job.acceptance_criteria = input.acceptanceCriteria;
    }
    if (input.dependsOn !== undefined) {
      for (const dep of input.dependsOn) {
        if (dep === job.id) throw invalid('A job cannot depend on itself.');
        const other = await queryOne(conn, `SELECT id, parent_job_id FROM jobs WHERE id = ?`, [dep]);
        if (!other || other.parent_job_id !== job.parent_job_id || !job.parent_job_id) {
          throw invalid(`Dependencies must be sibling subjobs; ${dep} is not.`);
        }
      }
      // Refuse cycles: a cycle would leave every job in it unclaimable.
      const edges = await query(conn, `SELECT job_id, depends_on_job_id FROM job_dependencies WHERE job_id <> ?`, [job.id]);
      const next = new Map<string, string[]>();
      for (const e of edges) next.set(e.job_id, [...(next.get(e.job_id) ?? []), e.depends_on_job_id]);
      next.set(job.id, input.dependsOn);
      const seen = new Set<string>();
      const stack = [...input.dependsOn];
      while (stack.length) {
        const cur = stack.pop()!;
        if (cur === job.id) throw invalid('These dependencies would create a cycle.');
        if (seen.has(cur)) continue;
        seen.add(cur);
        stack.push(...(next.get(cur) ?? []));
      }
      await exec(conn, `DELETE FROM job_dependencies WHERE job_id = ?`, [job.id]);
      for (const dep of input.dependsOn) {
        await exec(conn, `INSERT INTO job_dependencies (job_id, depends_on_job_id) VALUES (?, ?)`, [job.id, dep]);
      }
    }
    if (input.required !== undefined) {
      if (!job.parent_job_id) throw invalid('Only subjobs can be optional.');
      if (!input.reason) throw invalid('Changing whether a subjob is required needs a reason.');
      await exec(conn, `UPDATE jobs SET required = ? WHERE id = ?`, [input.required, job.id]);
      await recordJobDecision(conn, ctx, job.parent_job_id, agent.id, `${job.linear_identifier} is now ${input.required ? 'required' : 'optional'}.`, input.reason);
    }
    if (input.status !== undefined && input.status !== job.status) {
      const allowed = STAFF_TRANSITIONS[job.status as JobStatus] ?? [];
      if (input.status === 'cancelled') {
        if (!input.reason) throw invalid('Cancelling a job needs a reason.');
        await cancelJobTree(conn, ctx, job, agent.id, input.reason);
      } else if (job.status === 'refining') {
        throw conflict(`Job ${job.id} is being refined with the Client. Only the Client's approval moves it to planning; keep proposing and asking on the General thread.`);
      } else if (!allowed.includes(input.status)) {
        throw conflict(`Staff cannot move job ${job.id} from ${job.status} to ${input.status}. Use the dedicated tool for review and completion.`);
      } else {
        if (input.status === 'ready' && !job.acceptance_criteria) throw invalid('Write acceptance criteria before marking a job ready.');
        await setStatus(conn, ctx, job, input.status, agent.id);
      }
    }
    await emit(conn, ctx, { type: 'job.updated', jobId: job.id, actor: agent.id, payload: { fields: Object.keys(input).filter((k) => k !== 'jobId') } });
    if (job.status === 'refining' && (input.plan !== undefined || input.acceptanceCriteria !== undefined)) {
      // The Client reads the proposal in the dashboard and answers; this shows up in its activity feed.
      await emit(conn, ctx, { type: 'refinement.proposal_updated', jobId: job.id, actor: agent.id, payload: { fields: ['plan', 'acceptance_criteria'].filter((f) => (f === 'plan' ? input.plan : input.acceptanceCriteria) !== undefined) } });
    }
    return { job_id: job.id, status: job.status };
  });
}

export async function recordJobDecision(conn: Conn, ctx: Ctx, jobId: string, by: string, body: string, rationale: string | null) {
  const threadId = await generalThreadId(conn, jobId);
  await exec(
    conn,
    `INSERT INTO decisions (id, thread_id, job_id, decided_by, authority, body, rationale, considered_message_ids, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?)`,
    [newId('dec'), threadId, jobId, by, by === CLIENT ? 'client' : 'staff', body, rationale, ctx.clock.now()],
  );
  await emit(conn, ctx, { type: 'decision.recorded', jobId, threadId, actor: by, payload: { body } });
}

async function cancelJobTree(conn: Conn, ctx: Ctx, job: Row, actor: string, reason: string) {
  const ids = [job.id, ...(await query(conn, `SELECT id FROM jobs WHERE parent_job_id = ?`, [job.id])).map((r) => r.id as string)];
  for (const id of ids) {
    const j = id === job.id ? job : await lockJob(conn, id);
    if (CLOSED.includes(j.status)) continue;
    await exec(conn, `UPDATE jobs SET control = 'cancel' WHERE id = ?`, [id]);
    const holders = (await query(conn, `SELECT DISTINCT owner_agent_id FROM assignments WHERE job_id = ? AND status = 'held'`, [id])).map((r) => r.owner_agent_id as string);
    await closeAssignments(conn, ctx, id, 'cancelled');
    await exec(conn, `UPDATE blockers SET resolved_at = ?, resolved_by = ?, resolution = ? WHERE job_id = ? AND resolved_at IS NULL`, [ctx.clock.now(), actor, `Job cancelled: ${reason}`, id]);
    await setStatus(conn, ctx, j, 'cancelled', actor, { reason });
    await emit(conn, ctx, { type: 'job.cancelled', jobId: id, actor, targets: holders, payload: { reason } });
  }
}

async function closeAssignments(conn: Conn, ctx: Ctx, jobId: string, outcome: string, kind?: string) {
  const rows = await query(conn, `SELECT * FROM assignments WHERE job_id = ? AND status <> 'closed' ${kind ? 'AND kind = ?' : ''} FOR UPDATE`, kind ? [jobId, kind] : [jobId]);
  for (const a of rows) {
    await exec(conn, `UPDATE attempts SET ended_at = ?, outcome = ? WHERE assignment_id = ? AND number = ? AND ended_at IS NULL`, [
      ctx.clock.now(),
      outcome,
      a.id,
      a.current_attempt,
    ]);
    await exec(conn, `UPDATE assignments SET status = 'closed', lease_expires_at = NULL WHERE id = ?`, [a.id]);
  }
}

export { closeAssignments };

async function dependenciesDone(conn: Conn, jobId: string): Promise<{ done: boolean; pending: string[] }> {
  const rows = await query(
    conn,
    `SELECT j.id, j.linear_identifier, j.status FROM job_dependencies d JOIN jobs j ON j.id = d.depends_on_job_id WHERE d.job_id = ?`,
    [jobId],
  );
  const pending = rows.filter((r) => r.status !== 'done').map((r) => `${r.linear_identifier} (${r.status})`);
  return { done: pending.length === 0, pending };
}

/**
 * Issues a single-use ticket that a Senior or Reviewer uses to register. Registering with it claims
 * the assignment, so the caps and readiness checks happen here.
 */
export async function createSpawnTicket(ctx: Ctx, agent: Agent, input: { jobId: string; role: 'senior' | 'reviewer'; brief: string }) {
  return tx(ctx, async (conn) => {
    const job = await lockJob(conn, input.jobId);
    requireStaffOf(agent, job);
    if (job.control !== 'continue') throw conflict(`Job ${job.id} is ${job.control === 'pause' ? 'paused' : 'cancelled'}.`);
    const kind = input.role === 'senior' ? 'implement' : 'review';
    if (kind === 'implement') {
      if (!['ready', 'in_progress', 'delivering'].includes(job.status)) throw conflict(`Job ${job.id} must be ready before a Senior starts on it (it is ${job.status}).`);
      const children = await queryOne(conn, `SELECT COUNT(*) AS n FROM jobs WHERE parent_job_id = ?`, [job.id]);
      if (Number(children?.n) > 0) throw invalid('This job has subjobs. Start Seniors on the subjobs instead.');
      const deps = await dependenciesDone(conn, job.id);
      if (!deps.done) throw conflict(`Job ${job.id} waits for: ${deps.pending.join(', ')}.`);
      await checkSeniorCaps(conn, job, ctx.clock.now());
    } else if (job.status !== 'in_review') {
      throw conflict(`A reviewer can only start on a job in review (job ${job.id} is ${job.status}).`);
    }
    let assignment = await queryOne(conn, `SELECT * FROM assignments WHERE job_id = ? AND kind = ? AND status <> 'closed' FOR UPDATE`, [job.id, kind]);
    if (assignment && assignment.status === 'held' && assignment.lease_expires_at > ctx.clock.now()) {
      throw conflict(`Assignment ${assignment.id} is held by ${assignment.owner_agent_id}. Wait for its lease to expire or for it to finish.`);
    }
    if (!assignment) {
      const id = newId('asg');
      await exec(conn, `INSERT INTO assignments (id, job_id, kind, status, created_at) VALUES (?, ?, ?, 'open', ?)`, [id, job.id, kind, ctx.clock.now()]);
      assignment = { id };
    }
    const code = newSecret(TICKET_PREFIX);
    const expires = addSeconds(ctx.clock.now(), POLICY.spawnTicketSec);
    await exec(conn, `INSERT INTO spawn_tickets (code_hash, issued_by, assignment_id, role, expires_at) VALUES (?, ?, ?, ?, ?)`, [
      sha256(code),
      agent.id,
      assignment.id,
      input.role,
      expires,
    ]);
    await emit(conn, ctx, { type: 'spawn_ticket.issued', jobId: job.id, actor: agent.id, payload: { assignment_id: assignment.id, role: input.role } });
    const prompt = [
      `Call get_guide with role "${input.role}" (or read ${ctx.baseUrl}/guide.md?role=${input.role}) and follow it.`,
      `Register with register_agent using role "${input.role}" and spawn_ticket "${code}".`,
      `Your job is ${job.id} (Linear ${job.linear_identifier}: ${job.title}). Repository: ${job.repo_path}, base branch ${job.base_branch}.`,
      `Brief from Staff: ${input.brief}`,
    ].join('\n');
    const configured = await effectiveRoleModel(ctx, conn, input.role);
    return { spawn_ticket: code, assignment_id: assignment.id as string, expires_at: expires, start_prompt: prompt, model: configured ? startHint(configured) : null };
  });
}

/** Concurrency caps for Seniors. Checked when a ticket is issued and again when it is claimed. */
export async function checkSeniorCaps(conn: Conn, job: Row, now: Date): Promise<void> {
  const root = job.parent_job_id ?? job.id;
  const heldParent = await queryOne(
    conn,
    `SELECT COUNT(*) AS n FROM assignments a JOIN jobs j ON j.id = a.job_id
     WHERE a.kind = 'implement' AND a.status = 'held' AND a.lease_expires_at > ? AND (j.id = ? OR j.parent_job_id = ?)`,
    [now, root, root],
  );
  if (Number(heldParent?.n) >= POLICY.maxHeldPerParent) throw conflict(`At most ${POLICY.maxHeldPerParent} Seniors may work on one parent job at a time.`);
  const heldAll = await queryOne(conn, `SELECT COUNT(*) AS n FROM assignments WHERE kind = 'implement' AND status = 'held' AND lease_expires_at > ?`, [now]);
  if (Number(heldAll?.n) >= POLICY.maxHeldOverall) throw conflict(`At most ${POLICY.maxHeldOverall} Seniors may work at a time.`);
}

/** Checks that the caller holds the current attempt. Stale workers are refused here. */
export async function requireAttempt(conn: Conn, ctx: Ctx, agent: Agent, assignmentId: string, attempt: number): Promise<Row> {
  const a = await queryOne(conn, `SELECT * FROM assignments WHERE id = ? FOR UPDATE`, [assignmentId]);
  if (!a) throw notFound(`Assignment ${assignmentId}`);
  if (a.owner_agent_id !== agent.id || Number(a.current_attempt) !== attempt) {
    throw conflict(`Attempt ${attempt} on ${assignmentId} is no longer current. Stop work on it and report to your Staff agent.`);
  }
  if (a.status !== 'held' || !a.lease_expires_at || a.lease_expires_at <= ctx.clock.now()) {
    throw conflict(`Your lease on ${assignmentId} is gone (status ${a.status}). Stop work on it and report to your Staff agent.`);
  }
  return a;
}

export async function reportProgress(
  ctx: Ctx,
  agent: Agent,
  input: { assignmentId: string; attempt: number; note: string; worktreePath?: string; links?: string[] },
) {
  assertNoSecrets(input.note);
  return tx(ctx, async (conn) => {
    const a = await requireAttempt(conn, ctx, agent, input.assignmentId, input.attempt);
    if (input.worktreePath) {
      const clash = await queryOne(conn, `SELECT id FROM assignments WHERE worktree_path = ? AND status = 'held' AND id <> ?`, [input.worktreePath, a.id]);
      if (clash) throw conflict(`Worktree ${input.worktreePath} is in use by assignment ${clash.id}. Use your own worktree.`);
      await exec(conn, `UPDATE assignments SET worktree_path = ? WHERE id = ?`, [input.worktreePath, a.id]);
    }
    await exec(conn, `UPDATE attempts SET last_progress = ? WHERE assignment_id = ? AND number = ?`, [input.note, a.id, input.attempt]);
    await emit(conn, ctx, {
      type: 'progress',
      jobId: a.job_id,
      actor: agent.id,
      payload: { assignment_id: a.id, attempt: input.attempt, note: input.note, links: input.links ?? [] },
    });
    return { ok: true };
  });
}

/** Done for a parent: every required subjob done, every optional one done or cancelled, and a Staff integration decision. */
export async function completeParent(ctx: Ctx, agent: Agent, input: { jobId: string; integrationSummary: string }) {
  assertNoSecrets(input.integrationSummary);
  return tx(ctx, async (conn) => {
    const job = await lockJob(conn, input.jobId);
    requireStaffOf(agent, job);
    const children = await query(conn, `SELECT id, linear_identifier, status, required FROM jobs WHERE parent_job_id = ?`, [job.id]);
    if (children.length === 0) throw invalid('This job has no subjobs. It completes when its review is accepted.');
    if (CLOSED.includes(job.status)) throw conflict(`Job ${job.id} is already ${job.status}.`);
    const open = children.filter((c) => (c.required ? c.status !== 'done' : !CLOSED.includes(c.status)));
    if (open.length) throw conflict(`Not complete yet: ${open.map((c) => `${c.linear_identifier} is ${c.status}${c.required ? '' : ' (optional)'}`).join('; ')}.`);
    await recordJobDecision(conn, ctx, job.id, agent.id, 'Integration criteria confirmed; parent job complete.', input.integrationSummary);
    await setStatus(conn, ctx, job, 'done', agent.id);
    return { job_id: job.id, status: 'done' };
  });
}

/** Client controls: pause, resume, cancel. Agents receive them in the control field of every response. */
export async function setControl(ctx: Ctx, jobId: string, action: 'pause' | 'resume' | 'cancel', reason: string | null) {
  return tx(ctx, async (conn) => {
    const job = await lockJob(conn, jobId);
    if (CLOSED.includes(job.status)) throw conflict(`Job ${job.id} is ${job.status}.`);
    if (action === 'cancel') {
      await cancelJobTree(conn, ctx, job, CLIENT, reason ?? 'Cancelled by the Client');
    } else {
      const value = action === 'pause' ? 'pause' : 'continue';
      await exec(conn, `UPDATE jobs SET control = ? WHERE id = ? OR parent_job_id = ?`, [value, job.id, job.id]);
      await emit(conn, ctx, { type: `job.${action}d`, jobId: job.id, actor: CLIENT, targets: [job.staff_agent_id], payload: { reason } });
    }
    return { job_id: job.id, control: action === 'resume' ? 'continue' : action };
  });
}

/**
 * Client: reopens a job that was closed as done although it was not delivered (for example CI is red).
 * It goes back to delivering, so the next Senior takes the PR through the Copilot loop and CI.
 */
export async function reopenForDelivery(ctx: Ctx, jobId: string, reason: string) {
  if (!reason.trim()) throw invalid('Say why the job is not done.');
  assertNoSecrets(reason);
  return tx(ctx, async (conn) => {
    const job = await lockJob(conn, jobId);
    if (job.status !== 'done') throw conflict(`Job ${job.id} is ${job.status}; only a done job can be reopened.`);
    const children = await queryOne(conn, `SELECT COUNT(*) AS n FROM jobs WHERE parent_job_id = ?`, [job.id]);
    if (Number(children?.n) > 0) throw invalid('This job has subjobs. Reopen the subjob that was not delivered.');
    await setStatus(conn, ctx, job, 'delivering', CLIENT, { reason });
    await exec(conn, `UPDATE jobs SET control = 'continue' WHERE id = ?`, [job.id]);
    if (job.parent_job_id) {
      const parent = await lockJob(conn, job.parent_job_id);
      if (parent.status === 'done') await setStatus(conn, ctx, parent, 'in_progress', CLIENT, { reason: `Subjob ${job.id} reopened` });
    }
    await emit(conn, ctx, { type: 'job.reopened', jobId: job.id, actor: CLIENT, targets: [job.staff_agent_id].filter(Boolean), payload: { reason } });
    return { job_id: job.id, status: 'delivering' };
  });
}

export async function handoverSummary(conn: Conn, jobId: string): Promise<string> {
  const job = await queryOne(conn, `SELECT * FROM jobs WHERE id = ?`, [jobId]);
  if (!job) throw notFound(`Job ${jobId}`);
  const children = await query(conn, `SELECT id, linear_identifier, title, status, required FROM jobs WHERE parent_job_id = ? ORDER BY created_at`, [jobId]);
  const ids = [jobId, ...children.map((c) => c.id as string)];
  const assignments = await query(
    conn,
    `SELECT a.*, t.last_progress FROM assignments a LEFT JOIN attempts t ON t.assignment_id = a.id AND t.number = a.current_attempt
     WHERE a.job_id IN (?) AND a.status <> 'closed'`,
    [ids],
  );
  const questions = await query(conn, `SELECT q.*, th.title FROM questions q JOIN threads th ON th.id = q.thread_id WHERE q.job_id IN (?) AND q.state <> 'resolved' AND q.state <> 'collected'`, [ids]);
  const decisions = await query(conn, `SELECT body, created_at FROM decisions WHERE job_id IN (?) ORDER BY created_at DESC LIMIT 5`, [ids]);
  const blockers = await query(conn, `SELECT kind, requested_decision FROM blockers WHERE job_id IN (?) AND resolved_at IS NULL`, [ids]);
  const lines = [
    `Job ${job.id} (${job.linear_identifier}: ${job.title}) is ${job.status}.`,
    `Plan: ${job.plan ?? 'none recorded'}`,
    `Subjobs: ${children.map((c) => `${c.linear_identifier} ${c.status}${c.required ? '' : ' (optional)'}`).join('; ') || 'none'}`,
    `Open assignments: ${assignments.map((a) => `${a.id} on ${a.job_id} ${a.status}${a.owner_agent_id ? ` by ${a.owner_agent_id}` : ''}, last progress: ${a.last_progress ?? 'none'}`).join('; ') || 'none'}`,
    `Open questions: ${questions.map((q) => `${q.thread_id} "${q.title}" ${q.state}`).join('; ') || 'none'}`,
    `Open blockers: ${blockers.map((b) => `${b.kind}: ${b.requested_decision}`).join('; ') || 'none'}`,
    `Recent decisions: ${decisions.map((d) => d.body).join(' | ') || 'none'}`,
  ];
  return lines.join('\n');
}

/** Only the Client moves a job to another Staff agent. */
export async function reassignStaff(ctx: Ctx, jobId: string, staffAgentId: string) {
  return tx(ctx, async (conn) => {
    const job = await lockJob(conn, jobId);
    if (job.parent_job_id) throw invalid('Reassign the parent job; its subjobs follow.');
    const previousStaff = job.staff_agent_id as string | null;
    const staff = await queryOne(conn, `SELECT * FROM agents WHERE id = ?`, [staffAgentId]);
    if (!staff || staff.role !== 'staff') throw invalid(`${staffAgentId} is not a registered Staff agent.`);
    await exec(conn, `UPDATE jobs SET staff_agent_id = ?, updated_at = ? WHERE id = ? OR parent_job_id = ?`, [staffAgentId, ctx.clock.now(), job.id, job.id]);
    await exec(conn, `UPDATE questions SET owner_staff_id = ? WHERE job_id IN (SELECT id FROM jobs WHERE id = ? OR parent_job_id = ?)`, [staffAgentId, job.id, job.id]);
    const now = ctx.clock.now();
    const owners = await query(conn, `SELECT id FROM blockers WHERE job_id = ? AND kind = 'unavailable_owner' AND resolved_at IS NULL`, [job.id]);
    for (const b of owners) {
      await exec(conn, `UPDATE blockers SET resolved_at = ?, resolved_by = ?, resolution = ? WHERE id = ?`, [now, CLIENT, `Reassigned to ${staffAgentId}`, b.id]);
    }
    const stillOpen = await queryOne(conn, `SELECT COUNT(*) AS n FROM blockers WHERE job_id = ? AND resolved_at IS NULL`, [job.id]);
    if (owners.length && Number(stillOpen?.n) === 0 && job.status === 'blocked') {
      await setStatus(conn, ctx, job, job.previous_status ?? 'planning', CLIENT);
      await exec(conn, `UPDATE jobs SET previous_status = NULL WHERE id = ?`, [job.id]);
    }
    job.staff_agent_id = staffAgentId;
    const summary = await handoverSummary(conn, job.id);
    await emit(conn, ctx, {
      type: 'job.handover',
      jobId: job.id,
      actor: CLIENT,
      targets: [staffAgentId],
      payload: { previous_staff: previousStaff, summary },
    });
    return { job_id: job.id, staff_agent_id: staffAgentId, handover_summary: summary };
  });
}

export async function listJobs(ctx: Ctx) {
  const rows = await query(
    ctx.pool,
    `SELECT j.id, j.parent_job_id, j.linear_identifier, j.linear_url, j.source, j.title, j.status, j.control, j.required, j.staff_agent_id,
       j.linear_state, j.linear_diverged, j.updated_at,
       (SELECT COUNT(*) FROM blockers b WHERE b.job_id = j.id AND b.resolved_at IS NULL) AS open_blockers,
       (SELECT b.kind FROM blockers b WHERE b.job_id = j.id AND b.resolved_at IS NULL ORDER BY b.created_at LIMIT 1) AS blocked_reason,
       (SELECT MAX(e.created_at) FROM events e WHERE e.job_id = j.id) AS last_activity
     FROM jobs j ORDER BY COALESCE(j.parent_job_id, j.id), j.parent_job_id IS NOT NULL, j.created_at`,
  );
  return rows.map((r) => ({ ...r, next_action: nextAction(r) }));
}

export function nextAction(j: Row): string {
  if (j.control === 'pause') return 'Paused by the Client';
  switch (j.status as JobStatus) {
    case 'refining':
      return 'Client answers Staff and approves the goal and criteria';
    case 'queued':
    case 'planning':
      return 'Staff plans and writes acceptance criteria';
    case 'ready':
      return 'Staff starts a Senior';
    case 'in_progress':
      return 'Senior implements and submits for review';
    case 'in_review':
      return 'Reviewer gives a verdict';
    case 'delivering':
      return 'Senior runs the Copilot loop and gets CI green; Staff confirms';
    case 'blocked':
      return j.blocked_reason === 'client_decision' || j.blocked_reason === 'no_convergence' ? 'Client decision needed' : `Blocked: ${j.blocked_reason ?? 'see blockers'}`;
    default:
      return 'None';
  }
}

export async function getJob(conn: Conn, jobId: string) {
  const job = await queryOne(conn, `SELECT * FROM jobs WHERE id = ?`, [jobId]);
  if (!job) throw notFound(`Job ${jobId}`);
  const children = await query(conn, `SELECT id, linear_identifier, title, status, required, control FROM jobs WHERE parent_job_id = ? ORDER BY created_at`, [jobId]);
  const deps = await query(conn, `SELECT d.depends_on_job_id AS job_id, j.linear_identifier, j.status FROM job_dependencies d JOIN jobs j ON j.id = d.depends_on_job_id WHERE d.job_id = ?`, [jobId]);
  const assignments = await query(
    conn,
    `SELECT a.id, a.kind, a.status, a.owner_agent_id, a.current_attempt, a.lease_expires_at, a.worktree_path, t.last_progress
     FROM assignments a LEFT JOIN attempts t ON t.assignment_id = a.id AND t.number = a.current_attempt WHERE a.job_id = ? ORDER BY a.created_at`,
    [jobId],
  );
  const threads = await query(
    conn,
    `SELECT t.id, t.kind, t.title, t.created_at, q.state AS question_state, q.deadline_at,
       (SELECT COUNT(*) FROM messages m WHERE m.thread_id = t.id) AS message_count
     FROM threads t LEFT JOIN questions q ON q.thread_id = t.id WHERE t.job_id = ? ORDER BY t.created_at`,
    [jobId],
  );
  const blockers = await query(conn, `SELECT * FROM blockers WHERE job_id = ? ORDER BY created_at`, [jobId]);
  const packages = await query(conn, `SELECT * FROM review_packages WHERE job_id = ? ORDER BY round`, [jobId]);
  const verdicts = packages.length
    ? await query(conn, `SELECT * FROM review_verdicts WHERE package_id IN (?)`, [packages.map((p) => p.id)])
    : [];
  return {
    job: { ...job, linear_snapshot: parseJson(job.linear_snapshot), next_action: nextAction(job) } as Row,
    subjobs: children,
    depends_on: deps,
    assignments,
    threads,
    blockers,
    deliveries: await query(conn, `SELECT * FROM deliveries WHERE job_id = ? ORDER BY reported_at`, [jobId]),
    reviews: packages.map((p) => ({
      ...p,
      artifacts: parseJson(p.artifacts),
      finding_dispositions: parseJson(p.finding_dispositions),
      verdict: (() => {
        const v = verdicts.find((x) => x.package_id === p.id);
        return v ? { ...v, findings: parseJson(v.findings) } : null;
      })(),
    })),
  };
}

/** Refreshes Linear snapshots of open jobs and flags divergence. Never changes job state. */
export async function refreshFromLinear(ctx: Ctx): Promise<void> {
  if (!ctx.linear) return;
  const cutoff = addSeconds(ctx.clock.now(), -POLICY.linearRefreshSec);
  const parents = await query(ctx.pool, `SELECT * FROM jobs WHERE parent_job_id IS NULL AND source = 'linear' AND status NOT IN ('done','cancelled') AND linear_fetched_at < ?`, [cutoff]);
  for (const parent of parents) {
    let tree: LinearTree;
    try {
      tree = await ctx.linear.fetchTree(parent.linear_issue_id);
    } catch {
      // Back off for one refresh interval instead of retrying every tick.
      await exec(ctx.pool, `UPDATE jobs SET linear_fetched_at = ? WHERE id = ?`, [ctx.clock.now(), parent.id]);
      continue;
    }
    await tx(ctx, async (conn) => {
      const now = ctx.clock.now();
      const known = await query(conn, `SELECT * FROM jobs WHERE id = ? OR parent_job_id = ?`, [parent.id, parent.id]);
      const issues = [tree, ...tree.children];
      for (const issue of issues) {
        const job = known.find((j) => j.linear_issue_id === issue.id);
        if (!job) {
          const seen = await queryOne(conn, `SELECT id FROM events WHERE type = 'linear.new_subissue' AND job_id = ? AND JSON_UNQUOTE(JSON_EXTRACT(payload, '$.identifier')) = ? LIMIT 1`, [parent.id, issue.identifier]);
          if (seen) continue;
          await emit(conn, ctx, { type: 'linear.new_subissue', jobId: parent.id, actor: 'linear', targets: [parent.staff_agent_id], payload: { identifier: issue.identifier, title: issue.title } });
          continue;
        }
        const linearClosed = /^(done|completed|canceled|cancelled|duplicate)$/i.test(issue.state ?? '');
        const diverged = linearClosed && !CLOSED.includes(job.status);
        const changed = (issue.updatedAt ?? null) !== (job.linear_updated_at ? (job.linear_updated_at as Date).toISOString() : null);
        const { children: _children, ...snapshot } = issue as LinearTree;
        await exec(conn, `UPDATE jobs SET linear_snapshot = ?, linear_state = ?, linear_updated_at = ?, linear_fetched_at = ?, title = ?, linear_diverged = ? WHERE id = ?`, [
          json(snapshot),
          issue.state ?? null,
          issue.updatedAt ? new Date(issue.updatedAt) : null,
          now,
          issue.title,
          diverged,
          job.id,
        ]);
        if (diverged && !job.linear_diverged) {
          await emit(conn, ctx, { type: 'linear.diverged', jobId: job.id, actor: 'linear', targets: [job.staff_agent_id], payload: { linear_state: issue.state, job_status: job.status } });
        } else if (changed) {
          await emit(conn, ctx, { type: 'linear.changed', jobId: job.id, actor: 'linear', payload: { identifier: issue.identifier } });
        }
      }
    });
  }
}
