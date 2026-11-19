import { z } from 'zod';
import { pokeAgent } from './agents.ts';
import { dismissBlocker, resolveBlocker } from './blockers.ts';
import { editAgent } from './agent-edit.ts';
import { addMessage, notifyOperator, publish, type ChatAction } from './chat.ts';
import { tx, type Ctx } from './context.ts';
import { exec, query, queryOne, withTx, type Conn } from './db.ts';
import { emit } from './events.ts';
import { createJobRequest, MAX_PATH, MAX_PROMPT, MAX_URL } from './job-requests.ts';
import { reassignStaff, setControl } from './jobs.ts';
import { conflict, invalid, newId, notFound, RetryableAction } from './lib.ts';
import { applyAddendum, CONFIRM_SUMMARY_MAX, closeAddendum, describeAddendum } from './architect-addenda.ts';
import { updateRoleModel } from './models.ts';
import { applyRevision, closeRevision, describeStoredRevision } from './initiatives.ts';
import { approveRefinement } from './refine.ts';
import { requestResume } from './telemetry.ts';

/**
 * Changes the Operator may ask for. It only ever asks: the Client sees a card with a summary that this module writes
 * from the database, never from the model's words, and nothing happens until the Client confirms. The same schema checks
 * the request when it is made and again when it runs. A confirmed action does what the dashboard button does, as the Client.
 */

const ACTION_TTL_MS = 30 * 60_000;
const HOST_TTL_MS = 2 * 60_000;
const MAX_PENDING = 10;
const id = z.string().min(1).max(40);

const short = (text: string, n = 300) => (text.length > n ? `${text.slice(0, n)}...` : text);
const jobRow = async (ctx: Ctx, jobId: string) => {
  const j = await queryOne(ctx.pool, `SELECT linear_identifier, title FROM jobs WHERE id = ?`, [jobId]);
  if (!j) throw notFound(`Job ${jobId}`);
  return `${j.linear_identifier} ${j.title}`;
};
const agentRow = async (ctx: Ctx, agentId: string) => {
  const a = await queryOne(ctx.pool, `SELECT nickname, role FROM agents WHERE id = ?`, [agentId]);
  if (!a) throw notFound(`Agent ${agentId}`);
  return `${a.nickname} (${a.role})`;
};

type Def = {
  description: string;
  schema: z.ZodObject<z.ZodRawShape>;
  /** What the card says, written from the database. */
  describe: (ctx: Ctx, args: any) => Promise<string>;
  /** What the confirmed action does, and what to tell the Operator afterwards. Absent when the host runner does it. */
  run?: (ctx: Ctx, args: any) => Promise<string>;
  /** The command for the host runner, when the action must happen on this machine. */
  host?: (args: any) => Record<string, string>;
  /** Called when the Client denies the card or it expires, for an action that holds a record of its own. Runs in the transaction that moves the card, so the two never disagree. */
  close?: (conn: Conn, ctx: Ctx, args: any, state: 'denied' | 'expired') => Promise<void>;
};

