import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { migrateSchema } from './schema';

test('migrates an older sqlite schema to rooms, members, and message columns', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-schema-'));
  const dbPath = path.join(tempDir, 'hermes.db');
  const db = new Database(dbPath);

  db.exec(`
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender TEXT,
      content TEXT
    );
    CREATE TABLE rooms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT
    );
    CREATE TABLE room_members (
      room_id INTEGER,
      user_id INTEGER
    );
    INSERT INTO rooms (name) VALUES ('general');
    INSERT INTO messages (sender, content) VALUES ('alice', 'legacy hello');
  `);

  const first: Array<Record<string, unknown>> = [];
  migrateSchema(db, {
    info(obj) {
      first.push(obj);
    },
  });
  assert.ok(
    first.some((row) => row.step === 'rebuild_table' && row.table === 'rooms' && row.applied === true),
    'legacy rooms without slug are rebuilt'
  );
  assert.ok(
    first.some((row) => row.step === 'rebuild_table' && row.table === 'room_members' && row.applied === true),
    'legacy room_members without room+username are rebuilt'
  );
  assert.ok(
    first.some((row) => row.step === 'add_column' && row.table === 'messages' && row.column === 'room' && row.applied === true)
  );
  assert.ok(
    first.some((row) => row.step === 'create_table' && row.table === 'users' && row.applied === true)
  );
  assert.ok(
    first.some((row) => row.event === 'migrate' && row.applied === false),
    'no-op steps are logged on the first pass too'
  );

  const steps: Array<Record<string, unknown>> = [];
  migrateSchema(db, {
    info(obj) {
      steps.push(obj);
    },
  });
  assert.ok(steps.length > 0, 'second migrateSchema pass still logs');
  assert.ok(
    steps.every((row) => row.event === 'migrate' && row.applied === false),
    'a second pass against an already-migrated schema is all no-ops'
  );

  const rooms = db.prepare('SELECT slug, name FROM rooms ORDER BY id').all() as Array<{ slug: string }>;
  assert.ok(rooms.some((room) => room.slug === 'general'));

  db.prepare('INSERT OR IGNORE INTO room_members (room, username) VALUES (?, ?)').run('general', 'alice');
  const members = db.prepare('SELECT username FROM room_members WHERE room = ?').all('general') as Array<{
    username: string;
  }>;
  assert.deepEqual(members.map((row) => row.username), ['alice']);

  const history = db.prepare('SELECT room, sender, content FROM messages').all() as Array<{
    room: string;
    content: string;
  }>;
  assert.ok(history.some((message) => message.content === 'legacy hello'));
  assert.ok(history.every((message) => message.room === 'general'));

  db.prepare('INSERT INTO messages (room, sender, content) VALUES (?, ?, ?)').run(
    'general',
    'alice',
    'after migrate'
  );
});
