import crypto from 'node:crypto';
import { hashPassword } from './auth';
import { GUEST_COLOR } from './colors';
import { getDb } from './database';
import { guestStatus, type GuestStatus } from './guests';
import { getRoomBySlug, getUserByUsername } from './rooms';
import { createSession, type SessionRecord } from './sessions';
import { isSystemUsername } from './system-user';
import { isUsername } from './text';

export const DEFAULT_INVITE_USES = 1;
export const DEFAULT_INVITE_HOURS = 24;
export const GUEST_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

const MAX_USES = 20;
const MAX_HOURS = 24 * 7;

export type InviteSummary = {
  id: number;
  rooms: string[];
  maxUses: number;
  useCount: number;
  expiresAt: string;
  revoked: boolean;
  createdAt: string;
};

export type GuestSummary = {
  username: string;
  displayName: string;
  status: GuestStatus;
  rooms: string[];
  createdAt: string;
};

function hashInviteToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function roomsForInvite(inviteId: number): string[] {
  return (
    getDb()
      .prepare('SELECT room_slug FROM invite_rooms WHERE invite_id = ? ORDER BY room_slug ASC')
      .all(inviteId) as Array<{ room_slug: string }>
  ).map((row) => row.room_slug);
}

function roomsForGuest(userId: number): string[] {
  return (
    getDb()
      .prepare('SELECT room_slug FROM guest_rooms WHERE user_id = ? ORDER BY room_slug ASC')
      .all(userId) as Array<{ room_slug: string }>
  ).map((row) => row.room_slug);
}

export function isGatewayOpen(): boolean {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = 'gateway_open'").get() as
    | { value: string }
    | undefined;
  return row?.value === '1';
}

export function setGatewayOpen(open: boolean): void {
  getDb()
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run('gateway_open', open ? '1' : '0');
}

export function normalizeInviteLimits(input: { maxUses?: number; expiresInHours?: number }): {
  maxUses: number;
  expiresInHours: number;
} {
  const maxUses = input.maxUses ?? DEFAULT_INVITE_USES;
  const expiresInHours = input.expiresInHours ?? DEFAULT_INVITE_HOURS;
  if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > MAX_USES) {
    throw new Error('maxUses must be from 1 to 20');
  }
  if (!Number.isInteger(expiresInHours) || expiresInHours < 1 || expiresInHours > MAX_HOURS) {
    throw new Error('expiresInHours must be from 1 to 168');
  }
  return { maxUses, expiresInHours };
}

/** Group rooms only. `#general` and DMs are refused. */
export function assertInviteRooms(slugs: string[]): string[] {
  const unique = [...new Set(slugs)];
  if (unique.length === 0) {
    throw new Error('rooms are required');
  }
  for (const slug of unique) {
    if (slug === 'general') {
      throw new Error('cannot invite into general');
    }
    const room = getRoomBySlug(slug);
    if (!room || room.type !== 'group') {
      throw new Error('room not found');
    }
  }
  return unique;
}

export function createInvite(
  createdByUserId: number,
  rooms: string[],
  limits: { maxUses: number; expiresInHours: number },
  now = Date.now()
): { invite: InviteSummary; token: string } {
  const token = crypto.randomBytes(32).toString('base64url');
  const createdAt = new Date(now).toISOString();
  const expiresAt = new Date(now + limits.expiresInHours * 60 * 60 * 1000).toISOString();
  const db = getDb();
  const insert = db.transaction(() => {
    const result = db
      .prepare(
        `INSERT INTO invites (token_hash, created_by, max_uses, use_count, expires_at, created_at)
         VALUES (?, ?, ?, 0, ?, ?)`
      )
      .run(hashInviteToken(token), createdByUserId, limits.maxUses, expiresAt, createdAt);
    const inviteId = Number(result.lastInsertRowid);
    const link = db.prepare('INSERT INTO invite_rooms (invite_id, room_slug) VALUES (?, ?)');
    for (const slug of rooms) {
      link.run(inviteId, slug);
    }
    return inviteId;
  });
  const id = insert();
  return {
    token,
    invite: {
      id,
      rooms,
      maxUses: limits.maxUses,
      useCount: 0,
      expiresAt,
      revoked: false,
      createdAt,
    },
  };
}

export function listInvites(): InviteSummary[] {
  const rows = getDb()
    .prepare(
      `SELECT id, max_uses, use_count, expires_at, revoked_at, created_at
       FROM invites ORDER BY id DESC`
    )
    .all() as Array<{
    id: number;
    max_uses: number;
    use_count: number;
    expires_at: string;
    revoked_at: string | null;
    created_at: string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    rooms: roomsForInvite(row.id),
    maxUses: row.max_uses,
    useCount: row.use_count,
    expiresAt: row.expires_at,
    revoked: Boolean(row.revoked_at),
    createdAt: row.created_at,
  }));
}

export function revokeInvite(id: number): boolean {
  const result = getDb()
    .prepare(
      `UPDATE invites SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`
    )
    .run(new Date().toISOString(), id);
  return Number(result.changes) > 0;
}

export function listOpenGuests(): GuestSummary[] {
  const rows = getDb()
    .prepare(
      `SELECT id, username, display_name, guest_status, created_at
       FROM users
       WHERE role = 'guest' AND guest_status IN ('waiting', 'admitted')
       ORDER BY id ASC`
    )
    .all() as Array<{
    id: number;
    username: string;
    display_name: string | null;
    guest_status: GuestStatus;
    created_at: string;
  }>;
  return rows.map((row) => ({
    username: row.username,
    displayName: row.display_name || row.username,
    status: row.guest_status,
    rooms: roomsForGuest(row.id),
    createdAt: row.created_at,
  }));
}

