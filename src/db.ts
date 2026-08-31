import { getDb } from './database';
import {
  addRoomMember as addRoomMemberByNames,
  ensureRoom as ensureTypedRoom,
  getRoomBySlug as getTypedRoomBySlug,
  isRoomMember as isNamedRoomMember,
  listRoomMembers as listNamedRoomMembers,
  RoomRecord as TypedRoomRecord,
} from './rooms';

export { closeDb, resolveDatabasePath } from './database';
export type { RoomRecord } from './rooms';

export interface MessageRecord {
  id: number;
  room: string;
  sender: string;
  content: string;
  created_at: string;
  file_id?: number | null;
}

export interface FileRecord {
  id: number;
  room: string;
  uploader: string;
  original_name: string;
  mime: string;
  size: number;
  path: string;
  created_at: string;
}

export function listMessages(room: string): MessageRecord[] {
  const stmt = getDb().prepare(
    'SELECT id, room, sender, content, created_at, file_id FROM messages WHERE room = ? ORDER BY id ASC'
  );

  return stmt.all(room) as MessageRecord[];
}

export function createMessage(
  room: string,
  sender: string,
  content: string,
  fileId: number | null = null
): MessageRecord {
  const stmt = getDb().prepare(
    'INSERT INTO messages (room, sender, content, file_id) VALUES (?, ?, ?, ?)'
  );

  const result = stmt.run(room, sender, content, fileId);

  return {
    id: Number(result.lastInsertRowid),
    room,
    sender,
    content,
    created_at: new Date().toISOString(),
    file_id: fileId,
  };
}

export function ensureRoom(slug: string, name = slug): TypedRoomRecord {
  return ensureTypedRoom(slug, name);
}

export function getRoomBySlug(slug: string): TypedRoomRecord | undefined {
  return getTypedRoomBySlug(slug);
}

export function addRoomMember(slug: string, username: string): void {
  addRoomMemberByNames(slug, username);
}

export function isRoomMember(slug: string, username: string): boolean {
  return isNamedRoomMember(slug, username);
}

export function listRoomMembers(slug: string): string[] {
  return listNamedRoomMembers(slug);
}

export function createFileRecord(
  room: string,
  uploader: string,
  originalName: string,
  mime: string,
  size: number,
  filePath: string
): FileRecord {
  const stmt = getDb().prepare(
    'INSERT INTO files (room, uploader, original_name, mime, size, path) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const result = stmt.run(room, uploader, originalName, mime, size, filePath);
  return {
    id: Number(result.lastInsertRowid),
    room,
    uploader,
    original_name: originalName,
    mime,
    size,
    path: filePath,
    created_at: new Date().toISOString(),
  };
}

export function getFileRecord(id: number): FileRecord | undefined {
  return getDb()
    .prepare(
      'SELECT id, room, uploader, original_name, mime, size, path, created_at FROM files WHERE id = ?'
    )
    .get(id) as FileRecord | undefined;
}
