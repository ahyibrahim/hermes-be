import test from 'node:test';
import assert from 'node:assert/strict';
import {
  asciiFilename,
  buildContentDisposition,
  encodeRfc5987,
  isImageFile,
} from './content-disposition';

test('isImageFile trusts image mime and common extensions', () => {
  assert.equal(isImageFile('image/jpeg', 'x.bin'), true);
  assert.equal(isImageFile('application/octet-stream', 'Screenshot.jpg'), true);
  assert.equal(isImageFile('text/plain', 'note.txt'), false);
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
