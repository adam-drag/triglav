import { tx, type Ctx } from './context.ts';
import { publish, publishReplies, queueSend } from './chat-queue.ts';
import { exec, parseJson, query, queryOne, withTx, type Conn } from './db.ts';
import { invalid, newId, newSecret, notFound, sha256 } from './lib.ts';
import { initiativeById } from './initiatives.ts';
import { effectiveRoleModel, fallbackFor } from './models.ts';
import { recordClaudeUsage } from './telemetry.ts';

/**
 * The Operator: a Claude Code session on the Client's machine that the Client talks to from the dashboard.
 *
 * Triglav runs in Docker and cannot start processes, so the host runner owns the Claude process. The Client's messages
 * wait here as commands; the runner takes them (a long poll) and reports what the process says as events. Final
 * messages are stored, so a chat survives a restart of either side. Streamed text is only kept in memory.
 */

export const MAX_CHAT_TEXT = 8000;
export type ChatState = 'idle' | 'working' | 'stopped';
export type ChatMessage = { id: number; role: string; text: string; created_at: Date };

/** A change the Operator asked for. The Client confirms or denies it in the chat; see src/operator-actions.ts. */
export type ChatAction = { id: string; kind: string; summary: string; reason: string | null; state: string; result: string | null; created_at: Date };

const cleanText = (text: string) => {
  const t = text.trim();
  if (!t) throw invalid('Write a message first.');
  if (t.length > MAX_CHAT_TEXT) throw invalid(`A message can be at most ${MAX_CHAT_TEXT} characters.`);
  return t;
};

export async function addMessage(conn: Parameters<typeof exec>[0], ctx: Ctx, chatId: string, role: string, text: string): Promise<ChatMessage> {
  const at = ctx.clock.now();
  const res = await exec(conn, `INSERT INTO chat_messages (chat_id, role, text, created_at) VALUES (?, ?, ?, ?)`, [chatId, role, text, at]);
  await exec(conn, `UPDATE chats SET updated_at = ? WHERE id = ?`, [at, chatId]);
  return { id: res.insertId, role, text, created_at: at };
}

async function ask(conn: Parameters<typeof exec>[0], ctx: Ctx, chatId: string, text: string) {
  const message = await addMessage(conn, ctx, chatId, 'client', text);
  await exec(conn, `UPDATE chats SET state = 'working' WHERE id = ?`, [chatId]);
  const cleared = await queueSend(conn, ctx, chatId, text);
  return { message, cleared };
}

/**
 * Tells the Client something in the chat and hands the Operator the same news as its next message, so it carries on.
 * `toOperator` starts with [Triglav], so the Operator can tell it from the Client's own words.
 */
export async function notifyOperator(ctx: Ctx, chatId: string, visible: string, toOperator: string) {
  const { message, cleared } = await tx(ctx, async (conn) => {
    const m = await addMessage(conn, ctx, chatId, 'system', visible);
    await exec(conn, `UPDATE chats SET state = 'working' WHERE id = ?`, [chatId]);
    const cleared = await queueSend(conn, ctx, chatId, toOperator);
    return { message: m, cleared };
  });
  publish(chatId, { type: 'message', message });
  if (cleared) publishReplies(chatId, null);
  publish(chatId, { type: 'state', state: 'working' });
}

/** An initiative's Architect chat, made with the initiative (inside its import transaction). It starts on the first message. */
export async function insertArchitectChat(conn: Parameters<typeof exec>[0], chatId: string, title: string, initiativeId: string, now: Date) {
  await exec(conn, `INSERT INTO chats (id, title, state, kind, initiative_id, created_at, updated_at) VALUES (?, ?, 'stopped', 'architect', ?, ?, ?)`, [chatId, title.slice(0, 200), initiativeId, now, now]);
}

/** The initiative of an Architect chat, or null for any other chat. */
export async function architectChatInitiative(conn: Parameters<typeof queryOne>[0], chatId: string): Promise<string | null> {
  const c = await queryOne(conn, `SELECT initiative_id FROM chats WHERE id = ? AND kind = 'architect'`, [chatId]);
  return (c?.initiative_id as string | undefined) ?? null;
}

export async function createChat(ctx: Ctx, input: { text: string }) {
  const text = cleanText(input.text);
  const id = newId('cht');
  const now = ctx.clock.now();
  const message = await tx(ctx, async (conn) => {
    await exec(conn, `INSERT INTO chats (id, title, state, created_at, updated_at) VALUES (?, ?, 'working', ?, ?)`, [id, text.replace(/\s+/g, ' ').slice(0, 60), now, now]);
    return (await ask(conn, ctx, id, text)).message;
  });
  return { id, message };
}

export type ChatKind = 'operator' | 'architect';

/**
 * Every Client route of a chat names the kind it serves (`/api/chats` the Operator's, `/api/architect-chats` an
 * Architect's), and a chat of the other kind is not found there: the Operator page never reads or writes an Architect chat.
 */
