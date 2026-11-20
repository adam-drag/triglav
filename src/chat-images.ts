import type { Conn } from './db.ts';
import { exec, query, queryOne } from './db.ts';
import { checkImageBase64, MAX_IMAGES, MAX_IMAGE_B64, type ImageType } from './image-types.ts';
import { invalid, newId, notFound } from './lib.ts';

/**
 * Images in the Architect's chat (design v4, C-chat-images). The bytes stay in MySQL with the chat. Nothing reads them but the
 * Client's session (the image route) and the runner's handout of the command that carries them (src/chat.ts nextCommand).
 * This file is server-side: the checks that the browser also runs are in src/image-types.ts.
 */

/** The body limit of the Architect's message route: every image as base64, plus room for the text and the JSON. */
export const ARCHITECT_BODY_LIMIT = MAX_IMAGES * MAX_IMAGE_B64 + 1_000_000;

export type ChatImage = { media_type: ImageType; bytes: Buffer };

/** The images of one message, checked and decoded. Throws a 400 that names the image, never its data. */
export function decodeImages(list: { data: string }[] | undefined): ChatImage[] {
  if (!list?.length) return [];
  if (list.length > MAX_IMAGES) throw invalid(`A message can carry at most ${MAX_IMAGES} images.`);
  return list.map((img, n) => {
    const c = checkImageBase64(img.data);
    if (!c.ok) throw invalid(`Image ${n + 1}: ${c.reason}`);
    return { media_type: c.type, bytes: Buffer.from(img.data, 'base64') };
  });
}

/** Stores the images of a Client message; returns their ids in the order they were sent. Runs inside the caller's transaction. */
export async function storeImages(conn: Conn, chatId: string, messageId: number, images: ChatImage[], now: Date): Promise<string[]> {
  const ids: string[] = [];
  for (const [position, img] of images.entries()) {
    const id = newId('img');
    await exec(conn, `INSERT INTO chat_images (id, chat_id, message_id, position, media_type, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, [id, chatId, messageId, position, img.media_type, img.bytes, now]);
    ids.push(id);
  }
  return ids;
}

/** The images of one message, in the order sent, read when its command is handed out. Not run inside the write lock (see nextCommand). */
export const imagesOf = (conn: Conn, chatId: string, messageId: number) =>
  query(conn, `SELECT media_type, bytes FROM chat_images WHERE chat_id = ? AND message_id = ? ORDER BY position`, [chatId, messageId]) as Promise<ChatImage[]>;

/** The image ids of each message of a chat, in the order sent, without the bytes. */
export async function imageIdsOf(conn: Conn, chatId: string): Promise<Map<number, string[]>> {
  const out = new Map<number, string[]>();
  for (const r of await query(conn, `SELECT id, message_id FROM chat_images WHERE chat_id = ? ORDER BY message_id, position`, [chatId])) {
    const list = out.get(Number(r.message_id)) ?? [];
    list.push(r.id as string);
    out.set(Number(r.message_id), list);
  }
  return out;
}

/** One image of an Architect chat, for the Client's session. Another chat's image, or one of an Operator chat, is not found. */
export async function architectImage(conn: Conn, chatId: string, imageId: string): Promise<ChatImage> {
  const row = await queryOne(conn, `SELECT i.media_type, i.bytes FROM chat_images i JOIN chats c ON c.id = i.chat_id WHERE i.id = ? AND i.chat_id = ? AND c.kind = 'architect'`, [imageId, chatId]);
  if (!row) throw notFound(`Image ${imageId}`);
  return { media_type: row.media_type as ImageType, bytes: row.bytes as Buffer };
}
