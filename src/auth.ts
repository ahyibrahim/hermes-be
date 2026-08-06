import crypto from 'node:crypto';
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
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

export interface AuthUser {
  id: number;
  username: string;
  password: string;
}

export interface AuthSession {
  username: string;
  token: string;
}

function hashPassword(password: string): string {
  return crypto.createHash('sha256').update(password).digest('hex');
}

export function registerUser(username: string, password: string): AuthUser {
  const normalizedUsername = username.trim().toLowerCase();
  if (!normalizedUsername || !password.trim()) {
    throw new Error('username and password are required');
  }

  const stmt = db.prepare('INSERT INTO users (username, password) VALUES (?, ?)');
  const result = stmt.run(normalizedUsername, hashPassword(password));

  return {
    id: Number(result.lastInsertRowid),
    username: normalizedUsername,
    password: hashPassword(password),
  };
}

export function loginUser(username: string, password: string): AuthSession | null {
  const normalizedUsername = username.trim().toLowerCase();
  const stmt = db.prepare('SELECT id, username, password FROM users WHERE username = ?');
  const user = stmt.get(normalizedUsername) as AuthUser | undefined;

  if (!user || user.password !== hashPassword(password)) {
    return null;
  }

  return {
    username: user.username,
    token: crypto.randomUUID(),
  };
}
