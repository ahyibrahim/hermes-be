import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-v10-api-'));
process.env.HERMES_DB_PATH = path.join(tempDir, 'hermes.db');
process.env.HERMES_FILES_DIR = path.join(tempDir, 'files');

type JsonFrame = {
  type: string;
  room?: string;
  user?: string;
  message?: {
    id: number;
    room: string;
    sender: string;
    content: string;
    created_at: string;
    deleted_at?: string | null;
    file_id?: number | null;
  };
  user_updated?: { username: string; color: string };
};

test('v0.10.0 REST: hide, unsend, reset, last_message, colors', async () => {
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

  const aliceReg = await json('POST', '/auth/register', { username: 'alice', password: 'secret1' });
  const bobReg = await json('POST', '/auth/register', { username: 'bob', password: 'secret2' });
  await json('POST', '/auth/register', { username: 'cara', password: 'secret3' });
  const aliceUser = (aliceReg.data as { user: { id: number; color: string; role: string } }).user;
  const bobUser = (bobReg.data as { user: { id: number; color: string } }).user;
  assert.equal(aliceUser.role, 'admin');
  assert.notEqual(aliceUser.color, bobUser.color);

  const aliceToken = ((await json('POST', '/auth/login', { username: 'alice', password: 'secret1' })).data as {
    token: string;
  }).token;
  const bobToken = ((await json('POST', '/auth/login', { username: 'bob', password: 'secret2' })).data as {
    token: string;
  }).token;
  const caraToken = ((await json('POST', '/auth/login', { username: 'cara', password: 'secret3' })).data as {
    token: string;
  }).token;

  const dm = await json('POST', '/rooms/dm', { userId: bobUser.id }, aliceToken);
  assert.equal(dm.status, 200);
  const dmSlug = (dm.data as { slug: string }).slug;

  const leaveDm = await json('POST', '/rooms/leave', { room: dmSlug }, aliceToken);
  assert.equal(leaveDm.status, 400);

  const hideGroup = await json('POST', '/rooms/hide', { room: 'general' }, aliceToken);
  assert.equal(hideGroup.status, 400);

  const hid = await json('POST', '/rooms/hide', { room: dmSlug }, aliceToken);
  assert.equal(hid.status, 200);
  const aliceHidden = (await json('GET', '/rooms', undefined, aliceToken)).data as Array<{ slug: string }>;
  assert.equal(aliceHidden.some((room) => room.slug === dmSlug), false);
  const bobStillSees = (await json('GET', '/rooms', undefined, bobToken)).data as Array<{ slug: string }>;
  assert.equal(bobStillSees.some((room) => room.slug === dmSlug), true);

  await json('POST', '/messages', { room: dmSlug, content: 'ping-from-bob' }, bobToken);
  const aliceUnhidden = (await json('GET', '/rooms', undefined, aliceToken)).data as Array<{
    slug: string;
    unread_count: number;
    last_message: { id: number; sender: string; content: string; deleted: boolean; file: boolean } | null;
  }>;
  const aliceDm = aliceUnhidden.find((room) => room.slug === dmSlug);
  assert.ok(aliceDm);
  assert.ok((aliceDm?.unread_count ?? 0) >= 1);
  assert.equal(aliceDm?.last_message?.sender, 'bob');
  assert.equal(aliceDm?.last_message?.content, 'ping-from-bob');
  assert.equal(aliceDm?.last_message?.deleted, false);

  await json('POST', '/rooms/hide', { room: dmSlug }, aliceToken);
  const reopen = await json('POST', '/rooms/dm', { userId: bobUser.id }, aliceToken);
  assert.equal(reopen.status, 200);
  const aliceReopened = (await json('GET', '/rooms', undefined, aliceToken)).data as Array<{ slug: string }>;
  assert.equal(aliceReopened.some((room) => room.slug === dmSlug), true);

  const posted = await json('POST', '/messages', { room: dmSlug, content: 'take-it-back' }, aliceToken);
  assert.equal(posted.status, 200);
  const messageId = (posted.data as { id: number }).id;

  const bobUnsend = await json('DELETE', `/messages/${messageId}`, undefined, bobToken);
  assert.equal(bobUnsend.status, 403);

  const unsended = await json('DELETE', `/messages/${messageId}`, undefined, aliceToken);
  assert.equal(unsended.status, 200);
  const tombstone = unsended.data as { id: number; content: string; deleted_at: string; file_id: number | null };
  assert.equal(tombstone.id, messageId);
  assert.equal(tombstone.content, '');
  assert.equal(tombstone.file_id, null);
  assert.ok(tombstone.deleted_at);

  const again = await json('DELETE', `/messages/${messageId}`, undefined, aliceToken);
  assert.equal(again.status, 200);
  assert.equal((again.data as { id: number }).id, messageId);

  const history = (await json('GET', `/messages?room=${encodeURIComponent(dmSlug)}`, undefined, bobToken))
    .data as Array<{ id: number; content: string; deleted_at?: string | null }>;
  const kept = history.find((row) => row.id === messageId);
  assert.ok(kept?.deleted_at);
  assert.equal(kept?.content, '');

  await json('POST', '/rooms/read', { room: dmSlug }, bobToken);
  await json('POST', '/messages', { room: dmSlug, content: 'live-one' }, aliceToken);
  const live = await json('POST', '/messages', { room: dmSlug, content: 'live-two' }, aliceToken);
  const liveId = (live.data as { id: number }).id;
  await json('DELETE', `/messages/${liveId}`, undefined, aliceToken);
  const bobRooms = (await json('GET', '/rooms', undefined, bobToken)).data as Array<{
    slug: string;
    unread_count: number;
    last_message: { deleted: boolean; content: string } | null;
  }>;
  const bobDm = bobRooms.find((room) => room.slug === dmSlug);
  assert.equal(bobDm?.unread_count, 1);
  assert.equal(bobDm?.last_message?.deleted, true);
  assert.equal(bobDm?.last_message?.content, '');

  const long = 'x'.repeat(120);
  await json('POST', '/messages', { room: dmSlug, content: long }, aliceToken);
  const previewed = (await json('GET', '/rooms', undefined, aliceToken)).data as Array<{
    slug: string;
    last_message: { content: string } | null;
  }>;
  assert.equal(previewed.find((room) => room.slug === dmSlug)?.last_message?.content.length, 80);

  const group = await json('POST', '/rooms', { name: 'weekend', members: [bobUser.id] }, aliceToken);
  const groupSlug = (group.data as { slug: string }).slug;
  const hideWeekend = await json('POST', '/rooms/hide', { room: groupSlug }, aliceToken);
  assert.equal(hideWeekend.status, 400);
  const leftGroup = await json('POST', '/rooms/leave', { room: groupSlug }, aliceToken);
  assert.equal(leftGroup.status, 200);

  const memberReset = await json('POST', '/users/bob/password-reset', {}, caraToken);
  assert.equal(memberReset.status, 403);

  const missing = await json('POST', '/users/nobody/password-reset', {}, aliceToken);
  assert.equal(missing.status, 404);

  const firstIssue = await json('POST', '/users/bob/password-reset', {}, aliceToken);
  assert.equal(firstIssue.status, 201);
  const firstToken = (firstIssue.data as { token: string; expires_at: string }).token;
  assert.ok(firstToken);
  const secondIssue = await json('POST', '/users/bob/password-reset', undefined, aliceToken);
  assert.equal(secondIssue.status, 201);
  const resetToken = (secondIssue.data as { token: string }).token;
  assert.notEqual(resetToken, firstToken);

  const stale = await json('POST', '/auth/reset', {
    username: 'bob',
    token: firstToken,
    password: 'new-secret',
  });
  assert.equal(stale.status, 401);

  const redeemed = await json('POST', '/auth/reset', {
    username: 'bob',
    token: resetToken,
    password: 'new-secret',
  });
  assert.equal(redeemed.status, 200);
  const newSession = redeemed.data as { username: string; token: string; expires_at: string };
  assert.equal(newSession.username, 'bob');
  assert.ok(newSession.token);
  assert.notEqual(newSession.token, bobToken);

  const oldSession = await json('GET', '/users/me', undefined, bobToken);
  assert.equal(oldSession.status, 401);
  const newMe = await json('GET', '/users/me', undefined, newSession.token);
  assert.equal(newMe.status, 200);

  const selfIssue = await json('POST', '/users/alice/password-reset', {}, aliceToken);
  assert.equal(selfIssue.status, 201);

  const clash = await json('PATCH', '/users/me', { color: aliceUser.color }, newSession.token);
  assert.equal(clash.status, 409);

  await app.close();
});

