import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AddressInfo } from 'node:net';
import { Blob } from 'node:buffer';
import { WebSocket } from 'ws';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-files-'));
process.env.HERMES_DB_PATH = path.join(tempDir, 'hermes.db');
process.env.HERMES_FILES_DIR = path.join(tempDir, 'files');

type JsonFrame = {
  type: string;
  message?: {
    id: number;
    content: string;
    file_id?: number | null;
    sender: string;
    room: string;
  };
};

test('file upload, download, and live room broadcast', async () => {
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
    return (await login.json()) as { token: string; username: string };
  }

  function connect(token: string) {
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
    const open = new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    return { socket, readFrame, open };
  }

  try {
    const alice = await registerAndLogin('filealice');
    const bob = await registerAndLogin('filebob');
    const users = (await (
      await fetch(`${origin}/users`, { headers: { Authorization: `Bearer ${alice.token}` } })
    ).json()) as Array<{ id: number; username: string }>;
    const bobId = users.find((row) => row.username === 'filebob')?.id;
    const created = await fetch(`${origin}/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${alice.token}` },
      body: JSON.stringify({ name: 'File Share', members: bobId ? [bobId] : [] }),
    });
    assert.equal(created.status, 200);
    const share = (await created.json()) as { slug: string };
    const a = connect(alice.token);
    const b = connect(bob.token);
    await a.open;
    await b.open;
    await a.readFrame();
    await b.readFrame();

    a.socket.send(JSON.stringify({ type: 'join_room', room: share.slug }));
    await a.readFrame();
    await a.readFrame();
    b.socket.send(JSON.stringify({ type: 'join_room', room: share.slug }));
    await b.readFrame();
    await b.readFrame();
    await a.readFrame();

    const payload = Buffer.from('hermes-file-bytes');
    const form = new FormData();
    form.append('room', share.slug);
    form.append('file', new Blob([payload], { type: 'text/plain' }), 'note.txt');

    const uploaded = await fetch(`${origin}/files`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${alice.token}` },
      body: form,
    });
    assert.equal(uploaded.status, 200);
    const body = (await uploaded.json()) as {
      file: { id: number; original_name: string; size: number };
      message: { id: number; file_id: number; content: string };
    };
    assert.equal(body.file.original_name, 'note.txt');
    assert.equal(body.file.size, payload.length);
    assert.equal(body.message.file_id, body.file.id);
    assert.equal(body.message.content, 'note.txt');

    const live = await b.readFrame();
    assert.equal(live.type, 'message');
    assert.equal(live.message?.file_id, body.file.id);
    assert.equal(live.message?.content, 'note.txt');

    const downloaded = await fetch(`${origin}/files/${body.file.id}`, {
      headers: { Authorization: `Bearer ${bob.token}` },
    });
    assert.equal(downloaded.status, 200);
    const bytes = Buffer.from(await downloaded.arrayBuffer());
    assert.deepEqual(bytes, payload);

    a.socket.close();
    b.socket.close();
  } finally {
    await app.close();
  }
});