async function chatOfKind(conn: Parameters<typeof exec>[0], chatId: string, kind: ChatKind, lock = false) {
  if (!(await queryOne(conn, `SELECT id FROM chats WHERE id = ? AND kind = ?${lock ? ' FOR UPDATE' : ''}`, [chatId, kind]))) throw notFound(`Chat ${chatId}`);
}
export const assertChatKind = (ctx: Ctx, chatId: string, kind: ChatKind) => chatOfKind(ctx.pool, chatId, kind);

export async function sendChatMessage(ctx: Ctx, chatId: string, input: { text: string }, kind: ChatKind) {
  const text = cleanText(input.text);
  const { message, cleared } = await tx(ctx, async (conn) => {
    await chatOfKind(conn, chatId, kind, true);
    return ask(conn, ctx, chatId, text);
  });
  publish(chatId, { type: 'message', message });
  if (cleared) publishReplies(chatId, null);
  publish(chatId, { type: 'state', state: 'working' });
  return { ok: true };
}

/** Ends the Claude process of a chat. The conversation is kept; the next message starts it again where it left off. */
export async function stopChat(ctx: Ctx, chatId: string, kind: ChatKind) {
  await tx(ctx, async (conn) => {
    await chatOfKind(conn, chatId, kind);
    await exec(conn, `INSERT INTO chat_commands (chat_id, kind, created_at) VALUES (?, 'stop', ?)`, [chatId, ctx.clock.now()]);
  });
  return { ok: true };
}

/** The Operator's chats. An Architect's chat belongs to its initiative room and is not listed here. */
export const listChats = (ctx: Ctx) => query(ctx.pool, `SELECT id, title, state, created_at, updated_at FROM chats WHERE kind = 'operator' ORDER BY updated_at DESC LIMIT 50`);

export async function getChat(ctx: Ctx, chatId: string, kind: ChatKind) {
  const chat = await queryOne(ctx.pool, `SELECT id, title, state, kind, initiative_id, suggested_replies, created_at, updated_at FROM chats WHERE id = ? AND kind = ?`, [chatId, kind]);
  if (!chat) throw notFound(`Chat ${chatId}`);
  const messages = await query(ctx.pool, `SELECT id, role, text, created_at FROM chat_messages WHERE chat_id = ? ORDER BY id DESC LIMIT 500`, [chatId]);
  const actions = await query(ctx.pool, `SELECT id, kind, summary, reason, state, result, created_at FROM chat_actions WHERE chat_id = ? ORDER BY created_at`, [chatId]);
  // The replies on offer are an Architect's; an Operator chat never has any, and never shows any.
  const { suggested_replies: raw, ...rest } = chat;
  const suggested_replies: string[] | null = kind === 'architect' && raw != null ? parseJson<string[]>(raw) : null;
  return { ...rest, suggested_replies, messages: messages.reverse(), actions };
}

/**
 * A fresh token for a chat, for the process the runner is about to start. Only its SHA-256 is stored, so the plain value
 * exists once: in this return value. It replaces the chat's earlier token, which ends the access of an older process. The
 * runner asks only when it starts a process; a token handed out with every message would cut off a process that is running.
 */
export async function issueChatToken(ctx: Ctx, chatId: string): Promise<string> {
  const token = newSecret('orch_chat_');
  const res = await exec(ctx.pool, `UPDATE chats SET token_hash = ? WHERE id = ?`, [sha256(token), chatId]);
  if (!res.affectedRows) throw notFound(`Chat ${chatId}`);
  return token;
}

/**
 * Ends a token when its process has ended. It clears the hash only if it is still this token's: a newer process of the
 * same chat has already replaced it, and an older process closing late must not cut that one off.
 */
export async function revokeChatToken(ctx: Ctx, chatId: string, token: string): Promise<void> {
  await exec(ctx.pool, `UPDATE chats SET token_hash = NULL WHERE id = ? AND token_hash = ?`, [chatId, sha256(token)]);
}

/**
 * The chat a token belongs to, if it is a chat of this kind. The Operator's tools and an Architect's tools use it to know
 * who is calling; a token of one kind never opens the other kind's tools.
 */
export const chatByToken = (ctx: Ctx, token: string, kind: ChatKind = 'operator') =>
  queryOne(ctx.pool, `SELECT id, title, initiative_id FROM chats WHERE token_hash = ? AND kind = ?`, [sha256(token), kind]);

/**
 * What the runner needs to start an Architect: the initiative's key, its repositories (for the read-only worktrees) and the
 * model of the architect role. Plain fields; the runner checks each one again and builds the command itself.
 */
export type ArchitectStart = { key: string; title: string; model: string; effort: string; repos: { slug: string; path: string; base: string }[] };
async function architectStart(ctx: Ctx, conn: Conn, chatId: string): Promise<ArchitectStart | null> {
  const initiativeId = await architectChatInitiative(conn, chatId);
  if (!initiativeId) return null;
  const i = await initiativeById(conn, initiativeId);
  // Claude Code only: a row that somehow names another runtime falls back to Triglav's Claude choice.
  const saved = await effectiveRoleModel(ctx, conn, 'architect');
  const m = saved?.runtime === 'claude-code' ? saved : fallbackFor('claude-code', 'architect');
  return { key: i.key, title: i.title, model: m?.model ?? 'claude-opus-5-5', effort: m?.effort ?? 'high', repos: i.repos.map((r) => ({ slug: r.slug, path: r.path, base: r.base })) };
}

