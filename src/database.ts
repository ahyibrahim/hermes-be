import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { migrateSchema } from './schema';

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
export function getDb(): SqliteDb {
  if (handle) {
    return handle;
  }

  const dbPath = resolveDatabasePath();
  const directory = path.dirname(dbPath);
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }

  const db = new Database(dbPath);
  migrateSchema(db);
  handle = db;
  return handle;
}

/**
 * Drops the shared connection. The next getDb() reopens the file from disk,
 * which is what a service restart does.
 */
export function closeDb(): void {
  handle?.close();
  handle = null;
}
