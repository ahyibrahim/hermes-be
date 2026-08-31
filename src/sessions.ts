import crypto from 'node:crypto';
import { getDb } from './database';

export interface SessionRecord {
  token: string;
  username: string;
  created_at: string;
  expires_at: string;
}

export const DEFAULT_SESSION_TTL_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * HERMES_SESSION_TTL_DAYS, defaulting to 30. Values that are not a positive
 * finite number fall back to the default rather than locking everyone out.
 */
export function sessionTtlDays(): number {
  const raw = process.env.HERMES_SESSION_TTL_DAYS;
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_SESSION_TTL_DAYS;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_SESSION_TTL_DAYS;
  }

  return parsed;
}

export function pruneExpiredSessions(now = Date.now()): number {
  const result = getDb()
    .prepare('DELETE FROM sessions WHERE expires_at <= ?')
    .run(new Date(now).toISOString());
  return Number(result.changes);
}

export function createSession(username: string, now = Date.now()): SessionRecord {
  const record: SessionRecord = {
    token: crypto.randomUUID(),
    username,
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + sessionTtlDays() * DAY_MS).toISOString(),
  };

  pruneExpiredSessions(now);
  getDb()
    .prepare('INSERT INTO sessions (token, username, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(record.token, record.username, record.created_at, record.expires_at);

  return record;
}

export function deleteSession(token: string | undefined): boolean {
  const trimmed = token?.trim();
  if (!trimmed) {
    return false;
  }

  const result = getDb().prepare('DELETE FROM sessions WHERE token = ?').run(trimmed);
  return Number(result.changes) > 0;
}

/**
 * Resolves a bearer token to a username, or null when the token is unknown or
 * expired. An expired row is deleted on the way out.
 */
export function findSessionUser(token: string | undefined, now = Date.now()): string | null {
  const trimmed = token?.trim();
  if (!trimmed) {
    return null;
  }

  const row = getDb()
    .prepare('SELECT username, expires_at FROM sessions WHERE token = ?')
    .get(trimmed) as { username: string; expires_at: string } | undefined;

  if (!row) {
    return null;
  }

  const expiresAt = Date.parse(row.expires_at);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    getDb().prepare('DELETE FROM sessions WHERE token = ?').run(trimmed);
    return null;
  }

  return row.username;
}

export function getSession(token: string): SessionRecord | undefined {
  return getDb()
    .prepare('SELECT token, username, created_at, expires_at FROM sessions WHERE token = ?')
    .get(token) as SessionRecord | undefined;
}
