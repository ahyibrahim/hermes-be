import { getDb } from './database';
import { isoTimestamp } from './colors';

export interface RoomRecord {
  id: number;
  slug: string;
  name: string;
  type: 'group' | 'dm';
  created_at: string;
}

export interface LastMessagePreview {
  id: number;
  sender: string;
  content: string;
  deleted: boolean;
  file: boolean;
}

export interface RoomSummary extends RoomRecord {
  members: string[];
}

export interface PublicUser {
  id: number;
  username: string;
  role: 'member' | 'admin';
  avatar_file_id: number | null;
  color: string | null;
}

function membersOf(roomId: number): string[] {
  return (
    getDb()
      .prepare(
        `
        SELECT u.username
        FROM room_members rm
        JOIN users u ON u.id = rm.user_id
        WHERE rm.room_id = ?
        ORDER BY u.username ASC
      `
      )
      .all(roomId) as { username: string }[]
  ).map((row) => row.username);
}

function toSummary(room: RoomRecord): RoomSummary {
  return { ...room, members: membersOf(room.id) };
}

export function getUserByUsername(username: string): PublicUser | undefined {
  return getDb()
    .prepare('SELECT id, username, role, avatar_file_id, color FROM users WHERE username = ?')
    .get(username) as PublicUser | undefined;
}

export function getUserById(id: number): PublicUser | undefined {
  return getDb()
    .prepare('SELECT id, username, role, avatar_file_id, color FROM users WHERE id = ?')
    .get(id) as PublicUser | undefined;
}

export function listUsers(): PublicUser[] {
  return getDb()
    .prepare('SELECT id, username, role, avatar_file_id, color FROM users ORDER BY username ASC')
    .all() as PublicUser[];
}

export function getRoomBySlug(slug: string): RoomRecord | undefined {
  return getDb()
    .prepare('SELECT id, slug, name, type, created_at FROM rooms WHERE slug = ?')
    .get(slug) as RoomRecord | undefined;
}

export function ensureRoom(slug: string, name = slug, type: 'group' | 'dm' = 'group'): RoomRecord {
  getDb()
    .prepare('INSERT OR IGNORE INTO rooms (slug, name, type) VALUES (?, ?, ?)')
    .run(slug, name, type);
  return getRoomBySlug(slug) as RoomRecord;
}

function addMemberIds(roomId: number, userId: number): void {
  getDb()
    .prepare('INSERT OR IGNORE INTO room_members (room_id, user_id) VALUES (?, ?)')
    .run(roomId, userId);
}

export function addRoomMember(slug: string, username: string): void {
  const room = ensureRoom(slug);
  const user = getUserByUsername(username);
  if (!user) {
    return;
  }
  addMemberIds(room.id, user.id);
}

export function addUserToGeneralRoom(userId: number): void {
  const general = ensureRoom('general', 'general', 'group');
  addMemberIds(general.id, userId);
}

export function isRoomMember(slug: string, username: string): boolean {
  const row = getDb()
    .prepare(
      `
      SELECT 1 AS ok
      FROM room_members rm
      JOIN rooms r ON r.id = rm.room_id
      JOIN users u ON u.id = rm.user_id
      WHERE r.slug = ? AND u.username = ?
    `
    )
    .get(slug, username) as { ok: number } | undefined;
  return Boolean(row);
}

export function listRoomMembers(slug: string): string[] {
  const room = getRoomBySlug(slug);
  if (!room) {
    return [];
  }
  return membersOf(room.id);
}

export function listRoomsForUser(username: string): RoomSummary[] {
  const user = getUserByUsername(username);
  if (!user) {
    return [];
  }

  const rooms = getDb()
    .prepare(
      `
      SELECT r.id, r.slug, r.name, r.type, r.created_at
      FROM rooms r
      JOIN room_members rm ON rm.room_id = r.id
      WHERE rm.user_id = ? AND rm.hidden_at IS NULL
      ORDER BY r.created_at ASC, r.id ASC
    `
    )
    .all(user.id) as RoomRecord[];

  return rooms.map(toSummary);
}

export function createGroupRoom(
  name: string,
  creatorUserId: number,
  memberUserIds: number[]
): RoomSummary {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error('name is required');
  }

  const slug = `group:${trimmed.toLowerCase().replace(/\s+/g, '-')}:${Date.now()}`;
  const result = getDb()
    .prepare("INSERT INTO rooms (slug, name, type) VALUES (?, ?, 'group')")
    .run(slug, trimmed);

  const roomId = Number(result.lastInsertRowid);
  const uniqueMembers = new Set([creatorUserId, ...memberUserIds]);
  for (const memberId of uniqueMembers) {
    if (!getUserById(memberId)) {
      continue;
    }
    addMemberIds(roomId, memberId);
  }

  return toSummary({
    id: roomId,
    slug,
    name: trimmed,
    type: 'group',
    created_at: new Date().toISOString(),
  });
}

