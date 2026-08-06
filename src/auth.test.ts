import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

test('registers and authenticates a user with a token', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-auth-'));
  const dbPath = path.join(tempDir, 'hermes.db');

  process.env.HERMES_DB_PATH = dbPath;

  const { registerUser, loginUser } = await import('./auth');

  const user = registerUser('alice', 'hunter2');
  assert.equal(user.username, 'alice');

  const session = loginUser('alice', 'hunter2');
  assert.ok(session?.token);
  assert.equal(session?.username, 'alice');

  const badSession = loginUser('alice', 'wrong');
  assert.equal(badSession, null);
});
