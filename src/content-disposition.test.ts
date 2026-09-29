import test from 'node:test';
import assert from 'node:assert/strict';
import { asciiFilename, buildContentDisposition, encodeRfc5987 } from './content-disposition';
import { sniffInlineImage } from './file-type';

const bytes = (...values: Array<number | string>): Uint8Array =>
  Uint8Array.from(
    values.flatMap((value) => (typeof value === 'string' ? Array.from(value, (c) => c.charCodeAt(0)) : [value]))
  );

test('sniffInlineImage recognises png, jpeg, gif and webp by magic bytes', () => {
  assert.equal(sniffInlineImage(bytes(0x89, 'PNG', 0x0d, 0x0a, 0x1a, 0x0a)), 'image/png');
  assert.equal(sniffInlineImage(bytes(0xff, 0xd8, 0xff, 0xe0)), 'image/jpeg');
  assert.equal(sniffInlineImage(bytes('GIF89a')), 'image/gif');
  assert.equal(sniffInlineImage(bytes('GIF87a')), 'image/gif');
  assert.equal(sniffInlineImage(bytes('RIFF', 0, 0, 0, 0, 'WEBP')), 'image/webp');
});

test('sniffInlineImage refuses svg, html, bmp and short input', () => {
  assert.equal(sniffInlineImage(bytes('<svg xmlns="http://www.w3.org/2000/svg">')), null);
  assert.equal(sniffInlineImage(bytes('<!doctype html><script>')), null);
  assert.equal(sniffInlineImage(bytes('BM')), null);
  assert.equal(sniffInlineImage(bytes('RIFF', 0, 0, 0, 0, 'WAVE')), null);
  assert.equal(sniffInlineImage(bytes(0xff, 0xd8)), null);
  assert.equal(sniffInlineImage(new Uint8Array()), null);
});

test('asciiFilename replaces non-ASCII including U+202F', () => {
  const name = 'Screenshot 2026-09-16 at 3.08.06\u202Fpm.jpg';
  const ascii = asciiFilename(name);
  assert.match(ascii, /^[\x20-\x7E]+$/);
  assert.ok(ascii.includes('Screenshot'));
  assert.ok(ascii.endsWith('.jpg'));
  assert.ok(!ascii.includes('\u202F'));
});

test('buildContentDisposition emits ASCII filename plus RFC 5987 filename*', () => {
  const name = 'Screenshot 2026-09-16 at 3.08.06\u202Fpm.jpg';
  const header = buildContentDisposition('attachment', name);
  assert.match(header, /^attachment; filename="[\x20-\x7E]+"; filename\*=UTF-8''/);
  assert.ok(header.includes(encodeRfc5987(name)));
  // Header value itself must be Latin-1 / ASCII-safe for Node.
  assert.match(header, /^[\x20-\x7E]+$/);
});

test('buildContentDisposition supports inline for image-by-extension', () => {
  const header = buildContentDisposition('inline', 'pic.webp');
  assert.ok(header.startsWith('inline;'));
  assert.ok(header.includes('filename="pic.webp"'));
});
