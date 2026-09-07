import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-v14-api-'));
process.env.HERMES_DB_PATH = path.join(tempDir, 'hermes.db');
process.env.HERMES_FILES_DIR = path.join(tempDir, 'files');

type JsonFrame = {
  type: string;
  room?: string;
  added_by?: string;
  users?: string[];
  members?: string[];
};

test('v0.14.0 REST: add members, reject general/DM/hermes/unknown, unread starts at 0', async () => {
  const { closeDb } = await import('./database');
  closeDb();
  const { createApp } = await import('./app');
  const { app } = await createApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

  async function json(method: string, pathName: string, body?: unknown, token?: string) {
    const headers: Record<string, string> = {};
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    const res = await fetch(`${origin}${pathName}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
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

  await json('POST', '/auth/register', { username: 'alice', password: 'secret1' });
  const bobReg = await json('POST', '/auth/register', { username: 'bob', password: 'secret2' });
  const caraReg = await json('POST', '/auth/register', { username: 'cara', password: 'secret3' });
  const bobId = (bobReg.data as { user: { id: number } }).user.id;
  const caraId = (caraReg.data as { user: { id: number } }).user.id;

  const aliceToken = ((await json('POST', '/auth/login', { username: 'alice', password: 'secret1' })).data as {
    token: string;
  }).token;
  const bobToken = ((await json('POST', '/auth/login', { username: 'bob', password: 'secret2' })).data as {
    token: string;
  }).token;
  const caraToken = ((await json('POST', '/auth/login', { username: 'cara', password: 'secret3' })).data as {
    token: string;
  }).token;

  const group = await json('POST', '/rooms', { name: 'weekend' }, aliceToken);
  assert.equal(group.status, 200);
  const groupSlug = (group.data as { slug: string }).slug;

  await json('POST', '/messages', { room: groupSlug, content: 'before cara' }, aliceToken);

  const added = await json('POST', '/rooms/members', { room: groupSlug, userIds: [caraId] }, aliceToken);
  assert.equal(added.status, 200);
  const members = (added.data as { members: string[] }).members.sort();
  assert.deepEqual(members, ['alice', 'cara']);

  const again = await json('POST', '/rooms/members', { room: groupSlug, userIds: [caraId] }, aliceToken);
  assert.equal(again.status, 200);

  const caraRooms = await json('GET', '/rooms', undefined, caraToken);
  const caraWeekend = (caraRooms.data as Array<{ slug: string; unread_count: number }>).find(
    (room) => room.slug === groupSlug
  );
  assert.ok(caraWeekend);
  assert.equal(caraWeekend.unread_count, 0);

  const history = await json('GET', `/messages?room=${encodeURIComponent(groupSlug)}`, undefined, caraToken);
  assert.equal(history.status, 200);
  assert.equal((history.data as Array<{ content: string }>).some((row) => row.content === 'before cara'), true);

  const outsider = await json('POST', '/rooms/members', { room: groupSlug, userIds: [bobId] }, bobToken);
  assert.equal(outsider.status, 403);

  const general = await json('POST', '/rooms/members', { room: 'general', userIds: [bobId] }, aliceToken);
  assert.equal(general.status, 400);

  const dm = await json('POST', '/rooms/dm', { userId: bobId }, aliceToken);
  const dmSlug = (dm.data as { slug: string }).slug;
  const addToDm = await json('POST', '/rooms/members', { room: dmSlug, userIds: [caraId] }, aliceToken);
  assert.equal(addToDm.status, 400);

  const directory = (await json('GET', '/users', undefined, aliceToken)).data as Array<{
    id: number;
    username: string;
  }>;
  const hermesId = directory.find((row) => row.username === 'hermes')?.id as number;
  const addHermes = await json('POST', '/rooms/members', { room: groupSlug, userIds: [hermesId] }, aliceToken);
  assert.equal(addHermes.status, 400);

  const unknown = await json('POST', '/rooms/members', { room: groupSlug, userIds: [bobId, 999999] }, aliceToken);
  assert.equal(unknown.status, 404);
  const afterUnknown = await json('GET', '/rooms', undefined, bobToken);
  assert.equal(
    (afterUnknown.data as Array<{ slug: string }>).some((room) => room.slug === groupSlug),
    false
  );

  const empty = await json('POST', '/rooms/members', { room: groupSlug, userIds: [] }, aliceToken);
  assert.equal(empty.status, 400);

  await app.close();
});

test('v0.14.0 WS: member_added fans out to invitees on create and add-later', async () => {
  const { closeDb } = await import('./database');
  closeDb();
  process.env.HERMES_DB_PATH = path.join(tempDir, 'hermes-ws.db');
  process.env.HERMES_FILES_DIR = path.join(tempDir, 'files-ws');
  const { createApp } = await import('./app');
  const { app } = await createApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = (app.server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;

  async function registerAndLogin(username: string) {
    const registered = await fetch(`${origin}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: 'hunter2' }),
    });
    const login = await fetch(`${origin}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: 'hunter2' }),
    });
    return {
      ...((await login.json()) as { token: string }),
      user: ((await registered.json()) as { user: { id: number } }).user,
    };
  }

  async function connect(token: string) {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
    const inbox: JsonFrame[] = [];
    const waiters: Array<(frame: JsonFrame) => void> = [];
    socket.on('message', (raw) => {
      const frame = JSON.parse(raw.toString()) as JsonFrame;
      const waiter = waiters.shift();
      if (waiter) {
        waiter(frame);
      } else {
        inbox.push(frame);
      }
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    const readFrame = (timeoutMs = 1000) =>
      new Promise<JsonFrame>((resolve, reject) => {
        const queued = inbox.shift();
        if (queued) {
          resolve(queued);
          return;
        }
        const timer = setTimeout(() => reject(new Error('timed out waiting for websocket frame')), timeoutMs);
        waiters.push((frame) => {
          clearTimeout(timer);
          resolve(frame);
        });
      });
    const skipUntil = async (type: string, timeoutMs = 2000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const frame = await readFrame(Math.max(deadline - Date.now(), 50));
        if (frame.type === type) {
          return frame;
        }
      }
      throw new Error(`timed out waiting for ${type}`);
    };
    return { socket, skipUntil };
  }

  const alice = await registerAndLogin('alice');
  const bob = await registerAndLogin('bob');
  const cara = await registerAndLogin('cara');
  const a = await connect(alice.token);
  const b = await connect(bob.token);
  const c = await connect(cara.token);
  await a.skipUntil('connected');
  await b.skipUntil('connected');
  await c.skipUntil('connected');

  const created = await fetch(`${origin}/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${alice.token}` },
    body: JSON.stringify({ name: 'live-invite', members: [bob.user.id] }),
  });
  assert.equal(created.status, 200);
  const group = (await created.json()) as { slug: string };
  const bobAdded = await b.skipUntil('member_added');
  assert.equal(bobAdded.room, group.slug);
  assert.equal(bobAdded.added_by, 'alice');
  assert.deepEqual(bobAdded.users, ['bob']);
  assert.ok(bobAdded.members?.includes('alice'));
  assert.ok(bobAdded.members?.includes('bob'));

  const later = await fetch(`${origin}/rooms/members`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${alice.token}` },
    body: JSON.stringify({ room: group.slug, userIds: [cara.user.id] }),
  });
  assert.equal(later.status, 200);
  const caraAdded = await c.skipUntil('member_added');
  assert.equal(caraAdded.room, group.slug);
  assert.equal(caraAdded.added_by, 'alice');
  assert.deepEqual(caraAdded.users, ['cara']);
  const bobLater = await b.skipUntil('member_added');
  assert.deepEqual(bobLater.users, ['cara']);

  a.socket.close();
  b.socket.close();
  c.socket.close();
  await app.close();
});
