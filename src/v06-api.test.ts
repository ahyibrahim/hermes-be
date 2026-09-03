import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AddressInfo } from 'node:net';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-v06-api-'));
process.env.HERMES_DB_PATH = path.join(tempDir, 'hermes.db');
process.env.HERMES_FILES_DIR = path.join(tempDir, 'files');

test('v0.6.0 REST: users, rooms, DMs, logout', async () => {
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

  const health = await json('GET', '/health');
  assert.equal(health.status, 200);

  const regAlice = await json('POST', '/auth/register', { username: 'alice', password: 'secret1' });
  assert.equal(regAlice.status, 200);
  const aliceId = (regAlice.data as { user: { id: number } }).user.id;

  const regBob = await json('POST', '/auth/register', { username: 'bob', password: 'secret2' });
  assert.equal(regBob.status, 200);
  const bobId = (regBob.data as { user: { id: number } }).user.id;

  const dupReg = await json('POST', '/auth/register', { username: 'alice', password: 'x' });
  assert.equal(dupReg.status, 409);

  const loginAlice = await json('POST', '/auth/login', { username: 'alice', password: 'secret1' });
  assert.equal(loginAlice.status, 200);
  const aliceToken = (loginAlice.data as { token: string }).token;

  const badLogin = await json('POST', '/auth/login', { username: 'alice', password: 'wrong' });
  assert.equal(badLogin.status, 401);

  const noAuth = await json('GET', '/rooms');
  assert.equal(noAuth.status, 401);

  const users = await json('GET', '/users', undefined, aliceToken);
  assert.equal(users.status, 200);
  const directory = users.data as Array<{ username: string; system?: boolean }>;
  assert.deepEqual(
    directory.map((row) => row.username).sort(),
    ['alice', 'bob', 'hermes']
  );
  assert.equal(directory.find((row) => row.username === 'hermes')?.system, true);

  const online = await json('GET', '/users/online', undefined, aliceToken);
  assert.equal(online.status, 200);

  const rooms = await json('GET', '/rooms', undefined, aliceToken);
  assert.equal(rooms.status, 200);
  const aliceRooms = rooms.data as { slug: string; type: string }[];
  assert.ok(aliceRooms.some((room) => room.slug === 'general' && room.type === 'group'));

  const group = await json('POST', '/rooms', { name: 'Test Group', members: [bobId] }, aliceToken);
  assert.equal(group.status, 200);
  const groupSlug = (group.data as { slug: string }).slug;

  const dm = await json('POST', '/rooms/dm', { userId: bobId }, aliceToken);
  assert.equal(dm.status, 200);
  const dmSlug = (dm.data as { slug: string; type: string }).slug;
  assert.equal((dm.data as { type: string }).type, 'dm');

  const dmAgain = await json('POST', '/rooms/dm', { userId: bobId }, aliceToken);
  assert.equal((dmAgain.data as { slug: string }).slug, dmSlug);

  const selfDm = await json('POST', '/rooms/dm', { userId: aliceId }, aliceToken);
  assert.equal(selfDm.status, 400);

  const postMsg = await json(
    'POST',
    '/messages',
    { room: 'general', content: 'hello from REST' },
    aliceToken
  );
  assert.equal(postMsg.status, 200);
  assert.equal((postMsg.data as { sender: string }).sender, 'alice');

  const emptyMsg = await json('POST', '/messages', { room: 'general', content: '   ' }, aliceToken);
  assert.equal(emptyMsg.status, 400);

  const loginBob = await json('POST', '/auth/login', { username: 'bob', password: 'secret2' });
  const bobToken = (loginBob.data as { token: string }).token;

  const bobGroup = await json('GET', `/messages?room=${encodeURIComponent(groupSlug)}`, undefined, bobToken);
  assert.equal(bobGroup.status, 200);

  const logout = await json('POST', '/auth/logout', {}, aliceToken);
  assert.equal(logout.status, 200);

  const afterLogout = await json('GET', '/rooms', undefined, aliceToken);
  assert.equal(afterLogout.status, 401);

  await app.close();
});
