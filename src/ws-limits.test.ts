import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { createMessageBudget, WS_MAX_PAYLOAD_BYTES, WS_MAX_SOCKETS_PER_USER } from './ws/limits';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-ws-limits-'));
process.env.HERMES_DB_PATH = path.join(tempDir, 'hermes.db');
process.env.HERMES_FILES_DIR = path.join(tempDir, 'files');

test('message budget allows a burst, then refills at the steady rate', () => {
  const budget = createMessageBudget(3, 2);
  const t0 = 1_000_000;
  assert.equal(budget.take(t0), true);
  assert.equal(budget.take(t0), true);
  assert.equal(budget.take(t0), true);
  assert.equal(budget.take(t0), false);
  assert.equal(budget.take(t0 + 500), true, 'half a second at 2/s refills one');
  assert.equal(budget.take(t0 + 500), false);
});

test('websocket upgrade and frame limits', async () => {
  const { createApp } = await import('./app');
  const { app } = await createApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = (app.server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;

  await fetch(`${origin}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'limits', password: 'hunter2' }),
  });
  const login = await fetch(`${origin}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'limits', password: 'hunter2' }),
  });
  const { token } = (await login.json()) as { token: string };
  const url = `ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`;

  const handshake = (headers: Record<string, string>) =>
    new Promise<number>((resolve) => {
      const socket = new WebSocket(url, { headers });
      socket.once('open', () => {
        socket.close();
        resolve(101);
      });
      socket.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      socket.once('error', () => resolve(0));
    });

  const openSocket = () =>
    new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.once('open', () => resolve(socket));
      socket.once('error', reject);
    });

  const closeCode = (socket: WebSocket) =>
    new Promise<number>((resolve) => socket.once('close', (code) => resolve(code)));

  try {
    assert.equal(await handshake({ Origin: 'https://evil.example' }), 403, 'foreign origin is refused');
    assert.equal(await handshake({ Origin: origin }), 101, 'same-origin page is accepted');
    assert.equal(await handshake({}), 101, 'a client without Origin (CLI) is accepted');

    const big = await openSocket();
    const bigClosed = closeCode(big);
    big.send('x'.repeat(WS_MAX_PAYLOAD_BYTES + 1));
    assert.equal(await bigClosed, 1009, 'oversized frame closes the socket');

    const flood = await openSocket();
    const floodClosed = closeCode(flood);
    for (let i = 0; i < 1000; i += 1) {
      flood.send(JSON.stringify({ type: 'typing', room: 'general', active: false }));
    }
    assert.equal(await floodClosed, 1008, 'message flood closes the socket');

    const sockets: WebSocket[] = [];
    for (let i = 0; i < WS_MAX_SOCKETS_PER_USER; i += 1) {
      sockets.push(await openSocket());
    }
    const oldestClosed = closeCode(sockets[0]);
    sockets.push(await openSocket());
    assert.equal(await oldestClosed, 1008, 'one socket over the cap closes the oldest');
    for (const socket of sockets) {
      socket.close();
    }
  } finally {
    await app.close();
  }
});
