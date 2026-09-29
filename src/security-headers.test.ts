import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-headers-'));
process.env.HERMES_DB_PATH = path.join(tempDir, 'hermes.db');
process.env.HERMES_FILES_DIR = path.join(tempDir, 'files');

test('every response carries the security headers', async () => {
  const { createApp } = await import('./app');
  const { app } = await createApp();
  try {
    for (const url of ['/health', '/rooms', '/no-such-route']) {
      const res = await app.inject({ method: 'GET', url });
      assert.equal(res.headers['x-content-type-options'], 'nosniff', url);
      assert.equal(res.headers['x-frame-options'], 'DENY', url);
      assert.match(String(res.headers['content-security-policy']), /frame-ancestors 'none'/, url);
      assert.match(String(res.headers['content-security-policy']), /form-action 'self'/, url);
      assert.ok(res.headers['strict-transport-security'], url);
      assert.ok(res.headers['referrer-policy'], url);
    }
  } finally {
    await app.close();
  }
});

test('5xx responses do not echo the internal error message', async () => {
  const { createApp } = await import('./app');
  const { app } = await createApp();
  app.get('/__boom', async () => {
    throw new Error('SQLITE_FULL: /var/lib/hermes/p1/hermes.db');
  });
  try {
    const res = await app.inject({ method: 'GET', url: '/__boom' });
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.includes('SQLITE_FULL'), false);
    assert.equal(res.body.includes('/var/lib'), false);
    assert.equal((res.json() as { error: string }).error, 'internal server error');
  } finally {
    await app.close();
  }
});
