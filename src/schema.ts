import Database from 'better-sqlite3';

type SqliteDb = Database.Database;

function tableExists(db: SqliteDb, name: string): boolean {
  const row = db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as { ok: number } | undefined;
  return Boolean(row);
}

function columnNames(db: SqliteDb, table: string): Set<string> {
  if (!tableExists(db, table)) {
    return new Set();
  }

  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function addColumnIfMissing(db: SqliteDb, table: string, column: string, definition: string): void {
  if (!columnNames(db, table).has(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export function migrateSchema(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room TEXT NOT NULL DEFAULT 'general',
      sender TEXT NOT NULL DEFAULT 'anonymous',
      content TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS rooms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS room_members (
      room TEXT NOT NULL,
      username TEXT NOT NULL,
      PRIMARY KEY (room, username)
    );

    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room TEXT NOT NULL,
      uploader TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime TEXT NOT NULL,
      size INTEGER NOT NULL,
      path TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  addColumnIfMissing(db, 'messages', 'room', "TEXT NOT NULL DEFAULT 'general'");
  addColumnIfMissing(db, 'messages', 'sender', "TEXT NOT NULL DEFAULT 'anonymous'");
  addColumnIfMissing(db, 'messages', 'content', "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, 'messages', 'created_at', "TEXT DEFAULT ''");
  addColumnIfMissing(db, 'messages', 'file_id', 'INTEGER');
  db.exec(`UPDATE messages SET created_at = datetime('now') WHERE created_at IS NULL OR created_at = ''`);

  if (tableExists(db, 'rooms') && !columnNames(db, 'rooms').has('slug')) {
    const cols = columnNames(db, 'rooms');
    const nameExpr = cols.has('name') ? "COALESCE(name, 'general')" : "'general'";
    const createdExpr = cols.has('created_at') ? 'COALESCE(created_at, CURRENT_TIMESTAMP)' : 'CURRENT_TIMESTAMP';
    const slugExpr = cols.has('name')
      ? "lower(replace(COALESCE(name, 'room-' || id), ' ', '-'))"
      : "'room-' || id";

    db.exec(`
      CREATE TABLE rooms_migrated (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT OR IGNORE INTO rooms_migrated (id, slug, name, created_at)
        SELECT id, ${slugExpr}, ${nameExpr}, ${createdExpr} FROM rooms;
      DROP TABLE rooms;
      ALTER TABLE rooms_migrated RENAME TO rooms;
    `);
  }

  addColumnIfMissing(db, 'rooms', 'name', "TEXT NOT NULL DEFAULT 'general'");
  addColumnIfMissing(db, 'rooms', 'created_at', "TEXT DEFAULT ''");
  db.exec(`UPDATE rooms SET created_at = datetime('now') WHERE created_at IS NULL OR created_at = ''`);

  const memberColumns = columnNames(db, 'room_members');
  if (!memberColumns.has('room') || !memberColumns.has('username')) {
    db.exec('DROP TABLE IF EXISTS room_members');
    db.exec(`
      CREATE TABLE room_members (
        room TEXT NOT NULL,
        username TEXT NOT NULL,
        PRIMARY KEY (room, username)
      );
    `);
  }

  db.prepare('INSERT OR IGNORE INTO rooms (slug, name) VALUES (?, ?)').run('general', 'general');
}
