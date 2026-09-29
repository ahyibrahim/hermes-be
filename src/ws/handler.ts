import { FastifyInstance, FastifyRequest } from 'fastify';
import { isRoomMember } from '../db';
import { getUserByUsername, markRoomRead } from '../rooms';
import { can } from '../authz';
import { findSessionUser } from '../sessions';
import { normalizeYouTubeUrl, parseYouTubeVideoId } from '../youtube';
import {
  errorFrame,
  extractBearer,
  normalizeRoomSlug,
  PING_INTERVAL_MS,
  PONG_TIMEOUT_MS,
  RoomSocket,
  RouteContext,
  sendJson,
  TrackedSocket,
  unwrapSocket,
  WatchSession,
  WS_OPEN,
} from '../routes/common';
import {
  createMessageBudget,
  isAllowedWsOrigin,
  WS_MAX_SOCKETS_PER_USER,
  WS_POLICY_VIOLATION,
  WS_UPGRADES_PER_MINUTE,
} from './limits';
import { wsFrameSchema, type LooseWsFrame } from './frames';

export async function registerWsHandler(fastify: FastifyInstance, ctx: RouteContext): Promise<void> {
  const lastPong = new WeakMap<object, number>();

  function attachUserSocket(user: string, socket: TrackedSocket['socket']): TrackedSocket {
    const entry: TrackedSocket = { socket, user };
    if (!ctx.userSockets.has(user)) {
      ctx.userSockets.set(user, new Set());
    }
    const sockets = ctx.userSockets.get(user)!;
    // Set iteration order is insertion order, so the first entries are the oldest.
    for (const old of [...sockets].slice(0, Math.max(0, sockets.size - WS_MAX_SOCKETS_PER_USER + 1))) {
      try {
        old.socket.close?.(WS_POLICY_VIOLATION, 'too many connections');
      } catch {
        // already closed
      }
    }
    sockets.add(entry);
    return entry;
  }

  function detachUserSocket(entry: TrackedSocket | null): void {
    if (!entry) {
      return;
    }

    const sockets = ctx.userSockets.get(entry.user);
    sockets?.delete(entry);
    if (!sockets || sockets.size === 0) {
      ctx.userSockets.delete(entry.user);
      ctx.leaveAllCalls(entry.user);
      ctx.leaveAllWatches(entry.user);
      ctx.clearTypingForUser(entry.user);
    }
  }

  function dropClient(client: RoomSocket): void {
    const clients = ctx.roomClients.get(client.room);
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

  fastify.get(
    '/ws',
    {
      websocket: true,
      config: { rateLimit: { max: WS_UPGRADES_PER_MINUTE, timeWindow: '1 minute' } },
      preHandler: async (request, reply) => {
        if (!isAllowedWsOrigin(request)) {
          request.log.info(
            { event: 'ws_forbidden_origin', origin: request.headers.origin, host: request.headers.host },
            'websocket handshake rejected'
          );
          return reply.code(403).send({ error: 'origin not allowed' });
        }

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
      let userEntry: TrackedSocket | null = null;
      const budget = createMessageBudget();

      lastPong.set(socket, Date.now());
      if (user) {
        userEntry = attachUserSocket(user, socket);
        request.log.info({ event: 'ws_connect', user }, 'websocket connected');
      }

      const leaveCurrentRoom = () => {
        if (!client || !room) {
          return;
        }

        const leftRoom = room;
        const leftUser = user;
        const clients = ctx.roomClients.get(leftRoom);
        clients?.delete(client);
        client = null;
        room = null;

        ctx.broadcastToRoom(leftRoom, { type: 'user_left', room: leftRoom, user: leftUser });
      };

      const bindUser = (username: string) => {
        user = username;
        if (!userEntry) {
          userEntry = attachUserSocket(user, socket);
        } else {
          userEntry.user = user;
        }
      };

      const requireUser = (): boolean => {
        if (user) {
          return true;
        }
        sendJson(socket, errorFrame('authentication required'));
        return false;
      };

      const requireCallTarget = (
        payload: { room?: string; to?: unknown }
      ): { slug: string; to: string } | null => {
        const slug = normalizeRoomSlug(payload.room);
        const to = typeof payload.to === 'string' ? payload.to.trim().toLowerCase() : '';
        if (!slug || !to) {
          sendJson(socket, errorFrame('room and to are required'));
          return null;
        }

        const members = ctx.callMembers.get(slug);
        if (!members?.has(user) || !members.has(to) || !isRoomMember(slug, user) || !isRoomMember(slug, to)) {
          sendJson(socket, errorFrame('not in that call'));
          return null;
        }

        if (to === user) {
          sendJson(socket, errorFrame('cannot signal to yourself'));
          return null;
        }

        return { slug, to };
      };

      if (user) {
        sendJson(socket, { type: 'connected', user });
      }

      socket.on('pong', () => {
        lastPong.set(socket, Date.now());
      });

      socket.on('message', (raw: Buffer | string) => {
        if (!budget.take()) {
          request.log.warn({ event: 'ws_rate_limited', user }, 'websocket message rate exceeded');
          try {
            socket.close?.(WS_POLICY_VIOLATION, 'rate limit exceeded');
          } catch {
            // already closed
          }
          return;
        }

        try {
          const parsed = wsFrameSchema.safeParse(JSON.parse(raw.toString()));
          if (!parsed.success) {
            sendJson(socket, errorFrame('invalid message'));
            return;
          }
          const payload = parsed.data as LooseWsFrame;

          if (payload.type === 'join_room') {
            if (!user) {
              const joinToken = typeof payload.token === 'string' ? payload.token.trim() : '';
              const username = joinToken ? findSessionUser(joinToken) : null;
              if (!username) {
                sendJson(socket, errorFrame('authentication required'));
                socket.close?.();
                return;
              }
              bindUser(username);
              sendJson(socket, { type: 'connected', user });
              request.log.info({ event: 'ws_connect', user }, 'websocket connected');
            }

            const slug = normalizeRoomSlug(payload.room);
            if (!slug) {
              sendJson(socket, errorFrame('room must be a slug, not a numeric id'));
              return;
            }

            if (!isRoomMember(slug, user)) {
              sendJson(socket, errorFrame('not a member of this room'));
              return;
            }

            const profile = getUserByUsername(user);
            if (profile) {
              markRoomRead(profile.id, slug);
            }

            if (room && client) {
              leaveCurrentRoom();
            }

            room = slug;
            if (!ctx.roomClients.has(room)) {
              ctx.roomClients.set(room, new Set());
            }

            client = {
              socket,
              room,
              user,
              release: () => {
                client = null;
                room = null;
              },
            };
            ctx.roomClients.get(room)?.add(client);

            sendJson(socket, { type: 'joined_room', room });
            sendJson(socket, { type: 'room_users', room, users: ctx.connectedUsers(room) });
            ctx.broadcastToRoom(room, { type: 'user_joined', room, user }, socket);
            const activeWatch = ctx.watchSessions.get(room);
            if (activeWatch) {
              // Banner awareness only — does not join participants (use watch_join).
              sendJson(socket, { type: 'watch_state', ...ctx.watchSnapshot(activeWatch) });
            }
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

          if (payload.type === 'join_call') {
            if (!requireUser()) {
              return;
            }

            const slug = normalizeRoomSlug(payload.room);
            if (!slug) {
              sendJson(socket, errorFrame('room must be a slug, not a numeric id'));
              return;
            }

            if (!isRoomMember(slug, user)) {
              sendJson(socket, errorFrame('not a member of that room'));
              return;
            }

            for (const otherRoom of [...ctx.callMembers.keys()]) {
              if (otherRoom !== slug && ctx.callMembers.get(otherRoom)?.has(user)) {
                ctx.removeFromCall(otherRoom, user, true);
              }
            }

            if (!ctx.callMembers.has(slug)) {
              ctx.callMembers.set(slug, new Set());
            }
            const already = ctx.callMembers.get(slug)?.has(user) === true;
            const starting = (ctx.callMembers.get(slug)?.size ?? 0) === 0;
            ctx.callMembers.get(slug)?.add(user);

            sendJson(socket, {
              type: 'call_peers',
              room: slug,
              users: ctx.callRoster(slug),
              sharing: ctx.callSharingUser(slug),
            });
            if (!already) {
              if (starting) {
                ctx.broadcastToMembers(slug, { type: 'call_started', room: slug, user }, user);
              }
              ctx.broadcastCall(slug, { type: 'user_joined_call', room: slug, user }, user);
              request.log.info({ event: 'call_join', user, room: slug }, 'joined call');
            }
            ctx.touchCallAloneTimer(slug);
            return;
          }

          if (payload.type === 'screen_share_start') {
            if (!requireUser()) {
              return;
            }

            const slug = normalizeRoomSlug(payload.room);
            if (!slug) {
              sendJson(socket, errorFrame('room must be a slug, not a numeric id'));
              return;
            }

            const members = ctx.callMembers.get(slug);
            if (!members?.has(user) || !isRoomMember(slug, user)) {
              sendJson(socket, errorFrame('not in that call'));
              return;
            }

            const current = ctx.callSharingUser(slug);
            if (current && current !== user) {
              sendJson(socket, errorFrame(`${current} is sharing`));
              return;
            }

            if (current === user) {
              return;
            }

            ctx.callSharing.set(slug, user);
            ctx.broadcastCall(slug, { type: 'screen_share_started', room: slug, user });
            request.log.info({ event: 'screen_share_start', user, room: slug }, 'started screen share');
            return;
          }

          if (payload.type === 'screen_share_stop') {
            if (!requireUser()) {
              return;
            }

            const slug = normalizeRoomSlug(payload.room);
            if (!slug) {
              sendJson(socket, errorFrame('room must be a slug, not a numeric id'));
              return;
            }

            const members = ctx.callMembers.get(slug);
            if (!members?.has(user)) {
              sendJson(socket, errorFrame('not in that call'));
              return;
            }

            if (ctx.callSharingUser(slug) !== user) {
              sendJson(socket, errorFrame('only the sharer can stop'));
              return;
            }

            ctx.releaseShare(slug, user);
            request.log.info({ event: 'screen_share_stop', user, room: slug }, 'stopped screen share');
            return;
          }

          if (payload.type === 'leave_call') {
            if (!requireUser()) {
              return;
            }

            const slug = normalizeRoomSlug(payload.room);
            if (!slug) {
              sendJson(socket, errorFrame('room must be a slug, not a numeric id'));
              return;
            }

            ctx.removeFromCall(slug, user, true);
            request.log.info({ event: 'call_leave', user, room: slug }, 'left call');
            return;
          }

          if (payload.type === 'call_offer' || payload.type === 'call_answer') {
            if (!requireUser()) {
              return;
            }

            const target = requireCallTarget(payload);
            if (!target) {
              return;
            }

            ctx.sendToUser(target.to, {
              type: payload.type,
              room: target.slug,
              from: user,
              to: target.to,
              sdp: payload.sdp,
            });
            return;
          }

          if (payload.type === 'ice_candidate') {
            if (!requireUser()) {
              return;
            }

            const target = requireCallTarget(payload);
            if (!target) {
              return;
            }

            ctx.sendToUser(target.to, {
              type: 'ice_candidate',
              room: target.slug,
              from: user,
              to: target.to,
              candidate: payload.candidate ?? null,
            });
            return;
          }

          if (payload.type === 'watch_start') {
            if (!requireUser()) {
              return;
            }

            const slug = normalizeRoomSlug(payload.room);
            if (!slug) {
              sendJson(socket, errorFrame('room must be a slug, not a numeric id'));
              return;
            }

            if (!isRoomMember(slug, user)) {
              sendJson(socket, errorFrame('not a member of that room'));
              return;
            }

            const existing = ctx.watchSessions.get(slug);
            if (existing) {
              existing.participants.add(user);
              ctx.sendToUser(user, { type: 'watch_state', ...ctx.watchSnapshot(existing) });
              ctx.broadcastWatch(slug, ctx.watchPeersPayload(existing));
              ctx.touchWatchAloneTimer(slug);
              request.log.info(
                { event: 'watch_join', user, room: slug, videoId: existing.videoId },
                'joined existing watch session'
              );
              return;
            }

            const rawUrl = typeof payload.url === 'string' ? payload.url.trim() : '';
            const videoId = parseYouTubeVideoId(rawUrl);
            if (!videoId) {
              sendJson(socket, errorFrame('only YouTube URLs are supported'));
              return;
            }

            const url = normalizeYouTubeUrl(videoId);
            const now = Date.now();
            const session: WatchSession = {
              room: slug,
              provider: 'youtube',
              videoId,
              url,
              host: user,
              playing: false,
              position: 0,
              rate: 1,
              updatedAt: now,
              participants: new Set([user]),
            };
            ctx.watchSessions.set(slug, session);
            ctx.touchWatchAloneTimer(slug);

            const snapshot = ctx.watchSnapshot(session);
            ctx.broadcastToMembers(slug, { type: 'watch_started', ...snapshot, user }, user);
            ctx.sendToUser(user, { type: 'watch_state', ...snapshot });
            ctx.broadcastWatch(slug, ctx.watchPeersPayload(session));
            ctx.postWatchSystemLine(slug, `${user} started watching together: ${url}`);
            request.log.info(
              { event: 'watch_start', user, room: slug, videoId },
              'started watch session'
            );
            return;
          }

          if (payload.type === 'watch_join') {
            if (!requireUser()) {
              return;
            }

            const slug = normalizeRoomSlug(payload.room);
            if (!slug) {
              sendJson(socket, errorFrame('room must be a slug, not a numeric id'));
              return;
            }

            if (!isRoomMember(slug, user)) {
              sendJson(socket, errorFrame('not a member of that room'));
              return;
            }

            const session = ctx.watchSessions.get(slug);
            if (!session) {
              sendJson(socket, errorFrame('no active watch session'));
              return;
            }

            session.participants.add(user);
            ctx.sendToUser(user, { type: 'watch_state', ...ctx.watchSnapshot(session) });
            ctx.broadcastWatch(slug, ctx.watchPeersPayload(session));
            ctx.touchWatchAloneTimer(slug);
            request.log.info(
              { event: 'watch_join', user, room: slug, videoId: session.videoId },
              'joined watch session'
            );
            return;
          }

          if (payload.type === 'watch_leave') {
            if (!requireUser()) {
              return;
            }

            const slug = normalizeRoomSlug(payload.room);
            if (!slug) {
              sendJson(socket, errorFrame('room must be a slug, not a numeric id'));
              return;
            }

            ctx.removeFromWatch(slug, user, true);
            request.log.info({ event: 'watch_leave', user, room: slug }, 'left watch session');
            return;
          }

          if (payload.type === 'watch_control' || payload.type === 'watch_end') {
            if (!requireUser()) {
              return;
            }

            const slug = normalizeRoomSlug(payload.room);
            if (!slug) {
              sendJson(socket, errorFrame('room must be a slug, not a numeric id'));
              return;
            }

            const session = ctx.watchSessions.get(slug);
            if (!isRoomMember(slug, user) || !session) {
              sendJson(socket, errorFrame('no active watch session'));
              return;
            }

            const action =
              payload.type === 'watch_end'
                ? 'end'
                : typeof payload.action === 'string'
                  ? payload.action
                  : '';

            if (action !== 'play' && action !== 'pause' && action !== 'seek' && action !== 'rate' && action !== 'end') {
              sendJson(socket, errorFrame('invalid watch action'));
              return;
            }

            const actor = getUserByUsername(user);
            if (!actor) {
              ctx.sendToUser(user, { type: 'watch_control_denied', room: slug, action, reason: 'unknown user' });
              return;
            }

            const isWatchHost = session.host === user;
            const authzAction =
              action === 'play' || action === 'pause'
                ? 'watch.play_pause'
                : action === 'end'
                  ? 'watch.end'
                  : 'watch.seek';

            if (!can(actor, authzAction, { isWatchHost })) {
              ctx.sendToUser(user, { type: 'watch_control_denied', room: slug, action });
              return;
            }

            if (action === 'end') {
              ctx.endWatchSession(slug, user);
              return;
            }

            const clientPosition =
              typeof payload.position === 'number' && Number.isFinite(payload.position) && payload.position >= 0
                ? payload.position
                : undefined;

            if (action === 'play') {
              session.position = clientPosition ?? ctx.livePosition(session);
              session.playing = true;
              session.updatedAt = Date.now();
            } else if (action === 'pause') {
              session.position = clientPosition ?? ctx.livePosition(session);
              session.playing = false;
              session.updatedAt = Date.now();
            } else if (action === 'seek') {
              if (clientPosition === undefined) {
                sendJson(socket, errorFrame('position is required for seek'));
                return;
              }
              session.position = clientPosition;
              session.updatedAt = Date.now();
            } else if (action === 'rate') {
              const rawRate = typeof payload.rate === 'number' && Number.isFinite(payload.rate) ? payload.rate : NaN;
              if (!Number.isFinite(rawRate)) {
                sendJson(socket, errorFrame('rate is required'));
                return;
              }
              session.position = ctx.livePosition(session);
              session.rate = Math.min(2, Math.max(0.25, rawRate));
              session.updatedAt = Date.now();
            }

            ctx.broadcastWatch(slug, { type: 'watch_state', ...ctx.watchSnapshot(session) });
            request.log.info(
              { event: 'watch_control', user, room: slug, action, videoId: session.videoId },
              'watch control'
            );
            return;
          }

          if (payload.type === 'typing') {
            if (!requireUser()) {
              return;
            }
            const slug = normalizeRoomSlug(payload.room);
            if (!slug) {
              sendJson(socket, errorFrame('room is required'));
              return;
            }
            if (!isRoomMember(slug, user)) {
              sendJson(socket, errorFrame('not a member of that room'));
              return;
            }
            const active = payload.active === true;
            if (active) {
              ctx.touchTyping(slug, user);
            } else {
              ctx.stopTyping(slug, user);
            }
            return;
          }

          sendJson(socket, errorFrame('invalid message'));
        } catch (error) {
          request.log.warn(
            { err: error, event: 'ws_error', user, room: room ?? undefined },
            'websocket message handler failed'
          );
          sendJson(socket, errorFrame('invalid message'));
        }
      });

      socket.on('error', (error: Error) => {
        request.log.error(
          { err: error, event: 'ws_error', user, room: room ?? undefined },
          'websocket error'
        );
        leaveCurrentRoom();
        detachUserSocket(userEntry);
        userEntry = null;
      });

      socket.on('close', () => {
        request.log.info(
          { event: 'ws_disconnect', user, room: room ?? undefined },
          'websocket disconnected'
        );
        leaveCurrentRoom();
        detachUserSocket(userEntry);
        userEntry = null;
      });
    }
  );

  const pingTimer = setInterval(() => {
    const now = Date.now();
    const pinged = new Set<object>();

    const pingOne = (socket: RoomSocket['socket'], onDead: () => void) => {
      if (pinged.has(socket)) {
        return;
      }
      pinged.add(socket);
      const seen = lastPong.get(socket) ?? 0;
      if (now - seen > PONG_TIMEOUT_MS) {
        onDead();
        return;
      }

      try {
        socket.ping?.();
      } catch {
        onDead();
      }
    };

    for (const sockets of ctx.userSockets.values()) {
      for (const entry of [...sockets]) {
        pingOne(entry.socket, () => {
          try {
            entry.socket.terminate?.();
          } catch {
            // already closed
          }
          detachUserSocket(entry);
        });
      }
    }

    for (const clients of ctx.roomClients.values()) {
      for (const client of [...clients]) {
        pingOne(client.socket, () => dropClient(client));
      }
    }
  }, PING_INTERVAL_MS);

  pingTimer.unref();
  fastify.addHook('onClose', async () => {
    clearInterval(pingTimer);
    const closed = new Set<object>();
    const goodbye = (socket: { close?: (code?: number, reason?: string) => void; terminate?: () => void }) => {
      if (closed.has(socket)) {
        return;
      }
      closed.add(socket);
      try {
        socket.close?.(1001, 'server shutting down');
      } catch {
        try {
          socket.terminate?.();
        } catch {
          // already closed
        }
      }
    };
    for (const sockets of ctx.userSockets.values()) {
      for (const entry of sockets) {
        goodbye(entry.socket);
      }
    }
    for (const clients of ctx.roomClients.values()) {
      for (const client of clients) {
        goodbye(client.socket);
      }
    }
  });
}
