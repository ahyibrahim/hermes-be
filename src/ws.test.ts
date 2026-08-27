import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-ws-'));
process.env.HERMES_DB_PATH = path.join(tempDir, 'hermes.db');

type JsonFrame = {
  type: string;
  room?: string;
  user?: string;
  users?: string[];
  content?: string;
  message?: {
    id: number;
    room: string;
    sender: string;
    content: string;
    created_at: string;
    file_id?: number | null;
  };
};

test('live websocket contract', async () => {
  const { createApp } = await import('./app');
  const { app } = await createApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = (app.server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;

  async function waitUntilOpen(socket: WebSocket): Promise<void> {
    if (socket.readyState === WebSocket.OPEN) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', (error) => reject(error));
      socket.once('unexpected-response', (_req, res) => {
        reject(new Error(`unexpected response ${res.statusCode}`));
      });
    });
  }

  async function registerAndLogin(username: string, password = 'hunter2') {
    const register = await fetch(`${origin}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    assert.equal(register.status, 200);

    const login = await fetch(`${origin}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const body = (await login.json()) as { token: string; username: string };
    assert.ok(body.token);
    return body;
  }

async function connectAuthed(token: string) {
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

    await waitUntilOpen(socket);
    const connected = await readFrame();
    return { socket, connected, readFrame };
  }

  try {
    const unauthStatus = await new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      const timer = setTimeout(() => reject(new Error('unauthenticated upgrade did not complete')), 2000);
      socket.once('unexpected-response', (_req, res) => {
        clearTimeout(timer);
        resolve(res.statusCode);
      });
      socket.once('open', () => {
        clearTimeout(timer);
        socket.close();
        reject(new Error('unauthenticated socket should not open'));
      });
      socket.once('error', () => undefined);
    });
    assert.equal(unauthStatus, 401);

    const invalidStatus = await new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=not-a-real-token`);
      const timer = setTimeout(() => reject(new Error('invalid token upgrade did not complete')), 2000);
      socket.once('unexpected-response', (_req, res) => {
        clearTimeout(timer);
        resolve(res.statusCode);
      });
      socket.once('open', () => {
        clearTimeout(timer);
        socket.close();
        reject(new Error('invalid token should not open'));
      });
      socket.once('error', () => undefined);
    });
    assert.equal(invalidStatus, 401);

    const stay = await registerAndLogin('stayopen');
    const stayConn = await connectAuthed(stay.token);
    assert.equal(stayConn.connected.type, 'connected');
    assert.equal(stayConn.connected.user, 'stayopen');
    assert.equal(stayConn.socket.readyState, WebSocket.OPEN);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(stayConn.socket.readyState, WebSocket.OPEN);
    stayConn.socket.close();

    const joiner = await registerAndLogin('joiner');
    const joinConn = await connectAuthed(joiner.token);
    joinConn.socket.send(JSON.stringify({ type: 'join_room', room: 'general', user: 'ignored' }));
    const joined = await joinConn.readFrame();
    const users = await joinConn.readFrame();
    assert.equal(joined.type, 'joined_room');
    assert.equal(joined.room, 'general');
    assert.equal(users.type, 'room_users');
    assert.deepEqual(users.users, ['joiner']);
    joinConn.socket.close();

    const numeric = await registerAndLogin('numeric');
    const messages = await fetch(`${origin}/messages?room=1`, {
      headers: { Authorization: `Bearer ${numeric.token}` },
    });
    assert.equal(messages.status, 403);
    const numericConn = await connectAuthed(numeric.token);
    numericConn.socket.send(JSON.stringify({ type: 'join_room', room: '1' }));
    const numericError = await numericConn.readFrame();
    assert.equal(numericError.type, 'error');
    assert.match(numericError.content ?? '', /slug/i);
    numericConn.socket.close();

    const alice = await registerAndLogin('alice');
    const bob = await registerAndLogin('bob');
    const a = await connectAuthed(alice.token);
    const b = await connectAuthed(bob.token);
    a.socket.send(JSON.stringify({ type: 'join_room', room: 'general' }));
    await a.readFrame();
    await a.readFrame();
    b.socket.send(JSON.stringify({ type: 'join_room', room: 'general' }));
    await b.readFrame();
    await b.readFrame();
    const bobJoined = await a.readFrame();
    assert.equal(bobJoined.type, 'user_joined');
    assert.equal(bobJoined.user, 'bob');

    const posted = await fetch(`${origin}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${alice.token}` },
      body: JSON.stringify({ room: 'general', sender: 'alice', content: 'hello from alice' }),
    });
    const saved = (await posted.json()) as { id: number; content: string };
    assert.equal(posted.status, 200);
    assert.equal(saved.content, 'hello from alice');
    const live = await b.readFrame(1000);
    assert.equal(live.type, 'message');
    assert.equal(live.message?.id, saved.id);
    assert.equal(live.message?.sender, 'alice');
    assert.equal(live.message?.content, 'hello from alice');
    a.socket.close();
    b.socket.close();

    const dupes = await registerAndLogin('dupes');
    const dupeConn = await connectAuthed(dupes.token);
    dupeConn.socket.send(JSON.stringify({ type: 'join_room', room: 'general' }));
    await dupeConn.readFrame();
    await dupeConn.readFrame();
    await fetch(`${origin}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${dupes.token}` },
      body: JSON.stringify({ room: 'general', sender: 'dupes', content: 'once' }),
    });
    await dupeConn.readFrame();
    dupeConn.socket.send(JSON.stringify({ type: 'send_message', room: 'general', sender: 'dupes', content: 'once' }));
    await new Promise((resolve) => setTimeout(resolve, 150));
    const history = await fetch(`${origin}/messages?room=general`, {
      headers: { Authorization: `Bearer ${dupes.token}` },
    });
    const rows = (await history.json()) as Array<{ content: string }>;
    assert.equal(rows.filter((row) => row.content === 'once').length, 1);
    dupeConn.socket.close();

    const staying = await registerAndLogin('staying');
    const leaving = await registerAndLogin('leaving');
    const staySock = await connectAuthed(staying.token);
    const leaveSock = await connectAuthed(leaving.token);
    staySock.socket.send(JSON.stringify({ type: 'join_room', room: 'presence' }));
    await staySock.readFrame();
    await staySock.readFrame();
    leaveSock.socket.send(JSON.stringify({ type: 'join_room', room: 'presence' }));
    await leaveSock.readFrame();
    await leaveSock.readFrame();
    const joinedPresence = await staySock.readFrame();
    assert.equal(joinedPresence.type, 'user_joined');
    leaveSock.socket.close();
    const left = await staySock.readFrame();
    assert.equal(left.type, 'user_left');
    assert.equal(left.user, 'leaving');
    staySock.socket.close();

    const roomsUser = await registerAndLogin('roomsuser');
    const roomsResponse = await fetch(`${origin}/rooms`, {
      headers: { Authorization: `Bearer ${roomsUser.token}` },
    });
    assert.equal(roomsResponse.status, 200);
    const rooms = (await roomsResponse.json()) as Array<{ slug: string }>;
    assert.ok(rooms.some((room) => room.slug === 'general'));
  } finally {
    await app.close();
  }
});
