import { getDb } from './database';

export interface RoomRecord {
  id: number;
  slug: string;
  name: string;
  type: 'group' | 'dm';
  created_at: string;
}

export interface RoomSummary extends RoomRecord {
  members: string[];
}

export interface PublicUser {
  id: number;
  username: string;
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
    .prepare('SELECT id, username FROM users WHERE username = ?')
    .get(username) as PublicUser | undefined;
}

export function getUserById(id: number): PublicUser | undefined {
  return getDb().prepare('SELECT id, username FROM users WHERE id = ?').get(id) as
    | PublicUser
    | undefined;
}

export function listUsers(): PublicUser[] {
  return getDb()
    .prepare('SELECT id, username FROM users ORDER BY username ASC')
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
      WHERE rm.user_id = ?
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
