import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { migrateSchema, SchemaLogger } from './schema';

type SqliteDb = Database.Database;

let handle: SqliteDb | null = null;

export function resolveDatabasePath(): string {
  return process.env.HERMES_DB_PATH
    ? path.resolve(process.env.HERMES_DB_PATH)
    : path.resolve(process.cwd(), 'data', 'hermes.db');
}

/**
 * The one connection every module shares. Opened lazily so tests can point
 * HERMES_DB_PATH at a temp directory before the first query.
 */
export function getDb(log?: SchemaLogger): SqliteDb {
  if (handle) {
    return handle;
  }

  const dbPath = resolveDatabasePath();
  const directory = path.dirname(dbPath);
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  migrateSchema(db, log);
  handle = db;
  return handle;
}

/**
 * Drops the shared connection. The next getDb() reopens the file from disk,
 * which is what a service restart does.
 */
export function closeDb(): void {
  if (!handle) {
    return;
  }
  try {
    // Fold the WAL back into the main file so a copy of hermes.db after
    // shutdown is a complete backup.
    handle.pragma('wal_checkpoint(TRUNCATE)');
  } catch {
    // The handle can already be mid-close. Closing still releases it.
  }
  handle.close();
  handle = null;
}
