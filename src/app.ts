import './runtime-compat';
import Fastify, { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import websocket from '@fastify/websocket';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import crypto from 'node:crypto';
import {
  addRoomMember,
  createFileRecord,
  createMessage,
  ensureRoom,
  getFileRecord,
  isRoomMember,
  listMessages,
  listRoomMembers,
} from './db';
import {
  addUserToGeneralRoom,
  createGroupRoom,
  getOrCreateDmRoom,
  getUserByUsername,
  listRoomsForUser,
  listUsers,
} from './rooms';
import { loginUser, registerUser } from './auth';
import { getDb } from './database';
import { deleteSession, findSessionUser } from './sessions';
import { buildInfo } from './build-info';
import { buildLoggerConfig, type LogDestination } from './logger';

type RoomSocket = {
  socket: { readyState: number; send: (data: string) => void; ping?: () => void; terminate?: () => void };
  room: string;
  user: string;
};

const WS_OPEN = 1;
const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 60_000;
const FILE_SIZE_LIMIT = 25 * 1024 * 1024;

const filesDir = process.env.HERMES_FILES_DIR
  ? path.resolve(process.env.HERMES_FILES_DIR)
  : path.resolve(process.cwd(), 'data', 'files');

// Exact prefixes of the REST/WS surface. `/rooms-ui` is a client route and
// must not match `/rooms`. Trailing-slash and nested paths (`/files/1`) do.
const API_PATH_PREFIXES = ['/health', '/auth', '/rooms', '/messages', '/files', '/ws', '/users'];

function isApiRequestPath(url: string): boolean {
  const pathname = url.split('?')[0] || '/';
  return API_PATH_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );
}

function isDocumentNavigation(request: FastifyRequest): boolean {
  if (request.method !== 'GET') {
    return false;
  }
  const accept = request.headers.accept;
  return typeof accept === 'string' && accept.includes('text/html');
}

async function maybeServeWebBundle(fastify: FastifyInstance): Promise<void> {
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
    if (isDocumentNavigation(request) && !isApiRequestPath(request.url)) {
      return reply.sendFile('index.html');
    }
    reply.code(404);
    return { error: 'Not Found' };
  });
}

