import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-rooms-'));
process.env.HERMES_DB_PATH = path.join(tempDir, 'hermes.db');

test('creates group rooms, memberships, and idempotent DMs', async () => {
  const { closeDb } = await import('./database');
  closeDb();

  const { registerUser } = await import('./auth');
  const {
    addUserToGeneralRoom,
    createGroupRoom,
    getOrCreateDmRoom,
    isRoomMember,
    listRoomsForUser,
  } = await import('./rooms');

  const alice = await registerUser('alice', 'hunter2');
  const bob = await registerUser('bob', 'hunter2');
  addUserToGeneralRoom(alice.id);
  addUserToGeneralRoom(bob.id);

  const group = createGroupRoom('Weekend Plans', alice.id, [bob.id]);
  assert.equal(group.type, 'group');
  assert.deepEqual(group.members.sort(), ['alice', 'bob']);

  const dm = getOrCreateDmRoom(alice.id, bob.id);
  assert.equal(dm.type, 'dm');
  assert.equal(dm.slug, 'dm:alice:bob');
  assert.equal(getOrCreateDmRoom(bob.id, alice.id).slug, dm.slug);

  assert.equal(listRoomsForUser(alice.username).length, 3);
  assert.equal(isRoomMember('general', 'alice'), true);
  assert.equal(isRoomMember(group.slug, 'bob'), true);

  assert.throws(() => getOrCreateDmRoom(alice.id, alice.id), /cannot DM yourself/);
});
