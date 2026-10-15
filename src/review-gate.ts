import type { Agent } from './agents.ts';
import { tx, type Ctx } from './context.ts';
import { exec, query, queryOne, type Conn, type Row } from './db.ts';
import { CLOSED, lockJob, requireAttempt } from './jobs.ts';
import { conflict, invalid, newId, notFound } from './lib.ts';

/*
 * The review gate: what the server requires before a Senior's work goes on.
 *
 * - The local gate. A head sha passes when a finished local code review of exactly that sha has the verdict `ok`. Reviews
 *   form rounds of one "piece of work": the commits since the last passing gate. Round 1 reviews base..h1, every later round
 *   reviews the fix delta (the previous reviewed head..hN), and a passing round ends the piece, so the counter starts again.
 *   A failed review never passes and is not a round. At most LOCAL_ROUNDS rounds per piece, more only by a grant.
 *   The ranges of a job form one chain: round 1 of a piece starts at the job's last passing head (`lastPassingHead`) or at the
 *   merge base with the job's base branch; the server cannot run git, so requestCodeReview marks the second case for the runner.
 * - The Copilot rounds of one PR. The server cannot run gh, so the Senior asks before each round and records the result;
 *   the counts come from the Senior's report. That makes the Copilot gate a bar, not a boundary: Seniors still have gh.
 *
 * See .claude/skills/triglav-code-review and triglav-jobs-and-leases.
 */

/** Local review rounds of one piece of work. Staff resolving the round-limit blocker grants this many more. */
export const LOCAL_ROUNDS = 3;
/** Copilot rounds of one PR. */
export const COPILOT_ROUNDS = 3;

export interface WorkState {
  /** The finished reviews of the current piece of work, in order. Empty before the first round and right after a pass. */
  piece: Row[];
  /** Head of the last finished review of the piece, which the next round must use as its base; null when the piece is empty. */
  lastHead: string | null;
  rounds: number;
  /** LOCAL_ROUNDS plus the rounds granted for this piece. */
  allowed: number;
  /** Head sha -> id of a passing review of it. */
  passing: Map<string, string>;
  /** Head of the job's last passing review (the one passed latest in request order), or null before the first pass. */
  lastPassingHead: string | null;
}

/**
 * Replays the finished reviews of a job in request order: `created_at`, with `seq` as the tiebreaker (old rows got their
 * `seq` in table order, so it alone is not their history). A review with the verdict `ok` passes its head and ends the
 * piece; any other finished review is a round of the current piece. A review whose base is not the previous round's head
 * cannot come from request_code_review (it refuses that), so it starts a piece of its own. Failed and running reviews are
 * not rounds, and a passing head stays passing whatever comes after it.
 */
export async function workState(conn: Conn, jobId: string): Promise<WorkState> {
  const done = await query(conn, `SELECT * FROM code_reviews WHERE job_id = ? AND status = 'done' ORDER BY created_at, seq`, [jobId]);
  let piece: Row[] = [];
  const passing = new Map<string, string>();
  let lastPassingHead: string | null = null;
  for (const r of done) {
    const prev = piece[piece.length - 1];
    if (prev && prev.head_sha !== r.base_sha) piece = [];
    piece.push(r);
    if (r.verdict === 'ok') {
      passing.set(r.head_sha as string, r.id as string);
      lastPassingHead = r.head_sha as string;
      piece = [];
    }
  }
  let granted = 0;
  if (piece.length) {
    granted = Number((await queryOne(conn, `SELECT COALESCE(SUM(rounds), 0) AS n FROM code_review_grants WHERE piece_first_review_id = ? AND granted_at IS NOT NULL`, [piece[0]!.id]))?.n ?? 0);
  }
  return { piece, lastHead: piece.length ? (piece[piece.length - 1]!.head_sha as string) : null, rounds: piece.length, allowed: LOCAL_ROUNDS + granted, passing, lastPassingHead };
}

export type Gate = { passes: true; reviewId: string } | { passes: false; reason: string };

