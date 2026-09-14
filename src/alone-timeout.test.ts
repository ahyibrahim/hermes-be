import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-alone-'));
process.env.HERMES_DB_PATH = path.join(tempDir, 'hermes.db');
process.env.HERMES_FILES_DIR = path.join(tempDir, 'files');

type JsonFrame = {
  type: string;
  room?: string;
  user?: string;
  users?: string[];
  playing?: boolean;
  message?: { sender: string; content: string };
  content?: string;
};

test('alone timeouts: call leaves after short timeout; watch ends after short timeout', async () => {
  const { closeDb } = await import('./database');
  closeDb();
  const { createApp } = await import('./app');
  const { app } = await createApp({
    callAloneTimeoutMs: 80,
    watchAloneTimeoutMs: 80,
  });
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
    await waitUntilOpen(socket);
    await readFrame();
    return { socket, readFrame, readOfType };
  }

  try {
    const alice = await registerAndLogin('alice');
    const bob = await registerAndLogin('bob');
    const a = await connectAuthed(alice.token);
    const b = await connectAuthed(bob.token);

    // Call: alone alice is removed after timeout
    a.socket.send(JSON.stringify({ type: 'join_call', room: 'general' }));
    assert.equal((await a.readOfType('call_peers')).type, 'call_peers');
    await b.readOfType('call_started');
    const left = await a.readOfType('left_call', 1500);
    assert.equal(left.room, 'general');

    // Watch: alone bob session ends after timeout
    b.socket.send(
      JSON.stringify({
        type: 'watch_start',
        room: 'general',
        url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      })
    );
    const state = await b.readOfType('watch_state');
    assert.equal(state.playing, false);
    await a.readOfType('watch_started');
    await b.readOfType('watch_peers');
    await b.readOfType('message');
    await a.readOfType('message');

    const ended = await b.readOfType('watch_ended', 1500);
    assert.equal(ended.room, 'general');
    assert.equal(ended.user, 'bob');
    const endMsg = await b.readOfType('message', 1500);
    assert.equal(endMsg.message?.content, 'Watch together ended');

    // Second person joining cancels the alone timer
    a.socket.send(JSON.stringify({ type: 'join_call', room: 'general' }));
    await a.readOfType('call_peers');
    await b.readOfType('call_started');
    b.socket.send(JSON.stringify({ type: 'join_call', room: 'general' }));
    await b.readOfType('call_peers');
    await a.readOfType('user_joined_call');
    await new Promise((resolve) => setTimeout(resolve, 200));
    // Still in call — no left_call for alice
    a.socket.send(JSON.stringify({ type: 'leave_call', room: 'general' }));
    assert.equal((await a.readOfType('left_call')).type, 'left_call');
  } finally {
    await app.close();
    closeDb();
  }
});