/**
 * The next thing the runner must do, waiting up to waitMs for one. A plain transaction, not tx(): tx() announces a
 * change, and a poll that announced its own empty reads would wake itself. When the runner hangs up (`gone`), the poll
 * stops, and a command taken in that moment goes back to the queue: a runner that was restarted must not lose a message.
 */
export async function nextCommand(ctx: Ctx, waitMs: number, gone?: AbortSignal) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    if (gone?.aborted) return null;
    const c = await withTx(ctx.pool, async (conn) => {
      const row = await queryOne(
        conn,
        `SELECT c.id, c.kind, c.text, c.chat_id, h.session_id, h.kind AS chat_kind FROM chat_commands c JOIN chats h ON h.id = c.chat_id WHERE c.taken_at IS NULL ORDER BY c.id LIMIT 1 FOR UPDATE`,
      );
      if (!row) return null;
      // Read before the command is marked taken: a read that fails leaves the message in the queue. On this connection: the
      // transaction holds the write lock, and a second pool connection could wait behind writers that wait for the lock.
      const architect = row.chat_kind === 'architect' && row.kind === 'send' ? await architectStart(ctx, conn, row.chat_id as string) : null;
      // The Architect's next turn starts now. The replies it offered before this message are out of date, so they go; a reply
      // it offers during the new turn is kept.
      const cleared = architect !== null ? (await exec(conn, `UPDATE chats SET suggested_replies = NULL WHERE id = ? AND suggested_replies IS NOT NULL`, [row.chat_id])).affectedRows > 0 : false;
      await exec(conn, `UPDATE chat_commands SET taken_at = ? WHERE id = ?`, [ctx.clock.now(), row.id]);
      return { row, architect, cleared };
    });
    if (c?.cleared) publishReplies(c.row.chat_id as string, null);
    if (c && gone?.aborted) {
      await exec(ctx.pool, `UPDATE chat_commands SET taken_at = NULL WHERE id = ?`, [c.row.id]);
      return null;
    }
    if (c) {
      const { row } = c;
      const command = { kind: row.kind as string, chat_id: row.chat_id as string, text: (row.text as string | null) ?? '', session_id: (row.session_id as string | null) ?? null };
      if (row.chat_kind !== 'architect') return command;
      return { ...command, chat_kind: 'architect' as const, architect: c.architect };
    }
    const left = deadline - Date.now();
    if (left <= 0) return null;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        ctx.bus.off('change', done);
        gone?.removeEventListener('abort', done);
        resolve();
      };
      gone?.addEventListener('abort', done);
      const timer = setTimeout(done, Math.min(left, 2000));
      ctx.bus.once('change', done);
    });
  }
}

/**
 * The runner starts with no Claude process, so every chat that claimed to be running has stopped, and no token is in use:
 * one left by a runner that was killed before it could revoke it is cleared here.
 */
export async function resetChatStates(ctx: Ctx) {
  await exec(ctx.pool, `UPDATE chats SET state = 'stopped' WHERE state <> 'stopped'`);
  await exec(ctx.pool, `UPDATE chats SET token_hash = NULL WHERE token_hash IS NOT NULL`);
}

export type RunnerChatEvent =
  | { type: 'session'; session_id: string }
  | { type: 'delta'; text: string }
  | { type: 'message'; role: 'operator' | 'tool' | 'system'; text: string }
  | { type: 'state'; state: ChatState }
  | { type: 'usage'; windows: { window: string; used: number; resets_at: number | null }[] };

/** What the runner saw the Claude process do. */
export async function ingestChatEvents(ctx: Ctx, chatId: string, events: RunnerChatEvent[]) {
  if (!(await queryOne(ctx.pool, `SELECT id FROM chats WHERE id = ?`, [chatId]))) throw notFound(`Chat ${chatId}`);
  for (const e of events) {
    if (e.type === 'session') await exec(ctx.pool, `UPDATE chats SET session_id = ? WHERE id = ?`, [e.session_id, chatId]);
    else if (e.type === 'delta') publish(chatId, e);
    else if (e.type === 'message') publish(chatId, { type: 'message', message: await addMessage(ctx.pool, ctx, chatId, e.role, e.text) });
    else if (e.type === 'state') {
      await exec(ctx.pool, `UPDATE chats SET state = ? WHERE id = ?`, [e.state, chatId]);
      publish(chatId, e);
    } else if (e.type === 'usage') {
      for (const w of e.windows) {
        await recordClaudeUsage(ctx.pool, { window: w.window, used: w.used, resetsAt: w.resets_at ? new Date(w.resets_at * 1000) : null, at: ctx.clock.now(), source: 'stream' });
      }
    }
  }
}