export const ACTIONS: Record<string, Def> = {
  pause_job: {
    description: 'Ask the Client to pause a job: its agents finish the step they are on, stop changing code and wait.',
    schema: z.object({ job_id: id }),
    describe: async (ctx, a) => `Pause ${await jobRow(ctx, a.job_id)}. Its agents finish their current step and wait.`,
    run: async (ctx, a) => (await setControl(ctx, a.job_id, 'pause', 'Paused from the Operator'), `Paused ${await jobRow(ctx, a.job_id)}.`),
  },
  resume_job: {
    description: 'Ask the Client to resume a paused job.',
    schema: z.object({ job_id: id }),
    describe: async (ctx, a) => `Resume ${await jobRow(ctx, a.job_id)}.`,
    run: async (ctx, a) => (await setControl(ctx, a.job_id, 'resume', null), `Resumed ${await jobRow(ctx, a.job_id)}.`),
  },
  cancel_job: {
    description: 'Ask the Client to cancel a job: its agents stop at the next safe point and submit nothing. Only when the Client asked for this.',
    schema: z.object({ job_id: id }),
    describe: async (ctx, a) => `Cancel ${await jobRow(ctx, a.job_id)}. Its agents stop at the next safe point and submit nothing.`,
    run: async (ctx, a) => (await setControl(ctx, a.job_id, 'cancel', 'Cancelled from the Operator'), `Cancelled ${await jobRow(ctx, a.job_id)}.`),
  },
  poke_agent: {
    description: 'Ask the Client to poke an agent, so it checks Triglav on its next call.',
    schema: z.object({ agent_id: id, note: z.string().max(500).optional() }),
    describe: async (ctx, a) => `Poke ${await agentRow(ctx, a.agent_id)}${a.note ? ` with the note: ${short(a.note, 200)}` : ''}.`,
    run: async (ctx, a) => (await pokeAgent(ctx, a.agent_id, a.note ?? null), `Poked ${await agentRow(ctx, a.agent_id)}. It sees the poke when it next calls Triglav.`),
  },
  resume_staff: {
    description: 'Ask the Client to resume a stopped Staff agent. The host runner restarts its Claude session.',
    schema: z.object({ agent_id: id }),
    describe: async (ctx, a) => `Resume the stopped Staff ${await agentRow(ctx, a.agent_id)}. The host runner restarts its session.`,
    run: async (ctx, a) => {
      const r = await requestResume(ctx, a.agent_id);
      return r.already_queued ? 'A resume was already queued.' : 'Resume queued. The host runner starts the session within a few seconds.';
    },
  },
  start_job: {
    description: 'Ask the Client to start a job, from a ticket link or from a prompt, in a repository on this machine.',
    schema: z.object({
      mode: z.enum(['link', 'prompt']),
      url: z.string().max(MAX_URL).optional(),
      prompt: z.string().max(MAX_PROMPT).optional(),
      repo_path: z.string().max(MAX_PATH),
      base_branch: z.string().max(300).optional(),
    }),
    describe: async (_ctx, a) => `Start a job in ${a.repo_path} (branch ${a.base_branch || 'main'}) from ${a.mode === 'link' ? `the ticket ${a.url}` : `this prompt: ${short(a.prompt ?? '', 400)}`}`,
    run: async (ctx, a) => {
      const r = await createJobRequest(ctx, { mode: a.mode, url: a.url, prompt: a.prompt, repoPath: a.repo_path, baseBranch: a.base_branch });
      return r.already_queued ? `The same job request was already queued (${r.id}).` : `Job request ${r.id} queued. The host runner starts Staff within a few seconds.`;
    },
  },
  approve_job: {
    description: 'Ask the Client to approve the goal and criteria of a job that is being refined, so Staff starts planning. Only when the Client said to approve.',
    schema: z.object({ job_id: id }),
    describe: async (ctx, a) => `Approve the goal and acceptance criteria of ${await jobRow(ctx, a.job_id)}, so Staff starts planning.`,
    run: async (ctx, a) => (await approveRefinement(ctx, a.job_id), `Approved ${await jobRow(ctx, a.job_id)}. Staff starts planning.`),
  },
  answer_decision: {
    description: 'Ask the Client to send this answer to a decision that waits for them. Only with an answer the Client gave you or clearly asked for.',
    schema: z.object({ blocker_id: id, resolution: z.string().min(1).max(8000) }),
    describe: async (ctx, a) => {
      const b = await queryOne(ctx.pool, `SELECT b.requested_decision, j.linear_identifier, j.title FROM blockers b JOIN jobs j ON j.id = b.job_id WHERE b.id = ?`, [a.blocker_id]);
      if (!b) throw notFound(`Decision ${a.blocker_id}`);
      return `Answer the decision on ${b.linear_identifier} ${b.title} ("${short(String(b.requested_decision), 200)}") with: ${short(a.resolution, 600)}`;
    },
    run: async (ctx, a) => (await resolveBlocker(ctx, { kind: 'client' }, { blockerId: a.blocker_id, resolution: a.resolution }), 'The decision is answered and the work continues.'),
  },
  dismiss_decision: {
    description:
      'Ask the Client to dismiss a Client decision that no longer applies, for example the job already finished another way or the Staff that raised it is gone. Only when it is genuinely no longer relevant, not as a way to avoid answering a real question.',
    schema: z.object({ blocker_id: id, note: z.string().max(500).optional() }),
    describe: async (ctx, a) => {
      const b = await queryOne(ctx.pool, `SELECT b.requested_decision, j.linear_identifier, j.title FROM blockers b JOIN jobs j ON j.id = b.job_id WHERE b.id = ?`, [a.blocker_id]);
      if (!b) throw notFound(`Decision ${a.blocker_id}`);
      return `Dismiss the decision on ${b.linear_identifier} ${b.title} ("${short(String(b.requested_decision), 200)}") as no longer applicable${a.note ? `: ${short(a.note, 300)}` : ''}.`;
    },
    run: async (ctx, a) => (await dismissBlocker(ctx, a.blocker_id, a.note), 'The decision is dismissed.'),
  },
  reassign_staff: {
    description: 'Ask the Client to move a job to another active Staff agent.',
    schema: z.object({ job_id: id, staff_agent_id: id }),
    describe: async (ctx, a) => `Move ${await jobRow(ctx, a.job_id)} to the Staff ${await agentRow(ctx, a.staff_agent_id)}.`,
    run: async (ctx, a) => (await reassignStaff(ctx, a.job_id, a.staff_agent_id), `Moved ${await jobRow(ctx, a.job_id)} to ${await agentRow(ctx, a.staff_agent_id)}.`),
  },
  set_role_model: {
    description: 'Ask the Client to change the runtime, model and effort used for a role. It applies to agents started afterwards.',
    schema: z.object({ role: z.enum(['staff', 'senior', 'reviewer', 'researcher', 'architect']), runtime: z.string().min(1).max(40), model: z.string().min(1).max(100), effort: z.string().min(1).max(20) }),
    describe: async (_ctx, a) => `Set the ${a.role} role to ${a.runtime}, model ${a.model}, effort ${a.effort}. It applies to agents started afterwards.`,
    run: async (ctx, a) => (await updateRoleModel(ctx, a.role, { runtime: a.runtime, model: a.model, effort: a.effort }), `The ${a.role} role now uses ${a.model} at ${a.effort} effort.`),
  },
  edit_agent: {
    description:
      'Ask the Client to rename an agent, or change the model and effort it runs on. The runtime (Claude Code or Codex) never changes. For a running Claude Code Staff, a model or effort change restarts its session with the same conversation (its open wait is cut and it re-reads its context). Seniors and reviewers cannot be switched. Give the new model and effort together.',
    schema: z
      .object({ agent_id: id, nickname: z.string().min(1).max(100).optional(), model: z.string().min(1).max(100).optional(), effort: z.string().min(1).max(20).optional() })
      .refine((a) => a.nickname !== undefined || a.model !== undefined || a.effort !== undefined, 'Give a nickname, a model or an effort.'),
    describe: async (ctx, a) => {
      const parts = [];
      if (a.nickname !== undefined) parts.push(`rename it to ${a.nickname}`);
      if (a.model !== undefined || a.effort !== undefined) parts.push(`run it on ${[a.model && `model ${a.model}`, a.effort && `effort ${a.effort}`].filter(Boolean).join(' at ')}, which restarts a running Staff session with its conversation kept`);
      return `For ${await agentRow(ctx, a.agent_id)}: ${parts.join(' and ')}.`;
    },
    run: async (ctx, a) => {
      const r = await editAgent(ctx, a.agent_id, { nickname: a.nickname, model: a.model, effort: a.effort });
      return r.switch_queued ? 'Saved. The host runner restarts the session with the new model within a few seconds.' : 'Saved.';
    },
  },
  stop_session: {
    description: 'Ask the Client to stop a Claude Code background session on this machine, by the short id that `claude agents --json` shows. Its conversation is kept and can be resumed.',
    schema: z.object({ session: z.string().regex(/^[0-9a-f]{8}$/) }),
    describe: async (_ctx, a) => `Stop the Claude background session ${a.session} on this machine. Its conversation is kept and it can be resumed later.`,
    host: (a) => ({ action: 'stop_session', session: a.session }),
  },
};