function sendJson(socket: { readyState?: number; send: (data: string) => void }, payload: unknown): boolean {
  try {
    socket.send(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

function errorFrame(content: string) {
  return { type: 'error', content, message: content };
}

function extractBearer(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) {
    return header.slice(7).trim() || undefined;
  }
  return undefined;
}

function extractToken(request: FastifyRequest): string | undefined {
  const bearer = extractBearer(request);
  if (bearer) {
    return bearer;
  }

  const query = request.query as { token?: string };
  if (typeof query?.token === 'string' && query.token.trim()) {
    return query.token.trim();
  }

  const body = request.body as { token?: string } | undefined;
  if (body && typeof body.token === 'string' && body.token.trim()) {
    return body.token.trim();
  }

  return undefined;
}

export function isNumericRoom(room: string): boolean {
  return /^\d+$/.test(room);
}

export function normalizeRoomSlug(room: string | undefined): string | null {
  if (!room || typeof room !== 'string') {
    return null;
  }

  const slug = room.trim().toLowerCase();
  if (!slug || isNumericRoom(slug)) {
    return null;
  }

  return slug;
}

function unwrapSocket(connection: unknown): any {
  const conn = connection as { send?: unknown; on?: unknown; socket?: { send?: unknown; on?: unknown } };
  if (typeof conn?.send === 'function' && typeof conn?.on === 'function') {
    return conn;
  }

  if (typeof conn?.socket?.send === 'function' && typeof conn?.socket?.on === 'function') {
    return conn.socket;
  }

  return connection;
}

export type CreateAppOptions = {
  loggerDestination?: LogDestination;
  logLevel?: string;
};

export async function createApp(options: CreateAppOptions = {}): Promise<{
  app: FastifyInstance;
  roomClients: Map<string, Set<RoomSocket>>;
}> {
  const fastify = Fastify({
    logger: buildLoggerConfig({
      destination: options.loggerDestination,
      level: options.logLevel,
    }),
    genReqId: () => crypto.randomUUID(),
    requestIdHeader: 'x-request-id',
    requestIdLogLabel: 'reqId',
  });
  const roomClients = new Map<string, Set<RoomSocket>>();
  const lastPong = new WeakMap<object, number>();

  getDb({
    info(obj, msg) {
      fastify.log.info(obj, msg ?? '');
    },
  });

  fastify.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
    const statusCode = error.statusCode ?? 500;
    const payload = { err: error, event: 'request_error', statusCode };
    if (statusCode >= 500) {
      request.log.error(payload, error.message);
    } else {
      request.log.info(payload, error.message);
    }
    return reply.status(statusCode).send(error);
  });

  function connectedUsers(room: string): string[] {
    const clients = roomClients.get(room);
    if (!clients) {
      return [];
    }

    return [...new Set([...clients].map((client) => client.user))].sort((a, b) => a.localeCompare(b));
  }

  function dropClient(client: RoomSocket): void {
    const clients = roomClients.get(client.room);
    if (!clients) {
      return;
    }

    clients.delete(client);
    try {
      client.socket.terminate?.();
    } catch {
      // already closed
    }
  }

  function broadcastToRoom(room: string, payload: unknown, exceptSocket?: unknown): void {
    const clients = roomClients.get(room);
    if (!clients) {
      return;
    }

    for (const client of [...clients]) {
      if (exceptSocket && client.socket === exceptSocket) {
        continue;
      }

      if (client.socket.readyState !== undefined && client.socket.readyState !== WS_OPEN) {
        clients.delete(client);
        continue;
      }

      if (!sendJson(client.socket, payload)) {
        clients.delete(client);
      }
    }
  }

  function resolveUser(request: FastifyRequest, reply: FastifyReply): string | null {
    const token = extractToken(request);
    if (!token) {
      reply.code(401);
      return null;
    }

    const username = findSessionUser(token);
    if (!username) {
      reply.code(401);
      return null;
    }

    return username;
  }

  await fastify.register(websocket);
  await fastify.register(multipart, { limits: { fileSize: FILE_SIZE_LIMIT } });

  if (!fs.existsSync(filesDir)) {
    fs.mkdirSync(filesDir, { recursive: true });
  }

  fastify.get('/health', async () => {
    const { version, commit } = buildInfo();
    return {
      status: 'ok',
      service: 'hermes-be',
      message: 'Backend is running',
      version,
      commit,
    };
  });

  fastify.post('/auth/register', async (request, reply) => {
    const body = request.body as { username?: string; password?: string };

    if (!body.username || !body.password) {
      reply.code(400);
      return { error: 'username and password are required' };
    }

    try {
      const user = registerUser(body.username, body.password);
      addUserToGeneralRoom(user.id);
      return { user: { id: user.id, username: user.username } };
    } catch (error) {
      reply.code(409);
      return { error: (error as Error).message };
    }
  });

  fastify.post('/auth/login', async (request, reply) => {
    const body = request.body as { username?: string; password?: string };

    if (!body.username || !body.password) {
      reply.code(400);
      return { error: 'username and password are required' };
    }

    const session = loginUser(body.username, body.password);
    if (!session) {
      request.log.info(
        { event: 'login_failure', username: body.username.trim().toLowerCase() },
        'login failed'
      );
      reply.code(401);
      return { error: 'invalid credentials' };
    }

    request.log.info({ event: 'login_success', username: session.username }, 'login succeeded');
    return session;
  });

  fastify.post('/auth/logout', async (request, reply) => {
    const username = resolveUser(request, reply);
    if (!username) {
      return { error: 'authentication required' };
    }

    deleteSession(extractToken(request));
    request.log.info({ event: 'logout', username }, 'logged out');
    return { ok: true };
  });

  fastify.get('/users', async (request, reply) => {
    const username = resolveUser(request, reply);
    if (!username) {
      return { error: 'authentication required' };
    }

    return listUsers();
  });

  fastify.get('/users/online', async (request, reply) => {
    const username = resolveUser(request, reply);
    if (!username) {
      return { error: 'authentication required' };
    }

    const online = new Set<string>();
    for (const clients of roomClients.values()) {
      for (const client of clients) {
        online.add(client.user);
      }
    }
    return [...online].sort((a, b) => a.localeCompare(b));
  });

  fastify.get('/rooms', async (request, reply) => {
    const username = resolveUser(request, reply);
    if (!username) {
      return { error: 'authentication required' };
    }

    return listRoomsForUser(username).map((room) => {
      const connected = connectedUsers(room.slug);
      const members = [...new Set([...connected, ...room.members])].sort((a, b) => a.localeCompare(b));
      return {
        id: room.id,
        slug: room.slug,
        name: room.name,
        type: room.type,
        created_at: room.created_at,
        members,
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

    const body = request.body as { name?: string; members?: unknown };
    if (!body.name || typeof body.name !== 'string' || !body.name.trim()) {
      reply.code(400);
      return { error: 'name is required' };
    }

    const memberIds = Array.isArray(body.members)
      ? body.members.filter((id): id is number => typeof id === 'number' && Number.isInteger(id))
      : [];

    const room = createGroupRoom(body.name, me.id, memberIds);
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

    const body = request.body as { userId?: unknown };
    if (typeof body.userId !== 'number' || !Number.isInteger(body.userId)) {
      reply.code(400);
      return { error: 'userId is required' };
    }

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

  fastify.get('/messages', async (request: FastifyRequest<{ Querystring: { room?: string } }>, reply) => {
    const slug = normalizeRoomSlug(request.query.room ?? 'general');
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

    return listMessages(slug);
  });

  fastify.post('/messages', async (request, reply) => {
    const body = request.body as { room?: string; sender?: string; content?: string; token?: string };

    if (!body.room || typeof body.content !== 'string' || !body.content.trim()) {
      reply.code(400);
      return { error: 'room and content are required' };
    }

    const slug = normalizeRoomSlug(body.room);
    if (!slug) {
      reply.code(403);
      return { error: 'room must be a slug, not a numeric id' };
    }

    const token = extractToken(request);
    let username: string | undefined;
    if (token) {
      username = findSessionUser(token) ?? undefined;
      if (!username) {
        reply.code(401);
        return { error: 'invalid token' };
      }
    } else if (body.sender) {
      username = body.sender;
    }

    if (!username) {
      reply.code(401);
      return { error: 'authentication required' };
    }

    addRoomMember(slug, username);
    const message = createMessage(slug, username, body.content.trim());
    broadcastToRoom(slug, { type: 'message', message });
    return message;
  });

  fastify.post('/files', async (request, reply) => {
    const username = resolveUser(request, reply);
    if (!username) {
      return { error: 'authentication required' };
    }

    const data = await request.file();
    if (!data) {
      reply.code(400);
      return { error: 'file is required' };
    }

    const roomField = data.fields.room as { value?: string } | undefined;
    const slug = normalizeRoomSlug(roomField?.value);
    if (!slug) {
      reply.code(403);
      data.file.resume();
      return { error: 'room must be a slug, not a numeric id' };
    }

    addRoomMember(slug, username);
    const storedName = `${crypto.randomUUID()}`;
    const storedPath = path.join(filesDir, storedName);
    await pipeline(data.file, fs.createWriteStream(storedPath));

    if (data.file.truncated) {
      fs.rmSync(storedPath, { force: true });
      reply.code(413);
      return { error: 'file too large' };
    }

    const size = fs.statSync(storedPath).size;
    const file = createFileRecord(
      slug,
      username,
      data.filename || 'upload',
      data.mimetype || 'application/octet-stream',
      size,
      storedPath
    );
    const message = createMessage(slug, username, file.original_name, file.id);
    broadcastToRoom(slug, { type: 'message', message });
    request.log.info(
      {
        event: 'file_upload',
        id: file.id,
        uploader: username,
        size: file.size,
        mime: file.mime,
        room: slug,
      },
      'file uploaded'
    );

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
  });

  fastify.get('/files/:id', async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const username = resolveUser(request, reply);
    if (!username) {
      return { error: 'authentication required' };
    }

    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      reply.code(400);
      return { error: 'invalid file id' };
    }

    const file = getFileRecord(id);
    if (!file) {
      reply.code(404);
      return { error: 'file not found' };
    }

    if (!isRoomMember(file.room, username)) {
      reply.code(403);
      return { error: 'not a member of this room' };
    }

    if (!fs.existsSync(file.path)) {
      reply.code(404);
      return { error: 'file not found' };
    }

    reply.header('Content-Type', file.mime);
    reply.header('Content-Disposition', `attachment; filename="${file.original_name.replace(/"/g, '')}"`);
    return reply.send(fs.createReadStream(file.path));
  });

  fastify.get(
    '/ws',
    {
      websocket: true,
      preHandler: async (request, reply) => {
        const token = extractBearer(request) ?? (request.query as { token?: string }).token;
        if (typeof token === 'string' && token.trim()) {
          const username = findSessionUser(token);
          if (!username) {
            request.log.info(
              { event: 'ws_unauthorized', reason: 'invalid_token' },
              'websocket handshake rejected'
            );
            return reply.code(401).send({ error: 'authentication required' });
          }
          (request as FastifyRequest & { username: string }).username = username;
          return;
        }

        // Handshake token is the contract. Until the CLI sends ?token=, it may still
        // pass { token } on join_room after an unauthenticated upgrade is rejected.
        request.log.info(
          { event: 'ws_unauthorized', reason: 'missing_token' },
          'websocket handshake rejected'
        );
        return reply.code(401).send({ error: 'authentication required' });
      },
    },
    (connection: unknown, request: FastifyRequest) => {
      const socket = unwrapSocket(connection);
      let room: string | null = null;
      let user = (request as FastifyRequest & { username?: string }).username ?? '';
      let client: RoomSocket | null = null;

      lastPong.set(socket, Date.now());
      if (user) {
        request.log.info({ event: 'ws_connect', user }, 'websocket connected');
      }

      const leaveCurrentRoom = () => {
        if (!client || !room) {
          return;
        }

        const leftRoom = room;
        const leftUser = user;
        const clients = roomClients.get(leftRoom);
        clients?.delete(client);
        client = null;
        room = null;

        broadcastToRoom(leftRoom, { type: 'user_left', room: leftRoom, user: leftUser });
      };

      const requireUser = (): boolean => {
        if (user) {
          return true;
        }
        sendJson(socket, errorFrame('authentication required'));
        return false;
      };

      if (user) {
        sendJson(socket, { type: 'connected', user });
      }

      socket.on('pong', () => {
        lastPong.set(socket, Date.now());
      });

      socket.on('message', (raw: Buffer | string) => {
        try {
          const payload = JSON.parse(raw.toString());

          if (payload.type === 'join_room') {
            if (!user) {
              const joinToken = typeof payload.token === 'string' ? payload.token.trim() : '';
              const username = joinToken ? findSessionUser(joinToken) : null;
              if (!username) {
                sendJson(socket, errorFrame('authentication required'));
                socket.close?.();
                return;
              }
              user = username;
              sendJson(socket, { type: 'connected', user });
              request.log.info({ event: 'ws_connect', user }, 'websocket connected');
            }

            const slug = normalizeRoomSlug(payload.room);
            if (!slug) {
              sendJson(socket, errorFrame('room must be a slug, not a numeric id'));
              return;
            }

            ensureRoom(slug);
            addRoomMember(slug, user);

            if (room && client) {
              leaveCurrentRoom();
            }

            room = slug;
            if (!roomClients.has(room)) {
              roomClients.set(room, new Set());
            }

            client = { socket, room, user };
            roomClients.get(room)?.add(client);

            sendJson(socket, { type: 'joined_room', room });
            sendJson(socket, { type: 'room_users', room, users: connectedUsers(room) });
            broadcastToRoom(room, { type: 'user_joined', room, user }, socket);
            request.log.info({ event: 'room_join', user, room }, 'joined room');
            return;
          }

          if (payload.type === 'send_message') {
            if (!requireUser()) {
              return;
            }

            // Persist path is POST /messages. Ignore WS send to avoid duplicate rows
            // while the CLI still sends both.
            return;
          }

          sendJson(socket, errorFrame('unknown message type'));
        } catch (error) {
          request.log.warn(
            { err: error, event: 'ws_error', user, room: room ?? undefined },
            'websocket message handler failed'
          );
          const content =
            error instanceof SyntaxError ? 'Invalid message payload' : (error as Error).message;
          sendJson(socket, errorFrame(content));
        }
      });

      socket.on('error', (error: Error) => {
        request.log.error(
          { err: error, event: 'ws_error', user, room: room ?? undefined },
          'websocket error'
        );
        leaveCurrentRoom();
      });

      socket.on('close', () => {
        request.log.info(
          { event: 'ws_disconnect', user, room: room ?? undefined },
          'websocket disconnected'
        );
        leaveCurrentRoom();
      });
    }
  );

  await maybeServeWebBundle(fastify);

  const pingTimer = setInterval(() => {
    const now = Date.now();
    for (const clients of roomClients.values()) {
      for (const client of [...clients]) {
        const seen = lastPong.get(client.socket) ?? 0;
        if (now - seen > PONG_TIMEOUT_MS) {
          dropClient(client);
          continue;
        }

        try {
          client.socket.ping?.();
        } catch {
          dropClient(client);
        }
      }
    }
  }, PING_INTERVAL_MS);

  pingTimer.unref();
  fastify.addHook('onClose', async () => {
    clearInterval(pingTimer);
  });

  return { app: fastify, roomClients };
}
