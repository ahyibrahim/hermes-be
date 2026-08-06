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
`);

export interface MessageRecord {
  id: number;
  room: string;
  sender: string;
  content: string;
  created_at: string;
}

export function listMessages(room: string): MessageRecord[] {
  const stmt = db.prepare(
    'SELECT id, room, sender, content, created_at FROM messages WHERE room = ? ORDER BY id ASC'
  );

  return stmt.all(room) as MessageRecord[];
}

export function createMessage(room: string, sender: string, content: string): MessageRecord {
  const stmt = db.prepare(
    'INSERT INTO messages (room, sender, content) VALUES (?, ?, ?)'
  );

  const result = stmt.run(room, sender, content);

  return {
    id: Number(result.lastInsertRowid),
    room,
    sender,
    content,
    created_at: new Date().toISOString(),
  };
}
