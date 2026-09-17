import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AddressInfo } from 'node:net';
import {
  createLinkPreviewService,
  isBlockedHostname,
} from './link-preview';

test('isBlockedHostname rejects private and local names', () => {
  assert.equal(isBlockedHostname('127.0.0.1'), true);
  assert.equal(isBlockedHostname('10.0.0.5'), true);
  assert.equal(isBlockedHostname('192.168.1.1'), true);
  assert.equal(isBlockedHostname('169.254.169.254'), true);
  assert.equal(isBlockedHostname('localhost'), true);
  assert.equal(isBlockedHostname('foo.local'), true);
  assert.equal(isBlockedHostname('example.com'), false);
});

test('link preview parses OG tags and caches', async () => {
  let fetches = 0;
  const html = `
    <html><head>
      <meta property="og:title" content="Hello &amp; Friends" />
      <meta property="og:description" content="A page" />
      <meta property="og:image" content="/img.png" />
      <meta property="og:site_name" content="Example" />
      <link rel="icon" href="/logo.png" />
      <title>Fallback</title>
    </head></html>`;
  const service = createLinkPreviewService({
    lookup: async () => ['93.184.216.34'],
    fetchImpl: async (input) => {
      fetches += 1;
      const url = String(input);
      assert.equal(url, 'https://example.com/post');
      return new Response(html, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    },
  });

  const first = await service.getPreview('https://example.com/post');
  assert.deepEqual(first, {
    url: 'https://example.com/post',
    title: 'Hello & Friends',
    description: 'A page',
    image: 'https://example.com/img.png',
    site: 'Example',
    favicon: 'https://example.com/logo.png',
  });
  const second = await service.getPreview('https://example.com/post');
  assert.deepEqual(second, first);
  assert.equal(fetches, 1);
});

test('link preview fails soft for private DNS and blocked hosts', async () => {
  const service = createLinkPreviewService({
    lookup: async () => ['10.0.0.8'],
    fetchImpl: async () => {
      throw new Error('should not fetch');
    },
  });
  assert.equal(await service.getPreview('https://evil.example'), null);
  assert.equal(await service.getPreview('http://127.0.0.1/'), null);
  assert.equal(await service.getPreview('ftp://example.com/x'), null);
});

test('YouTube previews use oEmbed for title and thumbnail', async () => {
  const service = createLinkPreviewService({
    lookup: async () => ['142.251.150.4'],
    fetchImpl: async (input) => {
      const url = String(input);
      if (url.includes('oembed')) {
        return new Response(
          JSON.stringify({
            title: 'Never Gonna Give You Up',
            author_name: 'Rick Astley',
            author_url: 'https://www.youtube.com/@RickAstleyYT',
            thumbnail_url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      const html = `<meta itemprop="duration" content="PT3M33S" />`;
      return new Response(html, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    },
  });

  const preview = await service.getPreview('https://youtu.be/dQw4w9WgXcQ');
  assert.equal(preview?.title, 'Never Gonna Give You Up');
  assert.equal(preview?.author, 'Rick Astley');
  assert.equal(preview?.authorUrl, 'https://www.youtube.com/@RickAstleyYT');
  assert.equal(preview?.durationSeconds, 213);
  assert.equal(preview?.authorAvatar, undefined);
});

test('GET /link-preview returns cached metadata for members', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-link-preview-'));
  process.env.HERMES_DB_PATH = path.join(tempDir, 'hermes.db');
  process.env.HERMES_FILES_DIR = path.join(tempDir, 'files');

  const service = createLinkPreviewService({
    lookup: async () => ['1.2.3.4'],
    fetchImpl: async () =>
      new Response('<html><head><meta property="og:title" content="Card" /></head></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
  });

  const { createApp } = await import('./app');
  const { app } = await createApp({ linkPreview: service });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = (app.server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;

  try {
    await fetch(`${origin}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'previewer', password: 'hunter2' }),
    });
    const login = await fetch(`${origin}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'previewer', password: 'hunter2' }),
    });
    const { token } = (await login.json()) as { token: string };

    const noAuth = await fetch(`${origin}/link-preview?url=${encodeURIComponent('https://example.com')}`);
    assert.equal(noAuth.status, 401);

    const ok = await fetch(
      `${origin}/link-preview?url=${encodeURIComponent('https://example.com/a')}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as { preview: { title: string } | null };
    assert.equal(body.preview?.title, 'Card');

    const soft = await fetch(
      `${origin}/link-preview?url=${encodeURIComponent('http://127.0.0.1/')}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    assert.equal(soft.status, 200);
    assert.deepEqual(await soft.json(), { preview: null });
  } finally {
    await app.close();
  }
});
