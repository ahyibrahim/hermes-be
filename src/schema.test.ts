import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { migrateSchema } from './schema';

test('migrates slug+username membership to room_id+user_id and keeps message history', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-schema-'));
  const dbPath = path.join(tempDir, 'hermes.db');
  const db = new Database(dbPath);

  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL
    );
    CREATE TABLE rooms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL
    );
    CREATE TABLE room_members (
      room TEXT NOT NULL,
      username TEXT NOT NULL,
      PRIMARY KEY (room, username)
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room TEXT,
      sender TEXT,
      content TEXT
    );
    INSERT INTO users (username, password) VALUES ('alice', 'x');
    INSERT INTO rooms (slug, name) VALUES ('general', 'general');
    INSERT INTO room_members (room, username) VALUES ('general', 'alice');
    INSERT INTO messages (room, sender, content) VALUES ('general', 'alice', 'legacy hello');
  `);

  const first: Array<Record<string, unknown>> = [];
  migrateSchema(db, {
    info(obj) {
      first.push(obj);
    },
  });

  assert.ok(
    first.some(
      (row) => row.step === 'rebuild_table' && row.table === 'room_members' && row.applied === true
    ),
    'slug membership is rewritten to foreign keys'
  );
  assert.ok(
    first.some((row) => row.step === 'add_column' && row.table === 'rooms' && row.column === 'type')
  );

  const memberCols = new Set(
    (db.prepare('PRAGMA table_info(room_members)').all() as Array<{ name: string }>).map(
      (row) => row.name
    )
  );
  assert.ok(memberCols.has('room_id'));
  assert.ok(memberCols.has('user_id'));
  assert.equal(memberCols.has('room'), false);

  const members = db
    .prepare(
      `SELECT u.username
       FROM room_members rm
       JOIN users u ON u.id = rm.user_id
       JOIN rooms r ON r.id = rm.room_id
       WHERE r.slug = 'general'`
    )
    .all() as Array<{ username: string }>;
  assert.deepEqual(
    members.map((row) => row.username).sort(),
    ['alice', 'hermes']
  );

  const history = db.prepare('SELECT room, content FROM messages').all() as Array<{
    content: string;
  }>;
  assert.ok(history.some((message) => message.content === 'legacy hello'));

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
});

test('legacy rooms without slug still rebuild, then membership becomes FK', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-schema-legacy-'));
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

  const rooms = db.prepare('SELECT slug, type FROM rooms').all() as Array<{ slug: string; type: string }>;
  assert.ok(rooms.some((room) => room.slug === 'general'));
  assert.ok(rooms.every((room) => room.type === 'group'));
});
