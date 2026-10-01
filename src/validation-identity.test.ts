import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AddressInfo } from 'node:net';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-val-'));
process.env.HERMES_DB_PATH = path.join(tempDir, 'hermes.db');
process.env.HERMES_FILES_DIR = path.join(tempDir, 'files');

test('input validation (Zod) and server-side author binding', async () => {
  const { closeDb } = await import('./database');
  closeDb();
  const { createApp } = await import('./app');
  const { app } = await createApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = (app.server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;

  async function registerAndLogin(username: string, password = 'hunter2') {
    const reg = await fetch(`${origin}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    assert.equal(reg.status, 200);
    const { seatInGeneral } = await import('./test-seat');
    seatInGeneral(username);

    const login = await fetch(`${origin}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    assert.equal(login.status, 200);
    const body = (await login.json()) as { token: string; username: string };
    return body;
  }

  try {
    const alice = await registerAndLogin('alice');
    const bob = await registerAndLogin('bob');

    // 1. Zod Validation: Rejection of malformed registration payloads
    const emptyReg = await fetch(`${origin}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: '', password: '' }),
    });
    assert.equal(emptyReg.status, 400);
    assert.equal((await emptyReg.json()).error, 'username and password are required');

    // 2. Zod Validation: Rejection of malformed room creation payloads
    const emptyRoom = await fetch(`${origin}/rooms`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${alice.token}`,
      },
      body: JSON.stringify({ name: '   ' }),
    });
    assert.equal(emptyRoom.status, 400);
    assert.equal((await emptyRoom.json()).error, 'name is required');

    // 3. Zod Validation: Rejection of malformed message creation payloads
    const emptyMsg = await fetch(`${origin}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${alice.token}`,
      },
      body: JSON.stringify({ room: 'general', content: '   ' }),
    });
    assert.equal(emptyMsg.status, 400);
    assert.equal((await emptyMsg.json()).error, 'room and content are required');

    // 4. Server-Side Author Binding: Prevent sender spoofing on POST /messages
    const spoofedMsg = await fetch(`${origin}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${alice.token}`,
      },
      body: JSON.stringify({
        room: 'general',
        content: 'I am totally admin',
        sender: 'admin',
      }),
    });
    assert.equal(spoofedMsg.status, 200);
    const msgData = (await spoofedMsg.json()) as { sender: string; content: string };
    assert.equal(msgData.sender, 'alice', 'persisted sender must be bound to session user, not spoofed sender');

    // 5. Server-Side Author Binding: Prevent uploader spoofing on POST /files
    const form = new FormData();
    const blob = new Blob(['sample file content'], { type: 'text/plain' });
    form.append('file', blob, 'test.txt');
    form.append('room', 'general');
    form.append('uploader', 'admin');
    form.append('user', 'admin');

    const uploadRes = await fetch(`${origin}/files`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${alice.token}`,
      },
      body: form,
    });
    assert.equal(uploadRes.status, 200);
    const uploadData = (await uploadRes.json()) as { file: { uploader: string }; message: { sender: string } };
    assert.equal(uploadData.file.uploader, 'alice', 'persisted uploader must be session user, not spoofed uploader');
    assert.equal(uploadData.message.sender, 'alice', 'file message sender must be session user');
  } finally {
    await app.close();
    closeDb();
  }
});