/** Whether the local gate passes at this exact head sha, and if not, what to do about it. */
export async function gateAt(conn: Conn, jobId: string, headSha: string): Promise<Gate> {
  const ws = await workState(conn, jobId);
  const id = ws.passing.get(headSha);
  if (id) return { passes: true, reviewId: id };
  const short = headSha.slice(0, 12);
  const latest = await queryOne(conn, `SELECT id, status, verdict FROM code_reviews WHERE job_id = ? AND head_sha = ? ORDER BY created_at DESC, seq DESC LIMIT 1`, [jobId, headSha]);
  if (!latest) return { passes: false, reason: `No local code review of ${short} passed. Commit, then request_code_review on that exact head sha and fix what it finds.` };
  if (latest.status === 'running') return { passes: false, reason: `The local code review ${latest.id} of ${short} is still running. Wait for its code_review.finished event.` };
  if (latest.status === 'failed') return { passes: false, reason: `The local code review ${latest.id} of ${short} failed, and a failed review never passes. Ask for it again.` };
  return { passes: false, reason: `The local code review ${latest.id} of ${short} has the verdict ${latest.verdict}: blocking findings are open. Fix them, commit and ask for a new round, or answer them with answer_finding.` };
}

// ---------------------------------------------------------------- more local rounds

/**
 * A Senior raised a failed_execution blocker while the current piece of work is at its round limit: remember that this
 * blocker is the request for more rounds. Resolving it grants LOCAL_ROUNDS more for this piece. A blocker raised for
 * another reason (the piece is below its limit) is not tied to anything, and a piece has one pending request at a time.
 */
export async function noteRoundLimitBlocker(conn: Conn, ctx: Ctx, jobId: string, blockerId: string) {
  const ws = await workState(conn, jobId);
  if (!ws.piece.length || ws.rounds < ws.allowed) return;
  const first = ws.piece[0]!.id as string;
  if (await queryOne(conn, `SELECT blocker_id FROM code_review_grants WHERE piece_first_review_id = ? AND granted_at IS NULL`, [first])) return;
  await exec(conn, `INSERT INTO code_review_grants (blocker_id, job_id, piece_first_review_id, rounds, created_at) VALUES (?, ?, ?, ?, ?)`, [blockerId, jobId, first, LOCAL_ROUNDS, ctx.clock.now()]);
}

/** The blocker was resolved: the rounds it asked for are granted. Called in the transaction that resolves it. */
export async function grantRoundsFor(conn: Conn, ctx: Ctx, blockerId: string) {
  await exec(conn, `UPDATE code_review_grants SET granted_at = ? WHERE blocker_id = ? AND granted_at IS NULL`, [ctx.clock.now(), blockerId]);
}

// ---------------------------------------------------------------- Copilot rounds

const SHA = /^[0-9a-f]{40}$/;

export interface CopilotFindings {
  P0: number;
  P1: number;
  P2: number;
  P3: number;
}

/** Findings that justify another round: P0 to P2, minus the ones Copilot labelled "Previously missed". */
export const qualifying = (r: { p0?: unknown; p1?: unknown; p2?: unknown; previously_missed?: unknown }) => Math.max(0, Number(r.p0 ?? 0) + Number(r.p1 ?? 0) + Number(r.p2 ?? 0) - Number(r.previously_missed ?? 0));

/**
 * The Senior asks before it requests a Copilot review of a PR (`gh pr edit <pr> --add-reviewer "@copilot"`). Refused unless
 * the local gate passes on this head, at most COPILOT_ROUNDS per PR, never after Copilot recommended approval or after a
 * round with no qualifying finding, and not before the previous round's result is recorded. Needs a live lease.
 */
