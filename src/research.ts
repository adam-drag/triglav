/**
 * Researchers without an idle loop.
 *
 * An always-on researcher re-sends its whole conversation on every poll, so idling cost most of the Codex
 * usage window (measured 2026-10-08). Instead, Triglav routes the events a researcher should see into its
 * inbox, and a dispatcher starts a short `codex exec` (or `claude -p` when Codex is not on the machine) run per batch of items. The run exchanges a one-off
 * ticket for a session token, handles its items, marks each one, and exits. Memory between runs lives in a
 * small notebook, not in a transcript.
 */
import { tx, type Ctx } from './context.ts';
import { exec, parseJson, query, queryOne, type Conn } from './db.ts';
import { emit } from './events.ts';
import { conflict, forbidden, invalid, newId, newSecret, notFound, sha256, TOKEN_PREFIX } from './lib.ts';
import { detectedRuntimes, effectiveRoleModel, fallbackFor, usableRuntime } from './models.ts';

const RUN_TICKET_PREFIX = 'orch_run_';
/** New items wait this long so a burst of events becomes one run, unless one is due sooner. */
const BATCH_SEC = 15;
const URGENT_SEC = 90;
/** A run that has not ended by then is treated as dead: its items go back to the inbox once, then expire. */
const RUN_TIMEOUT_MIN = 15;
const MAX_ATTEMPTS = 2;
/** Above these shares of the 5-hour Codex window, only urgent kinds run, then nothing runs. */
const BUDGET_URGENT_ONLY = 70;
const BUDGET_STOP = 90;
// A view the Client asked for is as urgent as a question to the Client.
const URGENT_KINDS = ['question', 'client_decision', 'view_request'];

export type InboxKind = 'question' | 'proposal' | 'mention' | 'view_request' | 'client_decision' | 'review' | 'decision';

interface Persona {
  id: string;
  agent_id: string;
  nickname: string;
  focus: string;
  repo_path: string;
  model: string;
  effort: string;
  enabled: number;
}

// ---------------------------------------------------------------- routing

/** Turns one event into inbox items for the personas that should see it. Called from emit() in the same transaction. */
export async function routeToInbox(conn: Conn, ctx: Ctx, e: { id: number; type: string; jobId: string | null; threadId: string | null; actor: string; payload: Record<string, any> }) {
  const kind = kindOf(e);
  if (!kind) return;
  const personas = (await query(conn, `SELECT * FROM researcher_personas WHERE enabled = 1`)) as unknown as Persona[];
  for (const p of personas) {
    if (p.agent_id === e.actor) continue;
    // A mention, a Client's request for a view, or a decision on a thread where this persona objected, goes only to its targets.
    if ((kind === 'mention' || kind === 'view_request' || kind === 'decision') && !(e.payload.targets ?? []).includes(p.agent_id)) continue;
    // A review round goes to the researchers who already took part in that job.
    if (kind === 'review') {
      const took = await queryOne(conn, `SELECT 1 FROM messages WHERE job_id = ? AND author = ? LIMIT 1`, [e.jobId, p.agent_id]);
      if (!took) continue;
    }
    const blockerId = kind === 'client_decision' ? String(e.payload.blocker_id) : null;
    const key = `${p.id}|${blockerId ?? e.threadId ?? e.id}`;
    const title = await titleOf(conn, kind, e);
    const due = e.payload.deadline_at ? new Date(String(e.payload.deadline_at)) : null;
    // A follow-up on an item that is still new merges into it (a claimed one has no open_key). A Client's request for a view upgrades
    // a plain mention or proposal; a question keeps its kind and title (reviewedByOthers in board.ts reads the kind).
    await exec(
      conn,
      `INSERT INTO research_inbox (id, persona_id, kind, job_id, thread_id, blocker_id, event_id, title, due_at, status, open_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?)
       ON DUPLICATE KEY UPDATE kind = IF(VALUES(kind) = 'view_request' AND kind IN ('mention', 'proposal'), VALUES(kind), kind), event_id = VALUES(event_id), due_at = COALESCE(VALUES(due_at), due_at), title = IF(kind = 'question', title, VALUES(title))`,
      [newId('inb'), p.id, kind, e.jobId, e.threadId, blockerId, e.id, title.slice(0, 300), due, key, ctx.clock.now()],
    );
  }
}

