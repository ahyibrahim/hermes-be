import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-static-'));
process.env.HERMES_DB_PATH = path.join(tempDir, 'hermes.db');
process.env.HERMES_FILES_DIR = path.join(tempDir, 'files');

const INDEX_HTML = '<!doctype html><html><head><title>Hermes</title></head><body>spa</body></html>\n';
const APP_JS = 'console.log("hermes-web");\n';

function writeBundle(): string {
  const webDir = fs.mkdtempSync(path.join(tempDir, 'web-'));
  fs.writeFileSync(path.join(webDir, 'index.html'), INDEX_HTML);
  fs.mkdirSync(path.join(webDir, 'assets'));
  fs.writeFileSync(path.join(webDir, 'assets', 'app.js'), APP_JS);
  return webDir;
}

test('createApp and GET /health still work when HERMES_WEB_DIR is unset', async () => {
  const previous = process.env.HERMES_WEB_DIR;
  delete process.env.HERMES_WEB_DIR;

  const { createApp } = await import('./app');
  const { app } = await createApp();

  try {
    const response = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(response.statusCode, 200);
    const body = response.json() as { status: string; service: string };
    assert.equal(body.status, 'ok');
    assert.equal(body.service, 'hermes-be');
    assert.match(response.headers['content-type'] ?? '', /application\/json/);
  } finally {
    await app.close();
    if (previous === undefined) {
      delete process.env.HERMES_WEB_DIR;
    } else {
      process.env.HERMES_WEB_DIR = previous;
    }
  }
});

test('createApp is a no-op when HERMES_WEB_DIR points at a missing directory', async () => {
  process.env.HERMES_WEB_DIR = path.join(tempDir, 'does-not-exist');

  const { createApp } = await import('./app');
  const { app } = await createApp();

  try {
    const response = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().status, 'ok');
  } finally {
    await app.close();
    delete process.env.HERMES_WEB_DIR;
  }
});

test('HERMES_WEB_DIR serves the SPA without swallowing API routes', async () => {
  const webDir = writeBundle();
  process.env.HERMES_WEB_DIR = webDir;

  const { createApp } = await import('./app');
  const { app } = await createApp();

  try {
    const root = await app.inject({ method: 'GET', url: '/' });
    assert.equal(root.statusCode, 200);
    assert.equal(root.body, INDEX_HTML);
    assert.match(root.headers['content-type'] ?? '', /text\/html/);

    const asset = await app.inject({ method: 'GET', url: '/assets/app.js' });
    assert.equal(asset.statusCode, 200);
    assert.equal(asset.body, APP_JS);

    const health = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { accept: 'text/html' },
    });
    assert.equal(health.statusCode, 200);
    const healthBody = health.json() as { status: string; service: string };
    assert.equal(healthBody.status, 'ok');
    assert.equal(healthBody.service, 'hermes-be');
    assert.match(health.headers['content-type'] ?? '', /application\/json/);

    const rooms = await app.inject({
      method: 'GET',
      url: '/rooms',
      headers: { accept: 'text/html' },
    });
    assert.equal(rooms.statusCode, 401);
    assert.equal(rooms.json().error, 'authentication required');
    assert.match(rooms.headers['content-type'] ?? '', /application\/json/);

    for (const spaPath of ['/login', '/rooms-ui']) {
      const page = await app.inject({
        method: 'GET',
        url: spaPath,
        headers: { accept: 'text/html' },
      });
      assert.equal(page.statusCode, 200, `${spaPath} should fall back to index.html`);
      assert.equal(page.body, INDEX_HTML);
      assert.match(page.headers['content-type'] ?? '', /text\/html/);
    }

    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: {
        'content-type': 'application/json',
        accept: 'text/html',
      },
      payload: {},
    });
    assert.equal(login.statusCode, 400);
    assert.equal(login.json().error, 'username and password are required');
    assert.match(login.headers['content-type'] ?? '', /application\/json/);
    assert.equal(login.body.includes('<html>'), false);
  } finally {
    await app.close();
    delete process.env.HERMES_WEB_DIR;
  }
});

test('API 404s stay JSON even when a web bundle is mounted', async () => {
  process.env.HERMES_WEB_DIR = writeBundle();

  const { createApp } = await import('./app');
  const { app } = await createApp();

  try {
    const missingAuth = await app.inject({
      method: 'GET',
      url: '/auth/not-a-route',
      headers: { accept: 'text/html' },
    });
    assert.equal(missingAuth.statusCode, 404);
    assert.equal(missingAuth.json().error, 'Not Found');
    assert.match(missingAuth.headers['content-type'] ?? '', /application\/json/);
    assert.equal(missingAuth.body.includes('<html>'), false);

    const jsonNav = await app.inject({
      method: 'GET',
      url: '/login',
      headers: { accept: 'application/json' },
    });
    assert.equal(jsonNav.statusCode, 404);
    assert.equal(jsonNav.json().error, 'Not Found');
  } finally {
    await app.close();
    delete process.env.HERMES_WEB_DIR;
  }
});
