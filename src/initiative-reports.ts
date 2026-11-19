/**
 * Research linked to an initiative (phase 5 of the initiative room, docs/plans/initiative-room.md, criteria 1 to 3). A
 * research job's report versions are readable by the initiative's Architect, and can be cited, only while the report is
 * linked to that initiative. The Client links and unlinks from the room's Research tab.
 *
 * Report text is research output, so it is data: the Architect reads it as a quoted slice, and a citation of it is checked
 * here against the stored body, never against the model's words.
 */
import { tx, type Ctx } from './context.ts';
import { exec, query, queryOne, type Conn } from './db.ts';
import { initiativeByKey } from './initiatives.ts';
import { conflict, invalid, notFound } from './lib.ts';

/** The characters of one version the Architect reads in one call. A longer report is read in slices, by the next offset. */
export const REPORT_SLICE_CHARS = 30_000;

/** A quote shorter than this, after whitespace is collapsed, matches too many places to prove a citation (as for code quotes). */
export const REPORT_QUOTE_MIN = 8;
const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

/** A report link, and the research job it names. The job must be research, on one of the initiative's repositories. */
export async function linkReport(ctx: Ctx, key: string, jobId: string) {
  return tx(ctx, async (conn) => {
    const i = await initiativeByKey(conn, key);
    if (i.status !== 'active') throw conflict(`Initiative ${i.key} is ${i.status}.`);
    const job = await queryOne(conn, 'SELECT id, kind, repo_path FROM jobs WHERE id = ? FOR UPDATE', [jobId]);
    if (!job) throw notFound(`Job ${jobId}`);
    if (job.kind !== 'research') throw invalid(`Job ${jobId} is not a research job.`);
    if (!i.repos.some((r) => r.path === job.repo_path)) throw invalid(`Job ${jobId} is not on a repository of initiative ${i.key}.`);
    const linked = await queryOne(conn, 'SELECT initiative_id FROM initiative_reports WHERE job_id = ?', [jobId]);
    if (linked) throw conflict(linked.initiative_id === i.id ? `Job ${jobId} is already linked to ${i.key}.` : `Job ${jobId} is linked to another initiative.`);
    await exec(conn, 'INSERT INTO initiative_reports (job_id, initiative_id, linked_at) VALUES (?, ?, ?)', [jobId, i.id, ctx.clock.now()]);
    return { job_id: jobId, initiative: i.key };
  });
}

/** Unlinks a report. A citation already stored keeps its job and version; read_report refuses the job from now on. */
export async function unlinkReport(ctx: Ctx, key: string, jobId: string) {
  return tx(ctx, async (conn) => {
    const i = await initiativeByKey(conn, key);
    const res = await exec(conn, 'DELETE FROM initiative_reports WHERE job_id = ? AND initiative_id = ?', [jobId, i.id]);
    if (res.affectedRows !== 1) throw notFound(`Report ${jobId} is not linked to ${i.key}.`);
    return { job_id: jobId, initiative: i.key };
  });
}

/** The Research tab: the linked reports with their versions (no text), and the research jobs that could be linked. */
export async function reportsOfInitiative(ctx: Ctx, key: string) {
  const i = await initiativeByKey(ctx.pool, key);
  const linked = await query(
    ctx.pool,
    `SELECT j.id AS job_id, j.title, j.status, j.repo_path, ir.linked_at,
            (SELECT JSON_ARRAYAGG(JSON_OBJECT('version', v.version, 'summary', v.summary, 'created_at', v.created_at)) FROM job_reports v WHERE v.job_id = j.id) AS versions
       FROM initiative_reports ir JOIN jobs j ON j.id = ir.job_id WHERE ir.initiative_id = ? ORDER BY ir.linked_at`,
    [i.id],
  );
  const paths = i.repos.map((r) => r.path);
  const candidates = paths.length
    ? await query(
        ctx.pool,
        `SELECT j.id AS job_id, j.title, j.status, j.repo_path, j.created_at FROM jobs j
          WHERE j.kind = 'research' AND j.repo_path IN (${paths.map(() => '?').join(', ')})
            AND NOT EXISTS (SELECT 1 FROM initiative_reports ir WHERE ir.job_id = j.id)
          ORDER BY j.created_at DESC LIMIT 100`,
        paths,
      )
    : [];
  const parse = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v) ?? [];
  return {
    key: i.key,
    linked: linked.map((r) => ({
      job_id: String(r.job_id),
      title: r.title == null ? null : String(r.title),
      status: String(r.status),
      repo_path: String(r.repo_path),
      linked_at: r.linked_at as Date,
      versions: (parse(r.versions) as { version: number; summary: string; created_at: string }[]).sort((a, b) => b.version - a.version),
    })),
    candidates,
  };
}

