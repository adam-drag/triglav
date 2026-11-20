/**
 * Splits: Staff proposes to split a top-level job into subjobs, one per repository, each with its own repository and
 * base branch. Nothing is created until the Client approves; then the subjobs exist and Staff plans each like any
 * other. A job started from a research report needs an approved split before a Senior starts (createSpawnTicket).
 */
import { z } from 'zod';
import type { Agent } from './agents.ts';
import { tx, type Ctx } from './context.ts';
import { exec, json, parseJson, query, queryOne, type Conn, type Row } from './db.ts';
import { emit } from './events.ts';
import { assertNoSecrets, conflict, invalid, newId, notFound } from './lib.ts';
import { systemMessage } from './board.ts';
import { checkBranch, checkRepoPath, MAX_BRANCH, MAX_PATH } from './job-requests.ts';
import { CLIENT, CLOSED, insertJob, lockJob, recordJobDecision, requireStaffOf, type JobSource } from './jobs.ts';

export const MAX_SUBJOBS = 8;
export const MAX_SCOPE_CHARS = 4000;
export const MAX_SPLIT_NOTE_CHARS = 4000;
const KEY = z.string().regex(/^[a-z0-9][a-z0-9-]{0,29}$/, 'key: lowercase letters, digits and hyphens, at most 30');

export const subjobSchema = z.object({
  key: KEY,
  title: z.string().trim().min(1).max(200),
  repo_path: z.string().max(MAX_PATH),
  base_branch: z.string().max(MAX_BRANCH).optional(),
  scope: z.string().trim().min(1).max(MAX_SCOPE_CHARS),
  depends_on: z.array(KEY).max(MAX_SUBJOBS).default([]),
});
export type ProposedSubjob = z.infer<typeof subjobSchema>;

/** Checks the list and fills each base branch. A subjob depends only on subjobs listed before it, so the order is the build order and there is no cycle. */
export function checkSubjobs(raw: unknown, defaultBranch: string): ProposedSubjob[] {
  const list = z.array(subjobSchema).min(1).max(MAX_SUBJOBS).parse(raw);
  const seen = new Set<string>();
  return list.map((s) => {
    if (seen.has(s.key)) throw invalid(`Two subjobs have the key ${s.key}.`);
    for (const dep of s.depends_on) if (!seen.has(dep)) throw invalid(`Subjob ${s.key} depends on ${dep}, which is not listed before it.`);
    seen.add(s.key);
    assertNoSecrets(s.title, s.scope);
    return { ...s, repo_path: checkRepoPath(s.repo_path), base_branch: checkBranch(s.base_branch ?? defaultBranch) };
  });
}

async function latestSplit(conn: Conn, jobId: string) {
  return queryOne(conn, `SELECT * FROM job_splits WHERE job_id = ? ORDER BY version DESC LIMIT 1 FOR UPDATE`, [jobId]);
}

/** Every proposed split of a job, newest first. */
export async function splitsOf(conn: Conn, jobId: string) {
  const rows = await query(conn, `SELECT version, subjobs, status, note, proposed_by, created_at, decided_at FROM job_splits WHERE job_id = ? ORDER BY version DESC`, [jobId]);
  return rows.map((r) => ({ ...r, subjobs: parseJson(r.subjobs) }) as Row);
}

/** Staff of a top-level job in planning that has no subjobs yet: the split for the Client to approve. */
export async function proposeSplit(ctx: Ctx, agent: Agent, input: { jobId: string; subjobs: unknown }) {
  return tx(ctx, async (conn) => {
    const job = await lockJob(conn, input.jobId);
    requireStaffOf(agent, job);
    if (job.parent_job_id) throw invalid('Propose the split on the top-level job.');
    if (job.kind === 'research') throw conflict(`Job ${job.id} is a research job. It has no subjobs.`);
    if (job.status !== 'planning') throw conflict(`Propose the split while job ${job.id} is planning (it is ${job.status}).`);
    const children = await queryOne(conn, `SELECT COUNT(*) AS n FROM jobs WHERE parent_job_id = ?`, [job.id]);
    if (Number(children?.n) > 0) throw conflict(`Job ${job.id} already has subjobs.`);
    const subjobs = checkSubjobs(input.subjobs, job.base_branch as string);
    const last = await latestSplit(conn, job.id);
    if (last?.status === 'pending') throw conflict(`Version ${last.version} of the split waits for the Client. Wait for split.approved or split.returned.`);
    const version = Number(last?.version ?? 0) + 1;
    const now = ctx.clock.now();
    await exec(conn, `INSERT INTO job_splits (id, job_id, version, subjobs, status, proposed_by, created_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)`, [
      newId('spl'), job.id, version, json(subjobs), agent.id, now,
    ]);
    await systemMessage(conn, ctx, job.id, agent.id, 'progress', `Proposed a split into ${subjobs.length} subjob${subjobs.length === 1 ? '' : 's'} (version ${version}) for the Client to approve.`);
    await emit(conn, ctx, { type: 'split.proposed', jobId: job.id, actor: agent.id, payload: { version, subjobs: subjobs.length } });
    return { job_id: job.id, version, status: 'pending', next: 'Wait for split.approved (the subjobs exist then; plan each) or split.returned (read the note with get_job and propose again).' };
  });
}