test('v0.10.0 WS: hidden members still get messages; unsend and user_updated fan out', async () => {
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
      ...(await login.json()) as { token: string },
      user: ((await registered.json()) as { user: { id: number; color: string } }).user,
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
        const frame = await readFrame(deadline - Date.now());
        if (frame.type === type) {
          return frame;
        }
      }
      throw new Error(`timed out waiting for ${type}`);
    };
    return { socket, readFrame, skipUntil };
  }

  const alice = await registerAndLogin('alice');
  const bob = await registerAndLogin('bob');
  const a = await connect(alice.token);
  const b = await connect(bob.token);
  await a.readFrame();
  await b.readFrame();

  const dmRes = await fetch(`${origin}/rooms/dm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${alice.token}` },
    body: JSON.stringify({ userId: bob.user.id }),
  });
  const dm = (await dmRes.json()) as { slug: string };

  await fetch(`${origin}/rooms/hide`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bob.token}` },
    body: JSON.stringify({ room: dm.slug }),
  });

  const posted = await fetch(`${origin}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${alice.token}` },
    body: JSON.stringify({ room: dm.slug, content: 'still-reaches-bob' }),
  });
  const postedMessage = (await posted.json()) as { id: number };
  const bobMessage = await b.skipUntil('message');
  assert.equal(bobMessage.message?.content, 'still-reaches-bob');

  await fetch(`${origin}/messages/${postedMessage.id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${alice.token}` },
  });
  const deleted = await b.skipUntil('message_deleted');
  assert.equal(deleted.message?.id, postedMessage.id);
  assert.equal(deleted.message?.content, '');
  assert.ok(deleted.message?.deleted_at);

  const nextColor = ['lake', 'plum', 'rust'].find(
    (slot) => slot !== alice.user.color && slot !== bob.user.color
  ) as string;
  await fetch(`${origin}/users/me`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bob.token}` },
    body: JSON.stringify({ color: nextColor }),
  });
  const updated = await a.skipUntil('user_updated');
  assert.equal((updated as { user?: { username: string; color: string } }).user?.username, 'bob');
  assert.equal((updated as { user?: { username: string; color: string } }).user?.color, nextColor);

  a.socket.close();
  b.socket.close();
  await app.close();
});
