import type { Agent } from './agents.ts';
import type { Ctx } from './context.ts';
import { query, queryOne, type Conn } from './db.ts';
import { reviewView } from './code-review.ts';
import { gateAt } from './review-gate.ts';
import { assertNoSecrets, conflict, forbidden, invalid, notFound } from './lib.ts';

/*
 * The Triglav local-review summary comment of a pull request.
 *
 * A Senior posts it once with `gh pr comment` and edits that one comment later (the guide's "Triglav review comment" step).
 * The body is built here, from the database, never from what a model wrote for the purpose. Everything that a reviewer model,
 * a Senior or a failing process wrote (titles, reasons, failure text, sites, model names) is untrusted: it only ever appears
 * inside a code span whose fence is longer than any backtick run in it, with newlines and control characters collapsed, so
 * a mention, a link, HTML or markdown in it cannot render on GitHub. The finding bodies are not in the comment at all.
 * The text has no link outside GitHub: no localhost, no dashboard address.
 *
 * The server cannot run gh, so posting is the Senior's job: the comment is a bar, not a boundary. See src/guide/deliver.md.
 */

/** GitHub refuses a comment over 65536 characters; the body stays well under that. */
export const MAX_COMMENT_CHARS = 60_000;
/** Longest text of one untrusted value in a code span. */
const SPAN_MAX = 300;
const SITES_SHOWN = 5;

type View = Awaited<ReturnType<typeof reviewView>>;
type Finding = View['findings'][number];

export const reviewCommentMarker = (jobId: string) => `<!-- triglav-local-review job=${jobId} -->`;

