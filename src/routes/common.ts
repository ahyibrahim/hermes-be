import { FastifyRequest, FastifyReply } from 'fastify';
import { findSessionUser } from '../sessions';
import { LinkPreviewService } from '../link-preview';

export type RoomSocket = {
  socket: {
    readyState: number;
    send: (data: string) => void;
    ping?: () => void;
    terminate?: () => void;
    close?: (code?: number, reason?: string) => void;
    on?: (event: string, cb: (...args: any[]) => void) => void;
  };
  room: string;
  user: string;
};

export type TrackedSocket = {
  socket: RoomSocket['socket'];
  user: string;
};

export type WatchSession = {
  room: string;
  provider: 'youtube';
  videoId: string;
  url: string;
  host: string;
  playing: boolean;
  /** Seconds at `updatedAt` wall clock. */
  position: number;
  rate: number;
  updatedAt: number;
  participants: Set<string>;
};

export const WS_OPEN = 1;
export const PING_INTERVAL_MS = 30_000;
export const PONG_TIMEOUT_MS = 60_000;
export const FILE_SIZE_LIMIT = 25 * 1024 * 1024;
export const AVATAR_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

export const DEFAULT_CALL_ALONE_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_WATCH_ALONE_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_TYPING_TIMEOUT_MS = 5_000;

export const DEFAULT_ICE_SERVERS: Array<{ urls: string | string[]; username?: string; credential?: string }> = [
  { urls: 'stun:stun.l.google.com:19302' },
];

export function parseIceServers(
  raw: string | undefined
): Array<{ urls: string | string[]; username?: string; credential?: string }> {
  if (!raw || !raw.trim()) {
    return DEFAULT_ICE_SERVERS;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return DEFAULT_ICE_SERVERS;
    }

    const servers = parsed.filter(
      (item): item is { urls: string | string[]; username?: string; credential?: string } =>
        Boolean(item) &&
        typeof item === 'object' &&
        (typeof (item as { urls?: unknown }).urls === 'string' ||
          Array.isArray((item as { urls?: unknown }).urls))
    );
    return servers.length > 0 ? servers : DEFAULT_ICE_SERVERS;
  } catch {
    return DEFAULT_ICE_SERVERS;
  }
}

export function authRateLimitConfig(): { max: number; timeWindow: string } {
  const raw = Number(process.env.HERMES_AUTH_RATE_MAX);
  const max = Number.isFinite(raw) && raw > 0 ? raw : 10;
  return { max, timeWindow: '1 minute' };
}

export function sendJson(socket: { readyState?: number; send: (data: string) => void }, payload: unknown): boolean {
  try {
    socket.send(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

export function errorFrame(content: string) {
  return { type: 'error', content, message: content };
}

export function extractBearer(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) {
    return header.slice(7).trim() || undefined;
  }
  return undefined;
}

export function extractToken(request: FastifyRequest): string | undefined {
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

export function unwrapSocket(connection: unknown): any {
  const conn = connection as { send?: unknown; on?: unknown; socket?: { send?: unknown; on?: unknown } };
  if (typeof conn?.send === 'function' && typeof conn?.on === 'function') {
    return conn;
  }

  if (typeof conn?.socket?.send === 'function' && typeof conn?.socket?.on === 'function') {
    return conn.socket;
  }

  return connection;
}

export function resolveUser(request: FastifyRequest, reply: FastifyReply): string | null {
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

export type RouteContext = {
  roomClients: Map<string, Set<RoomSocket>>;
  userSockets: Map<string, Set<TrackedSocket>>;
  callMembers: Map<string, Set<string>>;
  callSharing: Map<string, string>;
  watchSessions: Map<string, WatchSession>;
  filesDir: string;
  linkPreview: LinkPreviewService;
  callAloneTimeoutMs: number;
  watchAloneTimeoutMs: number;
  typingTimeoutMs: number;
  sendToUser: (username: string, payload: unknown) => void;
  broadcastToRoom: (room: string, payload: unknown, exceptSocket?: unknown) => void;
  broadcastToMembers: (room: string, payload: unknown, exceptUser?: string) => void;
  fanOutMembership: (slug: string, addedBy: string, added: string[]) => void;
  connectedUsers: (room: string) => string[];
  onlineUsernames: () => string[];
  touchTyping: (room: string, username: string) => void;
  stopTyping: (room: string, username: string, broadcast?: boolean) => void;
  clearTypingForUser: (username: string) => void;
  removeFromCall: (room: string, username: string, notifyLeaver: boolean) => void;
  touchCallAloneTimer: (room: string) => void;
  clearCallAloneTimer: (room: string) => void;
  callRoster: (room: string) => string[];
  callSharingUser: (room: string) => string | null;
  releaseShare: (room: string, username: string) => void;
  broadcastCall: (room: string, payload: unknown, exceptUser?: string) => void;
  leaveAllCalls: (username: string) => void;
  removeFromWatch: (room: string, username: string, notifyLeaver: boolean) => void;
  touchWatchAloneTimer: (room: string) => void;
  clearWatchAloneTimer: (room: string) => void;
  endWatchSession: (room: string, endedBy: string) => void;
  broadcastWatch: (room: string, payload: unknown, exceptUser?: string) => void;
  leaveAllWatches: (username: string) => void;
  watchSnapshot: (s: WatchSession) => any;
  watchPeersPayload: (s: WatchSession) => any;
  postWatchSystemLine: (room: string, content: string) => void;
  livePosition: (s: WatchSession) => number;
};
