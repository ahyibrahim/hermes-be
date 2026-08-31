import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { redactRequestUrl, resolveLogLevel } from './logger';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-logger-'));
process.env.HERMES_DB_PATH = path.join(tempDir, 'hermes.db');
process.env.HERMES_FILES_DIR = path.join(tempDir, 'files');

const PASSWORD = 'pw-redact-probe-7f3a9c';
const QUERY_TOKEN = 'tok-query-probe-1b2e4d';
const BEARER_TOKEN = 'tok-bearer-probe-9c8a7b';

function parseLines(chunks: string[]): Array<Record<string, unknown>> {
  return chunks
    .join('')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test('redactRequestUrl strips token query values', () => {
  assert.equal(redactRequestUrl('/rooms?token=secret'), '/rooms?token=[Redacted]');
  assert.equal(redactRequestUrl('/ws?token=abc&x=1'), '/ws?token=[Redacted]&x=1');
  assert.equal(redactRequestUrl('/health'), '/health');
});

test('resolveLogLevel reads LOG_LEVEL and ignores junk', () => {
  const previous = process.env.LOG_LEVEL;
  try {
    delete process.env.LOG_LEVEL;
    assert.equal(resolveLogLevel(), 'info');
    assert.equal(resolveLogLevel('debug'), 'debug');
    process.env.LOG_LEVEL = 'WARN';
    assert.equal(resolveLogLevel(), 'warn');
    process.env.LOG_LEVEL = 'loud';
    assert.equal(resolveLogLevel(), 'info');
  } finally {
    if (previous === undefined) {
      delete process.env.LOG_LEVEL;
    } else {
      process.env.LOG_LEVEL = previous;
    }
  }
});

test('a login request with Bearer and ?token= does not leak secrets into logs', async () => {
  const chunks: string[] = [];
  const { createApp } = await import('./app');
  const { app } = await createApp({
    loggerDestination: {
      write(chunk: string) {
        chunks.push(chunk);
      },
    },
    logLevel: 'info',
  });

  try {
    const register = await app.inject({
      method: 'POST',
      url: '/auth/register',
      headers: { 'content-type': 'application/json' },
      payload: { username: 'logger', password: PASSWORD },
    });
    assert.equal(register.statusCode, 200);

    const login = await app.inject({
      method: 'POST',
      url: `/auth/login?token=${QUERY_TOKEN}`,
      headers: {
        authorization: `Bearer ${BEARER_TOKEN}`,
        'content-type': 'application/json',
      },
      payload: { username: 'logger', password: PASSWORD },
    });
    assert.equal(login.statusCode, 200);
    const session = login.json() as { token: string; username: string };
    assert.ok(session.token);

    const rooms = await app.inject({
      method: 'GET',
      url: `/rooms?token=${encodeURIComponent(session.token)}`,
      headers: { authorization: `Bearer ${session.token}` },
    });
    assert.equal(rooms.statusCode, 200);

    const dumped = chunks.join('');
    assert.equal(dumped.includes(PASSWORD), false, 'password must not appear in logs');
    assert.equal(dumped.includes(QUERY_TOKEN), false, '?token= value must not appear in logs');
    assert.equal(dumped.includes(BEARER_TOKEN), false, 'Authorization bearer must not appear in logs');
    assert.equal(dumped.includes(session.token), false, 'issued session token must not appear in logs');
    assert.match(dumped, /\[Redacted\]/);

    const records = parseLines(chunks);
    assert.ok(
      records.some((row) => row.event === 'login_success' && row.username === 'logger' && typeof row.reqId === 'string'),
      'login_success is a request-scoped domain event with a reqId'
    );
    assert.ok(
      records.some((row) => typeof row.reqId === 'string' && row.req !== undefined),
      'request log lines carry a reqId'
    );
    assert.ok(
      records.some((row) => row.event === 'migrate' && row.step === 'create_table'),
      'migrateSchema steps are logged at process start'
    );
  } finally {
    await app.close();
  }
});

test('login failure is logged without a password or token', async () => {
  const chunks: string[] = [];
  const { createApp } = await import('./app');
  const { closeDb } = await import('./database');
  closeDb();

  const { app } = await createApp({
    loggerDestination: {
      write(chunk: string) {
        chunks.push(chunk);
      },
    },
    logLevel: 'info',
  });

  try {
    await app.inject({
      method: 'POST',
      url: '/auth/register',
      headers: { 'content-type': 'application/json' },
      payload: { username: 'logger2', password: PASSWORD },
    });

    const failed = await app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: {
        authorization: `Bearer ${BEARER_TOKEN}`,
        'content-type': 'application/json',
      },
      payload: { username: 'logger2', password: PASSWORD + '-wrong' },
    });
    assert.equal(failed.statusCode, 401);

    const dumped = chunks.join('');
    assert.equal(dumped.includes(PASSWORD), false);
    assert.equal(dumped.includes(BEARER_TOKEN), false);

    const records = parseLines(chunks);
    assert.ok(records.some((row) => row.event === 'login_failure' && row.username === 'logger2' && row.password === undefined));
  } finally {
    await app.close();
  }
});