function kindOf(e: { type: string; payload: Record<string, any> }): InboxKind | null {
  if (e.type === 'question.opened') return 'question';
  if (e.type === 'proposal.posted') return 'proposal';
  if (e.type === 'mention') return e.payload.view_requested ? 'view_request' : 'mention';
  if (e.type === 'decision.recorded' || e.type === 'decision.superseded') return 'decision';
  if (e.type === 'review.submitted') return 'review';
  if (e.type === 'blocker.raised' && e.payload.kind === 'client_decision') return 'client_decision';
  return null;
}

async function titleOf(conn: Conn, kind: InboxKind, e: { jobId: string | null; payload: Record<string, any> }) {
  const job = e.jobId ? await queryOne(conn, `SELECT linear_identifier FROM jobs WHERE id = ?`, [e.jobId]) : null;
  const where = job ? `${job.linear_identifier}: ` : '';
  if (kind === 'question') return `${where}question: ${e.payload.title ?? ''}`;
  if (kind === 'client_decision') {
    const b = await queryOne(conn, `SELECT requested_decision FROM blockers WHERE id = ?`, [e.payload.blocker_id]);
    return `${where}Client decision: ${String(b?.requested_decision ?? '').slice(0, 200)}`;
  }
  if (kind === 'review') return `${where}review round ${e.payload.round ?? ''}`;
  if (kind === 'mention') return `${where}you were mentioned`;
  if (kind === 'view_request') return `${where}the Client asks for your view`;
  if (kind === 'decision') return `${where}decision on a thread where you objected`;
  return `${where}proposal`;
}

// ---------------------------------------------------------------- budget

/** The latest Codex rate-limit reading, taken from transcripts by telemetry. */
export async function codexBudget(conn: Conn) {
  return queryOne(conn, `SELECT * FROM codex_budget WHERE id = 1`);
}

export async function recordCodexBudget(conn: Conn, r: { used: number; windowMin: number | null; resetsAt: Date | null; weekly: number | null; weeklyResetsAt: Date | null; at: Date }) {
  await exec(
    conn,
    `INSERT INTO codex_budget (id, used_percent, window_minutes, resets_at, weekly_used_percent, weekly_resets_at, observed_at) VALUES (1, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE used_percent = IF(VALUES(observed_at) >= observed_at, VALUES(used_percent), used_percent),
       window_minutes = IF(VALUES(observed_at) >= observed_at, VALUES(window_minutes), window_minutes),
       resets_at = IF(VALUES(observed_at) >= observed_at, VALUES(resets_at), resets_at),
       weekly_used_percent = IF(VALUES(observed_at) >= observed_at, VALUES(weekly_used_percent), weekly_used_percent),
       weekly_resets_at = IF(VALUES(observed_at) >= observed_at, VALUES(weekly_resets_at), weekly_resets_at),
       observed_at = GREATEST(observed_at, VALUES(observed_at))`,
    [r.used, r.windowMin, r.resetsAt, r.weekly, r.weeklyResetsAt, r.at],
  );
}

/** The share of the 5-hour window in use now: a reading taken before its window reset counts as 0. */
function usedNow(b: any, now: Date): number {
  if (!b) return 0;
  if (b.resets_at && new Date(b.resets_at) <= now) return 0;
  return Number(b.used_percent);
}

/** The share of the Codex window in use now, from the latest reading (0 when there is none). Local code reviews use it for their own stop. */
export async function codexUsedNow(conn: Conn, now: Date): Promise<number> {
  return usedNow(await codexBudget(conn), now);
}

// ---------------------------------------------------------------- dispatcher

