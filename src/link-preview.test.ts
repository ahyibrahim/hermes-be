import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { AddressInfo } from 'node:net';
import {
  createLinkPreviewService,
  extractYouTubeDuration,
  isBlockedHostname,
  parsePreviewHtml,
} from './link-preview';
import { isPublicUnicast } from './safe-fetch';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

async function withServer(
  handler: http.RequestListener,
  run: (port: number, hits: () => number) => Promise<void>
): Promise<void> {
  let count = 0;
  const server = http.createServer((req, res) => {
    count += 1;
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(port, () => count);
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** Real transport, but 127.0.0.1 counts as "public" and the test port is allowed. */
function loopbackService(port: number, extra: Parameters<typeof createLinkPreviewService>[0] = {}) {
  return createLinkPreviewService({
    lookup: async () => ['127.0.0.1'],
    isAllowedAddress: (ip) => ip === '127.0.0.1',
    allowedPorts: new Set([String(port)]),
    ...extra,
  });
}

test('isBlockedHostname rejects private, local and non-unicast addresses', () => {
  for (const host of [
    '127.0.0.1',
    '10.0.0.5',
    '192.168.1.1',
    '169.254.169.254',
    '100.100.1.1',
    '198.18.0.1',
    '224.0.0.1',
    '255.255.255.255',
    '[::1]',
    '[::ffff:127.0.0.1]',
    '[64:ff9b::7f00:1]',
    '[2002:7f00:1::]',
    '[fec0::1]',
    '[fd7a:115c:a1e0::1]',
    'localhost',
    'foo.local',
    'router.home.arpa',
  ]) {
    assert.equal(isBlockedHostname(host), true, host);
  }
  assert.equal(isBlockedHostname('example.com'), false);
  assert.equal(isBlockedHostname('93.184.216.34'), false);
  assert.equal(isBlockedHostname('[2606:4700::1111]'), false);
  assert.equal(isPublicUnicast('not-an-ip'), false);
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
    fetchImpl: async (url) => {
      fetches += 1;
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

test('parser ignores tags inside scripts and non-http image URLs', () => {
  const preview = parsePreviewHtml(
    'https://example.com/',
    `<head><script>"<meta property='og:title' content='fake'>"</script>
     <title>Real &lt;title&gt;</title>
     <meta property="og:image" content="javascript:alert(1)">
     <link rel="icon" href="data:image/png;base64,AAAA"></head>`
  );
  assert.equal(preview.title, 'Real <title>');
  assert.equal(preview.image, null);
  assert.equal(preview.favicon, null);
});

test('parser stays linear on hostile markup', () => {
  const hostile =
    '<head>' + '<meta content="'.repeat(40_000) + '<link rel="icon '.repeat(40_000) + 'x'.repeat(200_000);
  const started = Date.now();
  parsePreviewHtml('https://example.com/', hostile);
  extractYouTubeDuration(hostile);
  assert.ok(Date.now() - started < 1_500, `took ${Date.now() - started} ms`);
});

test('fetch refuses private DNS before connecting', async () => {
  await withServer(
    (_req, res) => res.end('<title>should not load</title>'),
    async (port, hits) => {
      const service = createLinkPreviewService({
        lookup: async () => ['10.0.0.8'],
        allowedPorts: new Set([String(port)]),
      });
      assert.equal(await service.getPreview(`http://evil.example:${port}/`), null);
      assert.equal(await service.getPreview('http://127.0.0.1/'), null);
      assert.equal(await service.getPreview('ftp://example.com/x'), null);
      assert.equal(hits(), 0);
    }
  );
});

test('the checked address is the one dialled (one lookup per hop)', async () => {
  await withServer(
    (_req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end('<head><title>Pinned</title></head>');
    },
    async (port) => {
      let lookups = 0;
      const service = loopbackService(port, {
        // A rebinding name: public on the first answer, private afterwards.
        lookup: async () => {
          lookups += 1;
          return lookups === 1 ? ['127.0.0.1'] : ['127.0.0.2'];
        },
      });
      const preview = await service.getPreview(`http://rebind.example:${port}/`);
      assert.equal(preview?.title, 'Pinned');
      assert.equal(lookups, 1);
    }
  );
});

test('redirects are re-checked and ports other than the allowed ones refused', async () => {
  await withServer(
    (req, res) => {
      if (req.url === '/to-local') {
        res.writeHead(302, { location: 'http://localhost/' });
        res.end();
        return;
      }
      res.writeHead(302, { location: 'http://example.com:8080/' });
      res.end();
    },
    async (port, hits) => {
      const service = loopbackService(port);
      assert.equal(await service.getPreview(`http://a.example:${port}/to-local`), null);
      assert.equal(await service.getPreview(`http://a.example:${port}/to-port`), null);
      assert.equal(hits(), 2);
      const direct = createLinkPreviewService({
        fetchImpl: async () => {
          throw new Error('should not fetch');
        },
      });
      assert.equal(await direct.getPreview('https://example.com:8443/'), null);
    }
  );
});

test('a trickling body is cut off by the overall deadline', async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.write('<html><head>');
      const timer = setInterval(() => res.write(' '), 50);
      res.on('close', () => clearInterval(timer));
    },
    async (port) => {
      const service = loopbackService(port, { timeoutMs: 300 });
      const started = Date.now();
      assert.equal(await service.getPreview(`http://slow.example:${port}/`), null);
      assert.ok(Date.now() - started < 2_000);
    }
  );
});

test('reading stops at the end of the head', async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.write('<html><head><meta property="og:title" content="Early"></head><body>');
      // Never ends; the preview must not wait for it.
      const timer = setInterval(() => res.write('x'.repeat(1024)), 20);
      res.on('close', () => clearInterval(timer));
    },
    async (port) => {
      const service = loopbackService(port, { timeoutMs: 3_000 });
      const started = Date.now();
      const preview = await service.getPreview(`http://early.example:${port}/`);
      assert.equal(preview?.title, 'Early');
      assert.ok(Date.now() - started < 1_000);
    }
  );
});

