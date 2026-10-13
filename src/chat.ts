import { tx, type Ctx } from './context.ts';
import { exec, query, queryOne, withTx } from './db.ts';
import { invalid, newId, newSecret, notFound, sha256 } from './lib.ts';
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

/** What a dashboard that has a chat open receives while it streams. */
export type ChatEvent = { type: 'delta'; text: string } | { type: 'message'; message: ChatMessage } | { type: 'state'; state: ChatState } | { type: 'action'; action: ChatAction };

const live = new Map<string, { partial: string; listeners: Set<(e: ChatEvent) => void> }>();

function hub(chatId: string) {
  let h = live.get(chatId);
  if (!h) live.set(chatId, (h = { partial: '', listeners: new Set() }));
  return h;
}

export function publish(chatId: string, e: ChatEvent) {
  const h = live.get(chatId);
  if (!h) return;
  if (e.type === 'delta') h.partial += e.text;
  else if (e.type === 'message' && e.message.role === 'operator') h.partial = '';
  else if (e.type === 'state' && e.state !== 'working') h.partial = '';
  for (const l of h.listeners) l(e);
}

/** Listens to one chat. The snapshot is the text of the reply that is still streaming. */
export function subscribe(chatId: string, listener: (e: ChatEvent) => void) {
  const h = hub(chatId);
  h.listeners.add(listener);
  return {
    partial: h.partial,
    unsubscribe: () => {
      h.listeners.delete(listener);
      if (!h.listeners.size && !h.partial) live.delete(chatId);
    },
  };
}

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
  await exec(conn, `INSERT INTO chat_commands (chat_id, kind, text, created_at) VALUES (?, 'send', ?, ?)`, [chatId, text, ctx.clock.now()]);
  return message;
}

/**
 * Tells the Client something in the chat and hands the Operator the same news as its next message, so it carries on.
 * `toOperator` starts with [Triglav], so the Operator can tell it from the Client's own words.
 */
export async function notifyOperator(ctx: Ctx, chatId: string, visible: string, toOperator: string) {
  const message = await tx(ctx, async (conn) => {
    const m = await addMessage(conn, ctx, chatId, 'system', visible);
    await exec(conn, `UPDATE chats SET state = 'working' WHERE id = ?`, [chatId]);
    await exec(conn, `INSERT INTO chat_commands (chat_id, kind, text, created_at) VALUES (?, 'send', ?, ?)`, [chatId, toOperator, ctx.clock.now()]);
    return m;
  });
  publish(chatId, { type: 'message', message });
  publish(chatId, { type: 'state', state: 'working' });
}

export async function createChat(ctx: Ctx, input: { text: string }) {
  const text = cleanText(input.text);
  const id = newId('cht');
  const now = ctx.clock.now();
  const message = await tx(ctx, async (conn) => {
    await exec(conn, `INSERT INTO chats (id, title, state, created_at, updated_at) VALUES (?, ?, 'working', ?, ?)`, [id, text.replace(/\s+/g, ' ').slice(0, 60), now, now]);
    return ask(conn, ctx, id, text);
  });
  return { id, message };
}

export async function sendChatMessage(ctx: Ctx, chatId: string, input: { text: string }) {
  const text = cleanText(input.text);
  const message = await tx(ctx, async (conn) => {
    if (!(await queryOne(conn, `SELECT id FROM chats WHERE id = ? FOR UPDATE`, [chatId]))) throw notFound(`Chat ${chatId}`);
    return ask(conn, ctx, chatId, text);
  });
  publish(chatId, { type: 'message', message });
  publish(chatId, { type: 'state', state: 'working' });
  return { ok: true };
}

/** Ends the Claude process of a chat. The conversation is kept; the next message starts it again where it left off. */
export async function stopChat(ctx: Ctx, chatId: string) {
  await tx(ctx, async (conn) => {
    if (!(await queryOne(conn, `SELECT id FROM chats WHERE id = ?`, [chatId]))) throw notFound(`Chat ${chatId}`);
    await exec(conn, `INSERT INTO chat_commands (chat_id, kind, created_at) VALUES (?, 'stop', ?)`, [chatId, ctx.clock.now()]);
  });
  return { ok: true };
}

export const listChats = (ctx: Ctx) => query(ctx.pool, `SELECT id, title, state, created_at, updated_at FROM chats ORDER BY updated_at DESC LIMIT 50`);

export async function getChat(ctx: Ctx, chatId: string) {
  const chat = await queryOne(ctx.pool, `SELECT id, title, state, created_at, updated_at FROM chats WHERE id = ?`, [chatId]);
  if (!chat) throw notFound(`Chat ${chatId}`);
  const messages = await query(ctx.pool, `SELECT id, role, text, created_at FROM chat_messages WHERE chat_id = ? ORDER BY id DESC LIMIT 500`, [chatId]);
  const actions = await query(ctx.pool, `SELECT id, kind, summary, reason, state, result, created_at FROM chat_actions WHERE chat_id = ? ORDER BY created_at`, [chatId]);
  return { ...chat, messages: messages.reverse(), actions };
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

/** The chat a token belongs to. The Operator's tools use it to know who is calling. */
export const chatByToken = (ctx: Ctx, token: string) => queryOne(ctx.pool, `SELECT id, title FROM chats WHERE token_hash = ?`, [sha256(token)]);

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
        `SELECT c.id, c.kind, c.text, c.chat_id, h.session_id FROM chat_commands c JOIN chats h ON h.id = c.chat_id WHERE c.taken_at IS NULL ORDER BY c.id LIMIT 1 FOR UPDATE`,
      );
      if (row) await exec(conn, `UPDATE chat_commands SET taken_at = ? WHERE id = ?`, [ctx.clock.now(), row.id]);
      return row;
    });
    if (c && gone?.aborted) {
      await exec(ctx.pool, `UPDATE chat_commands SET taken_at = NULL WHERE id = ?`, [c.id]);
      return null;
    }
    if (c) return { kind: c.kind as string, chat_id: c.chat_id as string, text: (c.text as string | null) ?? '', session_id: (c.session_id as string | null) ?? null };
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

/** The runner starts with no Claude process, so every chat that claimed to be running has stopped. */
export const resetChatStates = (ctx: Ctx) => exec(ctx.pool, `UPDATE chats SET state = 'stopped' WHERE state <> 'stopped'`);

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