/**
 * Changes an Architect may ask for (src/architect.ts). Its chat never gets the Operator's actions, and the Operator never
 * gets these: the map is chosen by the chat's kind.
 */
export const ARCHITECT_ACTIONS: Record<string, Def> = {
  apply_design_revision: {
    description: 'Ask the Client to apply a stored design revision as the next version.',
    schema: z.object({ revision_id: id }),
    describe: async (ctx, a) => describeStoredRevision(ctx.pool, a.revision_id),
    run: async (ctx, a) => {
      const r = await applyRevision(ctx, a.revision_id);
      return `The design is now v${r.version}. Changed blocks: ${r.changed.join(', ') || 'none'}${r.removed.length ? `. Removed: ${r.removed.join(', ')}` : ''}.`;
    },
    close: (conn, ctx, a, state) => closeRevision(conn, ctx, a.revision_id, state),
  },
  apply_addendum: {
    description: 'Ask the Client to send an addendum to a running job of the initiative, posted on its General thread as the Architect.',
    schema: z.object({ addendum_id: id }),
    describe: async (ctx, a) => describeAddendum(ctx.pool, a.addendum_id),
    run: (ctx, a) => applyAddendum(ctx, a.addendum_id),
    close: (conn, ctx, a, state) => closeAddendum(conn, ctx, a.addendum_id, state),
  },
};

