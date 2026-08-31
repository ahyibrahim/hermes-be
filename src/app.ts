import './runtime-compat';
import Fastify, { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import websocket from '@fastify/websocket';
import multipart from '@fastify/multipart';
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
  listRooms,
} from './db';
import { loginUser, registerUser } from './auth';

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

export async function createApp(): Promise<{
  app: FastifyInstance;
  userTokens: Map<string, string>;
  roomClients: Map<string, Set<RoomSocket>>;
}> {
  const fastify = Fastify({ logger: false });
  const userTokens = new Map<string, string>();
  const roomClients = new Map<string, Set<RoomSocket>>();
  const lastPong = new WeakMap<object, number>();

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

    const username = userTokens.get(token);
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

  fastify.get('/health', async () => ({
    status: 'ok',
    service: 'hermes-be',
    message: 'Backend is running',
  }));

  fastify.post('/auth/register', async (request, reply) => {
    const body = request.body as { username?: string; password?: string };

    if (!body.username || !body.password) {
      reply.code(400);
      return { error: 'username and password are required' };
    }

    try {
      const user = registerUser(body.username, body.password);
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
      reply.code(401);
      return { error: 'invalid credentials' };
    }

    userTokens.set(session.token, session.username);
    return session;
  });

  fastify.get('/rooms', async (request, reply) => {
    const username = resolveUser(request, reply);
    if (!username) {
      return { error: 'authentication required' };
    }

    return listRooms().map((room) => {
      const connected = connectedUsers(room.slug);
      const stored = listRoomMembers(room.slug);
      const members = [...new Set([...connected, ...stored])].sort((a, b) => a.localeCompare(b));
      return {
        id: room.id,
        slug: room.slug,
        name: room.name,
        created_at: room.created_at,
        members,
      };
    });
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

    if (!body.room || !body.content) {
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
      username = userTokens.get(token);
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
    const message = createMessage(slug, username, body.content);
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
          const username = userTokens.get(token.trim());
          if (!username) {
            return reply.code(401).send({ error: 'authentication required' });
          }
          (request as FastifyRequest & { username: string }).username = username;
          return;
        }

        // Handshake token is the contract. Until the CLI sends ?token=, it may still
        // pass { token } on join_room after an unauthenticated upgrade is rejected.
        return reply.code(401).send({ error: 'authentication required' });
      },
    },
    (connection: unknown, request: FastifyRequest) => {
      const socket = unwrapSocket(connection);
      let room: string | null = null;
      let user = (request as FastifyRequest & { username?: string }).username ?? '';
      let client: RoomSocket | null = null;

      lastPong.set(socket, Date.now());

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
              const username = joinToken ? userTokens.get(joinToken) : undefined;
              if (!username) {
                sendJson(socket, errorFrame('authentication required'));
                socket.close?.();
                return;
              }
              user = username;
              sendJson(socket, { type: 'connected', user });
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
          const content =
            error instanceof SyntaxError ? 'Invalid message payload' : (error as Error).message;
          sendJson(socket, errorFrame(content));
        }
      });

      socket.on('error', () => {
        leaveCurrentRoom();
      });

      socket.on('close', () => {
        leaveCurrentRoom();
      });
    }
  );

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

  return { app: fastify, userTokens, roomClients };
}
