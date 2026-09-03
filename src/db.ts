import fs from 'node:fs';
import { getDb } from './database';
import { isoTimestamp, toIsoTimestamp } from './colors';
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
  deleted_at?: string | null;
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
    'SELECT id, room, sender, content, created_at, file_id, deleted_at FROM messages WHERE room = ? ORDER BY id ASC'
  );

  return (stmt.all(room) as MessageRecord[]).map((message) => ({
    ...message,
    created_at: toIsoTimestamp(message.created_at),
  }));
}

export function createMessage(
  room: string,
  sender: string,
  content: string,
  fileId: number | null = null
): MessageRecord {
  const createdAt = isoTimestamp();
  const stmt = getDb().prepare(
    'INSERT INTO messages (room, sender, content, file_id, created_at) VALUES (?, ?, ?, ?, ?)'
  );

  const result = stmt.run(room, sender, content, fileId, createdAt);

  return {
    id: Number(result.lastInsertRowid),
    room,
    sender,
    content,
    created_at: createdAt,
    file_id: fileId,
    deleted_at: null,
  };
}

export function getMessageById(id: number): MessageRecord | undefined {
  const row = getDb()
    .prepare(
      'SELECT id, room, sender, content, created_at, file_id, deleted_at FROM messages WHERE id = ?'
    )
    .get(id) as MessageRecord | undefined;
  if (!row) {
    return undefined;
  }
  return { ...row, created_at: toIsoTimestamp(row.created_at) };
}

function toTombstone(message: MessageRecord, deletedAt: string): MessageRecord {
  return {
    ...message,
    content: '',
    file_id: null,
    deleted_at: deletedAt,
  };
}

function deleteOrphanFile(fileId: number): void {
  const avatar = getDb()
    .prepare('SELECT 1 AS ok FROM users WHERE avatar_file_id = ?')
    .get(fileId) as { ok: number } | undefined;
  if (avatar) {
    return;
  }
  const used = getDb()
    .prepare('SELECT 1 AS ok FROM messages WHERE file_id = ?')
    .get(fileId) as { ok: number } | undefined;
  if (used) {
    return;
  }
  const file = getFileRecord(fileId);
  if (!file) {
    return;
  }
  fs.rmSync(file.path, { force: true });
  getDb().prepare('DELETE FROM files WHERE id = ?').run(fileId);
}

export function unsendMessage(
  id: number,
  username: string
): { message: MessageRecord } | { error: 'not_found' | 'forbidden' } {
  const existing = getMessageById(id);
  if (!existing) {
    return { error: 'not_found' };
  }
  if (existing.sender !== username) {
    return { error: 'forbidden' };
  }
  if (existing.deleted_at) {
    return { message: toTombstone(existing, existing.deleted_at) };
  }

  const deletedAt = isoTimestamp();
  const previousFileId = existing.file_id ?? null;
  getDb()
    .prepare('UPDATE messages SET content = ?, file_id = NULL, deleted_at = ? WHERE id = ?')
    .run('', deletedAt, id);
  if (previousFileId != null) {
    deleteOrphanFile(previousFileId);
  }
  return { message: toTombstone({ ...existing, created_at: existing.created_at }, deletedAt) };
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
  const createdAt = isoTimestamp();
  const stmt = getDb().prepare(
    'INSERT INTO files (room, uploader, original_name, mime, size, path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  const result = stmt.run(room, uploader, originalName, mime, size, filePath, createdAt);
  return {
    id: Number(result.lastInsertRowid),
    room,
    uploader,
    original_name: originalName,
    mime,
    size,
    path: filePath,
    created_at: createdAt,
  };
}

export function getFileRecord(id: number): FileRecord | undefined {
  return getDb()
    .prepare(
      'SELECT id, room, uploader, original_name, mime, size, path, created_at FROM files WHERE id = ?'
    )
    .get(id) as FileRecord | undefined;
}
