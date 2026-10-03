import crypto from 'node:crypto';
import { getDb } from './database';
import { retireGuestAccount } from './guests';

export type SessionScope = 'member' | 'guest';

export interface SessionRecord {
  /** Plaintext token. Present for the caller who just created it; not stored. */
  token: string;
  username: string;
  scope: SessionScope;
  created_at: string;
  expires_at: string;
}

export interface SessionAuth {
  username: string;
  scope: SessionScope;
}

export const DEFAULT_SESSION_TTL_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

export function hashSessionToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function asScope(value: unknown): SessionScope {
  return value === 'member' ? 'member' : 'guest';
}

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
  const iso = new Date(now).toISOString();
  const guests = getDb()
    .prepare(`SELECT DISTINCT username FROM sessions WHERE scope = 'guest' AND expires_at <= ?`)
    .all(iso) as Array<{ username: string }>;
  const result = getDb().prepare('DELETE FROM sessions WHERE expires_at <= ?').run(iso);
  for (const guest of guests) {
    retireGuestAccount(guest.username);
  }
  return Number(result.changes);
}

export function createSession(
  username: string,
  now = Date.now(),
  scope: SessionScope = 'member',
  ttlMs?: number
): SessionRecord {
  const token = crypto.randomBytes(32).toString('base64url');
  const lifetime = ttlMs != null && Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : sessionTtlDays() * DAY_MS;
  const record: SessionRecord = {
    token,
    username,
    scope,
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + lifetime).toISOString(),
  };

  pruneExpiredSessions(now);
  getDb()
    .prepare(
      'INSERT INTO sessions (token_hash, username, scope, created_at, expires_at) VALUES (?, ?, ?, ?, ?)'
    )
    .run(hashSessionToken(token), record.username, record.scope, record.created_at, record.expires_at);

  return record;
}

export function deleteSession(token: string | undefined): boolean {
  const trimmed = token?.trim();
  if (!trimmed) {
    return false;
  }

  const result = getDb()
    .prepare('DELETE FROM sessions WHERE token_hash = ?')
    .run(hashSessionToken(trimmed));
  return Number(result.changes) > 0;
}

export function deleteSessionsForUser(username: string): number {
  const result = getDb().prepare('DELETE FROM sessions WHERE username = ?').run(username);
  return Number(result.changes);
}

export function deleteOtherSessions(username: string, keepToken: string | undefined): number {
  const keep = keepToken?.trim();
  if (!keep) {
    const result = getDb().prepare('DELETE FROM sessions WHERE username = ?').run(username);
    return Number(result.changes);
  }

  const result = getDb()
    .prepare('DELETE FROM sessions WHERE username = ? AND token_hash != ?')
    .run(username, hashSessionToken(keep));
  return Number(result.changes);
}

type SessionRow = { username: string; scope: string; expires_at: string };

function readSession(token: string | undefined, now: number): SessionRow | null {
  const trimmed = token?.trim();
  if (!trimmed) {
    return null;
  }

  const row = getDb()
    .prepare('SELECT username, scope, expires_at FROM sessions WHERE token_hash = ?')
    .get(hashSessionToken(trimmed)) as SessionRow | undefined;

  if (!row) {
    return null;
  }

  const expiresAt = Date.parse(row.expires_at);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    getDb().prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashSessionToken(trimmed));
    if (row.scope === 'guest') {
      retireGuestAccount(row.username);
    }
    return null;
  }

  return row;
}

/**
 * Resolves a bearer token to a username and scope, or null when the token is
 * unknown or expired. An expired row is deleted on the way out.
 */
export function findSession(token: string | undefined, now = Date.now()): SessionAuth | null {
  const row = readSession(token, now);
  if (!row) {
    return null;
  }
  return { username: row.username, scope: asScope(row.scope) };
}

export function findSessionUser(token: string | undefined, now = Date.now()): string | null {
  return findSession(token, now)?.username ?? null;
}

/** True while this stored hash still names a live session. Drops an expired row. */
export function sessionIsLive(tokenHash: string | undefined, now = Date.now()): boolean {
  if (!tokenHash) {
    return false;
  }

  const row = getDb()
    .prepare('SELECT username, scope, expires_at FROM sessions WHERE token_hash = ?')
    .get(tokenHash) as { username: string; scope: string; expires_at: string } | undefined;
  if (!row) {
    return false;
  }

  const expiresAt = Date.parse(row.expires_at);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    getDb().prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
    if (row.scope === 'guest') {
      retireGuestAccount(row.username);
    }
    return false;
  }

  return true;
}

export function getSession(token: string): SessionRecord | undefined {
  const trimmed = token.trim();
  if (!trimmed) {
    return undefined;
  }
  const row = getDb()
    .prepare('SELECT username, scope, created_at, expires_at FROM sessions WHERE token_hash = ?')
    .get(hashSessionToken(trimmed)) as
    | { username: string; scope: string; created_at: string; expires_at: string }
    | undefined;
  if (!row) {
    return undefined;
  }
  return {
    token: trimmed,
    username: row.username,
    scope: asScope(row.scope),
    created_at: row.created_at,
    expires_at: row.expires_at,
  };
}
