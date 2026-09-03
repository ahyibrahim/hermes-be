import crypto from 'node:crypto';
import argon2 from 'argon2';
import { getDb } from './database';
import { createSession, deleteOtherSessions } from './sessions';
import { isoTimestamp, USER_COLOR_PALETTE, type UserColor } from './colors';
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
  let result;
  try {
    result = stmt.run(normalizedUsername, hashed, role, color);
  } catch (error) {
    const message = String((error as Error).message);
    if (message.includes('UNIQUE') && (message.includes('idx_users_color') || message.includes('users.color'))) {
      // 11th user wraps and shares a palette slot. Drop the unique index so
      // the insert can reuse a color; migrateSchema skips recreating it
      // while duplicates exist.
      getDb().exec('DROP INDEX IF EXISTS idx_users_color');
      result = stmt.run(normalizedUsername, hashed, role, color);
    } else {
      throw error;
    }
  }

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

const RESET_TTL_MS = 60 * 60 * 1000;

function hashResetToken(token: string): string {
  return sha256(token);
}

export function issuePasswordReset(
  username: string
): { token: string; expires_at: string } | { error: 'not_found' } {
  const normalizedUsername = username.trim().toLowerCase();
  const user = getProfile(normalizedUsername);
  if (!user) {
    return { error: 'not_found' };
  }

  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  const expiresAt = new Date(now + RESET_TTL_MS).toISOString();
  getDb()
    .prepare(
      `INSERT INTO password_reset_tokens (username, token_hash, expires_at, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(username) DO UPDATE SET
         token_hash = excluded.token_hash,
         expires_at = excluded.expires_at,
         created_at = excluded.created_at`
    )
    .run(normalizedUsername, hashResetToken(token), expiresAt, isoTimestamp());

  return { token, expires_at: expiresAt };
}

export async function redeemPasswordReset(
  username: string,
  token: string,
  password: string
): Promise<AuthSession | null> {
  if (!password.trim() || !token.trim()) {
    return null;
  }

  const normalizedUsername = username.trim().toLowerCase();
  const row = getDb()
    .prepare('SELECT token_hash, expires_at FROM password_reset_tokens WHERE username = ?')
    .get(normalizedUsername) as { token_hash: string; expires_at: string } | undefined;
  if (!row) {
    return null;
  }

  const expiresAt = Date.parse(row.expires_at);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    getDb().prepare('DELETE FROM password_reset_tokens WHERE username = ?').run(normalizedUsername);
    return null;
  }

  if (row.token_hash !== hashResetToken(token.trim())) {
    return null;
  }

  getDb()
    .prepare('UPDATE users SET password = ? WHERE username = ?')
    .run(await hashPassword(password), normalizedUsername);
  getDb().prepare('DELETE FROM password_reset_tokens WHERE username = ?').run(normalizedUsername);
  deleteOtherSessions(normalizedUsername, undefined);
  const session = createSession(normalizedUsername);
  return {
    username: session.username,
    token: session.token,
    expires_at: session.expires_at,
  };
}