/** One scheduler pass: time out dead runs, then start a run for each persona with items ready. */
export async function dispatchResearch(ctx: Ctx) {
  const now = ctx.clock.now();
  await timeoutRuns(ctx, now);
  const codexUsed = usedNow(await codexBudget(ctx.pool), now);
  const det = await detectedRuntimes(ctx);
  const personas = (await query(ctx.pool, `SELECT p.*, a.runtime FROM researcher_personas p JOIN agents a ON a.id = p.agent_id WHERE p.enabled = 1`)) as unknown as (Persona & { runtime: string })[];
  for (const persona of personas) {
    // A persona saved for a CLI that is not on the machine runs on the one that is, with Triglav's choice of model.
    const runtime = usableRuntime(det, persona.runtime);
    const fb = runtime === persona.runtime ? null : fallbackFor(runtime, 'researcher');
    const p = fb ? { ...persona, ...fb } : persona;
    // The Codex window only limits Codex runs.
    const budget = runtime === 'codex' ? codexUsed : 0;
    if (budget >= BUDGET_STOP) continue;
    await tx(ctx, async (conn) => {
      const busy = await queryOne(conn, `SELECT id FROM research_runs WHERE persona_id = ? AND status IN ('queued', 'running') FOR UPDATE`, [p.id]);
      if (busy) return;
      const kinds = budget >= BUDGET_URGENT_ONLY ? URGENT_KINDS : null;
      const items = await query(
        conn,
        `SELECT * FROM research_inbox WHERE persona_id = ? AND status = 'new' ${kinds ? `AND kind IN (${kinds.map(() => '?').join(',')})` : ''} ORDER BY created_at FOR UPDATE`,
        [p.id, ...(kinds ?? [])],
      );
      if (!items.length) return;
      const oldest = Math.min(...items.map((x) => new Date(x.created_at).getTime()));
      const soonest = Math.min(...items.map((x) => (x.due_at ? new Date(x.due_at).getTime() : Infinity)));
      if (now.getTime() - oldest < BATCH_SEC * 1000 && soonest - now.getTime() > URGENT_SEC * 1000) return;
      const runId = newId('run');
      const ticket = newSecret(RUN_TICKET_PREFIX);
      await exec(conn, `INSERT INTO research_runs (id, persona_id, ticket_hash, status, created_at, budget_pct_before) VALUES (?, ?, ?, 'queued', ?, ?)`, [
        runId, p.id, sha256(ticket), now, budget,
      ]);
      // Clearing open_key makes an event that arrives during the run a new item instead of one closed unread with this one.
      await exec(conn, `UPDATE research_inbox SET status = 'claimed', run_id = ?, attempts = attempts + 1, open_key = NULL WHERE id IN (${items.map(() => '?').join(',')})`, [
        runId, ...items.map((x) => x.id),
      ]);
      await exec(conn, `INSERT INTO launches (id, agent_id, kind, run_id, ticket, cwd, runtime, model, effort, requested_at) VALUES (?, ?, 'research_run', ?, ?, ?, ?, ?, ?, ?)`, [
        newId('lch'), p.agent_id, runId, ticket, p.repo_path, runtime, p.model, p.effort, now,
      ]);
    });
  }
}

async function timeoutRuns(ctx: Ctx, now: Date) {
  const cutoff = new Date(now.getTime() - RUN_TIMEOUT_MIN * 60_000);
  const dead = await query(ctx.pool, `SELECT id FROM research_runs WHERE status IN ('queued', 'running') AND created_at < ?`, [cutoff]);
  for (const { id } of dead) await closeRun(ctx, String(id), 'timed_out', `No end_run within ${RUN_TIMEOUT_MIN} minutes.`);
}

/** Ends a run. Items it left unmarked go back to the inbox, or expire after too many attempts. */
export async function closeRun(ctx: Ctx, runId: string, status: 'ended' | 'failed' | 'timed_out', result: string | null) {
  await tx(ctx, async (conn) => {
    const run = await queryOne(conn, `SELECT * FROM research_runs WHERE id = ? FOR UPDATE`, [runId]);
    if (!run || !['queued', 'running'].includes(run.status)) return;
    const now = ctx.clock.now();
    await exec(conn, `UPDATE research_runs SET status = ?, ended_at = ?, result = ? WHERE id = ?`, [status, now, result?.slice(0, 2000) ?? null, runId]);
    await exec(conn, `UPDATE research_inbox SET status = 'expired', done_at = ?, open_key = NULL, note = 'Not handled after repeated runs.' WHERE run_id = ? AND status = 'claimed' AND attempts >= ?`, [
      now, runId, MAX_ATTEMPTS,
    ]);
    await exec(conn, `UPDATE research_inbox SET status = 'new', run_id = NULL WHERE run_id = ? AND status = 'claimed'`, [runId]);
    if (run.session_id) await exec(conn, `UPDATE agent_sessions SET ended_at = ? WHERE id = ? AND ended_at IS NULL`, [now, run.session_id]);
  });
}

