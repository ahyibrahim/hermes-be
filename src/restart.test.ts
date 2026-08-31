import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-restart-'));
const dbPath = path.join(tempDir, 'hermes.db');
process.env.HERMES_DB_PATH = dbPath;
process.env.HERMES_FILES_DIR = path.join(tempDir, 'files');

async function boot() {
  const { createApp } = await import('./app');
  const { app } = await createApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = (app.server.address() as AddressInfo).port;
  return { app, origin: `http://127.0.0.1:${port}`, port };
}

function wsHandshake(port: number, url: string): Promise<{ opened: boolean; status?: number }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => reject(new Error('websocket handshake timed out')), 3000);
    socket.once('open', () => {
      clearTimeout(timer);
      socket.close();
      resolve({ opened: true });
    });
    socket.once('unexpected-response', (_req, response) => {
      clearTimeout(timer);
      resolve({ opened: false, status: response.statusCode });
    });
    socket.once('error', () => undefined);
  });
}

test('a login token still authenticates after the server restarts', async () => {
  const first = await boot();

  const register = await fetch(`${first.origin}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'persist', password: 'hunter2' }),
  });
  assert.equal(register.status, 200);

  const login = await fetch(`${first.origin}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'persist', password: 'hunter2' }),
  });
  assert.equal(login.status, 200);
  const session = (await login.json()) as { username: string; token: string; expires_at: string };
  assert.equal(session.username, 'persist');
  assert.ok(session.token);
  assert.ok(Date.parse(session.expires_at) > Date.now());

  const beforeRestart = await fetch(`${first.origin}/rooms`, {
    headers: { Authorization: `Bearer ${session.token}` },
  });
  assert.equal(beforeRestart.status, 200);

  // Tear the whole process state down: close the server and drop the shared
  // sqlite handle, so the second instance has to read the token back off disk.
  await first.app.close();
  const { closeDb } = await import('./database');
  closeDb();

  const second = await boot();

  try {
    const bearer = await fetch(`${second.origin}/rooms`, {
      headers: { Authorization: `Bearer ${session.token}` },
    });
    assert.equal(bearer.status, 200, 'Authorization: Bearer must still work after a restart');

    const queryParam = await fetch(`${second.origin}/rooms?token=${encodeURIComponent(session.token)}`);
    assert.equal(queryParam.status, 200, '?token= must still work after a restart');

    const bodyToken = await fetch(`${second.origin}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ room: 'general', content: 'after restart', token: session.token }),
    });
    assert.equal(bodyToken.status, 200, 'a token in the POST body must still work after a restart');
    const posted = (await bodyToken.json()) as { sender: string; content: string };
    assert.equal(posted.sender, 'persist');
    assert.equal(posted.content, 'after restart');

    const handshake = await wsHandshake(
      second.port,
      `ws://127.0.0.1:${second.port}/ws?token=${encodeURIComponent(session.token)}`
    );
    assert.equal(handshake.opened, true, 'the /ws handshake must still accept the old token');

    const rejected = await wsHandshake(second.port, `ws://127.0.0.1:${second.port}/ws?token=stale-token`);
    assert.deepEqual(rejected, { opened: false, status: 401 });

    const unknown = await fetch(`${second.origin}/rooms`, {
      headers: { Authorization: 'Bearer stale-token' },
    });
    assert.equal(unknown.status, 401);
  } finally {
    await second.app.close();
  }
});

test('the legacy body.sender fallback on POST /messages still works', async () => {
  const instance = await boot();
  try {
    const response = await fetch(`${instance.origin}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ room: 'general', sender: 'legacy-cli', content: 'no token here' }),
    });
    assert.equal(response.status, 200);
    const message = (await response.json()) as { sender: string };
    assert.equal(message.sender, 'legacy-cli');
  } finally {
    await instance.app.close();
  }
});
