import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AddressInfo } from 'node:net';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-v11-api-'));
process.env.HERMES_DB_PATH = path.join(tempDir, 'hermes.db');
process.env.HERMES_FILES_DIR = path.join(tempDir, 'files');

test('v0.11.0 REST: system hermes, no-login, one announcement', async () => {
  const { closeDb } = await import('./database');
  closeDb();
  const { createApp } = await import('./app');
  const { getDb } = await import('./database');
  const { postReleaseAnnouncement } = await import('./schema');
  const { app } = await createApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

  async function json(method: string, pathName: string, body?: unknown, token?: string) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    const res = await fetch(`${origin}${pathName}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { status: res.status, data };
  }

  const reserved = await json('POST', '/auth/register', { username: 'hermes', password: 'secret1' });
  assert.equal(reserved.status, 409);

  const aliceReg = await json('POST', '/auth/register', { username: 'alice', password: 'secret1' });
  assert.equal(aliceReg.status, 200);
  const alice = (aliceReg.data as { user: { id: number; role: string } }).user;
  assert.equal(alice.role, 'admin');

  const hermesLogin = await json('POST', '/auth/login', { username: 'hermes', password: 'secret1' });
  assert.equal(hermesLogin.status, 401);

  const aliceLogin = await json('POST', '/auth/login', { username: 'alice', password: 'secret1' });
  const aliceToken = (aliceLogin.data as { token: string }).token;

  const users = await json('GET', '/users', undefined, aliceToken);
  const directory = users.data as Array<{
    id: number;
    username: string;
    role: string;
    system?: boolean;
    avatar_file_id: number | null;
  }>;
  const hermes = directory.find((row) => row.username === 'hermes');
  assert.ok(hermes);
  assert.equal(hermes.system, true);
  assert.equal(hermes.role, 'member');
  assert.ok(hermes.avatar_file_id);

  const avatar = await fetch(`${origin}/users/${hermes.id}/avatar`, {
    headers: { Authorization: `Bearer ${aliceToken}` },
  });
  assert.equal(avatar.status, 200);
  assert.equal(avatar.headers.get('content-type'), 'image/png');

  const dm = await json('POST', '/rooms/dm', { userId: hermes.id }, aliceToken);
  assert.equal(dm.status, 400);

  const reset = await json('POST', '/users/hermes/password-reset', {}, aliceToken);
  assert.equal(reset.status, 404);

  const posted = postReleaseAnnouncement(getDb(), { info() {} }, '0.11.0');
  assert.equal(posted, true);
  const again = postReleaseAnnouncement(getDb(), { info() {} }, '0.11.0');
  assert.equal(again, false);

  const history = await json('GET', '/messages?room=general', undefined, aliceToken);
  const messages = history.data as Array<{ sender: string; content: string }>;
  const notes = messages.filter((message) => message.sender === 'hermes');
  assert.equal(notes.length, 1);
  assert.match(notes[0].content, /v0\.11\.0/);

  await app.close();
  closeDb();
});