function nextGuestUsername(): string {
  const db = getDb();
  const rows = db.prepare("SELECT username FROM users WHERE username LIKE 'guest_%'").all() as Array<{
    username: string;
  }>;
  const stored = db.prepare("SELECT value FROM settings WHERE key = 'guest_seq'").get() as { value: string } | undefined;
  let max = Number(stored?.value ?? '0');
  if (!Number.isFinite(max) || max < 0) {
    max = 0;
  }
  for (const row of rows) {
    const match = /^guest_(\d+)$/.exec(row.username);
    if (match) {
      max = Math.max(max, Number(match[1]));
    }
  }
  let n = max + 1;
  while (getUserByUsername(`guest_${n}`)) {
    n += 1;
  }
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run('guest_seq', String(n));
  return `guest_${n}`;
}

function displayNameTaken(name: string): boolean {
  if (getUserByUsername(name)) {
    return true;
  }
  const active = getDb()
    .prepare(
      `SELECT 1 AS ok FROM users
       WHERE role = 'guest' AND guest_status IN ('waiting', 'admitted') AND display_name = ?`
    )
    .get(name) as { ok: number } | undefined;
  return Boolean(active);
}

export async function redeemInvite(
  token: string,
  username: string,
  now = Date.now()
): Promise<{ error: string; status: 400 | 409 } | { userId: number; session: SessionRecord; displayName: string }> {
  const displayName = username.trim().toLowerCase();
  if (!isUsername(displayName) || isSystemUsername(displayName)) {
    return { error: 'name must be 2-24 characters: a-z, 0-9, underscore', status: 400 };
  }
  if (displayNameTaken(displayName)) {
    return { error: 'that name is not available', status: 409 };
  }

  const hashed = await hashPassword(crypto.randomBytes(32).toString('base64url'));
  const tokenHash = hashInviteToken(token.trim());
  const db = getDb();

  let userId = 0;
  let account = '';
  try {
    const redeem = db.transaction((): { error: string } | { userId: number; account: string } => {
      const invite = db
        .prepare(
          `SELECT id, max_uses, use_count, expires_at, revoked_at
           FROM invites WHERE token_hash = ?`
        )
        .get(tokenHash) as
        | {
            id: number;
            max_uses: number;
            use_count: number;
            expires_at: string;
            revoked_at: string | null;
          }
        | undefined;
      const expiresAt = invite ? Date.parse(invite.expires_at) : NaN;
      if (
        !invite ||
        invite.revoked_at ||
        invite.use_count >= invite.max_uses ||
        !Number.isFinite(expiresAt) ||
        expiresAt <= now
      ) {
        return { error: 'invite is not valid' as const };
      }

      if (displayNameTaken(displayName)) {
        return { error: 'that name is not available' as const };
      }

      const slugs = roomsForInvite(invite.id);
      const accountName = nextGuestUsername();
      let result;
      try {
        result = db
          .prepare(
            `INSERT INTO users (username, password, role, color, guest_status, display_name)
             VALUES (?, ?, 'guest', ?, 'waiting', ?)`
          )
          .run(accountName, hashed, GUEST_COLOR, displayName);
      } catch (error) {
        const message = String((error as Error).message);
        if (message.includes('UNIQUE') && (message.includes('idx_users_color') || message.includes('users.color'))) {
          db.exec('DROP INDEX IF EXISTS idx_users_color');
          result = db
            .prepare(
              `INSERT INTO users (username, password, role, color, guest_status, display_name)
               VALUES (?, ?, 'guest', ?, 'waiting', ?)`
            )
            .run(accountName, hashed, GUEST_COLOR, displayName);
        } else if (message.includes('UNIQUE')) {
          return { error: 'that name is not available' as const };
        } else {
          throw error;
        }
      }

      const id = Number(result.lastInsertRowid);
      const link = db.prepare('INSERT INTO guest_rooms (user_id, room_slug) VALUES (?, ?)');
      for (const slug of slugs) {
        link.run(id, slug);
      }
      db.prepare('UPDATE invites SET use_count = use_count + 1 WHERE id = ?').run(invite.id);
      return { userId: id, account: accountName };
    });
    const outcome = redeem();
    if ('error' in outcome) {
      return { error: outcome.error, status: outcome.error === 'invite is not valid' ? 400 : 409 };
    }
    userId = outcome.userId;
    account = outcome.account;
  } catch (error) {
    const message = String((error as Error).message);
    if (message.includes('UNIQUE')) {
      return { error: 'that name is not available', status: 409 };
    }
    throw error;
  }

  const session = createSession(account, now, 'guest', GUEST_SESSION_TTL_MS);
  return { userId, session, displayName };
}

export function admitGuest(username: string): { error: string; status: 400 | 404 } | { rooms: string[] } {
  const user = getUserByUsername(username);
  if (!user || user.role !== 'guest' || guestStatus(username) !== 'waiting') {
    return { error: 'guest not found', status: 404 };
  }

  const slugs = roomsForGuest(user.id);
  const rooms: string[] = [];
  const db = getDb();
  const admit = db.transaction(() => {
    for (const slug of slugs) {
      const room = getRoomBySlug(slug);
      if (!room || room.type !== 'group' || slug === 'general') {
        continue;
      }
      const max = db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM messages WHERE room = ?').get(slug) as {
        id: number;
      };
      db.prepare(
        `INSERT OR IGNORE INTO room_members (room_id, user_id, history_after_id) VALUES (?, ?, ?)`
      ).run(room.id, user.id, max.id);
      rooms.push(slug);
    }
    db.prepare("UPDATE users SET guest_status = 'admitted' WHERE id = ?").run(user.id);
  });
  admit();
  return { rooms };
}
