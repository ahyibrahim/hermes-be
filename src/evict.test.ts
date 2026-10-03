import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-evict-'));
process.env.HERMES_DB_PATH = path.join(tempDir, 'hermes.db');
process.env.HERMES_FILES_DIR = path.join(tempDir, 'files');

const WATCH_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

type JsonFrame = {
  type: string;
  room?: string;
  user?: string;
  content?: string;
  users?: string[];
  members?: string[];
  creator_id?: number | null;
};

test('leaving or being kicked drops call, share, watch and room sockets', async () => {
  const { closeDb } = await import('./database');
  closeDb();
  const { createApp } = await import('./app');
  const { app } = await createApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = (app.server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;

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
    return { status: res.status, data: text ? (JSON.parse(text) as Record<string, unknown>) : null };
  }

  async function register(username: string) {
    const res = await json('POST', '/auth/register', { username, password: 'hunter2' });
    assert.equal(res.status, 200);
    const { seatInGeneral } = await import('./test-seat');
    seatInGeneral(username);
    const login = await json('POST', '/auth/login', { username, password: 'hunter2' });
    assert.equal(login.status, 200);
    return login.data as { token: string; id?: number };
  }

  function connect(token: string): Promise<{ socket: WebSocket; read: () => Promise<JsonFrame> }> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
    const inbox: JsonFrame[] = [];
    const waiters: Array<(frame: JsonFrame) => void> = [];
    socket.on('message', (data) => {
      const frame = JSON.parse(data.toString()) as JsonFrame;
      const waiter = waiters.shift();
      if (waiter) {
        waiter(frame);
      } else {
        inbox.push(frame);
      }
    });
    const read = () =>
      new Promise<JsonFrame>((resolve, reject) => {
        const queued = inbox.shift();
        if (queued) {
          resolve(queued);
          return;
        }
        const timer = setTimeout(() => reject(new Error('timed out waiting for websocket frame')), 1500);
        waiters.push((frame) => {
          clearTimeout(timer);
          resolve(frame);
        });
      });
    return new Promise((resolve, reject) => {
      socket.once('open', () => resolve({ socket, read }));
      socket.once('error', reject);
    });
  }

  async function readOfType(read: () => Promise<JsonFrame>, type: string): Promise<JsonFrame> {
    const found = await collectUntil(read, [type]);
    return found.get(type)!;
  }

  async function collectUntil(
    read: () => Promise<JsonFrame>,
    types: string[]
  ): Promise<Map<string, JsonFrame>> {
    const pending = new Set(types);
    const found = new Map<string, JsonFrame>();
    const deadline = Date.now() + 2500;
    while (pending.size > 0 && Date.now() < deadline) {
      const frame = await read();
      if (pending.has(frame.type)) {
        found.set(frame.type, frame);
        pending.delete(frame.type);
      }
    }
    assert.deepEqual([...pending], [], `missing frames: ${[...pending].join(', ')}`);
    return found;
  }

  try {
    const alice = await register('alice');
    const bob = await register('bob');
    const carol = await register('carol');
    const { appointMaster } = await import('./auth');
    appointMaster('alice');
    const users = (await json('GET', '/users', undefined, alice.token)).data as Array<{
      id: number;
      username: string;
      role: string;
    }>;
    const bobId = users.find((user) => user.username === 'bob')!.id;
    const carolId = users.find((user) => user.username === 'carol')!.id;
    const aliceId = users.find((user) => user.username === 'alice')!.id;
    assert.equal(users.find((user) => user.username === 'alice')?.role, 'master');

    const created = await json('POST', '/rooms', { name: 'party', members: [carolId] }, bob.token);
    assert.equal(created.status, 200);
    const slug = String((created.data as { slug: string }).slug);

    const added = await json('POST', '/rooms/members', { room: slug, userIds: [aliceId] }, bob.token);
    assert.equal(added.status, 200);

    const creatorKickAdmin = await json('POST', '/rooms/kick', { room: slug, userId: aliceId }, bob.token);
    assert.equal(creatorKickAdmin.status, 403);

    const carolSock = await connect(carol.token);
    assert.equal((await carolSock.read()).type, 'connected');
    carolSock.socket.send(JSON.stringify({ type: 'join_room', room: slug }));
    assert.equal((await carolSock.read()).type, 'joined_room');
    await carolSock.read();
    carolSock.socket.send(JSON.stringify({ type: 'join_call', room: slug }));
    assert.equal((await carolSock.read()).type, 'call_peers');
    carolSock.socket.send(JSON.stringify({ type: 'screen_share_start', room: slug }));
    assert.equal((await carolSock.read()).type, 'screen_share_started');
    carolSock.socket.send(JSON.stringify({ type: 'watch_start', room: slug, url: WATCH_URL }));
    assert.equal((await carolSock.read()).type, 'watch_state');
    await carolSock.read();

    const bobSock = await connect(bob.token);
    assert.equal((await bobSock.read()).type, 'connected');
    bobSock.socket.send(JSON.stringify({ type: 'join_room', room: slug }));
    assert.equal((await bobSock.read()).type, 'joined_room');
    const roomUsers = await bobSock.read();
    assert.equal(roomUsers.type, 'room_users');
    const watchState = await bobSock.read();
    assert.equal(watchState.type, 'watch_state');

    const kicked = await json('POST', '/rooms/kick', { room: slug, userId: carolId }, bob.token);
    assert.equal(kicked.status, 200);

    const carolFrames = await collectUntil(carolSock.read, ['left_call', 'watch_ended', 'member_removed']);
    assert.equal(carolFrames.get('left_call')?.room, slug);
    assert.deepEqual(carolFrames.get('member_removed')?.users, ['carol']);

    const bobFrames = await collectUntil(bobSock.read, ['user_left', 'watch_ended']);
    assert.equal(bobFrames.get('user_left')?.user, 'carol');

    carolSock.socket.send(JSON.stringify({ type: 'screen_share_start', room: slug }));
    const shareDenied = await readOfType(carolSock.read, 'error');
    assert.match(shareDenied.content ?? '', /not in that call/i);

    carolSock.socket.send(
      JSON.stringify({ type: 'call_offer', room: slug, to: 'bob', sdp: { type: 'offer' } })
    );
    const offerDenied = await readOfType(carolSock.read, 'error');
    assert.match(offerDenied.content ?? '', /not in that call/i);

    carolSock.socket.send(JSON.stringify({ type: 'watch_control', room: slug, action: 'pause' }));
    const controlDenied = await readOfType(carolSock.read, 'error');
    assert.match(controlDenied.content ?? '', /no active watch session/i);

    const rooms = (await json('GET', '/rooms', undefined, bob.token)).data as Array<{
      slug: string;
      members: string[];
      creator_id: number | null;
    }>;
    const party = rooms.find((room) => room.slug === slug);
    assert.ok(party);
    assert.equal(party.members.includes('carol'), false);
    assert.equal(party.creator_id, bobId);

    const outsider = await register('dave');
    const daveSock = await connect(outsider.token);
    assert.equal((await daveSock.read()).type, 'connected');
    daveSock.socket.send(JSON.stringify({ type: 'watch_end', room: slug }));
    const daveDenied = await readOfType(daveSock.read, 'error');
    assert.match(daveDenied.content ?? '', /no active watch session/i);

    bobSock.socket.send(JSON.stringify({ type: 'watch_start', room: slug, url: WATCH_URL }));
    await readOfType(bobSock.read, 'watch_state');
    daveSock.socket.send(JSON.stringify({ type: 'watch_control', room: slug, action: 'pause' }));
    const daveStillDenied = await readOfType(daveSock.read, 'error');
    assert.match(daveStillDenied.content ?? '', /no active watch session/i);

    const aliceSock = await connect(alice.token);
    assert.equal((await aliceSock.read()).type, 'connected');
    const left = await json('POST', '/rooms/leave', { room: slug }, bob.token);
    assert.equal(left.status, 200);
    const aliceSawLeave = await readOfType(aliceSock.read, 'member_removed');
    assert.deepEqual(aliceSawLeave.users, ['bob']);
    assert.equal(aliceSawLeave.members?.includes('bob'), false);
    const afterLeave = (await json('GET', '/rooms', undefined, alice.token)).data as Array<{
      slug: string;
      creator_id: number | null;
    }>;
    assert.equal(afterLeave.find((room) => room.slug === slug)?.creator_id, null);

    const readded = await json('POST', '/rooms/members', { room: slug, userIds: [bobId] }, alice.token);
    assert.equal(readded.status, 200);
    const bobDelete = await json('DELETE', `/rooms/${encodeURIComponent(slug)}`, undefined, bob.token);
    assert.equal(bobDelete.status, 403);

    const deleted = await json('DELETE', `/rooms/${encodeURIComponent(slug)}`, undefined, alice.token);
    assert.equal(deleted.status, 200);
    const gone = await readOfType(bobSock.read, 'room_deleted');
    assert.equal(gone.room, slug);

    carolSock.socket.close();
    bobSock.socket.close();
    daveSock.socket.close();
    aliceSock.socket.close();
  } finally {
    await app.close();
  }
});
