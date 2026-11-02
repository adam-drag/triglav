/**
 * The report of a research job. Its Staff (read-only, src/claude-args.ts) researches with the researchers on the board and
 * submits the report as a numbered version. The Client reads it on the job page and asks for more (the job goes back to
 * drafting and Staff wakes), asks to publish it (Staff writes it as a page in its reports folder, publishes it as a
 * private claude.ai artifact and records the link), or marks the job done.
 */
import { tx, type Ctx } from './context.ts';
import { exec, query, queryOne, type Conn, type Row } from './db.ts';
import { systemMessage } from './board.ts';
import { emit } from './events.ts';
import { CLIENT, lockJob, requireStaffOf, setStatus } from './jobs.ts';
import { assertNoSecrets, conflict, invalid, newId, notFound } from './lib.ts';
import type { Agent } from './agents.ts';

export const MAX_REPORT_CHARS = 200_000;
export const MAX_SUMMARY_CHARS = 600;
export const MAX_FEEDBACK_CHARS = 20_000;
/** A claude.ai artifact link as the Artifact tool returns it. Nothing else is stored, so the job page links only there. */
export const ARTIFACT_URL = /^https:\/\/claude\.ai\/artifact\/[A-Za-z0-9_-]{8,64}$/;

function requireResearch(job: Row) {
  if (job.kind !== 'research') throw conflict(`Job ${job.id} is not a research job.`);
}

async function lockReport(conn: Conn, jobId: string, version: number) {
  const r = await queryOne(conn, `SELECT * FROM job_reports WHERE job_id = ? AND version = ? FOR UPDATE`, [jobId, version]);
  if (!r) throw notFound(`Version ${version} of the report of job ${jobId}`);
  return r;
}

