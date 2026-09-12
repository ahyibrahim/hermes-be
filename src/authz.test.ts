import test from 'node:test';
import assert from 'node:assert/strict';
import { can, type AuthzActor } from './authz';

const admin: AuthzActor = { id: 1, role: 'admin' };
const member: AuthzActor = { id: 2, role: 'member' };
const creator: AuthzActor = { id: 3, role: 'member' };
const system: AuthzActor = { id: 99, role: 'member', system: true };

const group = { slug: 'group:party:1', type: 'group' as const, creator_id: 3 };
const general = { slug: 'general', type: 'group' as const, creator_id: null };
const dm = { slug: 'dm:a:b', type: 'dm' as const, creator_id: null };

test('can(): admin-only actions', () => {
  assert.equal(can(admin, 'role.set'), true);
  assert.equal(can(member, 'role.set'), false);
  assert.equal(can(admin, 'message.admin_delete'), true);
  assert.equal(can(member, 'message.admin_delete'), false);
  assert.equal(can(admin, 'user.password_reset'), true);
  assert.equal(can(system, 'user.password_reset'), false);
});

test('can(): room.kick and room.delete for admin or creator', () => {
  assert.equal(can(admin, 'room.kick', { room: group }), true);
  assert.equal(can(creator, 'room.kick', { room: group }), true);
  assert.equal(can(member, 'room.kick', { room: group }), false);
  assert.equal(can(admin, 'room.delete', { room: group }), true);
  assert.equal(can(creator, 'room.delete', { room: group }), true);
  assert.equal(can(member, 'room.delete', { room: group }), false);

  assert.equal(can(admin, 'room.kick', { room: general }), false);
  assert.equal(can(admin, 'room.delete', { room: dm }), false);
});

test('can(): reserved watch actions (admin or host)', () => {
  assert.equal(can(admin, 'watch.play_pause'), true);
  assert.equal(can(member, 'watch.play_pause'), false);
  assert.equal(can(member, 'watch.play_pause', { isWatchHost: true }), true);
  assert.equal(can(member, 'watch.start', { isWatchHost: true }), true);
});
