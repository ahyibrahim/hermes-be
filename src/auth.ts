import crypto from 'node:crypto';
import { getDb } from './database';
import { createSession } from './sessions';

export interface AuthUser {
  id: number;
  username: string;
  password: string;
}

export interface AuthSession {
  username: string;
  token: string;
  expires_at: string;
}

function hashPassword(password: string): string {
  return crypto.createHash('sha256').update(password).digest('hex');
}

export function registerUser(username: string, password: string): AuthUser {
  const normalizedUsername = username.trim().toLowerCase();
  if (!normalizedUsername || !password.trim()) {
    throw new Error('username and password are required');
  }

  const stmt = getDb().prepare('INSERT INTO users (username, password) VALUES (?, ?)');
  const result = stmt.run(normalizedUsername, hashPassword(password));

  return {
    id: Number(result.lastInsertRowid),
    username: normalizedUsername,
    password: hashPassword(password),
  };
}

export function loginUser(username: string, password: string): AuthSession | null {
  const normalizedUsername = username.trim().toLowerCase();
  const stmt = getDb().prepare('SELECT id, username, password FROM users WHERE username = ?');
  const user = stmt.get(normalizedUsername) as AuthUser | undefined;

  if (!user || user.password !== hashPassword(password)) {
    return null;
  }

  const session = createSession(user.username);
  return {
    username: session.username,
    token: session.token,
    expires_at: session.expires_at,
  };
}
