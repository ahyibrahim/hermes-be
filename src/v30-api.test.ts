import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AddressInfo } from 'node:net';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-v30-api-'));
process.env.HERMES_DB_PATH = path.join(tempDir, 'hermes.db');
process.env.HERMES_FILES_DIR = path.join(tempDir, 'files');

test('v0.30.0: hashed sessions, ranked roles, scoped directory', async () => {
  const { closeDb, getDb } = await import('./database');
  closeDb();
  const { appointMaster } = await import('./auth');
  const { createApp } = await import('./app');
  const { app } = await createApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

  async function json(method: string, pathName: string, body?: unknown, token?: string) {
    const headers: Record<string, string> = {};
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    const res = await fetch(`${origin}${pathName}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
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
  assert.equal((regAlice.data as { user: { role: string } }).user.role, 'member');
  const regBob = await json('POST', '/auth/register', { username: 'bob', password: 'secret2' });
  assert.equal((regBob.data as { user: { role: string } }).user.role, 'member');
  const bobId = (regBob.data as { user: { id: number } }).user.id;
  const regCara = await json('POST', '/auth/register', { username: 'cara', password: 'secret3' });
  const caraId = (regCara.data as { user: { id: number } }).user.id;

  const loginAlice = await json('POST', '/auth/login', { username: 'alice', password: 'secret1' });
  const aliceToken = (loginAlice.data as { token: string }).token;
  const columns = getDb().prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
  assert.equal(columns.some((column) => column.name === 'token'), false);
  const stored = getDb()
    .prepare('SELECT scope FROM sessions WHERE token_hash = ?')
    .get(crypto.createHash('sha256').update(aliceToken).digest('hex')) as { scope: string };
  assert.equal(stored.scope, 'member');

  const directory = await json('GET', '/users', undefined, aliceToken);
  assert.deepEqual(
    (directory.data as Array<{ username: string }>).map((user) => user.username),
    ['alice']
  );
  const rooms = await json('GET', '/rooms', undefined, aliceToken);
  assert.equal(
    (rooms.data as Array<{ slug: string }>).some((room) => room.slug === 'general'),
    false
  );
  const generalPost = await json('POST', '/messages', { room: 'general', content: 'hi' }, aliceToken);
  assert.equal(generalPost.status, 403);

  await appointMaster('alice');
  const loginAliceAgain = await json('POST', '/auth/login', { username: 'alice', password: 'secret1' });
  const masterToken = (loginAliceAgain.data as { token: string }).token;
  const visible = (await json('GET', '/users', undefined, masterToken)).data as Array<{ username: string }>;
  assert.ok(visible.some((user) => user.username === 'bob'));
  assert.ok(visible.some((user) => user.username === 'cara'));

  const promote = await json('PATCH', '/users/bob/role', { role: 'admin' }, masterToken);
  assert.equal(promote.status, 200);
  assert.equal((promote.data as { role: string }).role, 'admin');
  const demoteMaster = await json('PATCH', '/users/alice/role', { role: 'member' }, masterToken);
  assert.equal(demoteMaster.status, 403);

  const loginBob = await json('POST', '/auth/login', { username: 'bob', password: 'secret2' });
  const bobToken = (loginBob.data as { token: string }).token;
  const resetMaster = await json('POST', '/users/alice/password-reset', {}, bobToken);
  assert.equal(resetMaster.status, 403);
  const resetCara = await json('POST', '/users/cara/password-reset', {}, bobToken);
  assert.equal(resetCara.status, 201);
  assert.equal(typeof (resetCara.data as { token: string }).token, 'string');
  const promoteByAdmin = await json('PATCH', '/users/cara/role', { role: 'admin' }, bobToken);
  assert.equal(promoteByAdmin.status, 403);

  const group = await json('POST', '/rooms', { name: 'notes', members: [bobId] }, masterToken);
  assert.equal(group.status, 200);
  const slug = (group.data as { slug: string }).slug;
  const posted = await json('POST', '/messages', { room: slug, content: 'secret' }, bobToken);
  assert.equal(posted.status, 200);
  const messageId = (posted.data as { id: number }).id;

  const loginCara = await json('POST', '/auth/login', { username: 'cara', password: 'secret3' });
  const caraToken = (loginCara.data as { token: string }).token;
  const outsider = await json('DELETE', `/messages/${messageId}`, undefined, caraToken);
  assert.equal(outsider.status, 404);
  assert.equal((outsider.data as { error: string }).error, 'message not found');

  const guestRole = getDb().prepare("UPDATE users SET role = 'guest' WHERE username = 'cara'").run();
  assert.equal(guestRole.changes, 1);
  const guestDm = await json('POST', '/rooms/dm', { userId: bobId }, caraToken);
  assert.equal(guestDm.status, 403);
  const guestAdd = await json('POST', '/rooms/members', { room: slug, userIds: [caraId] }, caraToken);
  assert.equal(guestAdd.status, 403);

  await app.close();
  closeDb();
});
