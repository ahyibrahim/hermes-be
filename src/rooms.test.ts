import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

test('creates rooms, memberships, and direct messages', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-rooms-'));
  process.env.HERMES_DB_PATH = path.join(tempDir, 'hermes.db');

  const { registerUser } = await import('./auth');
  const {
    addUserToGeneralRoom,
    createGroupRoom,
    ensureGeneralRoom,
    getOrCreateDmRoom,
    isRoomMember,
    listRoomsForUser,
  } = await import('./rooms');

  const alice = registerUser('alice', 'hunter2');
  const bob = registerUser('bob', 'hunter2');

  addUserToGeneralRoom(alice.id);
  addUserToGeneralRoom(bob.id);

  const general = ensureGeneralRoom();
  assert.equal(general.slug, 'general');

  const group = createGroupRoom('Weekend Plans', alice.id, [bob.id]);
  assert.equal(group.type, 'group');
  assert.deepEqual(group.members.sort(), ['alice', 'bob']);

  const dm = getOrCreateDmRoom(alice.id, bob.id);
  assert.equal(dm.type, 'dm');
  assert.equal(dm.slug, 'dm:alice:bob');

  const sameDm = getOrCreateDmRoom(bob.id, alice.id);
  assert.equal(sameDm.slug, dm.slug);

  const aliceRooms = listRoomsForUser(alice.id);
  assert.equal(aliceRooms.length, 3);
  assert.equal(isRoomMember('general', alice.id), true);
  assert.equal(isRoomMember(group.slug, bob.id), true);
});
