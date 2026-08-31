import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-sessions-'));
const dbPath = path.join(tempDir, 'hermes.db');
process.env.HERMES_DB_PATH = dbPath;

const DAY_MS = 24 * 60 * 60 * 1000;

test('session ttl defaults to 30 days and is configurable', async () => {
  const { DEFAULT_SESSION_TTL_DAYS, sessionTtlDays } = await import('./sessions');

  assert.equal(DEFAULT_SESSION_TTL_DAYS, 30);
  assert.equal(sessionTtlDays(), 30);

  process.env.HERMES_SESSION_TTL_DAYS = '7';
  assert.equal(sessionTtlDays(), 7);

  for (const bogus of ['', 'soon', '0', '-3']) {
    process.env.HERMES_SESSION_TTL_DAYS = bogus;
    assert.equal(sessionTtlDays(), DEFAULT_SESSION_TTL_DAYS);
  }

  delete process.env.HERMES_SESSION_TTL_DAYS;
});

test('a session is written to sqlite and survives reopening the file', async () => {
  const { createSession, findSessionUser } = await import('./sessions');
  const { closeDb } = await import('./database');

  const session = createSession('alice');
  assert.equal(findSessionUser(session.token), 'alice');
  assert.ok(Date.parse(session.expires_at) - Date.parse(session.created_at) >= 29 * DAY_MS);

  closeDb();

  const independent = new Database(dbPath, { readonly: true });
  const row = independent.prepare('SELECT username FROM sessions WHERE token = ?').get(session.token) as
    | { username: string }
    | undefined;
  independent.close();
  assert.equal(row?.username, 'alice');

  // Reopens the file through the shared handle, the way a restart does.
  assert.equal(findSessionUser(session.token), 'alice');
});

test('expired sessions are rejected and pruned', async () => {
  const { createSession, findSessionUser, getSession, pruneExpiredSessions } = await import('./sessions');

  const stale = createSession('bob', Date.now() - 40 * DAY_MS);
  assert.ok(getSession(stale.token));
  assert.equal(findSessionUser(stale.token), null);
  assert.equal(getSession(stale.token), undefined);

  const alsoStale = createSession('carol', Date.now() - 31 * DAY_MS);
  const fresh = createSession('carol');
  assert.equal(getSession(alsoStale.token), undefined, 'login should prune expired rows');
  assert.equal(findSessionUser(fresh.token), 'carol');

  assert.equal(pruneExpiredSessions(), 0);
  assert.equal(findSessionUser('not-a-real-token'), null);
  assert.equal(findSessionUser(undefined), null);
  assert.equal(findSessionUser('   '), null);
});

test('a short ttl expires a token without touching the clock', async () => {
  const { createSession, findSessionUser } = await import('./sessions');

  process.env.HERMES_SESSION_TTL_DAYS = '1';
  const session = createSession('dave');
  delete process.env.HERMES_SESSION_TTL_DAYS;

  assert.equal(findSessionUser(session.token), 'dave');
  assert.equal(findSessionUser(session.token, Date.now() + 2 * DAY_MS), null);
});
