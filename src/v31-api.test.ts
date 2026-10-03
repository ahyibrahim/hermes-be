import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AddressInfo } from 'node:net';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-v31-api-'));
process.env.HERMES_DB_PATH = path.join(tempDir, 'hermes.db');
process.env.HERMES_FILES_DIR = path.join(tempDir, 'files');
delete process.env.HERMES_TURN_URLS;
delete process.env.HERMES_TURN_SECRET;
delete process.env.HERMES_ICE_SERVERS;

test('v0.31.0: gateway invites, waiting room, and per-user TURN credentials', async () => {
  const { closeDb, getDb } = await import('./database');
  closeDb();
  const { appointMaster } = await import('./auth');
  const { createApp } = await import('./app');
  const { DEFAULT_ICE_SERVERS } = await import('./routes/common');
  const { app, gateway } = await createApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  await gateway.listen({ port: 0, host: '127.0.0.1' });
  const origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const guestOrigin = `http://127.0.0.1:${(gateway.server.address() as AddressInfo).port}`;

  async function json(base: string, method: string, pathName: string, body?: unknown, token?: string, cookie?: string) {
    const headers: Record<string, string> = {};
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    if (cookie) {
      headers.Cookie = cookie;
    }
    const res = await fetch(`${base}${pathName}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    const setCookie = res.headers.get('set-cookie');
    return { status: res.status, data, setCookie };
  }

  try {
    const closed = await json(guestOrigin, 'POST', '/join', { token: 'x'.repeat(32), username: 'sam' });
    assert.equal(closed.status, 404);
    const closedHealth = await json(guestOrigin, 'GET', '/health');
    assert.equal(closedHealth.status, 404);

    const regAlice = await json(origin, 'POST', '/auth/register', { username: 'alice', password: 'secret1' });
    assert.equal(regAlice.status, 200);
    await json(origin, 'POST', '/auth/register', { username: 'bob', password: 'secret2' });
    const loginBob = await json(origin, 'POST', '/auth/login', { username: 'bob', password: 'secret2' });
    const bobToken = (loginBob.data as { token: string }).token;
    await appointMaster('alice');
    const loginAlice = await json(origin, 'POST', '/auth/login', { username: 'alice', password: 'secret1' });
    const masterToken = (loginAlice.data as { token: string }).token;

    const denied = await json(origin, 'POST', '/invites', { rooms: ['nope'] }, bobToken);
    assert.equal(denied.status, 403);

    const room = await json(origin, 'POST', '/rooms', { name: 'Porch' }, masterToken);
    assert.equal(room.status, 200);
    const slug = (room.data as { slug: string }).slug;
    const old = await json(origin, 'POST', '/messages', { room: slug, content: 'before the guest' }, masterToken);
    assert.equal(old.status, 200);

    const generalInvite = await json(origin, 'POST', '/invites', { rooms: ['general'] }, masterToken);
    assert.equal(generalInvite.status, 400);

    const created = await json(
      origin,
      'POST',
      '/invites',
      { rooms: [slug], maxUses: 1, expiresInHours: 2 },
      masterToken
    );
    assert.equal(created.status, 200);
    const token = (created.data as { token: string; joinPath: string }).token;
    assert.equal((created.data as { joinPath: string }).joinPath, `/join#${token}`);
    assert.equal((created.data as { invite: { maxUses: number } }).invite.maxUses, 1);

    const stored = getDb()
      .prepare('SELECT token_hash FROM invites')
      .get() as { token_hash: string };
    assert.equal(stored.token_hash, crypto.createHash('sha256').update(token).digest('hex'));
    assert.equal(stored.token_hash.includes(token), false);

    const opened = await json(origin, 'POST', '/gateway', { open: true }, masterToken);
    assert.equal(opened.status, 200);
    assert.equal((opened.data as { open: boolean }).open, true);

    const stillHidden = await json(guestOrigin, 'GET', '/health');
    assert.equal(stillHidden.status, 404);
    const noIce = await json(guestOrigin, 'GET', '/ice');
    assert.equal(noIce.status, 404);
    const noRegister = await json(guestOrigin, 'POST', '/auth/register', { username: 'eve', password: 'secret9' });
    assert.equal(noRegister.status, 404);

    const joined = await json(guestOrigin, 'POST', '/join', { token, username: 'sam' });
    assert.equal(joined.status, 200);
    assert.ok(joined.setCookie?.includes('HttpOnly'));
    assert.ok(joined.setCookie?.includes('Secure'));
    const cookie = joined.setCookie!.split(';')[0];

    const waitingRooms = await json(guestOrigin, 'GET', '/rooms', undefined, undefined, cookie);
    assert.equal(waitingRooms.status, 200);
    assert.deepEqual(waitingRooms.data, []);
    const waitingMessages = await json(guestOrigin, 'GET', `/messages?room=${encodeURIComponent(slug)}`, undefined, undefined, cookie);
    assert.equal(waitingMessages.status, 403);

    const guestOnMain = await json(origin, 'GET', '/rooms', undefined, undefined, cookie);
    assert.equal(guestOnMain.status, 401);
    const guestBearer = cookie.split('=')[1];
    const bearerOnMain = await json(origin, 'GET', '/rooms', undefined, decodeURIComponent(guestBearer));
    assert.equal(bearerOnMain.status, 401);

    const again = await json(guestOrigin, 'POST', '/join', { token, username: 'sam2' });
    assert.equal(again.status, 400);

    const taken = await json(origin, 'POST', '/invites', { rooms: [slug] }, masterToken);
    const second = (taken.data as { token: string }).token;
    const collision = await json(guestOrigin, 'POST', '/join', { token: second, username: 'sam' });
    assert.equal(collision.status, 409);

    const admitted = await json(origin, 'POST', '/guests/sam/admit', {}, masterToken);
    assert.equal(admitted.status, 200);
    const history = await json(guestOrigin, 'GET', `/messages?room=${encodeURIComponent(slug)}`, undefined, undefined, cookie);
    assert.equal(history.status, 200);
    assert.deepEqual(
      (history.data as { messages: Array<{ content: string }> }).messages.map((message) => message.content),
      []
    );

    const fresh = await json(origin, 'POST', '/messages', { room: slug, content: 'welcome' }, masterToken);
    assert.equal(fresh.status, 200);
    const visible = await json(guestOrigin, 'GET', `/messages?room=${encodeURIComponent(slug)}`, undefined, undefined, cookie);
    assert.deepEqual(
      (visible.data as { messages: Array<{ content: string }> }).messages.map((message) => message.content),
      ['welcome']
    );

    const form = new FormData();
    form.set('room', slug);
    form.set('file', new File(['note'], 'note.txt', { type: 'text/plain' }));
    const uploaded = await fetch(`${guestOrigin}/files`, { method: 'POST', body: form, headers: { cookie } });
    assert.equal(uploaded.status, 200);
    const uploadedBody = (await uploaded.json()) as { file: { id: number; path?: string }; message: { id: number } };
    const fileRow = getDb().prepare('SELECT path FROM files WHERE id = ?').get(uploadedBody.file.id) as { path: string };
    assert.equal(fs.existsSync(fileRow.path), true);

    const removed = await json(origin, 'POST', '/guests/sam/remove', {}, masterToken);
    assert.equal(removed.status, 200);
    assert.equal(fs.existsSync(fileRow.path), false);
    const kept = await json(origin, 'GET', `/messages?room=${encodeURIComponent(slug)}`, undefined, masterToken);
    const contents = (kept.data as { messages: Array<{ content: string; file_id: number | null }> }).messages.map(
      (message) => message.content
    );
    assert.ok(contents.includes('before the guest'));
    assert.ok(contents.includes('welcome'));
    assert.ok(contents.includes('note.txt'));
    const attachment = (kept.data as { messages: Array<{ content: string; file_id: number | null }> }).messages.find(
      (message) => message.content === 'note.txt'
    );
    assert.equal(attachment?.file_id ?? null, null);

    const after = await json(guestOrigin, 'GET', '/me', undefined, undefined, cookie);
    assert.equal(after.status, 401);

    process.env.HERMES_ICE_SERVERS = JSON.stringify([
      { urls: 'stun:stun.example:19302', username: 'shared', credential: 'static-secret' },
    ]);
    process.env.HERMES_TURN_URLS = 'turn:turn.example:3478';
    process.env.HERMES_TURN_SECRET = 'turn-secret';
    const ice = await json(origin, 'GET', '/ice', undefined, masterToken);
    assert.equal(ice.status, 200);
    const servers = (ice.data as { iceServers: Array<{ urls: string | string[]; username?: string; credential?: string }> })
      .iceServers;
    assert.equal(JSON.stringify(servers).includes('static-secret'), false);
    assert.equal(JSON.stringify(servers).includes('shared'), false);
    const turn = servers.find((server) => {
      const urls = Array.isArray(server.urls) ? server.urls.join(' ') : server.urls;
      return urls.includes('turn:');
    });
    assert.ok(turn);
    assert.match(turn!.username ?? '', /^\d+:alice$/);
    const expected = crypto.createHmac('sha1', 'turn-secret').update(turn!.username!).digest('base64');
    assert.equal(turn!.credential, expected);

    delete process.env.HERMES_ICE_SERVERS;
    delete process.env.HERMES_TURN_URLS;
    delete process.env.HERMES_TURN_SECRET;
    const plain = await json(origin, 'GET', '/ice', undefined, masterToken);
    assert.deepEqual((plain.data as { iceServers: unknown }).iceServers, DEFAULT_ICE_SERVERS);
  } finally {
    delete process.env.HERMES_ICE_SERVERS;
    delete process.env.HERMES_TURN_URLS;
    delete process.env.HERMES_TURN_SECRET;
    await gateway.close();
    await app.close();
    closeDb();
  }
});
