import crypto from 'node:crypto';
import argon2 from 'argon2';
import { getDb } from './database';
import { createSession } from './sessions';
import { USER_COLOR_PALETTE, type UserColor } from './colors';
import { takenColors } from './rooms';

export type UserRole = 'member' | 'admin';

export interface AuthUser {
  id: number;
  username: string;
  role: UserRole;
  avatar_file_id: number | null;
  color: string | null;
}

export interface AuthSession {
  username: string;
  token: string;
  expires_at: string;
}

const ARGON2_OPTIONS: argon2.HashOptions = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
};

function sha256(password: string): string {
  return crypto.createHash('sha256').update(password).digest('hex');
}

function looksLikeArgon2(stored: string): boolean {
  return stored.startsWith('$argon2');
}

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { ...ARGON2_OPTIONS, raw: false });
}

async function passwordMatches(stored: string, password: string): Promise<boolean> {
  if (looksLikeArgon2(stored)) {
    try {
      return await argon2.verify(stored, password);
    } catch {
      return false;
    }
  }
  return stored === sha256(password);
}

function nextColor(): UserColor {
  const taken = takenColors();
  return USER_COLOR_PALETTE.find((slot) => !taken.has(slot)) ?? USER_COLOR_PALETTE[taken.size % USER_COLOR_PALETTE.length];
}

function nextRole(): UserRole {
  const row = getDb().prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
  return row.n === 0 ? 'admin' : 'member';
}

export async function registerUser(username: string, password: string): Promise<AuthUser> {
  const normalizedUsername = username.trim().toLowerCase();
  if (!normalizedUsername || !password.trim()) {
    throw new Error('username and password are required');
  }

  const role = nextRole();
  const color = nextColor();
  const hashed = await hashPassword(password);
  const stmt = getDb().prepare('INSERT INTO users (username, password, role, color) VALUES (?, ?, ?, ?)');
  const result = stmt.run(normalizedUsername, hashed, role, color);

  return {
    id: Number(result.lastInsertRowid),
    username: normalizedUsername,
    role,
    avatar_file_id: null,
    color,
  };
}

export async function loginUser(username: string, password: string): Promise<AuthSession | null> {
  const normalizedUsername = username.trim().toLowerCase();
  const stmt = getDb().prepare('SELECT id, username, password FROM users WHERE username = ?');
  const user = stmt.get(normalizedUsername) as
    | { id: number; username: string; password: string }
    | undefined;

  if (!user || !(await passwordMatches(user.password, password))) {
    return null;
  }

  if (!looksLikeArgon2(user.password)) {
    getDb()
      .prepare('UPDATE users SET password = ? WHERE id = ?')
      .run(await hashPassword(password), user.id);
  }

  const session = createSession(user.username);
  return {
    username: session.username,
    token: session.token,
    expires_at: session.expires_at,
  };
}

export function getProfile(username: string): AuthUser | undefined {
  return getDb()
    .prepare('SELECT id, username, role, avatar_file_id, color FROM users WHERE username = ?')
    .get(username) as AuthUser | undefined;
}

export async function changePassword(
  username: string,
  currentPassword: string,
  nextPassword: string
): Promise<boolean> {
  if (!nextPassword.trim()) {
    throw new Error('password is required');
  }

  const row = getDb()
    .prepare('SELECT id, password FROM users WHERE username = ?')
    .get(username) as { id: number; password: string } | undefined;
  if (!row || !(await passwordMatches(row.password, currentPassword))) {
    return false;
  }

  getDb()
    .prepare('UPDATE users SET password = ? WHERE id = ?')
    .run(await hashPassword(nextPassword), row.id);
  return true;
}

export function setAvatarFileId(userId: number, fileId: number): void {
  getDb().prepare('UPDATE users SET avatar_file_id = ? WHERE id = ?').run(fileId, userId);
}
