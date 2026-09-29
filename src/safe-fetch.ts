import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { Readable, pipeline } from 'node:stream';
import zlib from 'node:zlib';
import ipaddr from 'ipaddr.js';

/**
 * Outbound HTTP for URLs that users choose (link previews and their images).
 * Every hop is checked before it connects: http(s) only, no credentials,
 * ports 80/443, and a hostname that resolves only to public unicast
 * addresses. The check runs inside the socket's own DNS lookup, so the
 * address that was checked is the address that is dialled.
 */

export type ResolveFn = (hostname: string) => Promise<string[]>;

export type SafeFetchInit = {
  signal: AbortSignal;
  headers: Record<string, string>;
  lookup: LookupFunction;
};

/** Same shape as `fetch` for the parts used here; tests inject their own. */
export type SafeFetchTransport = (url: string, init: SafeFetchInit) => Promise<Response>;

export type SafeFetchOptions = {
  resolve?: ResolveFn;
  transport?: SafeFetchTransport;
  isAllowedAddress?: (ip: string) => boolean;
  allowedPorts?: ReadonlySet<string>;
  maxRedirects?: number;
};

export class BlockedUrlError extends Error {}

const BLOCKED_HOSTS = new Set(['localhost', 'metadata.google.internal']);
const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'];
const DEFAULT_PORTS: ReadonlySet<string> = new Set(['', '80', '443']);
const DEFAULT_MAX_REDIRECTS = 3;

export function isPublicUnicast(ip: string): boolean {
  if (!ipaddr.isValid(ip)) {
    return false;
  }
  // Unwraps ::ffff:a.b.c.d so a mapped private v4 is judged as v4.
  return ipaddr.process(ip).range() === 'unicast';
}

function bareHost(hostname: string): string {
  const host = hostname.trim().toLowerCase().replace(/\.$/, '');
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

export function isBlockedHostname(hostname: string, isAllowed = isPublicUnicast): boolean {
  const host = bareHost(hostname);
  if (!host || BLOCKED_HOSTS.has(host) || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) {
    return true;
  }
  if (isIP(host)) {
    return !isAllowed(host);
  }
  return false;
}

async function defaultResolve(hostname: string): Promise<string[]> {
  const rows = await dns.lookup(hostname, { all: true, verbatim: true });
  return rows.map((row) => row.address);
}

/**
 * A `net` lookup that refuses the whole name if any address is not public,
 * so a name that mixes public and private records cannot be raced.
 */
export function guardedLookup(resolve: ResolveFn, isAllowed: (ip: string) => boolean): LookupFunction {
  return ((hostname: string, options: { family?: number | string; all?: boolean }, callback: any) => {
    resolve(hostname).then(
      (addresses) => {
        if (addresses.length === 0 || !addresses.every(isAllowed)) {
          callback(new BlockedUrlError('blocked address'));
          return;
        }
        const family = options?.family === 'IPv4' ? 4 : options?.family === 'IPv6' ? 6 : Number(options?.family) || 0;
        const rows = addresses
          .map((address) => ({ address, family: isIP(address) }))
          .filter((row) => family === 0 || row.family === family);
        if (rows.length === 0) {
          callback(new BlockedUrlError('no address for family'));
          return;
        }
        if (options?.all) {
          callback(null, rows);
        } else {
          callback(null, rows[0].address, rows[0].family);
        }
      },
      (error) => callback(error)
    );
  }) as LookupFunction;
}

function decoded(res: http.IncomingMessage): Readable {
  const encoding = String(res.headers['content-encoding'] || '').toLowerCase().trim();
  const decoder =
    encoding === 'gzip' || encoding === 'x-gzip'
      ? zlib.createGunzip()
      : encoding === 'deflate'
        ? zlib.createInflate()
        : encoding === 'br'
          ? zlib.createBrotliDecompress()
          : null;
  if (!decoder) {
    return res;
  }
  return pipeline(res, decoder, () => {});
}

export const nodeTransport: SafeFetchTransport = (url, init) =>
  new Promise((resolve, reject) => {
    const target = new URL(url);
    const client = target.protocol === 'https:' ? https : http;
    const req = client.request(
      target,
      { method: 'GET', headers: init.headers, signal: init.signal, lookup: init.lookup, agent: false },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status < 200 || status > 599) {
          res.destroy();
          reject(new Error(`unexpected status ${status}`));
          return;
        }
        const headers = new Headers();
        for (const [name, value] of Object.entries(res.headers)) {
          if (Array.isArray(value)) {
            value.forEach((v) => headers.append(name, v));
          } else if (value !== undefined) {
            headers.set(name, value);
          }
        }
        const noBody = status === 204 || status === 205 || status === 304 || (status >= 300 && status < 400);
        if (noBody) {
          res.resume();
        }
        const body = noBody ? null : (Readable.toWeb(decoded(res)) as ReadableStream<Uint8Array>);
        resolve(new Response(body, { status, headers }));
      }
    );
    req.on('error', reject);
    req.end();
  });