test('preview images are proxied only when a preview named them, and only rasters', async () => {
  await withServer(
    (req, res) => {
      if (req.url === '/page') {
        res.setHeader('content-type', 'text/html');
        res.end('<head><title>T</title><meta property="og:image" content="/a.png"><link rel="icon" href="/i.svg"></head>');
      } else if (req.url === '/a.png') {
        res.setHeader('content-type', 'text/html');
        res.end(PNG);
      } else {
        res.setHeader('content-type', 'image/svg+xml');
        res.end('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
      }
    },
    async (port, hits) => {
      const service = loopbackService(port);
      const base = `http://img.example:${port}`;
      assert.equal(await service.getImage(`${base}/a.png`), null);
      assert.equal(hits(), 0);
      const preview = await service.getPreview(`${base}/page`);
      assert.equal(preview?.image, `${base}/a.png`);
      const image = await service.getImage(`${base}/a.png`);
      assert.equal(image?.type, 'image/png');
      assert.deepEqual(image?.bytes, PNG);
      assert.equal(await service.getImage(`${base}/i.svg`), null);
      const before = hits();
      await service.getImage(`${base}/a.png`);
      assert.equal(hits(), before, 'second image request served from cache');
    }
  );
});

test('YouTube previews use oEmbed for title and thumbnail', async () => {
  const service = createLinkPreviewService({
    fetchImpl: async (url) => {
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
  assert.equal(extractYouTubeDuration('{"lengthSeconds":"42"}'), 42);
});

test('standard YouTube thumbnails are proxied without a preview first', async () => {
  const seen: string[] = [];
  const service = createLinkPreviewService({
    fetchImpl: async (url) => {
      seen.push(url);
      return new Response(PNG, { status: 200 });
    },
  });
  const thumb = await service.getImage('https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg');
  assert.equal(thumb?.type, 'image/png');
  assert.equal(await service.getImage('https://i.ytimg.com/vi/dQw4w9WgXcQ/../../x.jpg'), null);
  assert.deepEqual(seen, ['https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg']);
});

test('GET /link-preview and /link-preview/image for members', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-link-preview-'));
  process.env.HERMES_DB_PATH = path.join(tempDir, 'hermes.db');
  process.env.HERMES_FILES_DIR = path.join(tempDir, 'files');

  const service = createLinkPreviewService({
    fetchImpl: async (url) =>
      url.endsWith('/card.png')
        ? new Response(PNG, { status: 200 })
        : new Response(
            '<html><head><meta property="og:title" content="Card" /><meta property="og:image" content="/card.png"></head></html>',
            { status: 200, headers: { 'content-type': 'text/html' } }
          ),
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
    const auth = { headers: { Authorization: `Bearer ${token}` } };

    const noAuth = await fetch(`${origin}/link-preview?url=${encodeURIComponent('https://example.com')}`);
    assert.equal(noAuth.status, 401);

    const ok = await fetch(`${origin}/link-preview?url=${encodeURIComponent('https://example.com/a')}`, auth);
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as { preview: { title: string; image: string } | null };
    assert.equal(body.preview?.title, 'Card');

    const img = await fetch(`${origin}/link-preview/image?url=${encodeURIComponent(body.preview!.image)}`, auth);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/png');
    assert.equal(img.headers.get('x-content-type-options'), 'nosniff');
    assert.match(img.headers.get('content-security-policy') ?? '', /sandbox/);

    const unknown = await fetch(
      `${origin}/link-preview/image?url=${encodeURIComponent('https://example.com/other.png')}`,
      auth
    );
    assert.equal(unknown.status, 404);

    const soft = await fetch(`${origin}/link-preview?url=${encodeURIComponent('http://127.0.0.1/')}`, auth);
    assert.equal(soft.status, 200);
    assert.deepEqual(await soft.json(), { preview: null });
  } finally {
    await app.close();
  }
});
