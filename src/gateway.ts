import Fastify, { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import websocket from '@fastify/websocket';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { buildContentDisposition } from './content-disposition';
import { createFileRecord, createMessage, getFileRecord, isRoomMember, listMessages } from './db';
import { sniffInlineImageFile, UPLOAD_RESPONSE_HEADERS } from './file-type';
import { guestStatus } from './guests';
import { GUEST_SESSION_TTL_MS, isGatewayOpen, redeemInvite } from './invites';
import { buildLoggerConfig, type LogDestination } from './logger';
import {
  authRateLimitConfig,
  FILE_SIZE_LIMIT,
  GUEST_COOKIE,
  normalizeRoomSlug,
  perUserRateLimit,
  readCookie,
  RouteContext,
} from './routes/common';
import { getDb } from './database';
import { getUserByUsername, historyAfterId, lastMessagePreview, listRoomsForUser, unreadCount } from './rooms';
import { findSession } from './sessions';
import { registerSecurityHeaders } from './security-headers';
import { WS_MAX_PAYLOAD_BYTES } from './ws/limits';
import { registerWsHandler } from './ws/handler';
import { createMessageSchema, fileIdParamSchema, formatZodError, listMessagesQuerySchema } from './schemas';
import { z } from 'zod';

const GATEWAY_API_PREFIXES = ['/me', '/rooms', '/messages', '/files', '/ws'];

const joinSchema = z.object({
  token: z.string().trim().min(20).max(512),
  username: z.string().trim().min(1).max(64),
});

export function gatewayPort(): number {
  const raw = process.env.HERMES_GATEWAY_PORT?.trim();
  if (raw) {
    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed > 0 && parsed < 65536) {
      return parsed;
    }
  }
  const main = Number(process.env.PORT ?? 3000);
  const base = Number.isInteger(main) && main > 0 ? main : 3000;
  return base + 10;
}

