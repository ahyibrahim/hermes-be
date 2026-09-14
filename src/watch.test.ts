import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-watch-'));
process.env.HERMES_DB_PATH = path.join(tempDir, 'hermes.db');
process.env.HERMES_FILES_DIR = path.join(tempDir, 'files');

const VIDEO_ID = 'dQw4w9WgXcQ';
const WATCH_URL = `https://www.youtube.com/watch?v=${VIDEO_ID}`;

type JsonFrame = {
  type: string;
  room?: string;
  user?: string;
  users?: string[];
  host?: string;
  videoId?: string;
  url?: string;
  playing?: boolean;
  position?: number;
  rate?: number;
  provider?: string;
  action?: string;
  content?: string;
  message?: { sender?: string; content?: string };
};

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

test('watch together: start, join, control, leave, end, disconnect, auth', async () => {
  const { closeDb } = await import('./database');
  closeDb();
  const { createApp } = await import('./app');
  const { app } = await createApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = (app.server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;

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

    const readOfType = async (type: string, timeoutMs = 2000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const frame = await readFrame(Math.max(50, deadline - Date.now()));
        if (frame.type === type) {
          return frame;
        }
      }
      throw new Error(`timed out waiting for ${type}`);
    };

    const drain = () => inbox.splice(0);

    await waitUntilOpen(socket);
    const connected = await readFrame();
    return { socket, connected, readFrame, readOfType, drain };
  }

  try {
    const alice = await registerAndLogin('alice');
    const bob = await registerAndLogin('bob');
    const carol = await registerAndLogin('carol');

    const a = await connectAuthed(alice.token);
    const b = await connectAuthed(bob.token);
    const c = await connectAuthed(carol.token);
    assert.equal(a.connected.type, 'connected');

    // 1. Member starts → watch_state; other members get watch_started; hermes system line
    b.socket.send(JSON.stringify({ type: 'watch_start', room: 'general', url: WATCH_URL }));
    const bobState = await b.readOfType('watch_state');
    assert.equal(bobState.videoId, VIDEO_ID);
    assert.equal(bobState.url, WATCH_URL);
    assert.equal(bobState.host, 'bob');
    assert.equal(bobState.playing, false);
    assert.equal(bobState.provider, 'youtube');
    assert.deepEqual(bobState.users, ['bob']);

    const bobPeers = await b.readOfType('watch_peers');
    assert.deepEqual(bobPeers.users, ['bob']);
    assert.equal(bobPeers.host, 'bob');

    const aliceStarted = await a.readOfType('watch_started');
    assert.equal(aliceStarted.user, 'bob');
    assert.equal(aliceStarted.videoId, VIDEO_ID);
    assert.equal(aliceStarted.url, WATCH_URL);

    const carolStarted = await c.readOfType('watch_started');
    assert.equal(carolStarted.user, 'bob');

    const bobStartMsg = await b.readOfType('message');
    assert.equal(bobStartMsg.message?.sender, 'hermes');
    assert.equal(
      bobStartMsg.message?.content,
      `bob started watching together: ${WATCH_URL}`
    );
    await a.readOfType('message');
    await c.readOfType('message');

    // Late room enter sees active session (banner) without joining participants.
    const dave = await registerAndLogin('dave');
    const d = await connectAuthed(dave.token);
    d.socket.send(JSON.stringify({ type: 'join_room', room: 'general' }));
    await d.readOfType('joined_room');
    await d.readOfType('room_users');
    const daveAware = await d.readOfType('watch_state');
    assert.equal(daveAware.videoId, VIDEO_ID);
    assert.equal(daveAware.host, 'bob');
    assert.deepEqual(daveAware.users, ['bob']);
    d.socket.close();

    const history = (await (
      await fetch(`${origin}/messages?room=general`, {
        headers: { Authorization: `Bearer ${bob.token}` },
      })
    ).json()) as Array<{ sender: string; content: string }>;
    const startLines = history.filter(
      (row) => row.sender === 'hermes' && row.content.includes('started watching together')
    );
    assert.equal(startLines.length, 1);

    // 2. Second watch_start joins existing — same videoId, no second start line
    a.socket.send(JSON.stringify({ type: 'watch_start', room: 'general', url: WATCH_URL }));
    const aliceJoinState = await a.readOfType('watch_state');
    assert.equal(aliceJoinState.videoId, VIDEO_ID);
    assert.equal(aliceJoinState.host, 'bob');
    assert.ok(aliceJoinState.users?.includes('alice'));
    assert.ok(aliceJoinState.users?.includes('bob'));

    const peersAfterAlice = await a.readOfType('watch_peers');
    assert.deepEqual(peersAfterAlice.users, ['alice', 'bob']);
    await b.readOfType('watch_peers');

    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(
      a.drain().some((f) => f.type === 'watch_started'),
      false,
      'joining via watch_start must not re-broadcast watch_started'
    );
    assert.equal(
      c.drain().some((f) => f.type === 'watch_started' || f.type === 'message'),
      false,
      'carol must not get a second start announcement'
    );

    const history2 = (await (
      await fetch(`${origin}/messages?room=general`, {
        headers: { Authorization: `Bearer ${bob.token}` },
      })
    ).json()) as Array<{ sender: string; content: string }>;
    assert.equal(
      history2.filter((row) => row.sender === 'hermes' && row.content.includes('started watching together'))
        .length,
      1
    );

    // 3. Non-host cannot pause; host can; admin (alice) can even if not host
    c.socket.send(JSON.stringify({ type: 'watch_join', room: 'general' }));
    await c.readOfType('watch_state');
    await c.readOfType('watch_peers');
    await a.readOfType('watch_peers');
    await b.readOfType('watch_peers');

    c.socket.send(JSON.stringify({ type: 'watch_control', room: 'general', action: 'pause' }));
    const carolDenied = await c.readOfType('watch_control_denied');
    assert.equal(carolDenied.action, 'pause');
    assert.equal(carolDenied.room, 'general');

    b.socket.send(JSON.stringify({ type: 'watch_control', room: 'general', action: 'pause', position: 12 }));
    const bobPaused = await b.readOfType('watch_state');
    assert.equal(bobPaused.playing, false);
    assert.equal(bobPaused.position, 12);
    await a.readOfType('watch_state');
    await c.readOfType('watch_state');

    a.socket.send(JSON.stringify({ type: 'watch_control', room: 'general', action: 'play', position: 12 }));
    const alicePlayed = await a.readOfType('watch_state');
    assert.equal(alicePlayed.playing, true);
    await b.readOfType('watch_state');
    await c.readOfType('watch_state');

    // 4. seek updates position for peers
    b.socket.send(JSON.stringify({ type: 'watch_control', room: 'general', action: 'seek', position: 42 }));
    const bobSeek = await b.readOfType('watch_state');
    assert.ok(Math.abs((bobSeek.position ?? 0) - 42) < 0.5);
    assert.equal(bobSeek.playing, true);
    const aliceSeek = await a.readOfType('watch_state');
    assert.ok(Math.abs((aliceSeek.position ?? 0) - 42) < 0.5);
    const carolSeek = await c.readOfType('watch_state');
    assert.ok(Math.abs((carolSeek.position ?? 0) - 42) < 0.5);

    // Pause so leave/rejoin assertions stay stable
    b.socket.send(JSON.stringify({ type: 'watch_control', room: 'general', action: 'pause', position: 42 }));
    await b.readOfType('watch_state');
    await a.readOfType('watch_state');
    await c.readOfType('watch_state');

    // 5. leave sends left_watch; session still joinable
    c.socket.send(JSON.stringify({ type: 'watch_leave', room: 'general' }));
    const carolLeft = await c.readOfType('left_watch');
    assert.equal(carolLeft.room, 'general');
    const peersAfterLeave = await a.readOfType('watch_peers');
    assert.deepEqual(peersAfterLeave.users, ['alice', 'bob']);
    await b.readOfType('watch_peers');

    c.socket.send(JSON.stringify({ type: 'watch_join', room: 'general' }));
    const carolRejoin = await c.readOfType('watch_state');
    assert.equal(carolRejoin.videoId, VIDEO_ID);
    assert.equal(carolRejoin.position, 42);
    assert.equal(carolRejoin.playing, false);
    await c.readOfType('watch_peers');
    await a.readOfType('watch_peers');
    await b.readOfType('watch_peers');

    // 6. end by host → watch_ended + system end line; join fails after
    b.socket.send(JSON.stringify({ type: 'watch_control', room: 'general', action: 'end' }));
    const aliceEnded = await a.readOfType('watch_ended');
    assert.equal(aliceEnded.user, 'bob');
    assert.equal(aliceEnded.room, 'general');
    await b.readOfType('watch_ended');
    await c.readOfType('watch_ended');

    const endMsg = await a.readOfType('message');
    assert.equal(endMsg.message?.sender, 'hermes');
    assert.match(endMsg.message?.content ?? '', /Watch together ended/);
    await b.readOfType('message');
    await c.readOfType('message');

    c.socket.send(JSON.stringify({ type: 'watch_join', room: 'general' }));
    const joinFail = await c.readOfType('error');
    assert.match(joinFail.content ?? '', /no active watch session/i);

    // 8. Reject non-YouTube URL on start
    b.socket.send(JSON.stringify({ type: 'watch_start', room: 'general', url: 'https://vimeo.com/123' }));
    const badUrl = await b.readOfType('error');
    assert.match(badUrl.content ?? '', /youtube/i);

    // Fresh session for disconnect + non-member tests
    b.socket.send(JSON.stringify({ type: 'watch_start', room: 'general', url: `https://youtu.be/${VIDEO_ID}` }));
    await b.readOfType('watch_state');
    await b.readOfType('watch_peers');
    await a.readOfType('watch_started');
    await c.readOfType('watch_started');
    await a.readOfType('message');
    await b.readOfType('message');
    await c.readOfType('message');

    // 7. Host disconnect (close last socket) ends session
    b.socket.close();
    const endedOnDisconnect = await a.readOfType('watch_ended');
    assert.equal(endedOnDisconnect.user, 'bob');
    await c.readOfType('watch_ended');
    const disconnectEndMsg = await a.readOfType('message');
    assert.match(disconnectEndMsg.message?.content ?? '', /Watch together ended/);
    await c.readOfType('message');

    // 9. Non-member cannot start/join
    const outsider = await registerAndLogin('outsider');
    const users = (await (
      await fetch(`${origin}/users`, { headers: { Authorization: `Bearer ${alice.token}` } })
    ).json()) as Array<{ id: number; username: string }>;
    const dm = await fetch(`${origin}/rooms/dm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${alice.token}` },
      body: JSON.stringify({ userId: users.find((row) => row.username === 'carol')?.id }),
    });
    assert.equal(dm.status, 200);
    const dmRoom = (await dm.json()) as { slug: string };

    const o = await connectAuthed(outsider.token);
    o.socket.send(JSON.stringify({ type: 'watch_start', room: dmRoom.slug, url: WATCH_URL }));
    const outsiderStart = await o.readOfType('error');
    assert.match(outsiderStart.content ?? '', /not a member/i);

    a.socket.send(JSON.stringify({ type: 'watch_start', room: dmRoom.slug, url: WATCH_URL }));
    await a.readOfType('watch_state');
    await a.readOfType('watch_peers');
    // carol is a DM member — may get watch_started; outsider must not succeed join
    o.socket.send(JSON.stringify({ type: 'watch_join', room: dmRoom.slug }));
    const outsiderJoin = await o.readOfType('error');
    assert.match(outsiderJoin.content ?? '', /not a member/i);

    a.socket.close();
    c.socket.close();
    o.socket.close();
  } finally {
    await app.close();
  }
});
