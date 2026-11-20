import { describe, expect, it } from 'vitest';
import { checkImageBase64, MAX_IMAGE_BYTES, MAX_IMAGE_B64, MAX_IMAGES, sniffImageType } from '../src/image-types.ts';
import { checkedImages } from '../scripts/operator.ts';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const JPEG = Buffer.from('ffd8ffe000104a4649460001', 'hex');
const GIF = Buffer.from('GIF89a' + '\x01\x00\x01\x00', 'binary');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x20, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);
const sized = (head: Buffer, total: number) => Buffer.concat([head, Buffer.alloc(total - head.length)]);
const b64 = (bytes: Buffer) => bytes.toString('base64');

describe('the type of an image comes from its first bytes', () => {
  it('reads the four allowed types', () => {
    expect(sniffImageType(PNG)).toBe('image/png');
    expect(sniffImageType(JPEG)).toBe('image/jpeg');
    expect(sniffImageType(WEBP)).toBe('image/webp');
    expect(sniffImageType(GIF)).toBe('image/gif');
  });

  it('refuses what only looks like an image: a page, a vector image or a PDF is never stored', () => {
    expect(sniffImageType(Buffer.from('<html><script>alert(1)</script></html>'))).toBeNull();
    expect(sniffImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'))).toBeNull();
    expect(sniffImageType(Buffer.from('%PDF-1.7'))).toBeNull();
    // A short file that starts like a png is not one.
    expect(sniffImageType(Buffer.from('89504e47', 'hex'))).toBeNull();
    // RIFF without WEBP is a wave file, not an image.
    expect(sniffImageType(Buffer.from('RIFF\x00\x00\x00\x00WAVEfmt ', 'binary'))).toBeNull();
  });

  it('takes the type of a polyglot from its first bytes; a page behind a picture start is refused', () => {
    // A png with html after it is a png: it is served as image/png with nosniff, so a browser draws it and runs nothing.
    const polyglot = Buffer.concat([PNG, Buffer.from('<script>alert(1)</script>')]);
    expect(sniffImageType(polyglot)).toBe('image/png');
    expect(checkImageBase64(b64(polyglot))).toMatchObject({ ok: true, type: 'image/png' });
    // The same bytes behind an html start are refused.
    expect(checkImageBase64(b64(Buffer.concat([Buffer.from('<html>'), PNG])))).toMatchObject({ ok: false });
  });
});

describe('an image sent as base64', () => {
  it('is checked before it is decoded: a text of the wrong shape or of more than the limit is refused', () => {
    expect(checkImageBase64(b64(PNG))).toMatchObject({ ok: true, type: 'image/png', bytes: PNG.length });
    expect(checkImageBase64('')).toMatchObject({ ok: false });
    expect(checkImageBase64(b64(PNG) + '\n')).toMatchObject({ ok: false, reason: 'The image is not valid base64.' });
    expect(checkImageBase64('AAA')).toMatchObject({ ok: false });
    expect(checkImageBase64('AB==AAAA')).toMatchObject({ ok: false });
    expect(checkImageBase64('A'.repeat(MAX_IMAGE_B64 + 4))).toMatchObject({ ok: false, reason: 'Each image is at most 5 MB.' });
  });

  it('accepts an image of exactly 5 MB and refuses one byte more', () => {
    const atLimit = sized(PNG, MAX_IMAGE_BYTES);
    expect(checkImageBase64(b64(atLimit))).toMatchObject({ ok: true, bytes: MAX_IMAGE_BYTES });
    const over = sized(PNG, MAX_IMAGE_BYTES + 1);
    expect(checkImageBase64(b64(over))).toMatchObject({ ok: false, reason: 'Each image is at most 5 MB.' });
  });

  it('refuses a file that is not an image, by its bytes', () => {
    expect(checkImageBase64(b64(Buffer.from('hello, not a picture')))).toMatchObject({ ok: false, reason: 'Only png, jpeg, webp and gif images can be sent.' });
  });
});

describe('the runner checks the images of a command again', () => {
  it('lets a message without images through, and refuses more than four', () => {
    expect(checkedImages(undefined)).toEqual({ images: [] });
    expect(checkedImages([{ data: b64(PNG) }, { data: b64(JPEG) }])).toEqual({
      images: [
        { media_type: 'image/png', data: b64(PNG) },
        { media_type: 'image/jpeg', data: b64(JPEG) },
      ],
    });
    const five = Array.from({ length: MAX_IMAGES + 1 }, () => ({ data: b64(PNG) }));
    expect(checkedImages(five)).toEqual({ reason: 'The message has too many images.' });
    expect(checkedImages('png')).toHaveProperty('reason');
    expect(checkedImages([{ data: 42 }])).toEqual({ reason: 'An image is not image data.' });
  });

  it('never puts the data into a refusal, even for a big image that fails', () => {
    // A 5 MB text of a non-image: the refusal names the fault and nothing of the data, so a log line cannot leak it.
    const big = b64(Buffer.alloc(5 * 1024 * 1024, 0x41));
    const refused = checkedImages([{ data: big }]);
    expect(refused).toHaveProperty('reason');
    expect(JSON.stringify(refused)).not.toContain(big.slice(0, 64));
    expect((refused as { reason: string }).reason.length).toBeLessThan(200);
  });
});