/** An untrusted value as one inline code span: control and format characters and newlines collapsed, cut at `max`. */
export function codeSpan(value: unknown, max = SPAN_MAX): string {
  let s = String(value ?? '')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(s);
  if (chars.length > max) s = `${chars.slice(0, max - 1).join('')}…`;
  if (!s) return '`-`';
  let longest = 0;
  for (const m of s.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  const fence = '`'.repeat(longest + 1);
  // A text that starts or ends with a backtick needs a space on both sides; CommonMark strips one space from each side.
  const pad = s.startsWith('`') || s.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${s}${pad}${fence}`;
}

const short = (sha: string) => codeSpan(sha.slice(0, 12));
const range = (v: View) => `${short(v.base_sha)}..${short(v.head_sha)}`;
const countOf = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const SEVERITIES = ['P0', 'P1', 'P2', 'P3'];

function seatLine(s: View['seats'][number]): string {
  const t = s.tokens;
  const parts = [
    s.status,
    s.secs === null ? 'time n/a' : `${s.secs} s`,
    t.in === null && t.cached === null && t.out === null ? 'tokens n/a' : `tokens in ${t.in ?? 'n/a'}, cached ${t.cached ?? 'n/a'}, out ${t.out ?? 'n/a'}`,
    t.cost_usd === null ? 'cost n/a' : `cost $${t.cost_usd.toFixed(4)}`,
  ];
  const error = s.status !== 'done' && s.error ? `, error ${codeSpan(s.error, 200)}` : '';
  return `- ${codeSpan(s.seat)} (${codeSpan(s.runtime)} ${codeSpan(s.model)} ${codeSpan(s.effort)}): ${parts.join(', ')}${error}`;
}

function findingLine(f: Finding): string {
  const sites = f.sites.slice(0, SITES_SHOWN).map((x) => codeSpan(`${x.file}:${x.line}`));
  const more = f.sites.length > SITES_SHOWN ? ` and ${f.sites.length - SITES_SHOWN} more` : '';
  const triage = f.triage ? `${codeSpan(f.triage)}${f.triage_reason ? ` ${codeSpan(f.triage_reason)}` : ''}` : 'none';
  return `- ${codeSpan(f.severity)} ${codeSpan(f.title)} (${countOf(f.reviewer_count, 'seat')}) at ${sites.join(', ') || '`-`'}${more}. Triage: ${triage}`;
}

function counts(findings: Finding[]): string {
  return SEVERITIES.map((p) => `${p} ${findings.filter((f) => f.severity === p).length}`).join(', ');
}

function outcome(v: View): string {
  return v.status === 'failed' ? 'failed' : `verdict ${codeSpan(v.verdict)}`;
}

/** One round in full, or as a single line. `findingCap` limits the findings listed in a full round. */
function renderRound(v: View, full: boolean, findingCap: number): string {
  const head = `Round ${v.round} (${range(v)}): ${outcome(v)}`;
  if (!full) return `- ${head}, ${countOf(v.seats.length, 'seat')}, findings: ${counts(v.findings)}`;
  const lines = [`### ${head}`];
  if (v.status === 'failed') lines.push('', `Reason: ${codeSpan(v.failure)}`);
  lines.push('', 'Seats:', ...v.seats.map(seatLine));
  if (!v.findings.length) lines.push('', 'No findings.');
  else {
    const listed = v.findings.slice(0, findingCap);
    lines.push('', `Findings (${v.findings.length}, ${counts(v.findings)}):`, ...listed.map(findingLine));
    if (listed.length < v.findings.length) lines.push(`- ${v.findings.length - listed.length} more findings not shown to keep the comment short.`);
  }
  return lines.join('\n');
}

/**
 * The comment text for finished and failed reviews (in request order; the caller leaves out running ones). When it would
 * pass MAX_COMMENT_CHARS, older rounds shrink to one line each first, then the findings of the newest round are cut, and
 * the oldest one-line rounds drop out last.
 */
export function renderReviewComment(jobId: string, headSha: string, reviews: View[], maxChars = MAX_COMMENT_CHARS): string {
  const header = [
    reviewCommentMarker(jobId),
    '## Triglav local review',
    '',
    `This comment is written by Triglav, the local orchestrator, not by a person. It lists the local code review rounds of this job. The gate passed on ${short(headSha)}. Triglav edits this comment in place after later rounds.`,
  ].join('\n');
  /** Rounds before index `full` are one line each, the rest are in full; the first `dropped` rounds are left out. */
  const build = (full: number, cap: number, dropped: number) => {
    const lines = [header];
    if (dropped) lines.push('', `${countOf(dropped, 'older round')} left out to keep the comment short.`);
    const kept = reviews.slice(dropped);
    const early = kept.filter((_, i) => dropped + i < full);
    const late = kept.filter((_, i) => dropped + i >= full);
    if (early.length) lines.push('', 'Earlier rounds:', '', ...early.map((v) => renderRound(v, false, cap)));
    for (const v of late) lines.push('', renderRound(v, true, cap));
    if (!reviews.length) lines.push('', 'No finished review yet.');
    return `${lines.join('\n')}\n`;
  };
  const last = Math.max(0, reviews.length - 1);
  // Shrink in steps: every round in full, then only the newest in full, then fewer findings, then drop the oldest lines.
  let text = build(0, Infinity, 0);
  if (text.length <= maxChars) return text;
  for (let full = 1; full <= last; full++) {
    text = build(full, Infinity, 0);
    if (text.length <= maxChars) return text;
  }
  for (const cap of [100, 50, 20, 10, 5, 0]) {
    text = build(last, cap, 0);
    if (text.length <= maxChars) return text;
  }
  for (let dropped = 1; dropped < last; dropped++) {
    text = build(last, 0, dropped);
    if (text.length <= maxChars) return text;
  }
  return build(last, 0, last);
}

/** The comment for a job: every finished or failed local review in request order. Refuses a body that looks like it holds a secret. */
export async function buildReviewComment(conn: Conn, jobId: string, headSha: string, maxChars = MAX_COMMENT_CHARS): Promise<{ marker: string; body: string; rounds: number }> {
  const rows = await query(conn, `SELECT * FROM code_reviews WHERE job_id = ? AND status IN ('done', 'failed') ORDER BY created_at, seq`, [jobId]);
  const views: View[] = [];
  for (const r of rows) views.push(await reviewView(conn, r));
  const body = renderReviewComment(jobId, headSha, views, maxChars);
  assertNoSecrets(body);
  return { marker: reviewCommentMarker(jobId), body, rounds: views.length };
}

/**
 * The MCP tool get_review_comment: the comment of a job for a head sha. Only a Senior with a live assignment on the job or the
 * job's Staff, and only when the local gate passes on that head, so a comment never claims a pass that did not happen.
 */
export async function getReviewComment(ctx: Ctx, agent: Agent, jobId: string, headSha: string) {
  if (!/^[0-9a-f]{40}$/.test(headSha)) throw invalid('head_sha must be the full 40-character lowercase sha of the head.');
  const job = await queryOne(ctx.pool, `SELECT id, staff_agent_id FROM jobs WHERE id = ?`, [jobId]);
  if (!job) throw notFound('Job');
  if (agent.role === 'senior') {
    const holds = await queryOne(ctx.pool, `SELECT id FROM assignments WHERE job_id = ? AND owner_agent_id = ? AND status = 'held' AND lease_expires_at > ?`, [jobId, agent.id, ctx.clock.now()]);
    if (!holds) throw forbidden('You do not hold a live assignment on this job.');
  } else if (agent.role !== 'staff' || job.staff_agent_id !== agent.id) {
    throw forbidden('Only a Senior with a live assignment on the job or its Staff agent reads the review comment.');
  }
  const gate = await gateAt(ctx.pool, jobId, headSha);
  if (!gate.passes) throw conflict(`No review comment: the local gate does not pass on ${headSha.slice(0, 12)}. ${gate.reason}`);
  const c = await buildReviewComment(ctx.pool, jobId, headSha);
  return { job_id: jobId, head_sha: headSha, gate_review_id: gate.reviewId, marker: c.marker, rounds: c.rounds, chars: c.body.length, body: c.body };
}
