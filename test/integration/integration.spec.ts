/**
 * Specification for the v0.6.0 API surface. NOT a regression test.
 *
 * This file is deliberately excluded from `npm test`. It is not a `node:test`
 * file: it is a standalone script that expects an already-running hermes-be on
 * PORT (default 3456) and asserts against endpoints and WebSocket events that
 * DO NOT EXIST YET. Against today's server it fails by design.
 *
 * Unimplemented surface it describes, all planned for v0.6.0 (see
 * docs/ROADMAP.md):
 *   REST  GET  /users            list all users
 *   REST  GET  /users/online     list currently connected users
 *   REST  POST /rooms            create a group room with a member list
 *   REST  POST /rooms/dm         get-or-create a DM room, idempotent
 *   REST  POST /auth/logout      invalidate the caller's token
 *   REST  GET  /rooms            room summaries carrying a `type` field
 *   WS    ->   authenticate      token handshake over an open socket
 *   WS    <-   authenticated     handshake acknowledgement
 *   WS    <-   presence          roster broadcast on connect and disconnect
 *   WS    <->  typing            typing indicator relay
 *
 * It is kept because it is the clearest written record of the intended shape of
 * that surface, including the behaviours worth pinning down: duplicate register
 * is 409, unauthenticated reads are 401, DM creation is idempotent, a self-DM is
 * 400, a token stops working after logout, and an unauthenticated WS send is
 * rejected before it reaches a room.
 *
 * Run it by hand once the v0.6.0 endpoints land, against a throwaway database:
 *
 *   HERMES_DB_PATH=/tmp/hermes-integration/hermes.db \
 *   HERMES_FILES_DIR=/tmp/hermes-integration/files \
 *   PORT=3456 npm run dev
 *   npm run test:integration
 *
 * It registers `alice` and `bob` and writes messages, so never point it at a
 * database holding real history. In v0.6.0 this becomes a genuine passing test.
 */

const BASE = `http://127.0.0.1:${process.env.PORT ?? 3456}`;
const WS_URL = `ws://127.0.0.1:${process.env.PORT ?? 3456}/ws`;

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.error(`  ✗ ${message}`);
  }
}

async function json(method: string, path: string, body?: unknown, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
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

function wsConnect(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    ws.addEventListener('open', () => resolve(ws));
    ws.addEventListener('error', reject);
  });
}

function wsWaitFor(ws: WebSocket, type: string, timeoutMs = 3000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener('message', handler);
      reject(new Error(`timeout waiting for ${type}`));
    }, timeoutMs);

    function handler(event: MessageEvent) {
      const payload = JSON.parse(String(event.data));
      if (payload.type === type) {
        clearTimeout(timer);
        ws.removeEventListener('message', handler);
        resolve(payload);
      }
    }

    ws.addEventListener('message', handler);
  });
}

function wsCollectUntil(ws: WebSocket, type: string, count: number, timeoutMs = 3000): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const results: unknown[] = [];
    const timer = setTimeout(() => {
      ws.removeEventListener('message', handler);
      reject(new Error(`timeout waiting for ${count}x ${type}, got ${results.length}`));
    }, timeoutMs);

    function handler(event: MessageEvent) {
      const payload = JSON.parse(String(event.data));
      if (payload.type === type) {
        results.push(payload);
        if (results.length >= count) {
          clearTimeout(timer);
          ws.removeEventListener('message', handler);
          resolve(results);
        }
      }
    }

    ws.addEventListener('message', handler);
  });
}

