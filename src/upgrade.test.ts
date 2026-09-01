import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { migrateSchema } from './schema';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-upgrade-'));

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/**
 * Before v0.3.0, auth.ts opened its own connection and created `users` itself
 * while schema.ts created everything else. Databases on the host already look
 * like this, so opening one must be a no-op apart from adding `sessions`.
 */
function seedPreV030Database(dbPath: string, options: { usersCreatedAt: boolean }): void {
  const db = new Database(dbPath);

  migrateSchema(db);
  db.prepare('INSERT INTO messages (room, sender, content) VALUES (?, ?, ?)').run(
    'general',
    'legacy',
    'history from before the upgrade'
  );

  // Roll the two v0.3.0 changes back: sessions did not exist, and `users` was
  // whatever the old auth.ts happened to create. Drop membership first so
  // foreign keys do not block dropping users.
  db.exec('DELETE FROM room_members');
  db.exec('DROP TABLE sessions');
  db.exec('DROP TABLE users');
  db.exec(
    options.usersCreatedAt
      ? `CREATE TABLE users (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           username TEXT NOT NULL UNIQUE,
           password TEXT NOT NULL,
           created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
         );`
      : `CREATE TABLE users (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           username TEXT NOT NULL UNIQUE,
           password TEXT NOT NULL
         );`
  );
  db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run('legacy', sha256('hunter2'));
  db.close();
}

test('an already-populated pre-v0.3.0 database opens cleanly and its users can log in', async () => {
  const dbPath = path.join(tempDir, 'populated.db');
  seedPreV030Database(dbPath, { usersCreatedAt: true });

  process.env.HERMES_DB_PATH = dbPath;
  const { closeDb, getDb } = await import('./database');
  closeDb();

  const { loginUser, registerUser } = await import('./auth');
  const { findSessionUser } = await import('./sessions');
  const { listMessages } = await import('./db');

  const session = await loginUser('legacy', 'hunter2');
  assert.ok(session?.token, 'a user registered by the old code path must still be able to log in');
  assert.equal(session?.username, 'legacy');
  assert.equal(findSessionUser(session!.token), 'legacy');
  assert.equal(await loginUser('legacy', 'wrong'), null);

  const history = listMessages('general');
  assert.equal(history.length, 1);
  assert.equal(history[0].content, 'history from before the upgrade');

  const fresh = await registerUser('newcomer', 'hunter2');
  assert.equal(fresh.username, 'newcomer');

  const users = getDb().prepare('SELECT username FROM users ORDER BY id').all() as Array<{
    username: string;
  }>;
  assert.deepEqual(
    users.map((row) => row.username),
    ['legacy', 'newcomer']
  );

  closeDb();
});

test('a users table created without created_at gets the column backfilled', async () => {
  const dbPath = path.join(tempDir, 'no-created-at.db');
  seedPreV030Database(dbPath, { usersCreatedAt: false });

  process.env.HERMES_DB_PATH = dbPath;
  const { closeDb, getDb } = await import('./database');
  closeDb();

  const { loginUser } = await import('./auth');
  assert.ok((await loginUser('legacy', 'hunter2'))?.token);

  const row = getDb().prepare('SELECT created_at FROM users WHERE username = ?').get('legacy') as {
    created_at: string | null;
  };
  assert.ok(row.created_at, 'created_at should be backfilled rather than left empty');

  closeDb();
});

test('migrating twice is a no-op', () => {
  const dbPath = path.join(tempDir, 'idempotent.db');
  seedPreV030Database(dbPath, { usersCreatedAt: true });

  const db = new Database(dbPath);
  migrateSchema(db);
  migrateSchema(db);

  const tables = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
      (row) => row.name
    )
  );
  for (const table of ['users', 'sessions', 'messages', 'rooms', 'room_members', 'files']) {
    assert.ok(tables.has(table), `expected table ${table}`);
  }

  const messages = db.prepare('SELECT COUNT(*) AS count FROM messages').get() as { count: number };
  assert.equal(messages.count, 1);
  db.close();
});
