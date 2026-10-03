import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { guestStatus, retireGuestAccount } from '../guests';
import { gatewayPort } from '../gateway';
import {
  admitGuest,
  assertInviteRooms,
  createInvite,
  isGatewayOpen,
  listInvites,
  listOpenGuests,
  normalizeInviteLimits,
  revokeInvite,
  setGatewayOpen,
} from '../invites';
import { getUserByUsername } from '../rooms';
import { deleteSessionsForUser } from '../sessions';
import { normalizeRoomSlug, resolveSession, RouteContext } from './common';

const createInviteSchema = z.object({
  rooms: z.array(z.string()).min(1).max(10),
  maxUses: z.number().int().optional(),
  expiresInHours: z.number().int().optional(),
});

const gatewaySchema = z.object({
  open: z.boolean(),
});

export async function masterRoutes(fastify: FastifyInstance, ctx: RouteContext): Promise<void> {
  function requireMaster(request: Parameters<typeof resolveSession>[0], reply: Parameters<typeof resolveSession>[1]) {
    const session = resolveSession(request, reply);
    if (!session) {
      return null;
    }
    const user = getUserByUsername(session.username);
    if (!user || user.role !== 'master') {
      reply.code(403);
      return null;
    }
    return user;
  }

  fastify.get('/gateway', async (request, reply) => {
    const master = requireMaster(request, reply);
    if (!master) {
      return { error: reply.statusCode === 403 ? 'forbidden' : 'authentication required' };
    }
    return { open: isGatewayOpen(), port: gatewayPort() };
  });

  fastify.post('/gateway', async (request, reply) => {
    const master = requireMaster(request, reply);
    if (!master) {
      return { error: reply.statusCode === 403 ? 'forbidden' : 'authentication required' };
    }
    const parsed = gatewaySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'open is required' };
    }
    setGatewayOpen(parsed.data.open);
    request.log.info({ event: 'gateway_open', user: master.username, open: parsed.data.open }, 'gateway switch');
    return { open: parsed.data.open, port: gatewayPort() };
  });

  fastify.get('/invites', async (request, reply) => {
    const master = requireMaster(request, reply);
    if (!master) {
      return { error: reply.statusCode === 403 ? 'forbidden' : 'authentication required' };
    }
    return { invites: listInvites() };
  });

  fastify.post('/invites', async (request, reply) => {
    const master = requireMaster(request, reply);
    if (!master) {
      return { error: reply.statusCode === 403 ? 'forbidden' : 'authentication required' };
    }
    const parsed = createInviteSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'rooms are required' };
    }
    const rooms: string[] = [];
    for (const raw of parsed.data.rooms) {
      const slug = normalizeRoomSlug(raw);
      if (!slug) {
        reply.code(400);
        return { error: 'room not found' };
      }
      rooms.push(slug);
    }
    let limits;
    try {
      limits = normalizeInviteLimits(parsed.data);
      const slugs = assertInviteRooms(rooms);
      const created = createInvite(master.id, slugs, limits);
      request.log.info({ event: 'invite_create', user: master.username, invite: created.invite.id }, 'invite created');
      return {
        invite: created.invite,
        token: created.token,
        joinPath: `/join#${created.token}`,
      };
    } catch (error) {
      reply.code(400);
      return { error: (error as Error).message };
    }
  });

  fastify.post('/invites/:id/revoke', async (request, reply) => {
    const master = requireMaster(request, reply);
    if (!master) {
      return { error: reply.statusCode === 403 ? 'forbidden' : 'authentication required' };
    }
    const id = Number((request.params as { id?: string }).id);
    if (!Number.isInteger(id) || id <= 0) {
      reply.code(400);
      return { error: 'invite not found' };
    }
    if (!revokeInvite(id)) {
      reply.code(404);
      return { error: 'invite not found' };
    }
    request.log.info({ event: 'invite_revoke', user: master.username, invite: id }, 'invite revoked');
    return { ok: true };
  });

  fastify.get('/guests', async (request, reply) => {
    const master = requireMaster(request, reply);
    if (!master) {
      return { error: reply.statusCode === 403 ? 'forbidden' : 'authentication required' };
    }
    return { guests: listOpenGuests() };
  });

  fastify.post('/guests/:username/admit', async (request, reply) => {
    const master = requireMaster(request, reply);
    if (!master) {
      return { error: reply.statusCode === 403 ? 'forbidden' : 'authentication required' };
    }
    const username = String((request.params as { username?: string }).username || '').trim().toLowerCase();
    const result = admitGuest(username);
    if ('error' in result) {
      reply.code(result.status);
      return { error: result.error };
    }
    for (const slug of result.rooms) {
      ctx.fanOutMembership(slug, master.username, [username]);
    }
    request.log.info({ event: 'guest_admit', user: master.username, guest: username }, 'guest admitted');
    return { ok: true, rooms: result.rooms };
  });

  fastify.post('/guests/:username/remove', async (request, reply) => {
    const master = requireMaster(request, reply);
    if (!master) {
      return { error: reply.statusCode === 403 ? 'forbidden' : 'authentication required' };
    }
    const username = String((request.params as { username?: string }).username || '').trim().toLowerCase();
    const status = guestStatus(username);
    if (status !== 'waiting' && status !== 'admitted') {
      reply.code(404);
      return { error: 'guest not found' };
    }
    deleteSessionsForUser(username);
    retireGuestAccount(username);
    request.log.info({ event: 'guest_remove', user: master.username, guest: username }, 'guest removed');
    return { ok: true };
  });
}
