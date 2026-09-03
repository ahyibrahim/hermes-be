import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { USER_COLOR_PALETTE } from './colors';
import { SYSTEM_PASSWORD_PLACEHOLDER, SYSTEM_USERNAME } from './system-user';

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

function backfillIsoTimestamps(db: SqliteDb, log: SchemaLogger, table: string): void {
  if (!columnNames(db, table).has('created_at')) {
    note(log, false, 'backfill', { table, column: 'created_at' }, `${table}.created_at absent`);
    return;
  }

  const rows = db
    .prepare(`SELECT rowid AS id, created_at FROM ${table}`)
    .all() as Array<{ id: number; created_at: string | null }>;
  let changes = 0;
  const update = db.prepare(`UPDATE ${table} SET created_at = ? WHERE rowid = ?`);
  for (const row of rows) {
    const next = toIso(row.created_at);
    if (next !== row.created_at) {
      update.run(next, row.id);
      changes += 1;
    }
  }
  note(
    log,
    changes > 0,
    'backfill',
    { table, column: 'created_at', changes },
    changes > 0
      ? `normalized ${changes} ${table}.created_at value(s) to ISO-8601`
      : `no ${table}.created_at values to normalize`
  );
}

function toIso(value: string | null): string {
  if (!value) {
    return new Date().toISOString();
  }
  if (value.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(value)) {
    const parsed = new Date(value.includes('T') ? value : value.replace(' ', 'T'));
    return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
  }
  const naive = value.includes('T') ? value : value.replace(' ', 'T');
  const parsed = new Date(`${naive}Z`);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

const COLOR_PALETTE = [
  'ember',
  'moss',
  'lake',
  'plum',
  'rust',
  'teal',
  'gold',
  'indigo',
  'rose',
  'slate',
];

function backfillUserColors(db: SqliteDb, log: SchemaLogger): void {
  const taken = new Set(
    (
      db
        .prepare("SELECT color FROM users WHERE color IS NOT NULL AND color != ''")
        .all() as Array<{ color: string }>
    ).map((row) => row.color)
  );
  const missing = db
    .prepare("SELECT id FROM users WHERE color IS NULL OR color = '' ORDER BY id ASC")
    .all() as Array<{ id: number }>;
  const update = db.prepare('UPDATE users SET color = ? WHERE id = ?');
  let changes = 0;
  for (const row of missing) {
    const color =
      COLOR_PALETTE.find((slot) => !taken.has(slot)) ?? COLOR_PALETTE[changes % COLOR_PALETTE.length];
    taken.add(color);
    update.run(color, row.id);
    changes += 1;
  }
  note(
    log,
    changes > 0,
    'backfill',
    { table: 'users', column: 'color', changes },
    changes > 0 ? `assigned color to ${changes} user(s)` : 'every user already has a color'
  );
}

function ensureUniqueUserColorIndex(db: SqliteDb, log: SchemaLogger): void {
  const dupes = db
    .prepare(
      `SELECT color FROM users
       WHERE color IS NOT NULL AND color != ''
       GROUP BY color
       HAVING COUNT(*) > 1`
    )
    .all() as Array<{ color: string }>;
  if (dupes.length > 0) {
    note(
      log,
      false,
      'create_index',
      { index: 'idx_users_color', skipped: true, duplicates: dupes.length },
      'skipped unique users.color index because the 11th user wraps and shares a slot'
    );
    return;
  }

  ensureIndex(
    db,
    log,
    'idx_users_color',
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_color ON users(color) WHERE color IS NOT NULL AND color != ''"
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

  const first = db
    .prepare(
      `SELECT id FROM users
       WHERE COALESCE(system, 0) = 0
       ORDER BY id ASC LIMIT 1`
    )
    .get() as { id: number } | undefined;
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

const projectRoot = path.resolve(__dirname, '..');

function resolveFilesDir(): string {
  return process.env.HERMES_FILES_DIR
    ? path.resolve(process.env.HERMES_FILES_DIR)
    : path.resolve(projectRoot, 'data', 'files');
}

function readPackageVersion(): string {
  try {
    const raw = fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version?.trim() || '';
  } catch {
    return '';
  }
}

function pickSystemColor(db: SqliteDb): string | null {
  const taken = new Set(
    (
      db
        .prepare("SELECT color FROM users WHERE color IS NOT NULL AND color != ''")
        .all() as Array<{ color: string }>
    ).map((row) => row.color)
  );
  return USER_COLOR_PALETTE.find((slot) => !taken.has(slot)) ?? null;
}

function seedSystemAvatar(db: SqliteDb, log: SchemaLogger, userId: number): void {
  const existing = db.prepare('SELECT avatar_file_id FROM users WHERE id = ?').get(userId) as
    | { avatar_file_id: number | null }
    | undefined;
  if (existing?.avatar_file_id) {
    const file = db
      .prepare('SELECT path FROM files WHERE id = ?')
      .get(existing.avatar_file_id) as { path: string } | undefined;
    if (file && fs.existsSync(file.path)) {
      note(log, false, 'seed_avatar', { username: SYSTEM_USERNAME }, 'hermes avatar already present');
      return;
    }
  }

  const source = path.join(projectRoot, 'assets', 'hermes-mark.png');
  if (!fs.existsSync(source)) {
    note(log, false, 'seed_avatar', { username: SYSTEM_USERNAME }, 'hermes mark asset missing');
    return;
  }

  const filesDir = resolveFilesDir();
  fs.mkdirSync(filesDir, { recursive: true });
  const storedPath = path.join(filesDir, 'hermes-mark.png');
  fs.copyFileSync(source, storedPath);
  const stat = fs.statSync(storedPath);
  const createdAt = new Date().toISOString();
  const inserted = db
    .prepare(
      `INSERT INTO files (room, uploader, original_name, mime, size, path, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run('general', SYSTEM_USERNAME, 'hermes-mark.png', 'image/png', stat.size, storedPath, createdAt);
  const fileId = Number(inserted.lastInsertRowid);
  db.prepare('UPDATE users SET avatar_file_id = ? WHERE id = ?').run(fileId, userId);
  note(log, true, 'seed_avatar', { username: SYSTEM_USERNAME, fileId }, 'seeded hermes mark avatar');
}

function seedSystemHermes(db: SqliteDb, log: SchemaLogger): void {
  const existing = db
    .prepare('SELECT id, system, role FROM users WHERE username = ?')
    .get(SYSTEM_USERNAME) as { id: number; system: number; role: string } | undefined;

  let userId: number;
  if (!existing) {
    const color = pickSystemColor(db);
    const inserted = db
      .prepare(
        `INSERT INTO users (username, password, role, system, color, created_at)
         VALUES (?, ?, 'member', 1, ?, ?)`
      )
      .run(SYSTEM_USERNAME, SYSTEM_PASSWORD_PLACEHOLDER, color, new Date().toISOString());
    userId = Number(inserted.lastInsertRowid);
    note(log, true, 'seed_user', { username: SYSTEM_USERNAME, userId }, 'seeded system user hermes');
  } else {
    userId = existing.id;
    if (!existing.system || existing.role === 'admin') {
      db.prepare("UPDATE users SET system = 1, role = 'member', password = ? WHERE id = ?").run(
        SYSTEM_PASSWORD_PLACEHOLDER,
        userId
      );
      note(log, true, 'seed_user', { username: SYSTEM_USERNAME, userId }, 'converted hermes to a system user');
      backfillFirstAdmin(db, log);
    } else {
      note(log, false, 'seed_user', { username: SYSTEM_USERNAME, userId }, 'system user hermes already present');
    }
  }

  const general = db.prepare("SELECT id FROM rooms WHERE slug = 'general'").get() as
    | { id: number }
    | undefined;
  if (general) {
    db.prepare('INSERT OR IGNORE INTO room_members (room_id, user_id) VALUES (?, ?)').run(
      general.id,
      userId
    );
  }

  seedSystemAvatar(db, log, userId);
}

export function postReleaseAnnouncement(
  db: SqliteDb,
  log: SchemaLogger = silentLogger,
  version = readPackageVersion()
): boolean {
  if (!version) {
    note(log, false, 'announce', { version }, 'no package version to announce');
    return false;
  }

  const already = db.prepare('SELECT message_id FROM announcements WHERE version = ?').get(version) as
    | { message_id: number }
    | undefined;
  if (already) {
    note(log, false, 'announce', { version, messageId: already.message_id }, `v${version} already announced`);
    return false;
  }

  const copyPath = path.join(projectRoot, 'docs', 'announcements', `v${version}.md`);
  if (!fs.existsSync(copyPath)) {
    note(log, false, 'announce', { version }, `no announcement copy for v${version}`);
    return false;
  }

  const content = fs.readFileSync(copyPath, 'utf8').trim();
  if (!content) {
    note(log, false, 'announce', { version }, `empty announcement copy for v${version}`);
    return false;
  }

  const createdAt = new Date().toISOString();
  const inserted = db
    .prepare('INSERT INTO messages (room, sender, content, created_at) VALUES (?, ?, ?, ?)')
    .run('general', SYSTEM_USERNAME, content, createdAt);
  const messageId = Number(inserted.lastInsertRowid);
  db.prepare('INSERT INTO announcements (version, message_id, posted_at) VALUES (?, ?, ?)').run(
    version,
    messageId,
    createdAt
  );
  note(log, true, 'announce', { version, messageId }, `posted v${version} announcement to general`);
  return true;
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
      system INTEGER NOT NULL DEFAULT 0,
      avatar_file_id INTEGER,
      color TEXT,
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
  addColumnIfMissing(db, log, 'users', 'system', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(db, log, 'users', 'avatar_file_id', 'INTEGER');
  addColumnIfMissing(db, log, 'users', 'color', 'TEXT');
  backfillFirstAdmin(db, log);
  backfillUserColors(db, log);
  ensureUniqueUserColorIndex(db, log);

  addColumnIfMissing(db, log, 'messages', 'room', "TEXT NOT NULL DEFAULT 'general'");
  addColumnIfMissing(db, log, 'messages', 'sender', "TEXT NOT NULL DEFAULT 'anonymous'");
  addColumnIfMissing(db, log, 'messages', 'content', "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, log, 'messages', 'created_at', "TEXT DEFAULT ''");
  addColumnIfMissing(db, log, 'messages', 'file_id', 'INTEGER');
  addColumnIfMissing(db, log, 'messages', 'deleted_at', 'TEXT');
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
  addColumnIfMissing(db, log, 'room_members', 'hidden_at', 'TEXT');
  backfillGeneralMembership(db, log);

  ensureTable(
    db,
    log,
    'password_reset_tokens',
    `CREATE TABLE IF NOT EXISTS password_reset_tokens (
      username TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`
  );

  ensureTable(
    db,
    log,
    'room_reads',
    `CREATE TABLE IF NOT EXISTS room_reads (
      user_id INTEGER NOT NULL,
      room TEXT NOT NULL,
      last_message_id INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, room)
    )`
  );

  backfillIsoTimestamps(db, log, 'messages');
  backfillIsoTimestamps(db, log, 'files');
  backfillIsoTimestamps(db, log, 'rooms');
  backfillIsoTimestamps(db, log, 'users');

  ensureTable(
    db,
    log,
    'announcements',
    `CREATE TABLE IF NOT EXISTS announcements (
      version TEXT PRIMARY KEY,
      message_id INTEGER NOT NULL,
      posted_at TEXT NOT NULL
    )`
  );
  seedSystemHermes(db, log);
  postReleaseAnnouncement(db, log);
}
