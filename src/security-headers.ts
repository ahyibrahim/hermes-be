import type { FastifyInstance } from 'fastify';

/**
 * Directives that only work as a response header (a `<meta>` CSP ignores
 * `frame-ancestors`), or that must hold even for responses the SPA's own
 * meta CSP never sees. Script and style policy lives in the web build, where
 * SvelteKit can hash its inline bootstrap script.
 */
export const APP_CSP = [
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  // YouTube embeds refuse to play without a Referer, so not `no-referrer`.
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Strict-Transport-Security': 'max-age=31536000',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy':
    'camera=(self), microphone=(self), display-capture=(self), geolocation=(), payment=(), usb=(), serial=(), bluetooth=()',
};

export function registerSecurityHeaders(fastify: FastifyInstance): void {
  fastify.addHook('onSend', async (_request, reply, payload) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      if (!reply.hasHeader(name)) {
        reply.header(name, value);
      }
    }
    // Upload responses set a stricter sandbox CSP of their own.
    if (!reply.hasHeader('Content-Security-Policy')) {
      reply.header('Content-Security-Policy', APP_CSP);
    }
    return payload;
  });
}