function guestCookie(token: string): string {
  const maxAge = Math.floor(GUEST_SESSION_TTL_MS / 1000);
  return `${GUEST_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
}

function requireGuest(
  request: FastifyRequest,
  reply: FastifyReply
): { username: string; status: 'waiting' | 'admitted' } | null {
  const token = readCookie(request.headers.cookie, GUEST_COOKIE);
  const session = findSession(token);
  if (!session || session.scope !== 'guest') {
    reply.code(401);
    return null;
  }
  const status = guestStatus(session.username);
  if (status !== 'waiting' && status !== 'admitted') {
    reply.code(401);
    return null;
  }
  return { username: session.username, status };
}

function isGatewayApi(url: string): boolean {
  const pathname = url.split('?')[0] || '/';
  return GATEWAY_API_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

async function serveWebBundle(fastify: FastifyInstance): Promise<void> {
  const raw = process.env.HERMES_WEB_DIR;
  if (raw === undefined || raw.trim() === '') {
    return;
  }
  const webDir = path.resolve(raw.trim());
  try {
    if (!fs.statSync(webDir).isDirectory()) {
      return;
    }
  } catch {
    return;
  }

  await fastify.register(fastifyStatic, {
    root: webDir,
    prefix: '/',
  });

  fastify.setNotFoundHandler((request, reply) => {
    const accept = request.headers.accept;
    const document = request.method === 'GET' && typeof accept === 'string' && accept.includes('text/html');
    if (document && !isGatewayApi(request.url)) {
      return reply.sendFile('index.html');
    }
    reply.code(404);
    return { error: 'Not Found' };
  });
}

export async function createGateway(
  ctx: RouteContext,
  options: { loggerDestination?: LogDestination; logLevel?: string } = {}
): Promise<FastifyInstance> {
  const gateway = Fastify({
    logger: buildLoggerConfig({
      destination: options.loggerDestination,
      level: options.logLevel,
    }),
    trustProxy: ['127.0.0.1', '::1'],
    genReqId: () => crypto.randomUUID(),
    requestIdHeader: 'x-request-id',
  });

  gateway.addHook('onRequest', async (_request, reply) => {
    if (!isGatewayOpen()) {
      return reply.code(404).send({ error: 'Not Found' });
    }
  });

  registerSecurityHeaders(gateway);
  await gateway.register(websocket, { options: { maxPayload: WS_MAX_PAYLOAD_BYTES } });
  await gateway.register(multipart, { limits: { fileSize: FILE_SIZE_LIMIT } });
  await gateway.register(rateLimit, { global: false, ...authRateLimitConfig() });

  gateway.post('/join', { config: { rateLimit: authRateLimitConfig() } }, async (request, reply) => {
    const parsed = joinSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'name and token are required' };
    }
    const result = await redeemInvite(parsed.data.token, parsed.data.username);
    if ('error' in result) {
      reply.code(result.status);
      return { error: result.error };
    }
    reply.header('Set-Cookie', guestCookie(result.session.token));
    return {
      user: {
        username: result.session.username,
        displayName: result.displayName,
        role: 'guest',
        status: 'waiting',
      },
    };
  });

  gateway.get('/me', async (request, reply) => {
    const guest = requireGuest(request, reply);
    if (!guest) {
      return { error: 'authentication required' };
    }
    const profile = getUserByUsername(guest.username);
    return {
      user: {
        username: guest.username,
        displayName: profile?.display_name || guest.username,
        role: 'guest',
        status: guest.status,
        color: profile?.color ?? null,
      },
      rooms: guest.status === 'admitted' ? roomsFor(guest.username) : [],
    };
  });

  gateway.get('/rooms', async (request, reply) => {
    const guest = requireGuest(request, reply);
    if (!guest) {
      return { error: 'authentication required' };
    }
    if (guest.status !== 'admitted') {
      return [];
    }
    return roomsFor(guest.username);
  });

  gateway.get('/messages', async (request, reply) => {
    const guest = requireGuest(request, reply);
    if (!guest) {
      return { error: 'authentication required' };
    }
    const parsed = listMessagesQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      reply.code(400);
      return { error: formatZodError(parsed.error) };
    }
    const slug = normalizeRoomSlug(parsed.data.room ?? '');
    if (!slug || !isRoomMember(slug, guest.username) || guest.status !== 'admitted') {
      reply.code(403);
      return { error: 'not a member of this room' };
    }
    const page = listMessages(slug, parsed.data.before, parsed.data.limit, historyAfterId(slug, guest.username));
    return {
      ...page,
      messages: page.messages.map((message) => ({
        ...message,
        sender_name: getUserByUsername(message.sender)?.display_name || message.sender,
      })),
    };
  });

  gateway.post('/messages', async (request, reply) => {
    const guest = requireGuest(request, reply);
    if (!guest) {
      return { error: 'authentication required' };
    }
    const parsed = createMessageSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'room and content are required' };
    }
    const slug = normalizeRoomSlug(parsed.data.room);
    if (!slug || guest.status !== 'admitted' || !isRoomMember(slug, guest.username)) {
      reply.code(403);
      return { error: 'not a member of this room' };
    }
    const message = createMessage(slug, guest.username, parsed.data.content.trim());
    ctx.broadcastToMembers(slug, { type: 'message', message });
    return message;
  });

  gateway.post('/files', { config: { rateLimit: perUserRateLimit(20) } }, async (request, reply) => {
    const guest = requireGuest(request, reply);
    if (!guest) {
      return { error: 'authentication required' };
    }
    const data = await request.file();
    if (!data) {
      reply.code(400);
      return { error: 'file is required' };
    }
    const roomField = data.fields.room as { value?: string } | undefined;
    const slug = normalizeRoomSlug(roomField?.value);
    if (!slug || guest.status !== 'admitted' || !isRoomMember(slug, guest.username)) {
      reply.code(403);
      data.file.resume();
      return { error: 'not a member of this room' };
    }
    const storedName = crypto.randomUUID();
    const storedPath = path.join(ctx.filesDir, storedName);
    let committed = false;
    try {
      await pipeline(data.file, fs.createWriteStream(storedPath));
      if (data.file.truncated) {
        reply.code(413);
        return { error: 'file too large' };
      }
      const size = fs.statSync(storedPath).size;
      const file = createFileRecord(
        slug,
        guest.username,
        data.filename || 'upload',
        data.mimetype || 'application/octet-stream',
        size,
        storedPath
      );
      committed = true;
      const message = createMessage(slug, guest.username, file.original_name, file.id);
      ctx.broadcastToMembers(slug, { type: 'message', message });
      return {
        file: {
          id: file.id,
          room: file.room,
          uploader: file.uploader,
          original_name: file.original_name,
          mime: file.mime,
          size: file.size,
          created_at: file.created_at,
        },
        message,
      };
    } finally {
      if (!committed) {
        fs.rmSync(storedPath, { force: true });
      }
    }
  });

  gateway.get('/files/:id', async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const guest = requireGuest(request, reply);
    if (!guest) {
      return { error: 'authentication required' };
    }
    const parsed = fileIdParamSchema.safeParse(request.params);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'invalid file id' };
    }
    const file = getFileRecord(parsed.data.id);
    if (!file || guest.status !== 'admitted' || !isRoomMember(file.room, guest.username)) {
      reply.code(404);
      return { error: 'file not found' };
    }
    const after = historyAfterId(file.room, guest.username);
    if (after != null) {
      const visible = getVisibleFile(file.id, file.room, after);
      if (!visible) {
        reply.code(404);
        return { error: 'file not found' };
      }
    }
    if (!fs.existsSync(file.path)) {
      reply.code(404);
      return { error: 'file not found' };
    }
    const image = sniffInlineImageFile(file.path);
    reply.headers(UPLOAD_RESPONSE_HEADERS);
    reply.header('Content-Type', image ?? 'application/octet-stream');
    reply.header(
      'Content-Disposition',
      buildContentDisposition(image ? 'inline' : 'attachment', file.original_name)
    );
    return reply.send(fs.createReadStream(file.path));
  });

  await registerWsHandler(gateway, ctx, { audience: 'guest' });
  await serveWebBundle(gateway);
  return gateway;
}

function roomsFor(username: string) {
  const user = getUserByUsername(username);
  return listRoomsForUser(username).map((room) => {
    const after = historyAfterId(room.slug, username);
    return {
      id: room.id,
      slug: room.slug,
      name: room.name,
      type: room.type,
      created_at: room.created_at,
      creator_id: room.creator_id,
      members: room.members,
      unread_count: user ? unreadCount(user.id, room.slug, after) : 0,
      last_message: lastMessagePreview(room.slug, after),
    };
  });
}

function getVisibleFile(fileId: number, room: string, afterId: number): boolean {
  const row = getDb()
    .prepare('SELECT 1 AS ok FROM messages WHERE file_id = ? AND room = ? AND id > ?')
    .get(fileId, room, afterId) as { ok: number } | undefined;
  return Boolean(row);
}
