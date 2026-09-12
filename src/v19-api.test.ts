import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-v19-api-'));
process.env.HERMES_DB_PATH = path.join(tempDir, 'hermes.db');
process.env.HERMES_FILES_DIR = path.join(tempDir, 'files');

type JsonFrame = {
  type: string;
  room?: string;
  removed_by?: string;
  users?: string[];
  members?: string[];
  user?: { username: string; role: string };
  message?: { id: number; deleted_at?: string | null; content?: string };
};

test('v0.19.0 REST: roles, kick, admin-delete, delete-group', async () => {
  const { closeDb } = await import('./database');
  closeDb();
  const { createApp } = await import('./app');
  const { app } = await createApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const wsOrigin = origin.replace('http', 'ws');

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

  function openWs(token: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`${wsOrigin}/ws?token=${encodeURIComponent(token)}`);
      socket.once('open', () => resolve(socket));
      socket.once('error', reject);
    });
  }

  function skipUntil(socket: WebSocket, type: string, timeoutMs = 3000): Promise<JsonFrame> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), timeoutMs);
      const onMessage = (raw: WebSocket.RawData) => {
        const frame = JSON.parse(String(raw)) as JsonFrame;
        if (frame.type !== type) {
          return;
        }
        clearTimeout(timer);
        socket.off('message', onMessage);
        resolve(frame);
      };
      socket.on('message', onMessage);
    });
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

  // Promote / demote
  const memberPromote = await json('PATCH', '/users/bob/role', { role: 'admin' }, bobToken);
  assert.equal(memberPromote.status, 403);

  const promote = await json('PATCH', '/users/bob/role', { role: 'admin' }, aliceToken);
  assert.equal(promote.status, 200);
  assert.equal((promote.data as { role: string }).role, 'admin');

  const demoteAliceLast = await json('PATCH', '/users/alice/role', { role: 'member' }, bobToken);
  assert.equal(demoteAliceLast.status, 200);

  const demoteLast = await json('PATCH', '/users/bob/role', { role: 'member' }, bobToken);
  assert.equal(demoteLast.status, 400);
  assert.match(String((demoteLast.data as { error: string }).error), /last admin/i);

  await json('PATCH', '/users/alice/role', { role: 'admin' }, bobToken);
  await json('PATCH', '/users/bob/role', { role: 'member' }, aliceToken);

  const hermesRole = await json('PATCH', '/users/hermes/role', { role: 'admin' }, aliceToken);
  assert.equal(hermesRole.status, 400);

  // Create group as bob (creator), alice is admin
  const group = await json('POST', '/rooms', { name: 'party', members: [caraId] }, bobToken);
  assert.equal(group.status, 200);
  const groupSlug = (group.data as { slug: string; creator_id: number }).slug;
  assert.equal((group.data as { creator_id: number }).creator_id, bobId);

  const rooms = (await json('GET', '/rooms', undefined, bobToken)).data as Array<{
    slug: string;
    creator_id: number | null;
  }>;
  assert.equal(rooms.find((room) => room.slug === groupSlug)?.creator_id, bobId);

  // Admin-delete message
  const msg = await json('POST', '/messages', { room: groupSlug, content: 'cara says hi' }, caraToken);
  assert.equal(msg.status, 200);
  const msgId = (msg.data as { id: number }).id;

  const bobCannot = await json('DELETE', `/messages/${msgId}`, undefined, bobToken);
  assert.equal(bobCannot.status, 403);

  const adminDelete = await json('DELETE', `/messages/${msgId}`, undefined, aliceToken);
  assert.equal(adminDelete.status, 200);
  assert.ok((adminDelete.data as { deleted_at: string }).deleted_at);

  // Kick: creator (bob) may kick cara; member cannot kick; general/DM blocked
  const caraWs = await openWs(caraToken);
  const kickWait = skipUntil(caraWs, 'member_removed');

  const kicked = await json('POST', '/rooms/kick', { room: groupSlug, userId: caraId }, bobToken);
  assert.equal(kicked.status, 200);
  assert.equal((kicked.data as { members: string[] }).members.includes('cara'), false);

  const kickFrame = await kickWait;
  assert.equal(kickFrame.room, groupSlug);
  assert.deepEqual(kickFrame.users, ['cara']);
  caraWs.close();

  const selfKick = await json('POST', '/rooms/kick', { room: groupSlug, userId: bobId }, bobToken);
  assert.equal(selfKick.status, 400);

  const generalKick = await json('POST', '/rooms/kick', { room: 'general', userId: caraId }, aliceToken);
  assert.equal(generalKick.status, 403);

  await json('POST', '/rooms/members', { room: groupSlug, userIds: [caraId] }, bobToken);
  const memberKick = await json('POST', '/rooms/kick', { room: groupSlug, userId: caraId }, caraToken);
  assert.equal(memberKick.status, 403);

  // Delete group: creator or admin; broadcast room_deleted
  const bobWs = await openWs(bobToken);
  const deleteWait = skipUntil(bobWs, 'room_deleted');

  const deleted = await json('DELETE', `/rooms/${encodeURIComponent(groupSlug)}`, undefined, bobToken);
  assert.equal(deleted.status, 200);
  assert.equal((deleted.data as { room: string }).room, groupSlug);

  const deletedFrame = await deleteWait;
  assert.equal(deletedFrame.room, groupSlug);
  bobWs.close();

  const bobRooms = (await json('GET', '/rooms', undefined, bobToken)).data as Array<{ slug: string }>;
  assert.equal(bobRooms.some((room) => room.slug === groupSlug), false);

  const gone = await json('DELETE', `/rooms/${encodeURIComponent(groupSlug)}`, undefined, aliceToken);
  assert.equal(gone.status, 404);

  const generalDelete = await json('DELETE', '/rooms/general', undefined, aliceToken);
  assert.equal(generalDelete.status, 403);

  // Non-creator member cannot delete a room they create isn't theirs
  const other = await json('POST', '/rooms', { name: 'alice-room' }, aliceToken);
  const otherSlug = (other.data as { slug: string }).slug;
  await json('POST', '/rooms/members', { room: otherSlug, userIds: [bobId] }, aliceToken);
  const bobDelete = await json('DELETE', `/rooms/${encodeURIComponent(otherSlug)}`, undefined, bobToken);
  assert.equal(bobDelete.status, 403);
  const aliceDelete = await json('DELETE', `/rooms/${encodeURIComponent(otherSlug)}`, undefined, aliceToken);
  assert.equal(aliceDelete.status, 200);

  await app.close();
  closeDb();
});
