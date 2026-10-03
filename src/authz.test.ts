import test from 'node:test';
import assert from 'node:assert/strict';
import { can, type AuthzActor } from './authz';

const master: AuthzActor = { id: 1, role: 'master' };
const admin: AuthzActor = { id: 2, role: 'admin' };
const member: AuthzActor = { id: 3, role: 'member' };
const guest: AuthzActor = { id: 4, role: 'guest' };
const creator: AuthzActor = { id: 5, role: 'member' };
const system: AuthzActor = { id: 99, role: 'member', system: true };
const guestScope: AuthzActor = { id: 3, role: 'member', scope: 'guest' };

const group = { slug: 'group:party:1', type: 'group' as const, creator_id: 5 };
const general = { slug: 'general', type: 'group' as const, creator_id: null };
const dm = { slug: 'dm:a:b', type: 'dm' as const, creator_id: null };

test('can(): rank gates role changes and password reset', () => {
  assert.equal(can(master, 'role.set', { target: admin, nextRole: 'member' }), true);
  assert.equal(can(master, 'role.set', { target: member, nextRole: 'admin' }), true);
  assert.equal(can(admin, 'role.set', { target: member, nextRole: 'admin' }), false);
  assert.equal(can(admin, 'role.set', { target: admin, nextRole: 'member' }), false);
  assert.equal(can(admin, 'role.set', { target: master, nextRole: 'member' }), false);
  assert.equal(can(member, 'role.set', { target: member, nextRole: 'admin' }), false);
  assert.equal(can(master, 'user.password_reset', { target: admin }), true);
  assert.equal(can(admin, 'user.password_reset', { target: member }), true);
  assert.equal(can(admin, 'user.password_reset', { target: admin }), false);
  assert.equal(can(admin, 'user.password_reset', { target: master }), false);
  assert.equal(can(system, 'user.password_reset', { target: member }), false);
  assert.equal(can(master, 'message.admin_delete'), true);
  assert.equal(can(member, 'message.admin_delete'), false);
});

test('can(): room.kick and room.delete for admin or creator', () => {
  const inRoom = { room: group, actorIsMember: true };
  assert.equal(can(admin, 'room.kick', { room: group, target: member }), true);
  assert.equal(can(master, 'room.kick', { room: group, target: admin }), true);
  assert.equal(can(admin, 'room.kick', { room: group, target: master }), false);
  assert.equal(can(creator, 'room.kick', { ...inRoom, target: member }), true);
  assert.equal(can(member, 'room.kick', { ...inRoom, target: creator }), false);
  assert.equal(can(admin, 'room.delete', { room: group }), true);
  assert.equal(can(creator, 'room.delete', inRoom), true);
  assert.equal(can(member, 'room.delete', inRoom), false);

  assert.equal(can(admin, 'room.kick', { room: general, target: member }), false);
  assert.equal(can(admin, 'room.delete', { room: dm }), false);
});

test('can(): a creator moderates only while a member, and never admins', () => {
  assert.equal(can(creator, 'room.kick', { room: group, target: member }), false);
  assert.equal(can(creator, 'room.delete', { room: group, actorIsMember: false }), false);
  assert.equal(can(creator, 'room.kick', { room: group, actorIsMember: true, target: admin }), false);
  assert.equal(can(creator, 'room.kick', { room: group, actorIsMember: true, target: master }), false);
});

test('can(): members may start watch; guests and a guest scope cannot host', () => {
  assert.equal(can(member, 'watch.start'), true);
  assert.equal(can(admin, 'watch.start'), true);
  assert.equal(can(guest, 'watch.start'), false);
  assert.equal(can(guestScope, 'watch.start'), false);
  assert.equal(can(admin, 'watch.play_pause'), true);
  assert.equal(can(member, 'watch.play_pause'), false);
  assert.equal(can(member, 'watch.play_pause', { isWatchHost: true }), true);
  assert.equal(can(guest, 'watch.play_pause', { isWatchHost: true }), false);
  assert.equal(can(guestScope, 'watch.end', { isWatchHost: true }), false);
  assert.equal(can(master, 'watch.seek'), true);
});

test('can(): guests cannot add members or open a DM', () => {
  assert.equal(can(member, 'room.add_member'), true);
  assert.equal(can(member, 'dm.create'), true);
  assert.equal(can(guest, 'room.add_member'), false);
  assert.equal(can(guest, 'dm.create'), false);
  assert.equal(can(guestScope, 'dm.create'), false);
});