/** Staff: the next version of the report. Only while drafting, so the Client always reads the newest version before Staff writes another. */
export async function submitReport(ctx: Ctx, agent: Agent, input: { jobId: string; summary: string; body: string }) {
  const summary = input.summary?.trim() ?? '';
  const body = input.body?.trim() ?? '';
  if (!summary || summary.length > MAX_SUMMARY_CHARS) throw invalid(`summary must be 1 to ${MAX_SUMMARY_CHARS} characters: what the report answers, in a few sentences.`);
  if (!body || body.length > MAX_REPORT_CHARS) throw invalid(`body must be 1 to ${MAX_REPORT_CHARS} characters of markdown.`);
  assertNoSecrets(summary, body);
  return tx(ctx, async (conn) => {
    const job = await lockJob(conn, input.jobId);
    requireStaffOf(agent, job);
    requireResearch(job);
    if (job.control !== 'continue') throw conflict(`Job ${job.id} is ${job.control === 'pause' ? 'paused' : 'cancelled'}.`);
    if (job.status !== 'drafting') throw conflict(`Job ${job.id} is ${job.status}. Submit a report while drafting: after the Client approved the questions or asked for more.`);
    const last = await queryOne(conn, `SELECT MAX(version) AS v FROM job_reports WHERE job_id = ?`, [job.id]);
    const version = Number(last?.v ?? 0) + 1;
    const now = ctx.clock.now();
    await exec(conn, `INSERT INTO job_reports (id, job_id, version, summary, body, author_agent_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, [
      newId('rpt'), job.id, version, summary, body, agent.id, now,
    ]);
    await systemMessage(conn, ctx, job.id, agent.id, 'progress', `Report version ${version} is ready for the Client: ${summary}`);
    await setStatus(conn, ctx, job, 'report_ready', agent.id, { version });
    await emit(conn, ctx, { type: 'report.submitted', jobId: job.id, actor: agent.id, payload: { version } });
    return { job_id: job.id, version, status: 'report_ready', next: 'Wait for the Client: report.feedback means write the next version, report.publish_requested means publish that version.' };
  });
}

/** The Client asks for more. The job goes back to drafting, the request goes on the General thread, and Staff wakes. */
export async function reportFeedback(ctx: Ctx, jobId: string, raw: string) {
  const message = raw?.trim() ?? '';
  if (!message) throw invalid('Write what the next version should add or change.');
  if (message.length > MAX_FEEDBACK_CHARS) throw invalid(`The message is longer than ${MAX_FEEDBACK_CHARS} characters.`);
  assertNoSecrets(message);
  return tx(ctx, async (conn) => {
    const job = await lockJob(conn, jobId);
    requireResearch(job);
    if (job.status !== 'report_ready') throw conflict(`Job ${job.id} is ${job.status}. You can ask for more once Staff has submitted a report.`);
    const version = Number((await queryOne(conn, `SELECT MAX(version) AS v FROM job_reports WHERE job_id = ?`, [job.id]))?.v ?? 0);
    const threadId = await systemMessage(conn, ctx, job.id, CLIENT, 'discussion', `On report version ${version}: ${message}`);
    await setStatus(conn, ctx, job, 'drafting', CLIENT, { feedback_on: version });
    await emit(conn, ctx, { type: 'report.feedback', jobId: job.id, threadId, actor: CLIENT, targets: [job.staff_agent_id].filter(Boolean), payload: { version, excerpt: message.slice(0, 200) } });
    return { job_id: job.id, status: 'drafting' };
  });
}

/** The Client asks Staff to publish a version as a private claude.ai artifact. Staff publishes only after this. */
export async function requestPublish(ctx: Ctx, jobId: string, version: number) {
  return tx(ctx, async (conn) => {
    const job = await lockJob(conn, jobId);
    requireResearch(job);
    if (job.status !== 'report_ready') throw conflict(`Job ${job.id} is ${job.status}. A report is published while it waits for you.`);
    const report = await lockReport(conn, job.id, version);
    if (report.artifact_url) throw conflict(`Version ${version} is already published at ${report.artifact_url}.`);
    if (report.publish_requested_at) return { job_id: job.id, version, already_requested: true };
    await exec(conn, `UPDATE job_reports SET publish_requested_at = ? WHERE id = ?`, [ctx.clock.now(), report.id]);
    const threadId = await systemMessage(conn, ctx, job.id, CLIENT, 'discussion', `Publish report version ${version} as an artifact.`);
    await emit(conn, ctx, { type: 'report.publish_requested', jobId: job.id, threadId, actor: CLIENT, targets: [job.staff_agent_id].filter(Boolean), payload: { version } });
    return { job_id: job.id, version, already_requested: false };
  });
}

/** Staff: the link the Artifact tool returned for a version the Client asked to publish. */
export async function recordArtifact(ctx: Ctx, agent: Agent, input: { jobId: string; version: number; url: string }) {
  const url = input.url?.trim() ?? '';
  if (!ARTIFACT_URL.test(url)) throw invalid('url must be the claude.ai artifact link the Artifact tool returned, like https://claude.ai/artifact/<id>.');
  return tx(ctx, async (conn) => {
    const job = await lockJob(conn, input.jobId);
    requireStaffOf(agent, job);
    requireResearch(job);
    const report = await lockReport(conn, job.id, input.version);
    if (!report.publish_requested_at) throw conflict(`The Client has not asked to publish version ${input.version}. Publish a report only after report.publish_requested.`);
    if (report.artifact_url && report.artifact_url !== url) throw conflict(`Version ${input.version} is already recorded at ${report.artifact_url}.`);
    const now = ctx.clock.now();
    await exec(conn, `UPDATE job_reports SET artifact_url = ?, published_at = ? WHERE id = ?`, [url, now, report.id]);
    await systemMessage(conn, ctx, job.id, agent.id, 'progress', `Published report version ${input.version} as a private artifact: ${url}`);
    await emit(conn, ctx, { type: 'report.published', jobId: job.id, actor: agent.id, payload: { version: input.version, url } });
    return { job_id: job.id, version: input.version, url };
  });
}

/** Every version of a job's report, newest first. `withBody` false leaves the text out (get_job). */
export async function listReports(conn: Conn, jobId: string, withBody = true) {
  const cols = `version, summary, created_at, publish_requested_at, artifact_url, published_at${withBody ? ', body' : ''}`;
  return query(conn, `SELECT ${cols} FROM job_reports WHERE job_id = ? ORDER BY version DESC`, [jobId]);
}

/** Staff: one version in full, or the newest. */
export async function getReport(ctx: Ctx, agent: Agent, jobId: string, version?: number) {
  const job = await queryOne(ctx.pool, `SELECT id, kind, staff_agent_id FROM jobs WHERE id = ?`, [jobId]);
  if (!job) throw notFound(`Job ${jobId}`);
  requireStaffOf(agent, job);
  requireResearch(job);
  const row = version
    ? await queryOne(ctx.pool, `SELECT version, summary, body, created_at, artifact_url FROM job_reports WHERE job_id = ? AND version = ?`, [jobId, version])
    : await queryOne(ctx.pool, `SELECT version, summary, body, created_at, artifact_url FROM job_reports WHERE job_id = ? ORDER BY version DESC LIMIT 1`, [jobId]);
  if (!row) throw notFound(version ? `Version ${version} of the report of job ${jobId}` : `A report of job ${jobId}`);
  return row;
}
