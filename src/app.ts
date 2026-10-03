import './runtime-compat';
import Fastify, { FastifyInstance, FastifyRequest } from 'fastify';
import websocket from '@fastify/websocket';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { listRoomMembers } from './db';
import { getDb } from './database';
import { buildInfo } from './build-info';
import { buildLoggerConfig, type LogDestination } from './logger';
import { createLinkPreviewService, type LinkPreviewService } from './link-preview';
import {
  authRateLimitConfig,
  DEFAULT_CALL_ALONE_TIMEOUT_MS,
  DEFAULT_ICE_SERVERS,
  DEFAULT_TYPING_TIMEOUT_MS,
  DEFAULT_WATCH_ALONE_TIMEOUT_MS,
  FILE_SIZE_LIMIT,
  isNumericRoom,
  normalizeRoomSlug,
  parseIceServers,
  RoomSocket,
  RouteContext,
  sendJson,
  TrackedSocket,
  WS_OPEN,
} from './routes/common';
import { authRoutes } from './routes/auth';
import { roomRoutes } from './routes/rooms';
import { messageRoutes } from './routes/messages';
import { fileRoutes } from './routes/files';
import { previewRoutes } from './routes/preview';
import { createCallState } from './routes/calls';
import { registerWsHandler } from './ws/handler';
import { WS_MAX_PAYLOAD_BYTES } from './ws/limits';
import { registerSecurityHeaders } from './security-headers';

export {
  DEFAULT_CALL_ALONE_TIMEOUT_MS,
  DEFAULT_ICE_SERVERS,
  DEFAULT_TYPING_TIMEOUT_MS,
  DEFAULT_WATCH_ALONE_TIMEOUT_MS,
  isNumericRoom,
  normalizeRoomSlug,
  parseIceServers,
};

const API_PATH_PREFIXES = ['/health', '/auth', '/rooms', '/messages', '/files', '/ws', '/users', '/ice'];

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

export type CreateAppOptions = {
  loggerDestination?: LogDestination;
  logLevel?: string;
  callAloneTimeoutMs?: number;
  watchAloneTimeoutMs?: number;
  typingTimeoutMs?: number;
  linkPreview?: LinkPreviewService;
};

