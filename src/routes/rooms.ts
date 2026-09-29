import { FastifyInstance, FastifyRequest } from 'fastify';
import fs from 'node:fs';
import {
  addMembersToGroup,
  createGroupRoom,
  deleteGroupRoom,
  getOrCreateDmRoom,
  getRoomBySlug,
  getUserById,
  getUserByUsername,
  hideRoom,
  kickMember,
  lastMessagePreview,
  leaveRoom,
  listRoomsForUser,
  markRoomRead,
  unreadCount,
} from '../rooms';
import { can } from '../authz';
import { isRoomMember, listRoomMembers } from '../db';
import { normalizeRoomSlug, resolveUser, RouteContext } from './common';
import {
  createDmSchema,
  createRoomSchema,
  formatZodError,
  roomKickBodySchema,
  roomMembersBodySchema,
  roomSlugBodySchema,
  roomSlugParamSchema,
} from '../schemas';

export async function roomRoutes(fastify: FastifyInstance, ctx: RouteContext): Promise<void> {
  fastify.get('/rooms', async (request, reply) => {
    const username = resolveUser(request, reply);
    if (!username) {
      return { error: 'authentication required' };
    }

    return listRoomsForUser(username).map((room) => {
      const connected = ctx.connectedUsers(room.slug);
      const members = [...new Set([...connected, ...room.members])].sort((a, b) => a.localeCompare(b));
      const me = getUserByUsername(username);
      return {
        id: room.id,
        slug: room.slug,
        name: room.name,
        type: room.type,
        created_at: room.created_at,
        creator_id: room.creator_id,
        members,
        unread_count: me ? unreadCount(me.id, room.slug) : 0,
        last_message: lastMessagePreview(room.slug),
      };
    });
  });

  fastify.post('/rooms', async (request, reply) => {
    const username = resolveUser(request, reply);
    if (!username) {
      return { error: 'authentication required' };
    }

    const me = getUserByUsername(username);
    if (!me) {
      reply.code(401);
      return { error: 'authentication required' };
    }

    const parsed = createRoomSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: formatZodError(parsed.error) };
    }

    const body = parsed.data;
    const memberIds = Array.isArray(body.members)
      ? body.members.filter((id): id is number => typeof id === 'number' && Number.isInteger(id))
      : [];

    const room = createGroupRoom(body.name, me.id, memberIds);
    const invited = room.members.filter((member) => member !== username);
    ctx.fanOutMembership(room.slug, username, invited);
    request.log.info({ event: 'room_create', user: username, room: room.slug }, 'created group room');
    return room;
  });

  fastify.post('/rooms/dm', async (request, reply) => {
    const username = resolveUser(request, reply);
    if (!username) {
      return { error: 'authentication required' };
    }

    const me = getUserByUsername(username);
    if (!me) {
      reply.code(401);
      return { error: 'authentication required' };
    }

    const parsed = createDmSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'userId is required' };
    }

    const body = parsed.data;
    if (body.userId === me.id) {
      reply.code(400);
      return { error: 'cannot DM yourself' };
    }

    try {
      const room = getOrCreateDmRoom(me.id, body.userId);
      request.log.info({ event: 'room_dm', user: username, room: room.slug }, 'opened DM');
      return room;
    } catch (error) {
      reply.code(400);
      return { error: (error as Error).message };
    }
  });

  fastify.post('/rooms/leave', async (request, reply) => {
    const username = resolveUser(request, reply);
    if (!username) {
      return { error: 'authentication required' };
    }

    const parsed = roomSlugBodySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: formatZodError(parsed.error) };
    }

    const slug = normalizeRoomSlug(parsed.data.room);
    if (!slug) {
      reply.code(400);
      return { error: 'room is required' };
    }

    const result = leaveRoom(slug, username);
    if ('error' in result) {
      reply.code(
        result.error === 'cannot leave general' || result.error === 'cannot leave a DM' ? 400 : 403
      );
      return { error: result.error };
    }

    ctx.evictFromRoom(slug, username);
    const members = listRoomMembers(slug);
    ctx.broadcastToMembers(slug, {
      type: 'member_removed',
      room: slug,
      removed_by: username,
      users: [username],
      members,
    });
    request.log.info({ event: 'room_leave', user: username, room: slug }, 'left room');
    return { ok: true, room: slug };
  });

  fastify.post('/rooms/hide', async (request, reply) => {
    const username = resolveUser(request, reply);
    if (!username) {
      return { error: 'authentication required' };
    }

    const parsed = roomSlugBodySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: formatZodError(parsed.error) };
    }

    const slug = normalizeRoomSlug(parsed.data.room);
    if (!slug) {
      reply.code(400);
      return { error: 'room is required' };
    }

    const result = hideRoom(slug, username);
    if ('error' in result) {
      reply.code(result.error === 'not a member of this room' ? 403 : 400);
      return { error: result.error };
    }

    request.log.info({ event: 'room_hide', user: username, room: slug }, 'hid DM');
    return { ok: true, room: slug };
  });

  fastify.post('/rooms/members', async (request, reply) => {
    const username = resolveUser(request, reply);
    if (!username) {
      return { error: 'authentication required' };
    }

    const rawBody = request.body as { room?: unknown; userIds?: unknown };
    if (!rawBody?.room || typeof rawBody.room !== 'string' || !rawBody.room.trim()) {
      reply.code(400);
      return { error: 'room is required' };
    }
    if (!Array.isArray(rawBody.userIds)) {
      reply.code(400);
      return { error: 'userIds is required' };
    }

    const parsed = roomMembersBodySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: formatZodError(parsed.error) };
    }

    const slug = normalizeRoomSlug(parsed.data.room);
    if (!slug) {
      reply.code(400);
      return { error: 'room is required' };
    }

    const result = addMembersToGroup(slug, username, parsed.data.userIds);
    if ('error' in result) {
      reply.code(result.status);
      return { error: result.error };
    }

    ctx.fanOutMembership(slug, username, result.added);
    request.log.info(
      { event: 'member_add', user: username, room: slug, added: result.added },
      'added members to group'
    );
    return result.room;
  });

  fastify.post('/rooms/kick', async (request, reply) => {
    const username = resolveUser(request, reply);
    if (!username) {
      return { error: 'authentication required' };
    }

    const actor = getUserByUsername(username);
    if (!actor) {
      reply.code(401);
      return { error: 'authentication required' };
    }

    const rawBody = request.body as { room?: unknown; userId?: unknown };
    if (!rawBody?.room || typeof rawBody.room !== 'string' || !rawBody.room.trim()) {
      reply.code(400);
      return { error: 'room is required' };
    }
    if (typeof rawBody.userId !== 'number' || !Number.isInteger(rawBody.userId)) {
      reply.code(400);
      return { error: 'userId is required' };
    }

    const parsed = roomKickBodySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: formatZodError(parsed.error) };
    }

    const slug = normalizeRoomSlug(parsed.data.room);
    if (!slug) {
      reply.code(400);
      return { error: 'room is required' };
    }

    const room = getRoomBySlug(slug);
    if (!room) {
      reply.code(404);
      return { error: 'room not found' };
    }
    const target = getUserById(parsed.data.userId);
    if (!can(actor, 'room.kick', { room, actorIsMember: isRoomMember(slug, username), target })) {
      reply.code(403);
      return { error: 'forbidden' };
    }
    if (parsed.data.userId === actor.id) {
      reply.code(400);
      return { error: 'cannot kick yourself' };
    }

    const result = kickMember(slug, parsed.data.userId);
    if ('error' in result) {
      reply.code(result.status);
      return { error: result.error };
    }

    ctx.evictFromRoom(slug, result.removed);

    const members = listRoomMembers(slug);
    const payload = {
      type: 'member_removed',
      room: slug,
      removed_by: username,
      users: [result.removed],
      members,
    };
    ctx.broadcastToMembers(slug, payload);
    ctx.sendToUser(result.removed, payload);
    request.log.info(
      { event: 'member_kick', user: username, room: slug, removed: result.removed },
      'kicked member from group'
    );
    return result.room;
  });

  fastify.delete(
    '/rooms/:slug',
    async (request: FastifyRequest<{ Params: { slug: string } }>, reply) => {
      const username = resolveUser(request, reply);
      if (!username) {
        return { error: 'authentication required' };
      }

      const actor = getUserByUsername(username);
      if (!actor) {
        reply.code(401);
        return { error: 'authentication required' };
      }

      const parsed = roomSlugParamSchema.safeParse(request.params);
      if (!parsed.success) {
        reply.code(400);
        return { error: formatZodError(parsed.error) };
      }

      const slug = normalizeRoomSlug(parsed.data.slug);
      if (!slug) {
        reply.code(400);
        return { error: 'room is required' };
      }

      const room = getRoomBySlug(slug);
      if (!room) {
        reply.code(404);
        return { error: 'room not found' };
      }
      if (!can(actor, 'room.delete', { room, actorIsMember: isRoomMember(slug, username) })) {
        reply.code(403);
        return { error: 'forbidden' };
      }

      const result = deleteGroupRoom(slug);
      if ('error' in result) {
        reply.code(result.status);
        return { error: result.error };
      }

      ctx.teardownRoom(result.slug, result.members, username);
      const payload = { type: 'room_deleted', room: result.slug };
      for (const member of result.members) {
        ctx.sendToUser(member, payload);
      }
      for (const filePath of result.filePaths) {
        fs.rmSync(filePath, { force: true });
      }
      request.log.info({ event: 'room_delete', user: username, room: result.slug }, 'deleted group room');
      return { ok: true, room: result.slug };
    }
  );

  fastify.post('/rooms/read', async (request, reply) => {
    const username = resolveUser(request, reply);
    if (!username) {
      return { error: 'authentication required' };
    }

    const me = getUserByUsername(username);
    const parsed = roomSlugBodySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: formatZodError(parsed.error) };
    }

    const slug = normalizeRoomSlug(parsed.data.room);
    if (!me || !slug) {
      reply.code(400);
      return { error: 'room is required' };
    }

    if (!isRoomMember(slug, username)) {
      reply.code(403);
      return { error: 'not a member of this room' };
    }

    markRoomRead(me.id, slug);
    return { ok: true, room: slug, unread_count: 0 };
  });
}
