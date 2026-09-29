import type { FastifyRequest } from 'fastify';

/** Largest WebSocket frame accepted. SDP offers with screen share stay well under this. */
export const WS_MAX_PAYLOAD_BYTES = 64 * 1024;

/** Oldest socket is closed when a user opens one more than this. */
export const WS_MAX_SOCKETS_PER_USER = 16;

/** Upgrades per client IP per minute. The client backs off on reconnect. */
export const WS_UPGRADES_PER_MINUTE = 60;

/**
 * Per-socket token bucket. Generous enough for a call starting in a full
 * mesh (a burst of ICE candidates to every peer) plus typing.
 */
export const WS_MESSAGE_BURST = 200;
export const WS_MESSAGES_PER_SECOND = 50;

export const WS_POLICY_VIOLATION = 1008;

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

function allowedOriginsFromEnv(): Set<string> {
  const raw = process.env.HERMES_ALLOWED_ORIGINS ?? '';
  return new Set(
    raw
      .split(',')
      .map((value) => value.trim().replace(/\/+$/, '').toLowerCase())
      .filter(Boolean)
  );
}

/**
 * Browsers always send Origin on a WebSocket upgrade and let any page open a
 * socket to any host, so this is the only thing stopping another site from
 * driving a logged-in browser's socket once sessions ride on cookies.
 * Non-browser clients (the CLI) send no Origin and are let through; they
 * cannot be tricked into connecting by a web page.
 */
export function isAllowedWsOrigin(request: FastifyRequest): boolean {
  const origin = request.headers.origin;
  if (origin === undefined) {
    return true;
  }

  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }

  if (allowedOriginsFromEnv().has(parsed.origin.toLowerCase())) {
    return true;
  }

  // Vite's dev proxy rewrites Host but not Origin; a page on loopback is
  // already running on this machine.
  if (LOOPBACK_HOSTNAMES.has(parsed.hostname.toLowerCase())) {
    return true;
  }

  const originHost = parsed.host.toLowerCase();
  // Fastify 4's `hostname` is X-Forwarded-Host (trusted from loopback only)
  // or Host, port included.
  const hosts = [request.headers.host, request.hostname].filter(
    (value): value is string => typeof value === 'string' && value.length > 0
  );
  return hosts.some((host) => host.toLowerCase() === originHost);
}

export type MessageBudget = { take(now?: number): boolean };

export function createMessageBudget(
  burst = WS_MESSAGE_BURST,
  perSecond = WS_MESSAGES_PER_SECOND
): MessageBudget {
  let tokens = burst;
  let last: number | null = null;
  return {
    take(now = Date.now()) {
      const elapsed = last === null ? 0 : Math.max(0, now - last);
      tokens = Math.min(burst, tokens + (elapsed / 1000) * perSecond);
      last = now;
      if (tokens < 1) {
        return false;
      }
      tokens -= 1;
      return true;
    },
  };
}
