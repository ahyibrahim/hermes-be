import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-v09-api-'));
process.env.HERMES_DB_PATH = path.join(tempDir, 'hermes.db');
process.env.HERMES_FILES_DIR = path.join(tempDir, 'files');

type JsonFrame = {
  type: string;
  room?: string;
  user?: string;
  message?: { id: number; room: string; sender: string; content: string; created_at: string };
};

test('v0.9.0 REST: timestamps, leave, unread, colors', async () => {
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

  const aliceReg = await json('POST', '/auth/register', { username: 'alice', password: 'secret1' });
  const bobReg = await json('POST', '/auth/register', { username: 'bob', password: 'secret2' });
  const alice = (aliceReg.data as { user: { id: number; color: string } }).user;
  const bob = (bobReg.data as { user: { id: number; color: string } }).user;
  assert.ok(alice.color);
  assert.ok(bob.color);
  assert.notEqual(alice.color, bob.color);

  const aliceToken = ((await json('POST', '/auth/login', { username: 'alice', password: 'secret1' })).data as {
    token: string;
  }).token;
  const bobToken = ((await json('POST', '/auth/login', { username: 'bob', password: 'secret2' })).data as {
    token: string;
  }).token;

  const posted = await json('POST', '/messages', { room: 'general', content: 'hello-iso' }, aliceToken);
  assert.equal(posted.status, 200);
  const createdAt = (posted.data as { created_at: string }).created_at;
  assert.match(createdAt, /^\d{4}-\d{2}-\d{2}T.*Z$/);

  const history = await json('GET', '/messages?room=general', undefined, aliceToken);
  const hello = (history.data as Array<{ content: string; created_at: string }>).find(
    (row) => row.content === 'hello-iso'
  );
  assert.equal(hello?.created_at, createdAt);

  const dm = await json('POST', '/rooms/dm', { userId: bob.id }, aliceToken);
  assert.equal(dm.status, 200);
  const dmSlug = (dm.data as { slug: string }).slug;

  const left = await json('POST', '/rooms/leave', { room: dmSlug }, aliceToken);
  assert.equal(left.status, 400);
  const hid = await json('POST', '/rooms/hide', { room: dmSlug }, aliceToken);
  assert.equal(hid.status, 200);
  const afterLeave = await json('GET', '/rooms', undefined, aliceToken);
  const aliceRooms = afterLeave.data as Array<{ slug: string }>;
  assert.equal(aliceRooms.some((room) => room.slug === dmSlug), false);

  const leaveGeneral = await json('POST', '/rooms/leave', { room: 'general' }, aliceToken);
  assert.equal(leaveGeneral.status, 400);

  const reopen = await json('POST', '/rooms/dm', { userId: bob.id }, aliceToken);
  assert.equal(reopen.status, 200);
  assert.equal((reopen.data as { slug: string }).slug, dmSlug);

  await json('POST', '/messages', { room: dmSlug, content: 'secret-from-alice' }, aliceToken);
  const bobRooms = (await json('GET', '/rooms', undefined, bobToken)).data as Array<{
    slug: string;
    unread_count: number;
  }>;
  const bobDm = bobRooms.find((room) => room.slug === dmSlug);
  assert.ok((bobDm?.unread_count ?? 0) >= 1);

  await json('POST', '/rooms/read', { room: dmSlug }, bobToken);
  const bobRoomsRead = (await json('GET', '/rooms', undefined, bobToken)).data as Array<{
    slug: string;
    unread_count: number;
  }>;
  assert.equal(bobRoomsRead.find((room) => room.slug === dmSlug)?.unread_count, 0);

  const clash = await json('PATCH', '/users/me', { color: alice.color }, bobToken);
  assert.equal(clash.status, 409);
  const keep = await json('PATCH', '/users/me', { color: bob.color }, bobToken);
  assert.equal(keep.status, 200);

  await app.close();
});

test('v0.9.0 WS: member fan-out and call_started', async () => {
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
    await fetch(`${origin}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: 'hunter2' }),
    });
    const login = await fetch(`${origin}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: 'hunter2' }),
    });
    return (await login.json()) as { token: string };
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
    return { socket, readFrame };
  }

  const alice = await registerAndLogin('alice');
  const bob = await registerAndLogin('bob');
  const a = await connect(alice.token);
  const b = await connect(bob.token);
  await a.readFrame();
  await b.readFrame();

  a.socket.send(JSON.stringify({ type: 'join_room', room: 'general' }));
  await a.readFrame();
  await a.readFrame();

  await fetch(`${origin}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${alice.token}` },
    body: JSON.stringify({ room: 'general', content: 'off-room-ping' }),
  });
  const bobMessage = await b.readFrame();
  assert.equal(bobMessage.type, 'message');
  assert.equal(bobMessage.message?.content, 'off-room-ping');

  a.socket.send(JSON.stringify({ type: 'join_call', room: 'general' }));
  const started = await b.readFrame();
  assert.equal(started.type, 'call_started');
  assert.equal(started.room, 'general');
  assert.equal(started.user, 'alice');

  a.socket.close();
  b.socket.close();
  await app.close();
});