/** The actions a chat of this kind may propose. */
export function actionsFor(chatKind: string): Record<string, Def> {
  return chatKind === 'architect' ? ARCHITECT_ACTIONS : ACTIONS;
}
const chatKindOf = async (conn: Parameters<typeof queryOne>[0], chatId: string) => {
  const c = await queryOne(conn, `SELECT kind FROM chats WHERE id = ?`, [chatId]);
  if (!c) throw notFound(`Chat ${chatId}`);
  return c.kind as string;
};

const publishAction = async (ctx: Ctx, actionId: string) => {
  const a = (await queryOne(ctx.pool, `SELECT id, chat_id, kind, summary, reason, state, result, created_at FROM chat_actions WHERE id = ?`, [actionId]))!;
  const { chat_id, ...action } = a;
  publish(chat_id, { type: 'action', action: action as ChatAction });
};

/** The Operator asks for a change. Nothing happens until the Client confirms; the Operator is told to wait. */
export async function proposeAction(ctx: Ctx, chatId: string, kind: string, rawArgs: unknown, reason: string | undefined) {
  const def = actionsFor(await chatKindOf(ctx.pool, chatId))[kind];
  if (!def) throw invalid(`Unknown action ${kind}`);
  const args = def.schema.parse(rawArgs);
  const summary = await def.describe(ctx, args);
  const placed = await tx(ctx, (conn) => placeAction(conn, ctx, chatId, kind, args, summary, reason));
  await announceAction(ctx, chatId, placed);
  return { id: placed.id, summary: placed.summary };
}

/**
 * The card's rows, on the caller's connection, so a caller can write a record of its own in the same transaction (an
 * Architect's revision and its card exist together or not at all). `args` must already be parsed by the action's schema and
 * `summary` written from the database. Call announceAction after the commit.
 */