/** The run behind a launch, if it is a research run: the runner reports an exit, or a start that failed, by launch id. */
export async function closeRunOfLaunch(ctx: Ctx, launchId: string, status: 'ended' | 'failed', result: string) {
  const l = (await queryOne(ctx.pool, `SELECT run_id, kind FROM launches WHERE id = ?`, [launchId])) as { run_id?: string; kind?: string } | null;
  if (l?.run_id && l.kind === 'research_run') await closeRun(ctx, l.run_id, status, result);
}

// ---------------------------------------------------------------- run protocol (MCP)

/** The first call of a run: trades the run ticket for a session token and returns the work. */
export async function startRun(ctx: Ctx, ticket: string) {
  if (!ticket.startsWith(RUN_TICKET_PREFIX)) throw forbidden('Not a run ticket.');
  return tx(ctx, async (conn) => {
    const run = await queryOne(conn, `SELECT * FROM research_runs WHERE ticket_hash = ? FOR UPDATE`, [sha256(ticket)]);
    if (!run) throw forbidden('Unknown run ticket.');
    if (run.status !== 'queued') throw conflict(`This run is ${run.status}.`);
    const p = (await queryOne(conn, `SELECT * FROM researcher_personas WHERE id = ?`, [run.persona_id])) as unknown as Persona;
    const now = ctx.clock.now();
    const sessionId = newId('ses');
    const token = newSecret(TOKEN_PREFIX);
    await exec(conn, `INSERT INTO agent_sessions (id, agent_id, token_hash, started_at, last_seen_at) VALUES (?, ?, ?, ?, ?)`, [sessionId, p.agent_id, sha256(token), now, now]);
    await exec(conn, `UPDATE research_runs SET status = 'running', started_at = ?, session_id = ? WHERE id = ?`, [now, sessionId, run.id]);
    const items = await query(conn, `SELECT id, kind, job_id, thread_id, blocker_id, title, due_at FROM research_inbox WHERE run_id = ? AND status = 'claimed' ORDER BY due_at IS NULL, due_at, created_at`, [run.id]);
    const notes = await query(conn, `SELECT job_id, body FROM researcher_notebook WHERE persona_id = ?`, [p.id]);
    await emit(conn, ctx, { type: 'research.run_started', actor: p.agent_id, payload: { run_id: run.id, items: items.length } });
    return {
      session_token: token,
      run_id: run.id,
      you: { nickname: p.nickname, focus: p.focus },
      items,
      notebook: notes,
      next: 'For each item: call get_item, decide, act (post_message on its thread, advise_decision for a Client decision, or file_dissent on a decision you still dispute), then mark_item handled or skipped with a one-line note. Update your notebook if you learned something worth remembering. Then end_run.',
    };
  });
}

async function runFor(conn: Conn, agentId: string) {
  const run = await queryOne(
    conn,
    `SELECT r.*, p.id AS pid FROM research_runs r JOIN researcher_personas p ON p.id = r.persona_id JOIN agent_sessions s ON s.id = r.session_id
     WHERE p.agent_id = ? AND r.status = 'running' AND s.ended_at IS NULL ORDER BY r.started_at DESC LIMIT 1`,
    [agentId],
  );
  if (!run) throw forbidden('No running research run for this session.');
  return run;
}