export type SafeFetcher = {
  /** Follows up to `maxRedirects`, checking every hop. Non-2xx is returned as is. */
  fetch(url: string, init: { signal: AbortSignal; headers: Record<string, string> }): Promise<{ response: Response; finalUrl: string }>;
  isBlockedHostname(hostname: string): boolean;
};

export function createSafeFetcher(options: SafeFetchOptions = {}): SafeFetcher {
  const resolve = options.resolve ?? defaultResolve;
  const transport = options.transport ?? nodeTransport;
  const isAllowed = options.isAllowedAddress ?? isPublicUnicast;
  const allowedPorts = options.allowedPorts ?? DEFAULT_PORTS;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const lookup = guardedLookup(resolve, isAllowed);

  function checkUrl(raw: string): URL {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      throw new BlockedUrlError('invalid url');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new BlockedUrlError('unsupported protocol');
    }
    if (parsed.username || parsed.password) {
      throw new BlockedUrlError('credentials not allowed');
    }
    if (!allowedPorts.has(parsed.port)) {
      throw new BlockedUrlError('port not allowed');
    }
    if (isBlockedHostname(parsed.hostname, isAllowed)) {
      throw new BlockedUrlError('blocked host');
    }
    return parsed;
  }

  async function safeFetch(
    url: string,
    init: { signal: AbortSignal; headers: Record<string, string> }
  ): Promise<{ response: Response; finalUrl: string }> {
    let current = checkUrl(url).toString();
    for (let hop = 0; ; hop += 1) {
      init.signal.throwIfAborted();
      const response = await transport(current, { ...init, lookup });
      if (response.status < 300 || response.status >= 400) {
        return { response, finalUrl: current };
      }
      await response.body?.cancel().catch(() => {});
      const location = response.headers.get('location');
      if (!location || hop >= maxRedirects) {
        throw new BlockedUrlError('too many redirects');
      }
      let next: string;
      try {
        next = new URL(location, current).toString();
      } catch {
        throw new BlockedUrlError('invalid redirect');
      }
      current = checkUrl(next).toString();
    }
  }

  return { fetch: safeFetch, isBlockedHostname: (h) => isBlockedHostname(h, isAllowed) };
}

/**
 * Reads at most `maxBytes`. `onChunk` may return true to stop early. The
 * signal cancels a body that trickles in, which a headers-only timeout misses.
 */
export async function readCapped(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
  onChunk?: (chunk: Uint8Array) => boolean | void
): Promise<Buffer> {
  if (!response.body) {
    return Buffer.alloc(0);
  }
  const reader = response.body.getReader();
  const onAbort = () => {
    reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', onAbort, { once: true });
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value || value.byteLength === 0) {
        continue;
      }
      const chunk = Buffer.from(value.buffer, value.byteOffset, Math.min(value.byteLength, maxBytes - total));
      chunks.push(chunk);
      total += chunk.byteLength;
      if (onChunk?.(chunk)) {
        break;
      }
    }
    signal.throwIfAborted();
  } finally {
    signal.removeEventListener('abort', onAbort);
    reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks);
}
