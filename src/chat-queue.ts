import type { Ctx } from './context.ts';
import { exec } from './db.ts';
import type { ChatAction, ChatMessage, ChatState } from './chat.ts';

/**
 * The live side of a chat (its stream listeners and the reply still streaming) and the one way a message is queued for a
 * chat's process (queueSend). They live here, not in chat.ts, because architect-wake.ts queues the Architect's wakes, and
 * chat.ts imports initiatives, models and telemetry, which import the event log, which imports architect-wake. Through
 * chat.ts that loop initialised splits.ts before its constants (MAX_PATH). This file imports only types from chat.ts.
 */

/** What a dashboard that has a chat open receives while it streams. */
export type ChatEvent = { type: 'delta'; text: string } | { type: 'message'; message: ChatMessage } | { type: 'state'; state: ChatState } | { type: 'action'; action: ChatAction } | { type: 'replies'; replies: string[] | null };

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

/** Publishes that a chat's suggested replies changed: the set the Architect offered, or null once they are cleared. */
export function publishReplies(chatId: string, replies: string[] | null) {
  publish(chatId, { type: 'replies', replies });
}

/**
 * Queues a message for a chat's process (a 'send' command) and clears the replies on offer, in the caller's transaction.
 * Every message to an Architect goes through here: the Client's, a Triglav wake, a notice to the Operator. Returns whether
 * replies were cleared, so the caller can publish the clear once the transaction has committed. Nothing else clears them:
 * the Architect's own message does not, since its replies usually come before that message is stored.
 */
export async function queueSend(conn: Parameters<typeof exec>[0], ctx: Ctx, chatId: string, text: string): Promise<boolean> {
  await exec(conn, `INSERT INTO chat_commands (chat_id, kind, text, created_at) VALUES (?, 'send', ?, ?)`, [chatId, text, ctx.clock.now()]);
  const res = await exec(conn, `UPDATE chats SET suggested_replies = NULL WHERE id = ? AND suggested_replies IS NOT NULL`, [chatId]);
  return res.affectedRows > 0;
}
