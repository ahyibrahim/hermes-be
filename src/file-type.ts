import fs from 'node:fs';

export type InlineImageType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

const SNIFF_BYTES = 12;

function startsWith(head: Uint8Array, bytes: number[], offset = 0): boolean {
  if (head.length < offset + bytes.length) {
    return false;
  }
  return bytes.every((byte, index) => head[offset + index] === byte);
}

const ascii = (text: string): number[] => Array.from(text, (char) => char.charCodeAt(0));

/**
 * The raster formats Hermes will display inline, identified by magic bytes.
 * The uploader's MIME type and filename are never consulted: both are
 * attacker-controlled, and anything else rendered inline on the app origin
 * (SVG, HTML) can run script as Hermes.
 */
export function sniffInlineImage(head: Uint8Array): InlineImageType | null {
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return 'image/png';
  }
  if (startsWith(head, [0xff, 0xd8, 0xff])) {
    return 'image/jpeg';
  }
  if (startsWith(head, ascii('GIF87a')) || startsWith(head, ascii('GIF89a'))) {
    return 'image/gif';
  }
  if (startsWith(head, ascii('RIFF')) && startsWith(head, ascii('WEBP'), 8)) {
    return 'image/webp';
  }
  return null;
}

export function sniffInlineImageFile(filePath: string): InlineImageType | null {
  const head = Buffer.alloc(SNIFF_BYTES);
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, 'r');
    const read = fs.readSync(fd, head, 0, SNIFF_BYTES, 0);
    return sniffInlineImage(head.subarray(0, read));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
}

/**
 * Headers for any response that streams user-uploaded bytes. `nosniff` stops
 * the browser from second-guessing Content-Type, and the sandbox CSP means
 * that even if a file is opened directly it gets an opaque origin with no
 * script, so it cannot read Hermes storage.
 */
export const UPLOAD_RESPONSE_HEADERS: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
  'Cross-Origin-Resource-Policy': 'same-origin',
};
