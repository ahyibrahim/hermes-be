import { FastifyInstance, FastifyRequest } from 'fastify';
import {
  createMessage,
  isRoomMember,
  listMessages,
  unsendMessage,
} from '../db';
import {
  getUserByUsername,
  historyAfterId,
  markRoomRead,
  revealRoomMembers,
} from '../rooms';
import { can } from '../authz';
import { findSession } from '../sessions';
import { extractToken, normalizeRoomSlug, resolveUser, RouteContext } from './common';
import {
  createMessageSchema,
  deleteMessageParamSchema,
  formatZodError,
  listMessagesQuerySchema,
} from '../schemas';

export async function messageRoutes(fastify: FastifyInstance, ctx: RouteContext): Promise<void> {
  fastify.get(
    '/messages',
    async (
      request: FastifyRequest<{ Querystring: { room?: string; before?: string; limit?: string } }>,
      reply
    ) => {
    const parsed = listMessagesQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      reply.code(400);
      return { error: formatZodError(parsed.error) };
    }

    const slug = normalizeRoomSlug(parsed.data.room ?? 'general');
    if (!slug) {
      reply.code(403);
      return { error: 'room must be a slug, not a numeric id' };
    }

    const username = resolveUser(request, reply);
    if (!username) {
      return { error: 'authentication required' };
    }

    if (!isRoomMember(slug, username)) {
      reply.code(403);
      return { error: 'not a member of this room' };
    }

    const me = getUserByUsername(username);
    if (me) {
      markRoomRead(me.id, slug);
    }

    return listMessages(slug, parsed.data.before, parsed.data.limit, historyAfterId(slug, username));
  });

  fastify.post('/messages', async (request, reply) => {
    const rawBody = request.body as { room?: unknown; content?: unknown } | undefined;
    if (!rawBody?.room || typeof rawBody.content !== 'string' || !rawBody.content.trim()) {
      reply.code(400);
      return { error: 'room and content are required' };
    }

    const parsed = createMessageSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: formatZodError(parsed.error) };
    }

    const body = parsed.data;
    const slug = normalizeRoomSlug(body.room);
    if (!slug) {
      reply.code(403);
      return { error: 'room must be a slug, not a numeric id' };
    }

    const token = extractToken(request);
    if (!token) {
      reply.code(401);
      return { error: 'authentication required' };
    }

    const session = findSession(token);
    if (!session || session.scope !== 'member') {
      reply.code(401);
      return { error: session ? 'authentication required' : 'invalid token' };
    }
    const username = session.username;

    if (!isRoomMember(slug, username)) {
      reply.code(403);
      return { error: 'not a member of this room' };
    }

    revealRoomMembers(slug);
    const message = createMessage(slug, username, body.content.trim());
    ctx.broadcastToMembers(slug, { type: 'message', message });
    return message;
  });

  fastify.delete('/messages/:id', async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const username = resolveUser(request, reply);
    if (!username) {
      return { error: 'authentication required' };
    }

    const parsed = deleteMessageParamSchema.safeParse(request.params);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'id is required' };
    }

    const id = parsed.data.id;
    const actor = getUserByUsername(username);
    const session = findSession(extractToken(request));
    const asAdmin = Boolean(
      actor && session && can({ ...actor, scope: session.scope }, 'message.admin_delete')
    );
    const result = unsendMessage(id, username, { asAdmin });
    if ('error' in result) {
      reply.code(404);
      return { error: 'message not found' };
    }

    ctx.broadcastToMembers(result.message.room, { type: 'message_deleted', message: result.message });
    return result.message;
  });
}
