import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';

const dbPath = process.env.HERMES_DB_PATH
  ? path.resolve(process.env.HERMES_DB_PATH)
  : path.resolve(process.cwd(), 'data', 'hermes.db');
const dbDirectory = path.dirname(dbPath);

if (!fs.existsSync(dbDirectory)) {
  fs.mkdirSync(dbDirectory, { recursive: true });
}

const db = new Database(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room TEXT NOT NULL,
    sender TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS rooms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS room_members (
    room TEXT NOT NULL,
    username TEXT NOT NULL,
    PRIMARY KEY (room, username)
  );

  CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room TEXT NOT NULL,
    uploader TEXT NOT NULL,
    original_name TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    path TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

const messageColumns = db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>;
if (!messageColumns.some((column) => column.name === 'file_id')) {
  db.exec('ALTER TABLE messages ADD COLUMN file_id INTEGER');
}

db.prepare('INSERT OR IGNORE INTO rooms (slug, name) VALUES (?, ?)').run('general', 'general');

export interface MessageRecord {
  id: number;
  room: string;
  sender: string;
  content: string;
  created_at: string;
  file_id?: number | null;
}

export interface RoomRecord {
  id: number;
  slug: string;
  name: string;
  created_at: string;
  members?: string[];
}

export interface FileRecord {
  id: number;
  room: string;
  uploader: string;
  original_name: string;
  mime: string;
  size: number;
  path: string;
  created_at: string;
}

export function listMessages(room: string): MessageRecord[] {
  const stmt = db.prepare(
    'SELECT id, room, sender, content, created_at, file_id FROM messages WHERE room = ? ORDER BY id ASC'
  );

  return stmt.all(room) as MessageRecord[];
}

export function createMessage(
  room: string,
  sender: string,
  content: string,
  fileId: number | null = null
): MessageRecord {
  const stmt = db.prepare(
    'INSERT INTO messages (room, sender, content, file_id) VALUES (?, ?, ?, ?)'
  );

  const result = stmt.run(room, sender, content, fileId);

  return {
    id: Number(result.lastInsertRowid),
    room,
    sender,
    content,
    created_at: new Date().toISOString(),
    file_id: fileId,
  };
}

export function ensureRoom(slug: string, name = slug): RoomRecord {
  db.prepare('INSERT OR IGNORE INTO rooms (slug, name) VALUES (?, ?)').run(slug, name);
  return getRoomBySlug(slug) as RoomRecord;
}

export function getRoomBySlug(slug: string): RoomRecord | undefined {
  return db.prepare('SELECT id, slug, name, created_at FROM rooms WHERE slug = ?').get(slug) as
    | RoomRecord
    | undefined;
}

export function addRoomMember(slug: string, username: string): void {
  ensureRoom(slug);
  db.prepare('INSERT OR IGNORE INTO room_members (room, username) VALUES (?, ?)').run(slug, username);
}

export function isRoomMember(slug: string, username: string): boolean {
  const row = db
    .prepare('SELECT 1 AS ok FROM room_members WHERE room = ? AND username = ?')
    .get(slug, username) as { ok: number } | undefined;
  return Boolean(row);
}

export function listRoomMembers(slug: string): string[] {
  const rows = db
    .prepare('SELECT username FROM room_members WHERE room = ? ORDER BY username ASC')
    .all(slug) as Array<{ username: string }>;
  return rows.map((row) => row.username);
}

export function listRooms(): RoomRecord[] {
  return db.prepare('SELECT id, slug, name, created_at FROM rooms ORDER BY id ASC').all() as RoomRecord[];
}

export function createFileRecord(
  room: string,
  uploader: string,
  originalName: string,
  mime: string,
  size: number,
  filePath: string
): FileRecord {
  const stmt = db.prepare(
    'INSERT INTO files (room, uploader, original_name, mime, size, path) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const result = stmt.run(room, uploader, originalName, mime, size, filePath);
  return {
    id: Number(result.lastInsertRowid),
    room,
    uploader,
    original_name: originalName,
    mime,
    size,
    path: filePath,
    created_at: new Date().toISOString(),
  };
}

export function getFileRecord(id: number): FileRecord | undefined {
  return db
    .prepare(
      'SELECT id, room, uploader, original_name, mime, size, path, created_at FROM files WHERE id = ?'
    )
    .get(id) as FileRecord | undefined;
}