/** One item in full: the thread or decision text, plus what happened on the job since this researcher last spoke. */
export async function getItem(ctx: Ctx, agentId: string, itemId: string) {
  const run = await runFor(ctx.pool, agentId);
  const item = await queryOne(ctx.pool, `SELECT * FROM research_inbox WHERE id = ? AND run_id = ?`, [itemId, run.id]);
  if (!item) throw notFound('No such item in this run.');
  // Only an item that was read counts as a researcher's look at a question (reviewedByOthers in board.ts).
  await exec(ctx.pool, `UPDATE research_inbox SET read_at = COALESCE(read_at, ?) WHERE id = ?`, [ctx.clock.now(), item.id]);
  const out: Record<string, unknown> = { item };
  if (item.thread_id) {
    out.messages = await query(
      ctx.pool,
      `SELECT m.id, COALESCE(a.nickname, m.author) AS author, m.type, m.stance, m.body, m.in_reply_to, m.received_at FROM messages m LEFT JOIN agents a ON a.id = m.author WHERE m.thread_id = ? ORDER BY m.id`,
      [item.thread_id],
    );
    // The ids let a researcher that disagrees with a decision file a dissent on it.
    out.decisions = await query(
      ctx.pool,
      `SELECT d.id, a.nickname AS decided_by, d.authority, d.body, d.rationale, d.supersedes_decision_id, d.created_at FROM decisions d LEFT JOIN agents a ON a.id = d.decided_by WHERE d.thread_id = ? ORDER BY d.created_at`,
      [item.thread_id],
    );
  }
  if (item.thread_id && item.event_id) {
    // The Client's latest request for this researcher's view (every Client mention is one) among the events merged into the item,
    // whatever the item's kind.
    // It is the message to answer with in_reply_to. event_id is the last event merged in, which may be another agent's.
    const e = await queryOne(
      ctx.pool,
      `SELECT payload FROM events WHERE type = 'mention' AND actor = 'client' AND thread_id = ? AND id <= ? AND created_at >= ?
         AND JSON_CONTAINS(payload, JSON_QUOTE(?), '$.targets')
       ORDER BY id DESC LIMIT 1`,
      [item.thread_id, item.event_id, item.created_at, agentId],
    );
    if (e) out.client_message_id = Number(parseJson<Record<string, unknown>>(e.payload).message_id);
  }
  if (item.blocker_id) {
    out.decision = await queryOne(ctx.pool, `SELECT context, requested_decision, recommendation, unblock_condition FROM blockers WHERE id = ?`, [item.blocker_id]);
  }
  if (item.job_id) {
    const job = await queryOne(ctx.pool, `SELECT linear_identifier, title, status, staff_agent_id FROM jobs WHERE id = ?`, [item.job_id]);
    const last = await queryOne(ctx.pool, `SELECT MAX(id) AS id FROM messages WHERE job_id = ? AND author = (SELECT agent_id FROM researcher_personas WHERE id = ?)`, [item.job_id, run.pid]);
    out.job = job;
    // Only the job's other threads since this researcher last spoke there, as one line each, to keep the context small.
    out.since_you_last_spoke = await query(
      ctx.pool,
      `SELECT m.thread_id, a.nickname AS author, m.type, LEFT(m.body, 200) AS excerpt FROM messages m LEFT JOIN agents a ON a.id = m.author
       WHERE m.job_id = ? AND m.id > ? AND (m.thread_id <> ? OR ? IS NULL) ORDER BY m.id DESC LIMIT 15`,
      [item.job_id, Number(last?.id ?? 0), item.thread_id, item.thread_id],
    );
  }
  return out;
}

export async function markItem(ctx: Ctx, agentId: string, itemId: string, status: 'handled' | 'skipped', note: string) {
  if (!note.trim()) throw invalid('Say in one line what you did or why you skipped it.');
  const run = await runFor(ctx.pool, agentId);
  await tx(ctx, async (conn) => {
    const res: any = await exec(conn, `UPDATE research_inbox SET status = ?, note = ?, done_at = ?, open_key = NULL WHERE id = ? AND run_id = ? AND status = 'claimed'`, [
      status, note.slice(0, 500), ctx.clock.now(), itemId, run.id,
    ]);
    if (!res.affectedRows) throw notFound('No open item with that id in this run.');
    await emit(conn, ctx, { type: 'research.item_done', actor: agentId, payload: { item_id: itemId, status } });
  });
  return { ok: true };
}

export async function updateNotebook(ctx: Ctx, agentId: string, jobId: string | null, body: string) {
  if (body.length > 2000) throw invalid('Keep a notebook entry under 2000 characters: it is read at the start of every run.');
  const run = await runFor(ctx.pool, agentId);
  await exec(ctx.pool, `INSERT INTO researcher_notebook (persona_id, job_id, body, updated_at) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE body = VALUES(body), updated_at = VALUES(updated_at)`, [
    run.pid, jobId ?? '', body, ctx.clock.now(),
  ]);
  return { ok: true };
}