export async function requestCopilotReview(ctx: Ctx, agent: Agent, input: { assignmentId: string; attempt: number; pr: number; headSha: string }) {
  if (!Number.isInteger(input.pr) || input.pr < 1 || input.pr > 2_000_000_000) throw invalid('pr must be the pull request number.');
  if (!SHA.test(input.headSha)) throw invalid('head_sha must be the full 40-character lowercase sha of the PR head.');
  return tx(ctx, async (conn) => {
    const a = await requireAttempt(conn, ctx, agent, input.assignmentId, input.attempt);
    if (a.kind !== 'implement') throw invalid('Only implementation assignments request Copilot reviews.');
    const job = await lockJob(conn, a.job_id);
    if (CLOSED.includes(job.status)) throw conflict(`Job ${job.id} is ${job.status}.`);
    const gate = await gateAt(conn, job.id, input.headSha);
    if (!gate.passes) throw conflict(`No Copilot review: the local gate does not pass on ${input.headSha.slice(0, 12)}. ${gate.reason}`);
    const rounds = await query(conn, `SELECT * FROM copilot_rounds WHERE job_id = ? AND pr = ? ORDER BY round_no`, [job.id, input.pr]);
    const last = rounds[rounds.length - 1];
    if (rounds.length >= COPILOT_ROUNDS) throw conflict(`No Copilot review: PR ${input.pr} already had ${COPILOT_ROUNDS} rounds. Fix what is left locally, pass the local gate and finish. If the findings still block you, raise a failed_execution blocker.`);
    if (last) {
      if (last.recorded_at === null) throw conflict(`No Copilot review: round ${last.round_no} on PR ${input.pr} has no recorded result. Read that review and call record_copilot_result first.`);
      if (Number(last.approval_recommended) === 1) throw conflict(`No Copilot review: round ${last.round_no} on PR ${input.pr} recommended approval. The loop is finished.`);
      if (qualifying(last) === 0) throw conflict(`No Copilot review: round ${last.round_no} on PR ${input.pr} left no P0-P2 finding that was not "Previously missed". Fix the rest locally, pass the local gate and finish.`);
      if (last.head_sha === input.headSha) throw conflict(`No Copilot review: ${input.headSha.slice(0, 12)} is the head of round ${last.round_no}. Fix the findings, pass the local gate on the new head, then ask.`);
    }
    const roundNo = rounds.length + 1;
    await exec(
      conn,
      `INSERT INTO copilot_rounds (id, job_id, assignment_id, pr, round_no, head_sha, gate_review_id, requested_by, requested_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [newId('cpr'), job.id, a.id, input.pr, roundNo, input.headSha, gate.reviewId, agent.id, ctx.clock.now()],
    );
    return {
      pr: input.pr,
      round: roundNo,
      rounds_left_after_this: COPILOT_ROUNDS - roundNo,
      gate_review_id: gate.reviewId,
      next: `Now run: gh pr edit ${input.pr} --add-reviewer "@copilot". Read the whole review, triage it, then call record_copilot_result with round ${roundNo}.`,
    };
  });
}

/**
 * The Senior reports what a Copilot round found, after reading the whole review. The counts are the Senior's own, so the
 * server cannot check them. previously_missed counts the P0-P2 findings that Copilot labelled "Previously missed".
 */
export async function recordCopilotResult(
  ctx: Ctx,
  agent: Agent,
  input: { assignmentId: string; attempt: number; pr: number; round: number; approvalRecommended: boolean; findings: CopilotFindings; previouslyMissed: number },
) {
  const f = input.findings;
  for (const n of [f.P0, f.P1, f.P2, f.P3, input.previouslyMissed]) if (!Number.isInteger(n) || n < 0 || n > 10_000) throw invalid('Counts are whole numbers from 0 to 10000.');
  if (input.previouslyMissed > f.P0 + f.P1 + f.P2) throw invalid('previously_missed counts the P0-P2 findings labelled "Previously missed", so it cannot exceed P0 + P1 + P2.');
  return tx(ctx, async (conn) => {
    const a = await requireAttempt(conn, ctx, agent, input.assignmentId, input.attempt);
    const job = await lockJob(conn, a.job_id);
    const row = await queryOne(conn, `SELECT * FROM copilot_rounds WHERE job_id = ? AND pr = ? AND round_no = ? FOR UPDATE`, [job.id, input.pr, input.round]);
    if (!row) throw notFound(`Copilot round ${input.round} on PR ${input.pr}`);
    if (row.recorded_at !== null) throw conflict(`Round ${input.round} on PR ${input.pr} already has a recorded result.`);
    await exec(conn, `UPDATE copilot_rounds SET recorded_at = ?, approval_recommended = ?, p0 = ?, p1 = ?, p2 = ?, p3 = ?, previously_missed = ? WHERE id = ?`, [
      ctx.clock.now(),
      input.approvalRecommended ? 1 : 0,
      f.P0,
      f.P1,
      f.P2,
      f.P3,
      input.previouslyMissed,
      row.id,
    ]);
    const open = qualifying({ p0: f.P0, p1: f.P1, p2: f.P2, previously_missed: input.previouslyMissed });
    const left = COPILOT_ROUNDS - input.round;
    const next = input.approvalRecommended
      ? 'Copilot recommended approval. The loop is finished: do not request another round.'
      : open === 0
        ? 'No P0-P2 finding that was not "Previously missed". The loop is finished: fix any P3 and missed findings locally, pass the local gate, and finish.'
        : left === 0
          ? `${open} qualifying finding(s) are open and the ${COPILOT_ROUNDS} rounds are used. Fix them locally and pass the local gate; if they still block you, raise a failed_execution blocker.`
          : `${open} qualifying finding(s) are open. Fix them, pass the local gate on the new head, then request_copilot_review for round ${input.round + 1}.`;
    return { pr: input.pr, round: input.round, qualifying_open: open, rounds_left: left, next };
  });
}