/** The Client approves a pending split: the subjobs are created in planning, with their dependencies, owned by the job's Staff. */
export async function approveSplit(ctx: Ctx, jobId: string, version: number) {
  return tx(ctx, async (conn) => {
    const job = await lockJob(conn, jobId);
    if (CLOSED.includes(job.status)) throw conflict(`Job ${job.id} is ${job.status}.`);
    const split = await lockPending(conn, jobId, version);
    const children = await queryOne(conn, `SELECT COUNT(*) AS n FROM jobs WHERE parent_job_id = ?`, [job.id]);
    if (Number(children?.n) > 0) throw conflict(`Job ${job.id} already has subjobs.`);
    const subjobs = parseJson<ProposedSubjob[]>(split.subjobs);
    const ids = new Map<string, string>();
    for (const [i, s] of subjobs.entries()) {
      const id = await insertJob(
        conn,
        ctx,
        { id: s.key, identifier: `${job.linear_identifier}-${i + 1}`.slice(0, 40), title: s.title, description: s.scope, url: '', state: null, updatedAt: null },
        { parentJobId: job.id, repoPath: s.repo_path, baseBranch: s.base_branch as string, staffId: job.staff_agent_id as string, source: job.source as JobSource, status: 'planning', issueKey: `split:${job.id}:${s.key}` },
      );
      ids.set(s.key, id);
      for (const dep of s.depends_on) await exec(conn, `INSERT INTO job_dependencies (job_id, depends_on_job_id) VALUES (?, ?)`, [id, ids.get(dep)]);
    }
    await exec(conn, `UPDATE job_splits SET status = 'approved', decided_at = ? WHERE id = ?`, [ctx.clock.now(), split.id]);
    const list = subjobs.map((s) => `${s.title} (${s.repo_path}, ${s.base_branch})`).join('; ');
    await recordJobDecision(conn, ctx, job.id, CLIENT, `The Client approved the split into ${subjobs.length} subjob${subjobs.length === 1 ? '' : 's'}: ${list}.`, null);
    await emit(conn, ctx, {
      type: 'split.approved',
      jobId: job.id,
      actor: CLIENT,
      targets: job.staff_agent_id ? [job.staff_agent_id] : [],
      payload: { version, subjobs: subjobs.map((s) => ({ key: s.key, job_id: ids.get(s.key) })) },
    });
    return { job_id: job.id, version, subjob_ids: [...ids.values()] };
  });
}

/** The Client sends a pending split back with a note; Staff proposes again. */
export async function returnSplit(ctx: Ctx, jobId: string, version: number, note: string) {
  const text = note.trim();
  if (!text) throw invalid('Say what to change in the split.');
  if (text.length > MAX_SPLIT_NOTE_CHARS) throw invalid(`The note is longer than ${MAX_SPLIT_NOTE_CHARS} characters.`);
  assertNoSecrets(text);
  return tx(ctx, async (conn) => {
    const job = await lockJob(conn, jobId);
    if (CLOSED.includes(job.status)) throw conflict(`Job ${job.id} is ${job.status}.`);
    const split = await lockPending(conn, jobId, version);
    await exec(conn, `UPDATE job_splits SET status = 'returned', note = ?, decided_at = ? WHERE id = ?`, [text, ctx.clock.now(), split.id]);
    await emit(conn, ctx, { type: 'split.returned', jobId: job.id, actor: CLIENT, targets: job.staff_agent_id ? [job.staff_agent_id] : [], payload: { version, note: text } });
    return { job_id: job.id, version, status: 'returned' };
  });
}

async function lockPending(conn: Conn, jobId: string, version: number) {
  const split = await queryOne(conn, `SELECT * FROM job_splits WHERE job_id = ? AND version = ? FOR UPDATE`, [jobId, version]);
  if (!split) throw notFound(`Version ${version} of the split of job ${jobId}`);
  if (split.status !== 'pending') throw conflict(`Version ${version} of the split is already ${split.status}.`);
  return split;
}
