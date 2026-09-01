import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-voice-'));
process.env.HERMES_DB_PATH = path.join(tempDir, 'hermes.db');
process.env.HERMES_FILES_DIR = path.join(tempDir, 'files');

type JsonFrame = {
  type: string;
  room?: string;
  user?: string;
  users?: string[];
  from?: string;
  to?: string;
  sdp?: unknown;
  candidate?: unknown;
  content?: string;
};

test('parseIceServers defaults and accepts a JSON array', async () => {
  const { DEFAULT_ICE_SERVERS, parseIceServers } = await import('./app');
  assert.deepEqual(parseIceServers(undefined), DEFAULT_ICE_SERVERS);
  assert.deepEqual(parseIceServers(''), DEFAULT_ICE_SERVERS);
  assert.deepEqual(parseIceServers('not-json'), DEFAULT_ICE_SERVERS);
  assert.deepEqual(parseIceServers('[]'), DEFAULT_ICE_SERVERS);
  assert.deepEqual(parseIceServers('[{"urls":"stun:example:3478"}]'), [{ urls: 'stun:example:3478' }]);
});

test('voice signaling: ICE auth, offer reaches only the target, disconnect clears the call', async () => {
  const { closeDb } = await import('./database');
  closeDb();
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

    const drain = () => inbox.splice(0);

    await waitUntilOpen(socket);
    const connected = await readFrame();
    return { socket, connected, readFrame, drain };
  }

  try {
    const noAuth = await fetch(`${origin}/ice`);
    assert.equal(noAuth.status, 401);

    const alice = await registerAndLogin('alice');
    const bob = await registerAndLogin('bob');
    const carol = await registerAndLogin('carol');

    const ice = await fetch(`${origin}/ice`, {
      headers: { Authorization: `Bearer ${alice.token}` },
    });
    assert.equal(ice.status, 200);
    const iceBody = (await ice.json()) as { iceServers: unknown[] };
    const { DEFAULT_ICE_SERVERS } = await import('./app');
    assert.deepEqual(iceBody.iceServers, DEFAULT_ICE_SERVERS);

    const a = await connectAuthed(alice.token);
    const b = await connectAuthed(bob.token);
    const c = await connectAuthed(carol.token);
    assert.equal(a.connected.type, 'connected');

    a.socket.send(JSON.stringify({ type: 'join_call', room: 'general' }));
    const alicePeers = await a.readFrame();
    assert.equal(alicePeers.type, 'call_peers');
    assert.deepEqual(alicePeers.users, ['alice']);

    b.socket.send(JSON.stringify({ type: 'join_call', room: 'general' }));
    const bobPeers = await b.readFrame();
    assert.equal(bobPeers.type, 'call_peers');
    assert.deepEqual(bobPeers.users, ['alice', 'bob']);
    const bobJoined = await a.readFrame();
    assert.equal(bobJoined.type, 'user_joined_call');
    assert.equal(bobJoined.user, 'bob');

    c.socket.send(JSON.stringify({ type: 'join_call', room: 'general' }));
    const carolPeers = await c.readFrame();
    assert.equal(carolPeers.type, 'call_peers');
    const carolToAlice = await a.readFrame();
    const carolToBob = await b.readFrame();
    assert.equal(carolToAlice.type, 'user_joined_call');
    assert.equal(carolToBob.type, 'user_joined_call');
    assert.equal(carolToAlice.user, 'carol');

    const offer = { type: 'offer', sdp: 'v=0-alice-to-bob' };
    a.socket.send(
      JSON.stringify({ type: 'call_offer', room: 'general', to: 'bob', sdp: offer })
    );
    const bobOffer = await b.readFrame();
    assert.equal(bobOffer.type, 'call_offer');
    assert.equal(bobOffer.from, 'alice');
    assert.equal(bobOffer.to, 'bob');
    assert.deepEqual(bobOffer.sdp, offer);

    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.deepEqual(c.drain(), [], 'carol must not receive alice→bob signaling');

    b.socket.send(
      JSON.stringify({
        type: 'call_answer',
        room: 'general',
        to: 'alice',
        sdp: { type: 'answer', sdp: 'v=0-bob-answer' },
      })
    );
    const aliceAnswer = await a.readFrame();
    assert.equal(aliceAnswer.type, 'call_answer');
    assert.equal(aliceAnswer.from, 'bob');

    a.socket.send(
      JSON.stringify({
        type: 'ice_candidate',
        room: 'general',
        to: 'bob',
        candidate: { candidate: 'candidate:1', sdpMid: '0' },
      })
    );
    const bobIce = await b.readFrame();
    assert.equal(bobIce.type, 'ice_candidate');
    assert.equal(bobIce.from, 'alice');

    a.socket.close();
    const aliceLeftBob = await b.readFrame();
    const aliceLeftCarol = await c.readFrame();
    assert.equal(aliceLeftBob.type, 'user_left_call');
    assert.equal(aliceLeftBob.user, 'alice');
    assert.equal(aliceLeftCarol.type, 'user_left_call');
    assert.equal(aliceLeftCarol.user, 'alice');

    b.socket.send(
      JSON.stringify({ type: 'call_offer', room: 'general', to: 'alice', sdp: offer })
    );
    const deadPeer = await b.readFrame();
    assert.equal(deadPeer.type, 'error');
    assert.match(deadPeer.content ?? '', /not in that call/i);

    const outsider = await registerAndLogin('outsider');
    const users = (await (
      await fetch(`${origin}/users`, { headers: { Authorization: `Bearer ${alice.token}` } })
    ).json()) as Array<{ id: number; username: string }>;
    const bobId = users.find((row) => row.username === 'bob')?.id;
    const dm = await fetch(`${origin}/rooms/dm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${alice.token}` },
      body: JSON.stringify({ userId: bobId }),
    });
    // alice's token is still valid; her socket closed but session remains.
    assert.equal(dm.status, 200);
    const dmRoom = (await dm.json()) as { slug: string };

    const o = await connectAuthed(outsider.token);
    o.socket.send(JSON.stringify({ type: 'join_call', room: dmRoom.slug }));
    const denied = await o.readFrame();
    assert.equal(denied.type, 'error');
    assert.match(denied.content ?? '', /not a member/i);

    b.socket.close();
    c.socket.close();
    o.socket.close();
  } finally {
    await app.close();
  }
});