async function main() {
  console.log(`Testing server at ${BASE}\n`);

  // Health
  console.log('Health');
  const health = await json('GET', '/health');
  assert(health.status === 200, 'GET /health returns 200');
  assert((health.data as { status: string }).status === 'ok', 'health status is ok');

  // Auth - register
  console.log('\nAuth');
  const regAlice = await json('POST', '/auth/register', { username: 'alice', password: 'secret1' });
  assert(regAlice.status === 200, 'register alice succeeds');
  const aliceId = (regAlice.data as { user: { id: number } }).user.id;

  const regBob = await json('POST', '/auth/register', { username: 'bob', password: 'secret2' });
  assert(regBob.status === 200, 'register bob succeeds');
  const bobId = (regBob.data as { user: { id: number } }).user.id;

  const dupReg = await json('POST', '/auth/register', { username: 'alice', password: 'x' });
  assert(dupReg.status === 409, 'duplicate register returns 409');

  const loginAlice = await json('POST', '/auth/login', { username: 'alice', password: 'secret1' });
  assert(loginAlice.status === 200, 'login alice succeeds');
  const aliceToken = (loginAlice.data as { token: string }).token;

  const badLogin = await json('POST', '/auth/login', { username: 'alice', password: 'wrong' });
  assert(badLogin.status === 401, 'bad login returns 401');

  const noAuth = await json('GET', '/rooms');
  assert(noAuth.status === 401, 'unauthenticated /rooms returns 401');

  // Users
  console.log('\nUsers');
  const users = await json('GET', '/users', undefined, aliceToken);
  assert(users.status === 200, 'GET /users succeeds');
  assert(Array.isArray(users.data) && (users.data as unknown[]).length === 2, 'lists 2 users');

  const online = await json('GET', '/users/online', undefined, aliceToken);
  assert(online.status === 200, 'GET /users/online succeeds');

  // Rooms
  console.log('\nRooms');
  const rooms = await json('GET', '/rooms', undefined, aliceToken);
  assert(rooms.status === 200, 'GET /rooms succeeds');
  const aliceRooms = rooms.data as { slug: string; type: string }[];
  assert(aliceRooms.some((r) => r.slug === 'general'), 'alice is in general room');

  const group = await json('POST', '/rooms', { name: 'Test Group', members: [bobId] }, aliceToken);
  assert(group.status === 200, 'create group room succeeds');
  const groupSlug = (group.data as { slug: string }).slug;

  const dm = await json('POST', '/rooms/dm', { userId: bobId }, aliceToken);
  assert(dm.status === 200, 'create DM succeeds');
  const dmSlug = (dm.data as { slug: string; type: string }).slug;
  assert((dm.data as { type: string }).type === 'dm', 'DM room type is dm');

  const dmAgain = await json('POST', '/rooms/dm', { userId: bobId }, aliceToken);
  assert((dmAgain.data as { slug: string }).slug === dmSlug, 'DM is idempotent');

  const selfDm = await json('POST', '/rooms/dm', { userId: aliceId }, aliceToken);
  assert(selfDm.status === 400, 'self DM returns 400');

  // Messages REST
  console.log('\nMessages (REST)');
  const postMsg = await json('POST', '/messages', { room: 'general', content: 'hello from REST' }, aliceToken);
  assert(postMsg.status === 200, 'POST /messages succeeds');
  assert((postMsg.data as { sender: string }).sender === 'alice', 'sender is alice from token');

  const emptyMsg = await json('POST', '/messages', { room: 'general', content: '   ' }, aliceToken);
  assert(emptyMsg.status === 400, 'empty message returns 400');

  const listMsg = await json('GET', '/messages?room=general', undefined, aliceToken);
  assert(listMsg.status === 200, 'GET /messages succeeds');
  assert((listMsg.data as unknown[]).length >= 1, 'messages returned');

  const loginBob = await json('POST', '/auth/login', { username: 'bob', password: 'secret2' });
  const bobToken = (loginBob.data as { token: string }).token;

  const forbidden = await json('GET', `/messages?room=${groupSlug}`, undefined, bobToken);
  assert(forbidden.status === 200, 'bob can read group he belongs to');

  // Logout
  console.log('\nLogout');
  const logout = await json('POST', '/auth/logout', {}, aliceToken);
  assert(logout.status === 200, 'logout succeeds');

  const afterLogout = await json('GET', '/rooms', undefined, aliceToken);
  assert(afterLogout.status === 401, 'token invalid after logout');

  // Re-login for websocket tests
  const relogin = await json('POST', '/auth/login', { username: 'alice', password: 'secret1' });
  const freshAliceToken = (relogin.data as { token: string }).token;

  // WebSocket
  console.log('\nWebSocket');
  const wsAlice = await wsConnect();
  const connected = await wsWaitFor(wsAlice, 'connected');
  assert((connected as { type: string }).type === 'connected', 'WS connected event received');

  wsAlice.send(JSON.stringify({ type: 'send_message', room: 'general', content: 'should fail' }));
  const authError = await wsWaitFor(wsAlice, 'error');
  assert((authError as { message: string }).message === 'authentication required', 'WS rejects unauthenticated send');

  wsAlice.send(JSON.stringify({ type: 'authenticate', token: freshAliceToken }));
  const authenticated = await wsWaitFor(wsAlice, 'authenticated');
  assert((authenticated as { user: string }).user === 'alice', 'WS authenticate succeeds');

  const presence = await wsWaitFor(wsAlice, 'presence');
  assert((presence as { users: string[] }).users.includes('alice'), 'presence includes alice');

  wsAlice.send(JSON.stringify({ type: 'join_room', room: 'general' }));
  const joined = await wsWaitFor(wsAlice, 'joined_room');
  assert((joined as { room: string }).room === 'general', 'WS join_room succeeds');

  // Second client for broadcast test
  const wsBob = await wsConnect();
  await wsWaitFor(wsBob, 'connected');
  wsBob.send(JSON.stringify({ type: 'authenticate', token: bobToken }));
  await wsWaitFor(wsBob, 'authenticated');
  wsBob.send(JSON.stringify({ type: 'join_room', room: 'general' }));

  const bobJoined = await wsWaitFor(wsBob, 'joined_room');
  assert((bobJoined as { room: string }).room === 'general', 'bob joins general');

  // Alice sends, bob should receive
  const bobMessagePromise = wsWaitFor(wsBob, 'message');
  wsAlice.send(JSON.stringify({ type: 'send_message', room: 'general', content: 'hello from WS' }));
  const received = await bobMessagePromise;
  assert((received as { message: { content: string; sender: string } }).message.content === 'hello from WS', 'WS message broadcast to bob');
  assert((received as { message: { sender: string } }).message.sender === 'alice', 'WS sender is alice');

  // Typing indicator
  const typingPromise = wsWaitFor(wsBob, 'typing');
  wsAlice.send(JSON.stringify({ type: 'typing', room: 'general' }));
  const typing = await typingPromise;
  assert((typing as { user: string }).user === 'alice', 'typing indicator received');

  // Presence on bob connect
  const presenceAfterBob = await wsWaitFor(wsAlice, 'presence');
  assert((presenceAfterBob as { users: string[] }).users.includes('bob'), 'presence includes bob after connect');

  wsAlice.close();
  wsBob.close();

  // Wait briefly for disconnect presence
  await new Promise((r) => setTimeout(r, 200));

  console.log(`\n${'='.repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Integration test crashed:', err);
  process.exit(1);
});