export function getOrCreateDmRoom(userId: number, otherUserId: number): RoomSummary {
  if (userId === otherUserId) {
    throw new Error('cannot DM yourself');
  }

  const members = getDb()
    .prepare('SELECT id, username FROM users WHERE id IN (?, ?) ORDER BY username ASC')
    .all(userId, otherUserId) as PublicUser[];

  if (members.length !== 2) {
    throw new Error('both users must exist');
  }

  const slug = `dm:${members[0].username}:${members[1].username}`;
  const existing = getRoomBySlug(slug);
  if (existing) {
    addMemberIds(existing.id, userId);
    addMemberIds(existing.id, otherUserId);
    clearHiddenAt(existing.id, userId);
    return toSummary(existing);
  }

  const name = members.map((member) => member.username).join(', ');
  const result = getDb()
    .prepare("INSERT INTO rooms (slug, name, type) VALUES (?, ?, 'dm')")
    .run(slug, name);

  const roomId = Number(result.lastInsertRowid);
  addMemberIds(roomId, userId);
  addMemberIds(roomId, otherUserId);

  return toSummary({
    id: roomId,
    slug,
    name,
    type: 'dm',
    created_at: new Date().toISOString(),
  });
}

export function leaveRoom(slug: string, username: string): { ok: true } | { error: string } {
  if (slug === 'general') {
    return { error: 'cannot leave general' };
  }
  const room = getRoomBySlug(slug);
  if (room?.type === 'dm') {
    return { error: 'cannot leave a DM' };
  }
  if (!isRoomMember(slug, username)) {
    return { error: 'not a member of this room' };
  }
  const user = getUserByUsername(username);
  if (!room || !user) {
    return { error: 'not a member of this room' };
  }
  getDb()
    .prepare('DELETE FROM room_members WHERE room_id = ? AND user_id = ?')
    .run(room.id, user.id);
  return { ok: true };
}

export function hideRoom(slug: string, username: string): { ok: true } | { error: string } {
  if (slug === 'general') {
    return { error: 'cannot hide general' };
  }
  const room = getRoomBySlug(slug);
  if (!room) {
    return { error: 'not a member of this room' };
  }
  if (room.type !== 'dm') {
    return { error: 'can only hide a DM' };
  }
  const user = getUserByUsername(username);
  if (!user || !isRoomMember(slug, username)) {
    return { error: 'not a member of this room' };
  }
  getDb()
    .prepare('UPDATE room_members SET hidden_at = ? WHERE room_id = ? AND user_id = ?')
    .run(isoTimestamp(), room.id, user.id);
  return { ok: true };
}

function clearHiddenAt(roomId: number, userId?: number): void {
  if (userId != null) {
    getDb()
      .prepare('UPDATE room_members SET hidden_at = NULL WHERE room_id = ? AND user_id = ?')
      .run(roomId, userId);
    return;
  }
  getDb().prepare('UPDATE room_members SET hidden_at = NULL WHERE room_id = ?').run(roomId);
}

export function revealRoomMembers(slug: string): void {
  const room = getRoomBySlug(slug);
  if (!room || room.type !== 'dm') {
    return;
  }
  clearHiddenAt(room.id);
}

const LAST_MESSAGE_PREVIEW_CHARS = 80;

export function lastMessagePreview(slug: string): LastMessagePreview | null {
  const row = getDb()
    .prepare(
      `SELECT m.id, m.sender, m.content, m.deleted_at, m.file_id, f.original_name
       FROM messages m
       LEFT JOIN files f ON f.id = m.file_id
       WHERE m.room = ?
       ORDER BY m.id DESC
       LIMIT 1`
    )
    .get(slug) as
    | {
        id: number;
        sender: string;
        content: string;
        deleted_at: string | null;
        file_id: number | null;
        original_name: string | null;
      }
    | undefined;
  if (!row) {
    return null;
  }
  if (row.deleted_at) {
    return { id: row.id, sender: row.sender, content: '', deleted: true, file: false };
  }
  const file = row.file_id != null;
  const raw = row.content || row.original_name || '';
  return {
    id: row.id,
    sender: row.sender,
    content: raw.length > LAST_MESSAGE_PREVIEW_CHARS ? raw.slice(0, LAST_MESSAGE_PREVIEW_CHARS) : raw,
    deleted: false,
    file,
  };
}

export function unreadCount(userId: number, slug: string): number {
  const read = getDb()
    .prepare('SELECT last_message_id FROM room_reads WHERE user_id = ? AND room = ?')
    .get(userId, slug) as { last_message_id: number } | undefined;
  const watermark = read?.last_message_id ?? 0;
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM messages
       WHERE room = ? AND id > ? AND (deleted_at IS NULL OR deleted_at = '')`
    )
    .get(slug, watermark) as { n: number };
  return row.n;
}

export function markRoomRead(userId: number, slug: string): void {
  const row = getDb()
    .prepare('SELECT MAX(id) AS max_id FROM messages WHERE room = ?')
    .get(slug) as { max_id: number | null };
  const lastId = row.max_id ?? 0;
  getDb()
    .prepare(
      `INSERT INTO room_reads (user_id, room, last_message_id)
       VALUES (?, ?, ?)
       ON CONFLICT(user_id, room) DO UPDATE SET last_message_id = excluded.last_message_id`
    )
    .run(userId, slug, lastId);
}

export function takenColors(): Set<string> {
  return new Set(
    (
      getDb()
        .prepare("SELECT color FROM users WHERE color IS NOT NULL AND color != ''")
        .all() as Array<{ color: string }>
    ).map((row) => row.color)
  );
}

export function setUserColor(userId: number, color: string): void {
  getDb().prepare('UPDATE users SET color = ? WHERE id = ?').run(color, userId);
}