export async function createApp(options: CreateAppOptions = {}): Promise<{
  app: FastifyInstance;
  roomClients: Map<string, Set<RoomSocket>>;
  callMembers: Map<string, Set<string>>;
}> {
  const linkPreview = options.linkPreview ?? createLinkPreviewService();
  const fastify = Fastify({
    logger: buildLoggerConfig({
      destination: options.loggerDestination,
      level: options.logLevel,
    }),
    // Tailscale Serve connects from loopback and sets X-Forwarded-For. Trust it
    // from there only, so request.ip (and the rate-limit key) is the real
    // client rather than 127.0.0.1 for everyone.
    trustProxy: ['127.0.0.1', '::1'],
    genReqId: () => crypto.randomUUID(),
    requestIdHeader: 'x-request-id',
  });

  const filesDir = process.env.HERMES_FILES_DIR
    ? path.resolve(process.env.HERMES_FILES_DIR)
    : path.resolve(process.cwd(), 'data', 'files');

  const roomClients = new Map<string, Set<RoomSocket>>();
  const userSockets = new Map<string, Set<TrackedSocket>>();

  const callState = createCallState(fastify, {
    callAloneTimeoutMs: options.callAloneTimeoutMs,
    watchAloneTimeoutMs: options.watchAloneTimeoutMs,
    typingTimeoutMs: options.typingTimeoutMs,
  });

  getDb({
    info(obj, msg) {
      fastify.log.info(obj, msg ?? '');
    },
  });

  function connectedUsers(room: string): string[] {
    const clients = roomClients.get(room);
    if (!clients) {
      return [];
    }
    return [...new Set([...clients].map((client) => client.user))].sort((a, b) => a.localeCompare(b));
  }

  function onlineUsernames(): string[] {
    return [...userSockets.keys()].sort((a, b) => a.localeCompare(b));
  }

  function closeUserSockets(
    username: string,
    filter?: { onlyHash?: string; exceptHash?: string }
  ): void {
    const sockets = userSockets.get(username);
    if (!sockets) {
      return;
    }
    for (const entry of [...sockets]) {
      if (filter?.onlyHash && entry.sessionHash !== filter.onlyHash) {
        continue;
      }
      if (filter?.exceptHash && entry.sessionHash === filter.exceptHash) {
        continue;
      }
      try {
        // 4001 is an application close: the client must not reconnect with this token.
        entry.socket.close?.(4001, 'session ended');
      } catch {
        // already closed
      }
    }
  }

  function sendToUser(username: string, payload: unknown): void {
    const sockets = userSockets.get(username);
    if (!sockets) {
      return;
    }

    for (const entry of [...sockets]) {
      if (entry.socket.readyState !== undefined && entry.socket.readyState !== WS_OPEN) {
        sockets.delete(entry);
        continue;
      }

      if (!sendJson(entry.socket, payload)) {
        sockets.delete(entry);
      }
    }

    if (sockets.size === 0) {
      userSockets.delete(username);
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

  function broadcastToMembers(room: string, payload: unknown, exceptUser?: string): void {
    for (const name of listRoomMembers(room)) {
      if (exceptUser && name === exceptUser) {
        continue;
      }
      sendToUser(name, payload);
    }
  }

  function fanOutMembership(slug: string, addedBy: string, added: string[]): void {
    if (added.length === 0) {
      return;
    }
    const members = listRoomMembers(slug);
    broadcastToMembers(slug, {
      type: 'member_added',
      room: slug,
      added_by: addedBy,
      users: added,
      members,
    });
  }

  function detachRoomSockets(room: string, username: string): boolean {
    const clients = roomClients.get(room);
    let detached = false;
    for (const client of [...(clients ?? [])]) {
      if (client.user === username) {
        clients!.delete(client);
        client.release?.();
        detached = true;
      }
    }
    if (clients && clients.size === 0) {
      roomClients.delete(room);
    }
    return detached;
  }

  /**
   * Everything in memory that still ties `username` to `room`, ended in one
   * place. Called after the membership row is gone (leave, kick).
   */
  function evictFromRoom(room: string, username: string): void {
    callState.removeFromCall(room, username, true);
    const watch = callState.watchSessions.get(room);
    if (watch?.host === username) {
      callState.endWatchSession(room, username);
      sendToUser(username, { type: 'watch_ended', room, user: username });
    } else {
      callState.removeFromWatch(room, username, true);
    }
    callState.stopTyping(room, username);
    if (detachRoomSockets(room, username)) {
      broadcastToRoom(room, { type: 'user_left', room, user: username });
    }
  }

  /** A deleted room: no call, watch, typing or socket state may outlive it. */
  function teardownRoom(room: string, formerMembers: string[], deletedBy: string): void {
    for (const user of callState.callRoster(room)) {
      callState.removeFromCall(room, user, true);
    }
    if (callState.watchSessions.has(room)) {
      callState.discardWatchSession(room);
      for (const user of formerMembers) {
        sendToUser(user, { type: 'watch_ended', room, user: deletedBy });
      }
    }
    for (const user of formerMembers) {
      callState.stopTyping(room, user, false);
    }
    for (const client of [...(roomClients.get(room) ?? [])]) {
      client.release?.();
    }
    roomClients.delete(room);
  }

  callState.setBroadcastHelpers(sendToUser, broadcastToMembers);

  const ctx: RouteContext = {
    roomClients,
    userSockets,
    callMembers: callState.callMembers,
    callSharing: callState.callSharing,
    watchSessions: callState.watchSessions,
    filesDir,
    linkPreview,
    callAloneTimeoutMs: callState.callAloneTimeoutMs,
    watchAloneTimeoutMs: callState.watchAloneTimeoutMs,
    typingTimeoutMs: callState.typingTimeoutMs,
    sendToUser,
    broadcastToRoom,
    broadcastToMembers,
    fanOutMembership,
    evictFromRoom,
    teardownRoom,
    connectedUsers,
    onlineUsernames,
    closeUserSockets,
    touchTyping: callState.touchTyping,
    stopTyping: callState.stopTyping,
    clearTypingForUser: callState.clearTypingForUser,
    removeFromCall: callState.removeFromCall,
    touchCallAloneTimer: callState.touchCallAloneTimer,
    clearCallAloneTimer: callState.clearCallAloneTimer,
    callRoster: callState.callRoster,
    callSharingUser: callState.callSharingUser,
    releaseShare: callState.releaseShare,
    broadcastCall: callState.broadcastCall,
    leaveAllCalls: callState.leaveAllCalls,
    removeFromWatch: callState.removeFromWatch,
    touchWatchAloneTimer: callState.touchWatchAloneTimer,
    clearWatchAloneTimer: callState.clearWatchAloneTimer,
    endWatchSession: callState.endWatchSession,
    broadcastWatch: callState.broadcastWatch,
    leaveAllWatches: callState.leaveAllWatches,
    watchSnapshot: callState.watchSnapshot,
    watchPeersPayload: callState.watchPeersPayload,
    postWatchSystemLine: callState.postWatchSystemLine,
    livePosition: callState.livePosition,
  };

  fastify.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
    const statusCode = error.statusCode ?? 500;
    const payload = { err: error, event: 'request_error', statusCode };
    if (statusCode >= 500) {
      request.log.error(payload, error.message);
      // Internal messages can carry paths, SQL and library details.
      return reply.status(statusCode).send({ error: 'internal server error', reqId: request.id });
    }
    request.log.info(payload, error.message);
    return reply.status(statusCode).send(error);
  });

  registerSecurityHeaders(fastify);

  await fastify.register(websocket, { options: { maxPayload: WS_MAX_PAYLOAD_BYTES } });
  await fastify.register(multipart, { limits: { fileSize: FILE_SIZE_LIMIT } });
  await fastify.register(rateLimit, { global: false, ...authRateLimitConfig() });

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

  await authRoutes(fastify, ctx);
  await roomRoutes(fastify, ctx);
  await messageRoutes(fastify, ctx);
  await fileRoutes(fastify, ctx);
  await previewRoutes(fastify, ctx);
  await registerWsHandler(fastify, ctx);

  await maybeServeWebBundle(fastify);

  return { app: fastify, roomClients, callMembers: callState.callMembers };
}
