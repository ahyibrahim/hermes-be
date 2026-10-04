import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-v32-api-'));
process.env.HERMES_DB_PATH = path.join(tempDir, 'hermes.db');
process.env.HERMES_FILES_DIR = path.join(tempDir, 'files');
delete process.env.HERMES_TURN_URLS;
delete process.env.HERMES_TURN_SECRET;
delete process.env.HERMES_ICE_SERVERS;

type JsonFrame = {
  type: string;
  room?: string;
  user?: string;
  users?: string[];
  guests?: string[];
  guest?: boolean;
  from?: string;
  to?: string;
  message?: string;
  content?: string;
  candidate?: unknown;
};

test('v0.32.0: guest page closes itself, and an admitted guest can join a call', async () => {
  const { closeDb, getDb } = await import('./database');
  closeDb();
  const { appointMaster } = await import('./auth');
  const { createApp } = await import('./app');
  const { app, gateway } = await createApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  await gateway.listen({ port: 0, host: '127.0.0.1' });
  const origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const guestOrigin = `http://127.0.0.1:${(gateway.server.address() as AddressInfo).port}`;
  const guestPort = (gateway.server.address() as AddressInfo).port;
  const mainPort = (app.server.address() as AddressInfo).port;

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

  function hoursFromNow(iso: string): number {
    return (Date.parse(iso) - Date.now()) / (60 * 60 * 1000);
  }

  async function openSocket(url: string, cookie?: string): Promise<{
    socket: WebSocket;
    frames: JsonFrame[];
    readOfType: (type: string, timeoutMs?: number) => Promise<JsonFrame>;
  }> {
    const socket = new WebSocket(url, cookie ? { headers: { Cookie: cookie } } : undefined);
    const frames: JsonFrame[] = [];
    const inbox: JsonFrame[] = [];
    const waiters: Array<(frame: JsonFrame) => void> = [];
    socket.on('message', (data) => {
      const frame = JSON.parse(data.toString()) as JsonFrame;
      frames.push(frame);
      const waiter = waiters.shift();
      if (waiter) {
        waiter(frame);
      } else {
        inbox.push(frame);
      }
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', (error) => reject(error));
      socket.once('unexpected-response', (_req, res) => {
        reject(new Error(`unexpected response ${res.statusCode}`));
      });
    });
    const readOfType = (type: string, timeoutMs = 2000) =>
      new Promise<JsonFrame>((resolve, reject) => {
        const index = inbox.findIndex((frame) => frame.type === type);
        if (index >= 0) {
          resolve(inbox.splice(index, 1)[0]);
          return;
        }
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), timeoutMs);
        const check = (frame: JsonFrame) => {
          if (frame.type === type) {
            clearTimeout(timer);
            resolve(frame);
            return;
          }
          inbox.push(frame);
          waiters.push(check);
        };
        waiters.push(check);
      });
    return { socket, frames, readOfType };
  }

  try {
    const regAlice = await json(origin, 'POST', '/auth/register', { username: 'alice', password: 'secret1' });
    assert.equal(regAlice.status, 200);
    const regBob = await json(origin, 'POST', '/auth/register', { username: 'bob', password: 'secret2' });
    assert.equal(regBob.status, 200);
    const bobId = (regBob.data as { user: { id: number } }).user.id;
    await appointMaster('alice');
    const loginAlice = await json(origin, 'POST', '/auth/login', { username: 'alice', password: 'secret1' });
    const masterToken = (loginAlice.data as { token: string }).token;
    const loginBob = await json(origin, 'POST', '/auth/login', { username: 'bob', password: 'secret2' });
    const bobToken = (loginBob.data as { token: string }).token;

    const room = await json(origin, 'POST', '/rooms', { name: 'Porch' }, masterToken);
    assert.equal(room.status, 200);
    const slug = (room.data as { slug: string }).slug;
    const added = await json(origin, 'POST', '/rooms/members', { room: slug, userIds: [bobId] }, masterToken);
    assert.equal(added.status, 200);

    const tooSmall = await json(origin, 'POST', '/gateway', { open: true, hours: 0 }, masterToken);
    assert.equal(tooSmall.status, 400);
    const tooBig = await json(origin, 'POST', '/gateway', { open: true, hours: 169 }, masterToken);
    assert.equal(tooBig.status, 400);

    const opened = await json(origin, 'POST', '/gateway', { open: true, hours: 1 }, masterToken);
    assert.equal(opened.status, 200);
    const openedBody = opened.data as { open: boolean; closesAt: string };
    assert.equal(openedBody.open, true);
    assert.ok(Math.abs(hoursFromNow(openedBody.closesAt) - 1) < 0.05);

    const created = await json(origin, 'POST', '/invites', { rooms: [slug] }, masterToken);
    assert.equal(created.status, 200);
    const token = (created.data as { token: string }).token;
    const joined = await json(guestOrigin, 'POST', '/join', { token, username: 'sam' });
    assert.equal(joined.status, 200);
    const cookie = joined.setCookie!.split(';')[0];

    const admitted = await json(origin, 'POST', '/guests/guest_1/admit', {}, masterToken);
    assert.equal(admitted.status, 200);

    const closed = await json(origin, 'POST', '/gateway', { open: false }, masterToken);
    assert.equal(closed.status, 200);
    assert.equal((closed.data as { open: boolean; closesAt: string | null }).open, false);
    assert.equal((closed.data as { closesAt: string | null }).closesAt, null);
    const stillInside = await json(guestOrigin, 'GET', '/me', undefined, undefined, cookie);
    assert.equal(stillInside.status, 200);
    const refused = await json(guestOrigin, 'POST', '/join', { token: 'x'.repeat(32), username: 'pat' });
    assert.equal(refused.status, 404);
    const stranger = await json(guestOrigin, 'GET', '/me');
    assert.equal(stranger.status, 404);

    const reopened = await json(origin, 'POST', '/gateway', { open: true }, masterToken);
    assert.equal(reopened.status, 200);
    assert.ok(Math.abs(hoursFromNow((reopened.data as { closesAt: string }).closesAt) - 4) < 0.05);
    const noIce = await json(guestOrigin, 'GET', '/ice', undefined, undefined, cookie);
    assert.equal(noIce.status, 404);

    const alice = await openSocket(`ws://127.0.0.1:${mainPort}/ws?token=${encodeURIComponent(masterToken)}`);
    alice.socket.send(JSON.stringify({ type: 'join_room', room: slug }));
    alice.socket.send(JSON.stringify({ type: 'join_call', room: slug }));
    const alicePeers = await alice.readOfType('call_peers');
    assert.deepEqual(alicePeers.guests, []);

    const bob = await openSocket(`ws://127.0.0.1:${mainPort}/ws?token=${encodeURIComponent(bobToken)}`);
    bob.socket.send(JSON.stringify({ type: 'join_room', room: slug }));
    await bob.readOfType('joined_room');

    const guest = await openSocket(`ws://127.0.0.1:${guestPort}/ws`, cookie);
    guest.socket.send(JSON.stringify({ type: 'join_room', room: slug }));
    guest.socket.send(JSON.stringify({ type: 'join_call', room: slug }));
    const guestPeers = await guest.readOfType('call_peers');
    assert.ok(guestPeers.guests?.includes('guest_1'));
    const joinedCall = await alice.readOfType('user_joined_call');
    assert.equal(joinedCall.user, 'guest_1');
    assert.equal(joinedCall.guest, true);

    guest.socket.send(JSON.stringify({ type: 'ice_candidate', room: slug, to: 'bob', candidate: { candidate: 'a=candidate:bob' } }));
    const rejected = await guest.readOfType('error');
    assert.match(rejected.message || rejected.content || '', /not in that call/);

    guest.socket.send(
      JSON.stringify({ type: 'ice_candidate', room: slug, to: 'alice', candidate: { candidate: 'a=candidate:alice' } })
    );
    const delivered = await alice.readOfType('ice_candidate');
    assert.equal(delivered.from, 'guest_1');
    assert.equal(bob.frames.some((frame) => frame.type === 'ice_candidate'), false);

    guest.socket.send(JSON.stringify({ type: 'watch_start', room: slug, url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }));
    const blocked = await guest.readOfType('error');
    assert.match(blocked.message || blocked.content || '', /invalid message/);

    getDb()
      .prepare("UPDATE settings SET value = ? WHERE key = 'gateway_closes_at'")
      .run(new Date(Date.now() - 1000).toISOString());
    const expired = await json(origin, 'GET', '/gateway', undefined, masterToken);
    assert.equal((expired.data as { open: boolean }).open, false);
    assert.equal((expired.data as { closesAt: string | null }).closesAt, null);
    const afterClose = await json(guestOrigin, 'GET', '/me', undefined, undefined, cookie);
    assert.equal(afterClose.status, 200);
    const lateJoin = await json(guestOrigin, 'POST', '/join', { token: 'y'.repeat(32), username: 'late' });
    assert.equal(lateJoin.status, 404);

    alice.socket.close();
    bob.socket.close();
    guest.socket.close();
  } finally {
    await gateway.close();
    await app.close();
    closeDb();
  }
});
