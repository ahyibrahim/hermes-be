import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

test('uses an environment-configured database path for room messages', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-test-'));
  const dbPath = path.join(tempDir, 'hermes.db');
  const defaultDbPath = path.resolve(process.cwd(), 'data', 'hermes.db');

  fs.rmSync(defaultDbPath, { force: true });
  process.env.HERMES_DB_PATH = dbPath;

  const { createMessage, listMessages } = await import('./db');

  const message = createMessage('general', 'alice', 'hello');
  const messages = listMessages('general');
  const hello = messages.filter((row) => row.sender === 'alice' && row.content === 'hello');

  assert.equal(message.content, 'hello');
  assert.equal(hello.length, 1);
  assert.ok(fs.existsSync(dbPath));
  assert.equal(fs.existsSync(defaultDbPath), false);
});
