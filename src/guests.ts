import fs from 'node:fs';
import { getDb } from './database';

export type GuestStatus = 'waiting' | 'admitted' | 'removed';

type RetiredHandler = (username: string, rooms: string[]) => void;

let onRetired: RetiredHandler = () => {
  // The app registers the live-socket cleanup once it exists.
};

/** Called when a guest's last session is gone and their uploads are deleted. */
export function setGuestRetiredHandler(handler: RetiredHandler): void {
  onRetired = handler;
}

export function guestStatus(username: string): GuestStatus | null {
  const row = getDb()
    .prepare('SELECT guest_status FROM users WHERE username = ?')
    .get(username) as { guest_status: string | null } | undefined;
  if (!row) {
    return null;
  }
  if (row.guest_status === 'waiting' || row.guest_status === 'admitted' || row.guest_status === 'removed') {
    return row.guest_status;
  }
  return null;
}

function membershipSlugs(userId: number): string[] {
  return (
    getDb()
      .prepare(
        `SELECT r.slug AS slug
         FROM room_members rm
         JOIN rooms r ON r.id = rm.room_id
         WHERE rm.user_id = ?`
      )
      .all(userId) as Array<{ slug: string }>
  ).map((row) => row.slug);
}

function deleteUploads(username: string): void {
  const files = getDb()
    .prepare('SELECT id, path FROM files WHERE uploader = ?')
    .all(username) as Array<{ id: number; path: string }>;
  const clearMessage = getDb().prepare('UPDATE messages SET file_id = NULL WHERE file_id = ?');
  const clearAvatar = getDb().prepare('UPDATE users SET avatar_file_id = NULL WHERE avatar_file_id = ?');
  const dropFile = getDb().prepare('DELETE FROM files WHERE id = ?');
  for (const file of files) {
    clearMessage.run(file.id);
    clearAvatar.run(file.id);
    fs.rmSync(file.path, { force: true });
    dropFile.run(file.id);
  }
}

/**
 * Ends a guest who has no live session. Messages stay. Uploads are deleted
 * and the account leaves its rooms. A second call is a no-op.
 * The 12-hour session end uses this path. The master's Remove button does not.
 */
export function retireGuestAccount(username: string): string[] {
  const db = getDb();
  const live = db.prepare('SELECT 1 AS ok FROM sessions WHERE username = ?').get(username) as
    | { ok: number }
    | undefined;
  if (live) {
    return [];
  }

  const user = db
    .prepare(
      `SELECT id FROM users
       WHERE username = ? AND role = 'guest' AND guest_status IN ('waiting', 'admitted')`
    )
    .get(username) as { id: number } | undefined;
  if (!user) {
    return [];
  }

  const rooms = membershipSlugs(user.id);
  const finish = db.transaction(() => {
    deleteUploads(username);
    db.prepare('DELETE FROM room_members WHERE user_id = ?').run(user.id);
    db.prepare('DELETE FROM guest_rooms WHERE user_id = ?').run(user.id);
    db.prepare("UPDATE users SET guest_status = 'removed' WHERE id = ?").run(user.id);
  });
  finish();
  onRetired(username, rooms);
  return rooms;
}

/**
 * Master's Remove. Deletes the account and that guest's messages. Other
 * people's messages stay. A waiting guest who never sent anything is only
 * the account row.
 */
export function purgeGuestAccount(username: string): string[] {
  const db = getDb();
  const user = db
    .prepare(
      `SELECT id FROM users
       WHERE username = ? AND role = 'guest' AND guest_status IN ('waiting', 'admitted')`
    )
    .get(username) as { id: number } | undefined;
  if (!user) {
    return [];
  }

  const rooms = membershipSlugs(user.id);
  const finish = db.transaction(() => {
    db.prepare('DELETE FROM sessions WHERE username = ?').run(username);
    deleteUploads(username);
    db.prepare('DELETE FROM messages WHERE sender = ?').run(username);
    db.prepare('DELETE FROM room_members WHERE user_id = ?').run(user.id);
    db.prepare('DELETE FROM guest_rooms WHERE user_id = ?').run(user.id);
    db.prepare('DELETE FROM room_reads WHERE user_id = ?').run(user.id);
    db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
  });
  finish();
  onRetired(username, rooms);
  return rooms;
}