export async function placeAction(conn: Conn, ctx: Ctx, chatId: string, kind: string, args: unknown, summary: string, reason: string | undefined) {
  const open = await queryOne(conn, `SELECT COUNT(*) AS n FROM chat_actions WHERE chat_id = ? AND state = 'pending'`, [chatId]);
  if (Number(open?.n) >= MAX_PENDING) throw conflict(`${MAX_PENDING} requests already wait for the Client. Ask them to answer those first.`);
  const id = newId('act');
  const text = short(summary, CONFIRM_SUMMARY_MAX);
  await exec(conn, `INSERT INTO chat_actions (id, chat_id, kind, args, summary, reason, state, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`, [id, chatId, kind, JSON.stringify(args), text, reason ? short(reason, 1000) : null, ctx.clock.now()]);
  return { id, summary: text, message: await addMessage(conn, ctx, chatId, 'action', id) };
}

export async function announceAction(ctx: Ctx, chatId: string, placed: { id: string; message: Awaited<ReturnType<typeof addMessage>> }) {
  publish(chatId, { type: 'message', message: placed.message });
  await publishAction(ctx, placed.id);
}

/** The Client's click. The state moves on in one step, so a second click on the same card does nothing. */
export async function decideAction(ctx: Ctx, chatId: string, actionId: string, decision: 'confirm' | 'deny') {
  const act = await withTx(ctx.pool, async (conn) => {
    const a = await queryOne(conn, `SELECT * FROM chat_actions WHERE id = ? AND chat_id = ? FOR UPDATE`, [actionId, chatId]);
    if (!a) throw notFound(`Request ${actionId}`);
    if (a.state !== 'pending') throw conflict(`This request is already ${a.state}.`);
    const expired = ctx.clock.now().getTime() - new Date(a.created_at).getTime() > ACTION_TTL_MS;
    const state = expired ? 'expired' : decision === 'deny' ? 'denied' : 'running';
    await exec(conn, `UPDATE chat_actions SET state = ?, decided_at = ? WHERE id = ?`, [state, ctx.clock.now(), actionId]);
    if (state !== 'running') {
      const def = actionsFor(await chatKindOf(conn, chatId))[a.kind as string];
      if (def?.close) await def.close(conn, ctx, def.schema.parse(JSON.parse(a.args as string)), state);
    }
    return { ...a, state } as Record<string, any>;
  });
  await publishAction(ctx, actionId);
  const def = actionsFor(await chatKindOf(ctx.pool, chatId))[act.kind];
  if (!def) throw invalid(`Unknown action ${act.kind}`);
  const args = def.schema.parse(JSON.parse(act.args));
  if (act.state === 'expired') throw conflict('This request is too old to confirm. Ask for it again in the chat.');
  if (act.state === 'denied') {
    await notifyOperator(ctx, chatId, `Denied: ${act.summary}`, `[Triglav] The Client denied your request: ${act.summary} Do not ask for it again unless the Client does.`);
    return { ok: true };
  }
  if (def.host) {
    await tx(ctx, (conn) => exec(conn, `INSERT INTO chat_commands (chat_id, kind, text, created_at) VALUES (?, 'host', ?, ?)`, [chatId, JSON.stringify({ action_id: actionId, ...def.host!(args) }), ctx.clock.now()]));
    return { ok: true };
  }
  try {
    await finishAction(ctx, act, true, await def.run!(ctx, args));
  } catch (e) {
    // A run that refused before it changed anything leaves the card pending, with the reason, for the next Confirm.
    if (e instanceof RetryableAction) {
      await exec(ctx.pool, `UPDATE chat_actions SET state = 'pending', result = ? WHERE id = ? AND state = 'running'`, [short(e.message, 2000), act.id]);
      await publishAction(ctx, act.id);
      return { ok: true };
    }
    await finishAction(ctx, act, false, e instanceof Error ? e.message : 'It failed.');
  }
  return { ok: true };
}

