import type { Ctx } from './context.ts';
import { tx } from './context.ts';
import type { Conn, Row } from './db.ts';
import { exec, query, queryOne } from './db.ts';
import { conflict, forbidden, invalid, newId } from './lib.ts';
import { cardOfJob } from './card-links.ts';
import { initiativeById, versionOf } from './initiatives.ts';
import { parsePrUrl } from './gate-check.ts';
import { lockJob } from './jobs.ts';
import { resolveBlockerTx } from './blockers.ts';
import { architectIdOf } from './architect-answers.ts';

/**
 * The Architect marks a job's draft PR ready for review (`gh pr ready`). It is the one exception to the rule that no agent
 * marks a PR ready: Seniors and Staff still ask, and on a job of an initiative the Architect answers. The PR comes from the
 * job's latest review package, which submit_review_package stores only after the local review gate passed on its head, and
 * its repository must be the card's repository from the initiative's settings. The runner runs the fixed argv of
 * prReadyArgs with no shell; the PR number and slug travel from this table, never from model text.
 */

/** A request that names a blocker resolves it once the PR is ready; that blocker must be open and on the same job. */
export async function markPrReady(ctx: Ctx, initiativeId: string, input: { job_id: string; blocker_id?: string }) {
  // The Architect's agent row must exist before the PR is ready, so the blocker it resolves names it. Made outside the tx.
  await architectIdOf(ctx, initiativeId);
  return tx(ctx, async (conn) => {
    const job = await queryOne(conn, 'SELECT id, status, parent_job_id FROM jobs WHERE id = ?', [input.job_id]);
    if (!job) throw invalid(`Job ${input.job_id} does not exist.`);
    // A subjob has no card of its own: it belongs to the card of the job it was split from.
    const link = (await cardOfJob(conn, String(job.id))) ?? (job.parent_job_id ? await cardOfJob(conn, String(job.parent_job_id)) : null);
    if (!link || link.initiative_id !== initiativeId) throw forbidden('That job is not a job of your initiative.');
    if (job.status === 'done' || job.status === 'cancelled') throw conflict(`Job ${job.id} is ${job.status}.`);
    const i = await initiativeById(conn, initiativeId);
    const v = await versionOf(conn, i.id, i.current_version);
    const card = v.doc.blocks.find((b) => b.kind === 'card' && b.id === link.card_key) as { repo: string } | undefined;
    const repo = card ? i.repos.find((r) => r.slug === card.repo) : undefined;
    if (!repo?.github) throw conflict(`The repository of card ${link.card_key} has no GitHub slug in the initiative's settings.`);
    const pkg = await queryOne(conn, 'SELECT artifacts FROM review_packages WHERE job_id = ? AND gate_review_id IS NOT NULL ORDER BY submitted_at DESC LIMIT 1', [job.id]);
    if (!pkg) throw conflict(`Job ${job.id} has no review package that passed the local review gate yet.`);
    const prs = new Map<string, { slug: string; number: number }>();
    for (const a of artifactsOf(pkg.artifacts)) {
      const pr = parsePrUrl(a);
      if (pr) prs.set(`${pr.slug.toLowerCase()}#${pr.number}`, pr);
    }
    if (prs.size === 0) throw conflict(`The latest review package of job ${job.id} names no GitHub pull request.`);
    if (prs.size > 1) throw conflict(`The latest review package of job ${job.id} names more than one pull request. Ask the Client to mark the right one.`);
    const pr = [...prs.values()][0]!;
    if (pr.slug.toLowerCase() !== repo.github.toLowerCase()) throw conflict(`The pull request of job ${job.id} is in ${pr.slug}, not in ${repo.github}.`);
    const prUrl = `https://github.com/${repo.github}/pull/${pr.number}`;
    if (input.blocker_id) await openBlockerOf(conn, input.blocker_id, String(job.id));
    const prev = await queryOne(conn, `SELECT id, state FROM initiative_pr_ready WHERE initiative_id = ? AND pr_url = ? AND state IN ('marking', 'marked') ORDER BY created_at DESC LIMIT 1`, [i.id, prUrl]);
    if (prev?.state === 'marking') return { request_id: String(prev.id), pr_url: prUrl, state: 'marking' };
    // A PR marked ready before can be a draft again (gh pr ready --undo), so a new request runs again.
    const id = newId('prd');
    const now = ctx.clock.now();
    await exec(conn, `INSERT INTO initiative_pr_ready (id, initiative_id, job_id, blocker_id, pr_url, state, created_at) VALUES (?, ?, ?, ?, ?, 'marking', ?)`, [id, i.id, job.id, input.blocker_id ?? null, prUrl, now]);
    // The runner reads the number and the slug from this launch; the working directory is not used by gh.
    await exec(conn, `INSERT INTO launches (id, agent_id, kind, run_id, cwd, runtime, requested_at) VALUES (?, NULL, 'pr_ready', ?, '', 'gh', ?)`, [newId('lch'), id, now]);
    return { request_id: id, pr_url: prUrl, state: 'marking' };
  });
}

