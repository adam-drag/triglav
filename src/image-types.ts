/**
 * The images a Client can send to an Architect (design v4, C-chat-images). This file imports nothing: the browser and the
 * server and the runner all check an image with it, and the web build stage copies it (see the Dockerfile).
 *
 * A type comes from the first bytes of the file, never from its name or the MIME type the browser reports.
 */

export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
export type ImageType = (typeof IMAGE_TYPES)[number];

/** At most this many images in one message. */
export const MAX_IMAGES = 4;
/** Each image, after decoding, at most this many bytes (5 MB). */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** The base64 text of an image at the limit: 4 characters for every 3 bytes, rounded up. */
export const MAX_IMAGE_B64 = 4 * Math.ceil(MAX_IMAGE_BYTES / 3);

/** The type of the image whose first bytes are `head`, or null when they are not one of the four image types. */
export function sniffImageType(head: Uint8Array): ImageType | null {
  const at = (offset: number, text: string) => text.split('').every((c, i) => head[offset + i] === c.charCodeAt(0));
  if (head.length >= 8 && head[0] === 0x89 && at(1, 'PNG') && head[4] === 0x0d && head[5] === 0x0a && head[6] === 0x1a && head[7] === 0x0a) return 'image/png';
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.length >= 12 && at(0, 'RIFF') && at(8, 'WEBP')) return 'image/webp';
  if (head.length >= 6 && (at(0, 'GIF87a') || at(0, 'GIF89a'))) return 'image/gif';
  return null;
}

// A flat pattern on purpose: a nested group of the 4-character blocks overflows the regex stack on a 5 MB text.
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export type ImageCheck = { ok: true; type: ImageType; bytes: number } | { ok: false; reason: string };

/**
 * Checks one image sent as base64 text: the length is capped before anything is decoded, the text must be canonical base64,
 * the decoded size must be at most 5 MB, and the type comes from the decoded first bytes. No Buffer here: the browser runs this too.
 */
export function checkImageBase64(data: string): ImageCheck {
  if (data.length === 0 || data.length > MAX_IMAGE_B64) return { ok: false, reason: 'Each image is at most 5 MB.' };
  if (data.length % 4 !== 0 || !BASE64.test(data)) return { ok: false, reason: 'The image is not valid base64.' };
  const pad = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  const bytes = (data.length / 4) * 3 - pad;
  if (bytes > MAX_IMAGE_BYTES) return { ok: false, reason: 'Each image is at most 5 MB.' };
  const type = sniffImageType(Uint8Array.from(atob(data.slice(0, 24)), (c) => c.charCodeAt(0)));
  if (!type) return { ok: false, reason: 'Only png, jpeg, webp and gif images can be sent.' };
  return { ok: true, type, bytes };
}