async function finishAction(ctx: Ctx, act: Record<string, any>, ok: boolean, text: string) {
  await exec(ctx.pool, `UPDATE chat_actions SET state = ?, result = ? WHERE id = ?`, [ok ? 'done' : 'failed', short(text, 2000), act.id]);
  if (ok) await tx(ctx, (conn) => emit(conn, ctx, { type: 'operator.action', actor: 'client', payload: { action_id: act.id, kind: act.kind, summary: act.summary } }));
  await publishAction(ctx, act.id);
  await notifyOperator(ctx, act.chat_id, `${ok ? 'Done' : 'Failed'}: ${text}`, `[Triglav] The Client confirmed your request: ${act.summary} Result: ${ok ? 'done' : 'failed'}. ${text}`);
}

/** The host runner reports what it did for an action that runs on this machine. */
export async function finishHostAction(ctx: Ctx, actionId: string, ok: boolean, text: string) {
  const act = await queryOne(ctx.pool, `SELECT * FROM chat_actions WHERE id = ? AND state = 'running'`, [actionId]);
  if (act) await finishAction(ctx, act, ok, text);
}

/** An action for the host runner that nobody answered does not wait for ever: the runner may be down. */
export async function expireHostActions(ctx: Ctx, chatId: string) {
  const stale = await query(ctx.pool, `SELECT * FROM chat_actions WHERE chat_id = ? AND state = 'running' AND decided_at < ?`, [chatId, new Date(ctx.clock.now().getTime() - HOST_TTL_MS)]);
  for (const act of stale) await finishAction(ctx, act, false, 'The host runner did not answer within 2 minutes. It may not be running.');
}

/**
 * A design revision whose Confirm card nobody answered within the card's lifetime expires, and so does a revision still
 * pending after that with no card left to answer it. The click path already expires a late card; this sweep makes the room
 * show it without a click (docs/plans/initiative-room.md, phase 2). Runs in the scheduler tick.
 */
export async function expireStaleCards(ctx: Ctx) {
  const now = ctx.clock.now();
  const cutoff = new Date(now.getTime() - ACTION_TTL_MS);
  const stale = await query<{ id: string; kind: string; args: string }>(ctx.pool, `SELECT a.id, a.kind, a.args FROM chat_actions a WHERE a.kind IN ('apply_design_revision', 'apply_addendum') AND a.state = 'pending' AND a.created_at < ?`, [cutoff]);
  for (const a of stale) {
    const expired = await tx(ctx, async (conn) => {
      const res = await exec(conn, `UPDATE chat_actions SET state = 'expired', decided_at = ? WHERE id = ? AND state = 'pending'`, [now, a.id]);
      if (res.affectedRows === 0) return false;
      const def = ARCHITECT_ACTIONS[a.kind]!;
      await def.close!(conn, ctx, def.schema.parse(JSON.parse(a.args)), 'expired');
      return true;
    });
    if (expired) await publishAction(ctx, a.id);
  }
  // An orphan only: a revision whose Confirm card is pending or running is left alone. The card may have been accepted
  // a moment before the cutoff, and applyRevision must still be able to run. The revision row is locked while the card
  // is checked, the same lock applyRevision takes.
  const orphans = await query<{ id: string }>(ctx.pool, `SELECT id FROM initiative_revisions WHERE state = 'pending' AND created_at < ?`, [cutoff]);
  for (const { id } of orphans) {
    await tx(ctx, async (conn) => {
      const r = await queryOne(conn, `SELECT id FROM initiative_revisions WHERE id = ? AND state = 'pending' FOR UPDATE`, [id]);
      if (!r) return;
      const card = await queryOne(conn, `SELECT id FROM chat_actions WHERE kind = 'apply_design_revision' AND state IN ('pending', 'running') AND JSON_UNQUOTE(JSON_EXTRACT(args, '$.revision_id')) = ? LIMIT 1`, [id]);
      if (card) return;
      await exec(conn, `UPDATE initiative_revisions SET state = 'expired', decided_at = ? WHERE id = ?`, [now, id]);
    });
  }
}