/**
 * One version of a report, read for the Architect of `initiativeId`. Every refusal (the job is missing, is not research, is
 * not linked to this initiative, or the version does not exist) gives the same null, so no caller learns which one it was.
 */
export async function linkedReportVersion(conn: Conn, initiativeId: string, jobId: string, version: number) {
  return (await queryOne(
    conn,
    `SELECT v.job_id, v.version, v.summary, v.body, v.created_at, j.title
       FROM initiative_reports ir
       JOIN jobs j ON j.id = ir.job_id AND j.kind = 'research'
       JOIN job_reports v ON v.job_id = ir.job_id AND v.version = ?
      WHERE ir.initiative_id = ? AND ir.job_id = ?`,
    [version, initiativeId, jobId],
  )) ?? null;
}

/** The Architect's read: one slice of one version, as text that is data, with the offset of the next slice (null at the end). */
export async function readReportSlice(conn: Conn, initiativeId: string, a: { job_id: string; version: number; offset: number }) {
  const v = await linkedReportVersion(conn, initiativeId, a.job_id, a.version);
  if (!v) throw notFound('No linked research report has that version.');
  const body = String(v.body);
  const offset = Math.min(Math.max(0, Math.floor(a.offset)), body.length);
  const text = body.slice(offset, offset + REPORT_SLICE_CHARS);
  const end = offset + text.length;
  // A closing tag inside the report cannot end the quote early (the same defence as the wake's PR bodies).
  const defused = text.replace(/<\/report_text/gi, '&lt;/report_text');
  return {
    job_id: a.job_id,
    version: a.version,
    title: v.title,
    summary: v.summary,
    total_chars: body.length,
    offset,
    next_offset: end < body.length ? end : null,
    quoted: `<report_text>\n${defused}\n</report_text>`,
  };
}

/** Whether a quote is in a linked version's body, for a citation. Throws the same refusal as read_report for any missing piece. */
export async function assertReportQuote(conn: Conn, initiativeId: string, c: { job_id: string; version: number; quote: string }) {
  const v = await linkedReportVersion(conn, initiativeId, c.job_id, c.version);
  if (!v) throw invalid('That report version is not linked to your initiative, or does not exist.');
  if (squash(c.quote).length < REPORT_QUOTE_MIN) throw invalid(`A quote needs at least ${REPORT_QUOTE_MIN} characters after spaces are collapsed.`);
  if (!squash(String(v.body)).includes(squash(c.quote))) throw invalid(`The quote is not in report ${c.job_id} version ${c.version}.`);
  return v;
}

/** The sources of a revision: each named version must be linked to the initiative, checked in the caller's transaction. */
export async function checkedReportSources(conn: Conn, initiativeId: string, sources: { job_id: string; version: number }[]) {
  const out: { job_id: string; version: number; title: string }[] = [];
  for (const s of sources) {
    const v = await linkedReportVersion(conn, initiativeId, s.job_id, s.version);
    if (!v) throw invalid(`Report ${s.job_id} version ${s.version} is not linked to this initiative, or does not exist.`);
    out.push({ job_id: s.job_id, version: s.version, title: String(v.title) });
  }
  return out;
}

