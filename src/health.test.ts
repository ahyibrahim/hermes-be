import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-health-'));
process.env.HERMES_DB_PATH = path.join(tempDir, 'hermes.db');
process.env.HERMES_FILES_DIR = path.join(tempDir, 'files');
delete process.env.HERMES_GIT_COMMIT;

const packageVersion = (
  JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8')) as {
    version: string;
  }
).version;

test('the commit falls back to unknown when git cannot be run', async () => {
  const { buildInfo } = await import('./build-info');

  const realPath = process.env.PATH;
  process.env.PATH = path.join(tempDir, 'no-binaries-here');
  try {
    const info = buildInfo();
    assert.equal(info.version, packageVersion);
    assert.equal(info.commit, 'unknown');
  } finally {
    process.env.PATH = realPath;
  }
});

test('GET /health reports the package version and the deployed commit', async () => {
  process.env.HERMES_GIT_COMMIT = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

  const { createApp } = await import('./app');
  const { app } = await createApp();

  try {
    const response = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(response.statusCode, 200);

    const body = response.json() as Record<string, string>;
    assert.equal(body.status, 'ok');
    assert.equal(body.service, 'hermes-be');
    assert.equal(body.message, 'Backend is running');
    assert.equal(body.version, packageVersion);
    assert.equal(body.commit, 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678');
  } finally {
    await app.close();
    delete process.env.HERMES_GIT_COMMIT;
  }
});