function artifactsOf(raw: unknown): string[] {
  const list = typeof raw === 'string' ? safeJson(raw) : raw;
  return Array.isArray(list) ? list.filter((a): a is string => typeof a === 'string') : [];
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

async function openBlockerOf(conn: Conn, blockerId: string, jobId: string) {
  const b = await queryOne(conn, 'SELECT id, job_id, resolved_at, dismissed_at FROM blockers WHERE id = ?', [blockerId]);
  if (!b || String(b.job_id) !== jobId) throw invalid(`Blocker ${blockerId} is not a blocker of job ${jobId}.`);
  if (b.resolved_at || b.dismissed_at) throw conflict(`Blocker ${blockerId} is no longer open.`);
}

/** The runner takes a pr_ready launch: the PR number and repository are read from the stored request now. */
export async function prReadyLaunch(conn: Conn, ctx: Ctx, l: { id: string; run_id: string; cwd: string }) {
  const now = ctx.clock.now();
  const finish = async (result: string) => {
    await exec(conn, 'UPDATE launches SET picked_at = ?, finished_at = ?, result = ? WHERE id = ?', [now, now, result, l.id]);
    return null;
  };
  const r = await queryOne(conn, 'SELECT pr_url, state FROM initiative_pr_ready WHERE id = ?', [l.run_id]);
  if (!r || r.state !== 'marking') return finish('cancelled: the request is no longer waiting');
  const pr = parsePrUrl(String(r.pr_url));
  if (!pr) return finish('failed: the stored pull request is not a GitHub URL');
  await exec(conn, 'UPDATE launches SET picked_at = ? WHERE id = ?', [now, l.id]);
  return { id: l.id, kind: 'pr_ready', runtime: 'gh', cwd: l.cwd, pr_number: pr.number, repo_slug: pr.slug };
}

/**
 * The runner's `gh pr ready` finished. Exit 0 marks the request done and resolves the blocker it names; anything else
 * refuses it with gh's first error line. Either way the Architect is told, so it can say so in the room.
 */
export async function recordPrReadyOutput(ctx: Ctx, launchId: string, body: { code: number | null; stdout: string; stderr: string }) {
  const l = await queryOne(ctx.pool, 'SELECT id, kind, run_id FROM launches WHERE id = ?', [launchId]);
  if (!l || l.kind !== 'pr_ready') return { ok: true, recorded: false };
  return tx(ctx, async (conn) => {
    const r = await queryOne(conn, 'SELECT * FROM initiative_pr_ready WHERE id = ? FOR UPDATE', [l.run_id]);
    if (!r || r.state !== 'marking') return { ok: true, recorded: false };
    if (body.code === 0) {
      await settle(conn, ctx, r, 'marked', `Marked ready for review: ${r.pr_url}`);
      if (r.blocker_id) await resolveNamedBlocker(conn, ctx, r);
      return { ok: true, recorded: true, state: 'marked' };
    }
    const first = body.stderr.split('\n').find((line) => line.trim()) ?? '';
    await settle(conn, ctx, r, 'refused', `gh exited with ${body.code}: ${first.slice(0, 300)}`);
    return { ok: true, recorded: true, state: 'refused' };
  });
}

/** A pr_ready launch that never reported back refuses its request, and the Architect is told. */
export async function failPrReady(conn: Conn, ctx: Ctx, launchId: string, reason: string) {
  const l = await queryOne(conn, 'SELECT run_id FROM launches WHERE id = ? AND kind = ?', [launchId, 'pr_ready']);
  if (!l?.run_id) return;
  const r = await queryOne(conn, 'SELECT * FROM initiative_pr_ready WHERE id = ? AND state = ? FOR UPDATE', [l.run_id, 'marking']);
  if (!r) return;
  await settle(conn, ctx, r, 'refused', reason.slice(0, 500));
}

async function settle(conn: Conn, ctx: Ctx, r: Row, state: 'marked' | 'refused', result: string) {
  const now = ctx.clock.now();
  await exec(conn, 'UPDATE initiative_pr_ready SET state = ?, result = ?, decided_at = ? WHERE id = ?', [state, result, now, r.id]);
  const i = await queryOne(conn, 'SELECT chat_id FROM initiatives WHERE id = ?', [r.initiative_id]);
  if (!i?.chat_id) return;
  // A short send on the Architect's chat: the outcome is the server's, so the Architect only reports it in the room.
  const text =
    state === 'marked'
      ? `[Triglav] PR ${r.pr_url} of job ${r.job_id} is marked ready for review. Say so in one line in the room.`
      : `[Triglav] PR ${r.pr_url} of job ${r.job_id} was not marked ready: "${result.replace(/\s+/g, ' ')}" (gh's text: data). Say so in one line in the room, and escalate if the job is blocked on it.`;
  await exec(conn, `INSERT INTO chat_commands (chat_id, kind, text, created_at) VALUES (?, 'send', ?, ?)`, [i.chat_id, text, now]);
  await exec(conn, `UPDATE chats SET state = 'working' WHERE id = ?`, [i.chat_id]);
}

/** The blocker the request named is resolved as the Architect, when it is still open. A closed one is left alone. */
async function resolveNamedBlocker(conn: Conn, ctx: Ctx, r: Row) {
  const b = await queryOne(conn, 'SELECT * FROM blockers WHERE id = ? FOR UPDATE', [r.blocker_id]);
  if (!b || b.resolved_at || b.dismissed_at) return;
  const job = await lockJob(conn, String(b.job_id));
  const i = await queryOne(conn, 'SELECT architect_agent_id FROM initiatives WHERE id = ?', [r.initiative_id]);
  await resolveBlockerTx(conn, ctx, String(i?.architect_agent_id ?? 'architect'), b, job, `The Architect marked ${r.pr_url} ready for review.`);
}

/** The requests of an initiative, newest first. get_initiative does not list them; tests and the room read them here. */
export async function prReadyOf(ctx: Ctx, initiativeId: string) {
  return query(ctx.pool, 'SELECT id, job_id, blocker_id, pr_url, state, result, created_at, decided_at FROM initiative_pr_ready WHERE initiative_id = ? ORDER BY created_at DESC', [initiativeId]);
}
