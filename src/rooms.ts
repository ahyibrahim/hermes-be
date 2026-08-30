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
  CREATE TABLE IF NOT EXISTS rooms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('group', 'dm')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS room_members (
    room_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (room_id, user_id),
    FOREIGN KEY (room_id) REFERENCES rooms(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

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

function getRoomMembers(roomId: number): string[] {
  return (
    db
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

function toRoomSummary(room: RoomRecord): RoomSummary {
  return {
    ...room,
    members: getRoomMembers(room.id),
  };
}

function addRoomMember(roomId: number, userId: number): void {
  db.prepare('INSERT OR IGNORE INTO room_members (room_id, user_id) VALUES (?, ?)').run(
    roomId,
    userId
  );
}

function getRoomBySlug(slug: string): RoomRecord | null {
  const room = db
    .prepare('SELECT id, slug, name, type, created_at FROM rooms WHERE slug = ?')
    .get(slug) as RoomRecord | undefined;

  return room ?? null;
}

export function ensureGeneralRoom(): RoomRecord {
  const existing = getRoomBySlug('general');
  if (existing) {
    return existing;
  }

  const result = db
    .prepare("INSERT INTO rooms (slug, name, type) VALUES ('general', 'General', 'group')")
    .run();

  return {
    id: Number(result.lastInsertRowid),
    slug: 'general',
    name: 'General',
    type: 'group',
    created_at: new Date().toISOString(),
  };
}

export function addUserToGeneralRoom(userId: number): void {
  const generalRoom = ensureGeneralRoom();
  addRoomMember(generalRoom.id, userId);
}

export function createGroupRoom(name: string, creatorUserId: number, memberUserIds: number[]): RoomSummary {
  const slug = `group:${name.trim().toLowerCase().replace(/\s+/g, '-')}:${Date.now()}`;
  const result = db
    .prepare('INSERT INTO rooms (slug, name, type) VALUES (?, ?, ?)')
    .run(slug, name.trim(), 'group');

  const roomId = Number(result.lastInsertRowid);
  const uniqueMembers = new Set([creatorUserId, ...memberUserIds]);
  for (const memberId of uniqueMembers) {
    addRoomMember(roomId, memberId);
  }

  return toRoomSummary({
    id: roomId,
    slug,
    name: name.trim(),
    type: 'group',
    created_at: new Date().toISOString(),
  });
}

export function getOrCreateDmRoom(userId: number, otherUserId: number): RoomSummary {
  const members = db
    .prepare('SELECT id, username FROM users WHERE id IN (?, ?) ORDER BY username ASC')
    .all(userId, otherUserId) as { id: number; username: string }[];

  if (members.length !== 2) {
    throw new Error('both users must exist');
  }

  const slug = `dm:${members[0].username}:${members[1].username}`;
  const existing = getRoomBySlug(slug);
  if (existing) {
    return toRoomSummary(existing);
  }

  const name = members.map((member) => member.username).join(', ');
  const result = db
    .prepare('INSERT INTO rooms (slug, name, type) VALUES (?, ?, ?)')
    .run(slug, name, 'dm');

  const roomId = Number(result.lastInsertRowid);
  addRoomMember(roomId, userId);
  addRoomMember(roomId, otherUserId);

  return toRoomSummary({
    id: roomId,
    slug,
    name,
    type: 'dm',
    created_at: new Date().toISOString(),
  });
}

export function listRoomsForUser(userId: number): RoomSummary[] {
  const rooms = db
    .prepare(
      `
      SELECT r.id, r.slug, r.name, r.type, r.created_at
      FROM rooms r
      JOIN room_members rm ON rm.room_id = r.id
      WHERE rm.user_id = ?
      ORDER BY r.created_at ASC
    `
    )
    .all(userId) as RoomRecord[];

  return rooms.map(toRoomSummary);
}

export function isRoomMember(roomSlug: string, userId: number): boolean {
  const row = db
    .prepare(
      `
      SELECT 1
      FROM room_members rm
      JOIN rooms r ON r.id = rm.room_id
      WHERE r.slug = ? AND rm.user_id = ?
    `
    )
    .get(roomSlug, userId);

  return Boolean(row);
}

export function getRoomBySlugForUser(roomSlug: string, userId: number): RoomSummary | null {
  if (!isRoomMember(roomSlug, userId)) {
    return null;
  }

  const room = getRoomBySlug(roomSlug);
  return room ? toRoomSummary(room) : null;
}
