import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AddressInfo } from 'node:net';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-v29-api-'));
process.env.HERMES_DB_PATH = path.join(tempDir, 'hermes.db');
process.env.HERMES_FILES_DIR = path.join(tempDir, 'files');

test('GET /messages returns the latest page, then the page before it', async () => {
  const { closeDb } = await import('./database');
  closeDb();
  const { createApp } = await import('./app');
  const { app } = await createApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

  async function json(method: string, pathName: string, body?: unknown, token?: string) {
    const headers: Record<string, string> = {};
    if (body) {
      headers['Content-Type'] = 'application/json';
    }
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    const res = await fetch(`${origin}${pathName}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, data: text ? JSON.parse(text) : null };
  }

  try {
    const registered = await json('POST', '/auth/register', { username: 'alice', password: 'secret1' });
    assert.equal(registered.status, 200);
    const loggedIn = await json('POST', '/auth/login', { username: 'alice', password: 'secret1' });
    assert.equal(loggedIn.status, 200);
    const token = (loggedIn.data as { token: string }).token;

    for (let i = 0; i < 105; i += 1) {
      const posted = await json('POST', '/messages', { room: 'general', content: `m${i}` }, token);
      assert.equal(posted.status, 200);
    }

    const page = await json('GET', '/messages?room=general', undefined, token);
    assert.equal(page.status, 200);
    const body = page.data as {
      messages: Array<{ id: number; content: string }>;
      has_more: boolean;
    };
    assert.equal(body.has_more, true);
    assert.equal(body.messages.length, 100);
    assert.equal(body.messages[0]?.content, 'm5');
    assert.equal(body.messages[99]?.content, 'm104');
    assert.ok(body.messages.every((row, index) => index === 0 || row.id > body.messages[index - 1].id));

    const older = await json(
      'GET',
      `/messages?room=general&before=${body.messages[0].id}`,
      undefined,
      token
    );
    const olderBody = older.data as {
      messages: Array<{ id: number; content: string }>;
      has_more: boolean;
    };
    assert.equal(older.status, 200);
    assert.equal(olderBody.has_more, false);
    assert.deepEqual(
      olderBody.messages.map((row) => row.content).slice(1),
      ['m0', 'm1', 'm2', 'm3', 'm4']
    );
    assert.match(olderBody.messages[0]?.content ?? '', /Hermes v0\.28\.0/);

    const tooBig = await json('GET', '/messages?room=general&limit=101', undefined, token);
    assert.equal(tooBig.status, 400);
  } finally {
    await app.close();
    closeDb();
  }
});
