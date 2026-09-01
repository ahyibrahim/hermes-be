import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

test('registers with argon2id, first user is admin, SHA256 rehashes on login', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-auth-'));
  process.env.HERMES_DB_PATH = path.join(tempDir, 'hermes.db');

  const { closeDb } = await import('./database');
  closeDb();
  const { registerUser, loginUser, getProfile } = await import('./auth');
  const { getDb } = await import('./database');

  const alice = await registerUser('alice', 'hunter2');
  assert.equal(alice.username, 'alice');
  assert.equal(alice.role, 'admin');
  const stored = getDb().prepare('SELECT password FROM users WHERE username = ?').get('alice') as {
    password: string;
  };
  assert.ok(stored.password.startsWith('$argon2id$'));

  const session = await loginUser('alice', 'hunter2');
  assert.ok(session?.token);
  assert.equal(session?.username, 'alice');
  assert.equal(await loginUser('alice', 'wrong'), null);

  const bob = await registerUser('bob', 'hunter2');
  assert.equal(bob.role, 'member');
  assert.equal(getProfile('bob')?.role, 'member');

  const legacyHash = crypto.createHash('sha256').update('oldpass').digest('hex');
  getDb()
    .prepare("INSERT INTO users (username, password, role) VALUES ('legacy', ?, 'member')")
    .run(legacyHash);
  const upgraded = await loginUser('legacy', 'oldpass');
  assert.ok(upgraded?.token);
  const after = getDb().prepare('SELECT password FROM users WHERE username = ?').get('legacy') as {
    password: string;
  };
  assert.ok(after.password.startsWith('$argon2id$'));
  assert.ok(await loginUser('legacy', 'oldpass'));
});
