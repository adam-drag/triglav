import type { Conn } from './db.ts';
import { query, queryOne } from './db.ts';
import { cardOfJob } from './card-links.ts';
import { versionOf, type Repo } from './initiatives.ts';
import { parsePrUrl } from './gate-check.ts';
import { conflict, forbidden, invalid } from './lib.ts';

/** A pull request link inside free text; parsePrUrl then checks it. */
const PR_LINK = /https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/pull\/[0-9]+/g;

/**
 * The pull request an Architect's mark_pr_ready may mark ready, read from Triglav's records, never from the model's words.
 * The job must be a job of the initiative (or a subjob of one) that is not done or cancelled. The PR comes from the newest
 * review package of the job or its subjobs that names one, which submit_review_package stores only after the local review
 * gate passed, or else from the newest delivery, which comes after the review accepted. A draft-gated repository runs CI
 * only once the PR is ready, so the review package is usually the only record at that point. When the card's repository
 * has a GitHub slug, the PR must be in it.
 *
 * A blocker_id names an open client decision of the job or its subjobs that asks for it: it is resolved, as the Architect,
 * once gh marked the PR ready (src/operator-actions.ts, mark_pr_ready).
 */
export async function prReadyTarget(conn: Conn, i: { id: string; current_version: number; repos: Repo[] }, jobId: string, blockerId: string | undefined, architectId: string | null) {
  const job = await queryOne(conn, 'SELECT id, status, parent_job_id FROM jobs WHERE id = ?', [jobId]);
  // A subjob belongs to the initiative through its parent, the job a card started.
  const link = job ? await cardOfJob(conn, String(job.parent_job_id ?? job.id)) : null;
  if (!job || !link || link.initiative_id !== i.id) throw forbidden('That job is not a job of your initiative.');
  if (job.status === 'done' || job.status === 'cancelled') throw conflict(`Job ${jobId} is ${job.status}.`);
  const family = 'job_id IN (SELECT id FROM jobs WHERE id = ? OR parent_job_id = ?)';
  let pr: { slug: string; number: number } | null = null;
  // Only packages whose artifacts mention a pull request link, newest first: the newest of them decides, however old it is.
  for (const p of await query(conn, `SELECT job_id, artifacts FROM review_packages WHERE ${family} AND gate_review_id IS NOT NULL AND artifacts LIKE '%github.com/%/pull/%' ORDER BY submitted_at DESC, id DESC`, [jobId, jobId])) {
    const named = new Map<string, { slug: string; number: number }>();
    for (const a of artifactsOf(p.artifacts)) {
      // An artifact is free text ("PR: <url>"), so every pull request link in it counts.
      for (const m of a.matchAll(PR_LINK)) {
        const found = parsePrUrl(m[0]);
        if (found) named.set(`${found.slug.toLowerCase()}#${found.number}`, found);
      }
    }
    if (named.size > 1) throw conflict(`The newest review package of job ${String(p.job_id)} names more than one pull request. Ask the Client to mark the right one.`);
    if (named.size === 1) {
      pr = [...named.values()][0]!;
      break;
    }
  }
  if (!pr) {
    const d = await queryOne(conn, `SELECT pr_url FROM deliveries WHERE ${family} AND pr_url <> '' ORDER BY reported_at DESC LIMIT 1`, [jobId, jobId]);
    pr = d ? parsePrUrl(String(d.pr_url)) : null;
  }
  if (!pr) throw invalid(`Job ${jobId} has no pull request yet: no review package that passed the local review gate names one, and no delivery does.`);
  const v = await versionOf(conn, i.id, i.current_version);
  const card = v.doc.blocks.find((b) => b.kind === 'card' && b.id === link.card_key) as { repo?: string } | undefined;
  const github = i.repos.find((r) => r.slug === card?.repo)?.github;
  if (github && pr.slug.toLowerCase() !== github.toLowerCase()) throw conflict(`The pull request of job ${jobId} is in ${pr.slug}, not in ${github}, the repository of card ${link.card_key}.`);
  if (blockerId) {
    const b = await queryOne(conn, `SELECT id, kind, raised_by, resolved_at, dismissed_at FROM blockers WHERE id = ? AND ${family}`, [blockerId, jobId, jobId]);
    if (!b || b.kind !== 'client_decision' || b.resolved_at || b.dismissed_at) throw invalid(`Blocker ${blockerId} is not an open client decision of job ${jobId} or its subjobs.`);
    if (architectId && String(b.raised_by) === architectId) throw invalid('That blocker is your own escalation, so the Client decides it.');
    if (await queryOne(conn, `SELECT id FROM architect_answers WHERE blocker_id = ? AND state = 'escalated' LIMIT 1`, [blockerId])) throw invalid('Your escalation of that blocker is open, so the Client decides it.');
  }
  return { job_id: jobId, pr_url: `https://github.com/${pr.slug}/pull/${pr.number}`, ...(blockerId ? { blocker_id: blockerId } : {}) };
}

/**
 * Refuses a second mark_pr_ready for the same pull request while one waits or runs in this chat. Call it in the transaction
 * that writes the card, so two calls at once cannot both pass. The URL is compared without case, as GitHub does.
 */
export async function assertNoOpenPrReady(conn: Conn, chatId: string, prUrl: string) {
  const open = await query(conn, `SELECT args FROM chat_actions WHERE chat_id = ? AND kind = 'mark_pr_ready' AND state IN ('pending', 'running') FOR UPDATE`, [chatId]);
  if (open.some((o) => String(JSON.parse(String(o.args)).pr_url).toLowerCase() === prUrl.toLowerCase())) throw invalid(`A request to mark ${prUrl} ready already waits or runs.`);
}

function artifactsOf(raw: unknown): string[] {
  let list = raw;
  if (typeof raw === 'string') {
    try {
      list = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  return Array.isArray(list) ? list.filter((a): a is string => typeof a === 'string') : [];
}
