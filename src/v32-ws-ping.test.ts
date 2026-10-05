import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-v32-ping-'));
process.env.HERMES_DB_PATH = path.join(tempDir, 'hermes.db');
process.env.HERMES_FILES_DIR = path.join(tempDir, 'files');
process.env.HERMES_WS_PING_INTERVAL_MS = '100';

test('gateway ping does not drop a tailnet socket', async () => {
  const { closeDb } = await import('./database');
  closeDb();
  const { createApp } = await import('./app');
  const { app, gateway } = await createApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  await gateway.listen({ port: 0, host: '127.0.0.1' });
  const port = (app.server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;

  try {
    const register = await fetch(`${origin}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'secret1' }),
    });
    assert.equal(register.status, 200);
    const login = await fetch(`${origin}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'secret1' }),
    });
    const token = ((await login.json()) as { token: string }).token;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(socket.readyState, WebSocket.OPEN);
    socket.close();
  } finally {
    await gateway.close();
    await app.close();
    closeDb();
  }
});
