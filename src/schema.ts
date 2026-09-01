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

function backfillFirstAdmin(db: SqliteDb, log: SchemaLogger): void {
  const admins = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get() as {
    n: number;
  };
  if (admins.n > 0) {
    note(log, false, 'backfill', { table: 'users', column: 'role' }, 'an admin user already exists');
    return;
  }

  const first = db.prepare('SELECT id FROM users ORDER BY id ASC LIMIT 1').get() as
    | { id: number }
    | undefined;
  if (!first) {
    note(log, false, 'backfill', { table: 'users', column: 'role' }, 'no users to promote to admin');
    return;
  }

  db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(first.id);
  note(
    log,
    true,
    'backfill',
    { table: 'users', column: 'role', userId: first.id },
    `promoted user ${first.id} to admin`
  );
}

const FK_MEMBERS_DDL = `CREATE TABLE room_members (
      room_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (room_id, user_id),
      FOREIGN KEY (room_id) REFERENCES rooms(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    )`;

function migrateRoomMembers(db: SqliteDb, log: SchemaLogger): void {
  if (!tableExists(db, 'room_members')) {
    db.exec(FK_MEMBERS_DDL);
    note(log, true, 'create_table', { table: 'room_members' }, 'created table room_members');
    return;
  }

  const cols = columnNames(db, 'room_members');
  const isFk = cols.has('room_id') && cols.has('user_id');
  const isSlug = cols.has('room') && cols.has('username');

  if (isFk && !isSlug) {
    addColumnIfMissing(db, log, 'room_members', 'joined_at', "TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP");
    note(
      log,
      false,
      'rebuild_table',
      { table: 'room_members' },
      'room_members already uses room_id+user_id'
    );
    return;
  }

  if (isSlug) {
    db.exec('DROP TABLE IF EXISTS room_members_new');
    db.exec(FK_MEMBERS_DDL.replace('CREATE TABLE room_members', 'CREATE TABLE room_members_new'));
    const inserted = db
      .prepare(
        `INSERT OR IGNORE INTO room_members_new (room_id, user_id)
         SELECT r.id, u.id
         FROM room_members old
         JOIN rooms r ON r.slug = old.room
         JOIN users u ON u.username = old.username`
      )
      .run();
    db.exec('DROP TABLE room_members');
    db.exec('ALTER TABLE room_members_new RENAME TO room_members');
    note(
      log,
      true,
      'rebuild_table',
      { table: 'room_members', changes: inserted.changes },
      `rewrote room_members to room_id+user_id (${inserted.changes} row(s))`
    );
    return;
  }

  db.exec('DROP TABLE room_members');
  db.exec(FK_MEMBERS_DDL);
  note(
    log,
    true,
    'rebuild_table',
    { table: 'room_members' },
    'replaced unrecognised room_members shape with room_id+user_id'
  );
}

function backfillGeneralMembership(db: SqliteDb, log: SchemaLogger): void {
  const general = db.prepare("SELECT id FROM rooms WHERE slug = 'general'").get() as
    | { id: number }
    | undefined;
  if (!general) {
    note(log, false, 'backfill', { table: 'room_members' }, 'no general room to backfill into');
    return;
  }

  const result = db
    .prepare(
      `INSERT OR IGNORE INTO room_members (room_id, user_id)
       SELECT ?, id FROM users`
    )
    .run(general.id);
  note(
    log,
    result.changes > 0,
    'backfill',
    { table: 'room_members', room: 'general', changes: result.changes },
    result.changes > 0
      ? `added ${result.changes} user(s) to general`
      : 'every user is already in general'
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
      role TEXT NOT NULL DEFAULT 'member',
      avatar_file_id INTEGER,
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
      type TEXT NOT NULL DEFAULT 'group' CHECK(type IN ('group', 'dm')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`
  );

  addColumnIfMissing(db, log, 'rooms', 'type', "TEXT NOT NULL DEFAULT 'group'");

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
  addColumnIfMissing(db, log, 'users', 'role', "TEXT NOT NULL DEFAULT 'member'");
  addColumnIfMissing(db, log, 'users', 'avatar_file_id', 'INTEGER');
  backfillFirstAdmin(db, log);

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
        type TEXT NOT NULL DEFAULT 'group' CHECK(type IN ('group', 'dm')),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT OR IGNORE INTO rooms_migrated (id, slug, name, type, created_at)
        SELECT id, ${slugExpr}, ${nameExpr}, 'group', ${createdExpr} FROM rooms;
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

  const seeded = db.prepare("INSERT OR IGNORE INTO rooms (slug, name, type) VALUES (?, ?, 'group')").run(
    'general',
    'general'
  );
  note(
    log,
    seeded.changes > 0,
    'seed_room',
    { slug: 'general', changes: seeded.changes },
    seeded.changes > 0 ? 'seeded room general' : 'room general already present'
  );

  migrateRoomMembers(db, log);
  backfillGeneralMembership(db, log);
}
