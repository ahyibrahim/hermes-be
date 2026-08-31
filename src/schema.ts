import Database from 'better-sqlite3';

type SqliteDb = Database.Database;

export interface SchemaLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
}

const silentLogger: SchemaLogger = {
  info() {
    // Tests and direct callers that do not care about migrate output.
  },
};

function tableExists(db: SqliteDb, name: string): boolean {
  const row = db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as { ok: number } | undefined;
  return Boolean(row);
}

function indexExists(db: SqliteDb, name: string): boolean {
  const row = db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'index' AND name = ?")
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

function note(
  log: SchemaLogger,
  applied: boolean,
  step: string,
  extra: Record<string, unknown>,
  summary: string
): void {
  log.info({ event: 'migrate', step, applied, ...extra }, summary);
}

function ensureTable(db: SqliteDb, log: SchemaLogger, name: string, ddl: string): void {
  const existed = tableExists(db, name);
  db.exec(ddl);
  note(
    log,
    !existed,
    'create_table',
    { table: name },
    existed ? `table ${name} already exists` : `created table ${name}`
  );
}

function ensureIndex(db: SqliteDb, log: SchemaLogger, name: string, ddl: string): void {
  const existed = indexExists(db, name);
  db.exec(ddl);
  note(
    log,
    !existed,
    'create_index',
    { index: name },
    existed ? `index ${name} already exists` : `created index ${name}`
  );
}

function addColumnIfMissing(
  db: SqliteDb,
  log: SchemaLogger,
  table: string,
  column: string,
  definition: string
): void {
  const missing = !columnNames(db, table).has(column);
  if (missing) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
  note(
    log,
    missing,
    'add_column',
    { table, column },
    missing ? `added ${table}.${column}` : `column ${table}.${column} already exists`
  );
}

function backfillEmpty(
  db: SqliteDb,
  log: SchemaLogger,
  table: string,
  column: string
): void {
  const result = db
    .prepare(
      `UPDATE ${table} SET ${column} = datetime('now') WHERE ${column} IS NULL OR ${column} = ''`
    )
    .run();
  note(
    log,
    result.changes > 0,
    'backfill',
    { table, column, changes: result.changes },
    result.changes > 0
      ? `backfilled ${result.changes} ${table}.${column} row(s)`
      : `no ${table}.${column} rows to backfill`
  );
}

export function migrateSchema(db: SqliteDb, log: SchemaLogger = silentLogger): void {
  ensureTable(
    db,
    log,
    'users',
    `CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`
  );

  ensureTable(
    db,
    log,
    'sessions',
    `CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    )`
  );

  ensureIndex(
    db,
    log,
    'idx_sessions_expires_at',
    'CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions (expires_at)'
  );

  ensureTable(
    db,
    log,
    'messages',
    `CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room TEXT NOT NULL DEFAULT 'general',
      sender TEXT NOT NULL DEFAULT 'anonymous',
      content TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`
  );

  ensureTable(
    db,
    log,
    'rooms',
    `CREATE TABLE IF NOT EXISTS rooms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`
  );

  ensureTable(
    db,
    log,
    'room_members',
    `CREATE TABLE IF NOT EXISTS room_members (
      room TEXT NOT NULL,
      username TEXT NOT NULL,
      PRIMARY KEY (room, username)
    )`
  );

  ensureTable(
    db,
    log,
    'files',
    `CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room TEXT NOT NULL,
      uploader TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime TEXT NOT NULL,
      size INTEGER NOT NULL,
      path TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`
  );

  // Databases in the wild had `users` created by the old auth.ts code path rather
  // than here, so treat every column as possibly absent.
  addColumnIfMissing(db, log, 'users', 'created_at', "TEXT DEFAULT ''");
  backfillEmpty(db, log, 'users', 'created_at');

  addColumnIfMissing(db, log, 'messages', 'room', "TEXT NOT NULL DEFAULT 'general'");
  addColumnIfMissing(db, log, 'messages', 'sender', "TEXT NOT NULL DEFAULT 'anonymous'");
  addColumnIfMissing(db, log, 'messages', 'content', "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, log, 'messages', 'created_at', "TEXT DEFAULT ''");
  addColumnIfMissing(db, log, 'messages', 'file_id', 'INTEGER');
  backfillEmpty(db, log, 'messages', 'created_at');

  const rebuildRooms = tableExists(db, 'rooms') && !columnNames(db, 'rooms').has('slug');
  if (rebuildRooms) {
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
  note(
    log,
    rebuildRooms,
    'rebuild_table',
    { table: 'rooms' },
    rebuildRooms ? 'rebuilt rooms with slug' : 'rooms already has slug'
  );

  addColumnIfMissing(db, log, 'rooms', 'name', "TEXT NOT NULL DEFAULT 'general'");
  addColumnIfMissing(db, log, 'rooms', 'created_at', "TEXT DEFAULT ''");
  backfillEmpty(db, log, 'rooms', 'created_at');

  const memberColumns = columnNames(db, 'room_members');
  const rebuildMembers = !memberColumns.has('room') || !memberColumns.has('username');
  if (rebuildMembers) {
    db.exec('DROP TABLE IF EXISTS room_members');
    db.exec(`
      CREATE TABLE room_members (
        room TEXT NOT NULL,
        username TEXT NOT NULL,
        PRIMARY KEY (room, username)
      );
    `);
  }
  note(
    log,
    rebuildMembers,
    'rebuild_table',
    { table: 'room_members' },
    rebuildMembers ? 'rebuilt room_members with room+username' : 'room_members already has room+username'
  );

  const seeded = db.prepare('INSERT OR IGNORE INTO rooms (slug, name) VALUES (?, ?)').run('general', 'general');
  note(
    log,
    seeded.changes > 0,
    'seed_room',
    { slug: 'general', changes: seeded.changes },
    seeded.changes > 0 ? 'seeded room general' : 'room general already present'
  );
}
