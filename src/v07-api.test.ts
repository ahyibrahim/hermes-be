import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AddressInfo } from 'node:net';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-v07-api-'));
process.env.HERMES_DB_PATH = path.join(tempDir, 'hermes.db');
process.env.HERMES_FILES_DIR = path.join(tempDir, 'files');

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

test('v0.7.0 REST: profile, password change, avatar, first user is admin', async () => {
  const { closeDb } = await import('./database');
  closeDb();
  const { createApp } = await import('./app');
  const { app } = await createApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

  async function json(method: string, pathName: string, body?: unknown, token?: string) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    const res = await fetch(`${origin}${pathName}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { status: res.status, data };
  }

  const regAlice = await json('POST', '/auth/register', { username: 'alice', password: 'secret1' });
  assert.equal(regAlice.status, 200);
  const alice = (regAlice.data as { user: { id: number; role: string } }).user;
  assert.equal(alice.role, 'admin');

  const regBob = await json('POST', '/auth/register', { username: 'bob', password: 'secret2' });
  assert.equal((regBob.data as { user: { role: string } }).user.role, 'member');
  const bobId = (regBob.data as { user: { id: number } }).user.id;

  const loginAlice = await json('POST', '/auth/login', { username: 'alice', password: 'secret1' });
  const aliceToken = (loginAlice.data as { token: string }).token;

  const otherLogin = await json('POST', '/auth/login', { username: 'alice', password: 'secret1' });
  const otherToken = (otherLogin.data as { token: string }).token;

  const me = await json('GET', '/users/me', undefined, aliceToken);
  assert.equal(me.status, 200);
  assert.equal((me.data as { username: string; role: string }).username, 'alice');
  assert.equal((me.data as { role: string }).role, 'admin');
  assert.equal((me.data as { avatar_file_id: number | null }).avatar_file_id, null);

  const users = await json('GET', '/users', undefined, aliceToken);
  assert.equal(users.status, 200);
  const aliceRow = (users.data as Array<{ username: string; role: string }>).find(
    (row) => row.username === 'alice'
  );
  assert.equal(aliceRow?.role, 'admin');

  const badPassword = await json(
    'PATCH',
    '/users/me',
    { current_password: 'nope', password: 'next-secret' },
    aliceToken
  );
  assert.equal(badPassword.status, 401);

  const changed = await json(
    'PATCH',
    '/users/me',
    { current_password: 'secret1', password: 'next-secret' },
    aliceToken
  );
  assert.equal(changed.status, 200);

  const stillMe = await json('GET', '/users/me', undefined, aliceToken);
  assert.equal(stillMe.status, 200);

  const otherGone = await json('GET', '/users/me', undefined, otherToken);
  assert.equal(otherGone.status, 401);

  const oldLogin = await json('POST', '/auth/login', { username: 'alice', password: 'secret1' });
  assert.equal(oldLogin.status, 401);

  const loginBob = await json('POST', '/auth/login', { username: 'bob', password: 'secret2' });
  const bobToken = (loginBob.data as { token: string }).token;

  const form = new FormData();
  form.append('file', new Blob([PNG], { type: 'image/png' }), 'me.png');
  const uploaded = await fetch(`${origin}/users/me/avatar`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${aliceToken}` },
    body: form,
  });
  assert.equal(uploaded.status, 200);
  const profile = (await uploaded.json()) as { avatar_file_id: number | null };
  assert.ok(profile.avatar_file_id);

  const avatar = await fetch(`${origin}/users/${alice.id}/avatar`, {
    headers: { Authorization: `Bearer ${bobToken}` },
  });
  assert.equal(avatar.status, 200);
  assert.equal(avatar.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await avatar.arrayBuffer()), PNG);

  const missing = await fetch(`${origin}/users/${bobId}/avatar`, {
    headers: { Authorization: `Bearer ${aliceToken}` },
  });
  assert.equal(missing.status, 404);

  const notImage = new FormData();
  notImage.append('file', new Blob(['hello'], { type: 'text/plain' }), 'notes.txt');
  const rejected = await fetch(`${origin}/users/me/avatar`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${aliceToken}` },
    body: notImage,
  });
  assert.equal(rejected.status, 415);

  await app.close();
});

test('v0.7.0 REST: auth routes are rate limited', async () => {
  const rateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-v07-rate-'));
  process.env.HERMES_DB_PATH = path.join(rateDir, 'hermes.db');
  process.env.HERMES_FILES_DIR = path.join(rateDir, 'files');

  const { closeDb } = await import('./database');
  closeDb();
  const { createApp } = await import('./app');
  const { app } = await createApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

  let lastStatus = 0;
  for (let i = 0; i < 11; i += 1) {
    const res = await fetch(`${origin}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'ghost', password: 'nope' }),
    });
    lastStatus = res.status;
    if (i < 10) {
      assert.equal(res.status, 401);
    }
  }
  assert.equal(lastStatus, 429);

  await app.close();
});