export async function endRun(ctx: Ctx, agentId: string, summary: string) {
  const run = await runFor(ctx.pool, agentId);
  await closeRun(ctx, String(run.id), 'ended', summary || null);
  return { ok: true, next: 'You are done. Exit now; do not wait for more events.' };
}

// ---------------------------------------------------------------- personas and dashboard

export async function createPersona(ctx: Ctx, input: { nickname: string; focus: string; repo_path: string; model: string; effort: string; runtime?: string }) {
  if (!input.repo_path.startsWith('/')) throw invalid('repo_path must be an absolute path.');
  return tx(ctx, async (conn) => {
    // Without a runtime, a persona runs on what the researcher role uses now (which follows what is on the machine).
    const runtime = input.runtime ?? (await effectiveRoleModel(ctx, conn, 'researcher'))?.runtime ?? 'codex';
    const now = ctx.clock.now();
    const agentId = newId('agt');
    await exec(conn, `INSERT INTO agents (id, nickname, role, focus, runtime, model, parent_agent_id, created_at) VALUES (?, ?, 'researcher', ?, ?, ?, NULL, ?)`, [
      agentId, input.nickname, input.focus, runtime, input.model, now,
    ]);
    const id = newId('per');
    await exec(conn, `INSERT INTO researcher_personas (id, agent_id, nickname, focus, repo_path, model, effort, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`, [
      id, agentId, input.nickname, input.focus, input.repo_path, input.model, input.effort, now,
    ]);
    return { id, agent_id: agentId };
  });
}

export async function updatePersona(ctx: Ctx, id: string, patch: Partial<{ focus: string; repo_path: string; model: string; effort: string; enabled: boolean }>) {
  const fields = Object.entries(patch).filter(([, v]) => v !== undefined);
  if (!fields.length) return { ok: true };
  await exec(ctx.pool, `UPDATE researcher_personas SET ${fields.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`, [...fields.map(([k, v]) => (k === 'enabled' ? (v ? 1 : 0) : v)), id]);
  return { ok: true };
}

export async function researchOverview(ctx: Ctx) {
  const personas = await query(ctx.pool, `SELECT * FROM researcher_personas ORDER BY created_at`);
  const inbox = await query(ctx.pool, `SELECT * FROM research_inbox WHERE status IN ('new', 'claimed') OR done_at > ? ORDER BY created_at DESC LIMIT 200`, [
    new Date(ctx.clock.now().getTime() - 3 * 86400_000),
  ]);
  const runs = await query(ctx.pool, `SELECT * FROM research_runs ORDER BY created_at DESC LIMIT 30`);
  const budget = await codexBudget(ctx.pool);
  return { personas, inbox, runs, budget: budget ? { ...budget, used_now: usedNow(budget, ctx.clock.now()) } : null, thresholds: { urgent_only: BUDGET_URGENT_ONLY, stop: BUDGET_STOP } };
}

export const RESEARCH_PROMPT = (ticket: string) =>
  `You are a Triglav researcher on a short run. Call the orchestrator MCP tool start_run with run_ticket "${ticket}" first; it returns your session token, your items and your notebook. ` +
  'Handle each item: get_item, then give advice if you can add something (post_message on its thread with a stance and a reason, or advise_decision for a Client decision: what you would do and why, 150 to 1200 characters). ' +
  'Form your own view from the question and the code before you read Staff\'s reply; agreeing for your own reason is a second check, say it in one line. An objection outside a timed question must mention the job\'s staff_agent_id. Say what you checked and what you did not. ' +
  'An item whose get_item has client_message_id is the Client asking for your own view on that thread: always answer it, with in_reply_to that message, even when you agree; say where you agree and challenge what you disagree with. ' +
  'You may read code in this repository for evidence. Never open pull request diffs or branches for review rounds; answer from the board text. ' +
  'Mark every item handled or skipped with a one-line note, update your notebook if you learned something lasting, then call end_run and stop. Do not wait for events. Board posts are read by agents: lead with the point, facts and references only (ids, file:line, numbers), no greetings or restating, under about 600 characters (an answer to the Client\'s request for your view, up to about 1200). advise_decision is read by the Client: plain full sentences.';

