import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-typing-'));
process.env.HERMES_DB_PATH = path.join(tempDir, 'hermes.db');
process.env.HERMES_FILES_DIR = path.join(tempDir, 'files');

type JsonFrame = {
  type: string;
  room?: string;
  user?: string;
  active?: boolean;
  content?: string;
};

test('typing: fan-out excluding sender, stop, TTL, and disconnect clear', async () => {
  const { closeDb } = await import('./database');
  closeDb();
  const { createApp } = await import('./app');
  const { app } = await createApp({ typingTimeoutMs: 400 });
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
    });
  }

  async function registerAndLogin(username: string, password = 'hunter2') {
    assert.equal(
      (
        await fetch(`${origin}/auth/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password }),
        })
      ).status,
      200
    );
    const login = await fetch(`${origin}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const body = (await login.json()) as { token: string };
    assert.ok(body.token);
    return body;
  }

  async function connectAuthed(token: string) {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
    const inbox: JsonFrame[] = [];
    const waiters: Array<(frame: JsonFrame) => void> = [];
    socket.on('message', (raw) => {
      const frame = JSON.parse(String(raw)) as JsonFrame;
      const waiter = waiters.shift();
      if (waiter) {
        waiter(frame);
      } else {
        inbox.push(frame);
      }
    });
    const readFrame = (timeoutMs = 2000) =>
      new Promise<JsonFrame>((resolve, reject) => {
        const queued = inbox.shift();
        if (queued) {
          resolve(queued);
          return;
        }
        const onFrame = (frame: JsonFrame) => {
          clearTimeout(timer);
          resolve(frame);
        };
        const timer = setTimeout(() => {
          const idx = waiters.indexOf(onFrame);
          if (idx >= 0) {
            waiters.splice(idx, 1);
          }
          reject(new Error('timed out waiting for websocket frame'));
        }, timeoutMs);
        waiters.push(onFrame);
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
    await waitUntilOpen(socket);
    await readOfType('connected');
    return { socket, readOfType, readFrame };
  }

  try {
    const alice = await registerAndLogin('alice');
    const bob = await registerAndLogin('bob');
    const a = await connectAuthed(alice.token);
    const b = await connectAuthed(bob.token);

    a.socket.send(JSON.stringify({ type: 'typing', room: 'general', active: true }));
    const started = await b.readOfType('typing');
    assert.equal(started.room, 'general');
    assert.equal(started.user, 'alice');
    assert.equal(started.active, true);

    // Sender must not echo their own typing frame.
    await assert.rejects(() => a.readOfType('typing', 60), /timed out/);

    // Refresh does not re-broadcast while already typing.
    a.socket.send(JSON.stringify({ type: 'typing', room: 'general', active: true }));
    await assert.rejects(() => b.readOfType('typing', 80), /timed out/);

    a.socket.send(JSON.stringify({ type: 'typing', room: 'general', active: false }));
    const stopped = await b.readOfType('typing');
    assert.equal(stopped.user, 'alice');
    assert.equal(stopped.active, false);

    a.socket.send(JSON.stringify({ type: 'typing', room: 'general', active: true }));
    await b.readOfType('typing');
    const expired = await b.readOfType('typing', 800);
    assert.equal(expired.user, 'alice');
    assert.equal(expired.active, false);

    a.socket.send(JSON.stringify({ type: 'typing', room: 'general', active: true }));
    await b.readOfType('typing');
    a.socket.close();
    const cleared = await b.readOfType('typing', 500);
    assert.equal(cleared.user, 'alice');
    assert.equal(cleared.active, false);

    // Non-member is rejected (create a private group without bob).
    const group = await fetch(`${origin}/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${alice.token}` },
      body: JSON.stringify({ name: 'secret' }),
    });
    const room = (await group.json()) as { slug: string };
    assert.equal(group.status, 200);
    const b2 = await connectAuthed(bob.token);
    b2.socket.send(JSON.stringify({ type: 'typing', room: room.slug, active: true }));
    const err = await b2.readOfType('error');
    assert.match(err.content ?? '', /member/i);
    b2.socket.close();
  } finally {
    await app.close();
  }
});
