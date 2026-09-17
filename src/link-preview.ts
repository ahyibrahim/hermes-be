import dns from 'node:dns/promises';
import net from 'node:net';
import { isIP } from 'node:net';
import { normalizeYouTubeUrl, parseYouTubeVideoId } from './youtube';

export type LinkPreview = {
  url: string;
  title: string | null;
  description: string | null;
  image: string | null;
  site: string | null;
  favicon: string | null;
  /** Channel / site author when known (YouTube oEmbed). */
  author?: string | null;
  authorUrl?: string | null;
  /** Runtime in whole seconds when known (YouTube). */
  durationSeconds?: number | null;
};

type CacheEntry = {
  expiresAt: number;
  preview: LinkPreview | null;
};

const DEFAULT_TIMEOUT_MS = 5_000;
/** YouTube embeds OG tags after a large script payload; keep headroom for late meta. */
const DEFAULT_MAX_BYTES = 1.5 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 3;
const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000;
const DEFAULT_CACHE_MAX = 256;

const BLOCKED_HOSTS = new Set(['localhost', 'metadata.google.internal']);

export type LinkPreviewOptions = {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  cacheTtlMs?: number;
  cacheMax?: number;
  /** Injected fetch for tests. */
  fetchImpl?: typeof fetch;
  /** Injected DNS lookup for tests. */
  lookup?: (hostname: string) => Promise<string[]>;
};

function isPrivateOrLocalIp(ip: string): boolean {
  if (ip === '::' || ip === '0.0.0.0') {
    return true;
  }
  if (ip === '::1' || ip.startsWith('fe80:') || ip.startsWith('fc') || ip.startsWith('fd')) {
    return true;
  }
  const v4 = ip.includes(':') && ip.includes('.') ? ip.split(':').pop()! : ip;
  if (!net.isIPv4(v4)) {
    // Other IPv6: treat unique-local / link-local already handled; block unspecified.
    return ip === '::' || ip.toLowerCase().startsWith('::ffff:127.');
  }
  const parts = v4.split('.').map(Number);
  const [a, b] = parts;
  if (a === 10 || a === 127 || a === 0) {
    return true;
  }
  if (a === 169 && b === 254) {
    return true;
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return true;
  }
  if (a === 192 && b === 168) {
    return true;
  }
  if (a === 100 && b >= 64 && b <= 127) {
    // CGNAT
    return true;
  }
  return false;
}

export function isBlockedHostname(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, '');
  if (!host || BLOCKED_HOSTS.has(host)) {
    return true;
  }
  if (host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return true;
  }
  if (isIP(host)) {
    return isPrivateOrLocalIp(host);
  }
  return false;
}

function metaContent(html: string, property: string): string | null {
  const patterns = [
    new RegExp(
      `<meta[^>]+(?:property|name)=["']${property}["'][^>]+content=["']([^"']*)["'][^>]*>`,
      'i'
    ),
    new RegExp(
      `<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${property}["'][^>]*>`,
      'i'
    ),
  ];
  for (const re of patterns) {
    const match = html.match(re);
    if (match?.[1]) {
      return decodeHtmlEntities(match[1].trim()) || null;
    }
  }
  return null;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function pageTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  if (!match?.[1]) {
    return null;
  }
  return decodeHtmlEntities(match[1].trim()) || null;
}

function absoluteUrl(base: string, maybeRelative: string | null): string | null {
  if (!maybeRelative) {
    return null;
  }
  try {
    return new URL(maybeRelative, base).toString();
  } catch {
    return null;
  }
}

/** Prefer apple-touch / icon / shortcut icon; fall back to /favicon.ico. */
function findFavicon(finalUrl: string, html: string): string | null {
  const linkRe =
    /<link\b[^>]*\brel=["']([^"']*)["'][^>]*>/gi;
  let match: RegExpExecArray | null;
  const candidates: Array<{ rel: string; href: string }> = [];
  while ((match = linkRe.exec(html)) !== null) {
    const tag = match[0];
    const rel = match[1].toLowerCase();
    const hrefMatch = tag.match(/\bhref=["']([^"']+)["']/i);
    if (!hrefMatch?.[1]) {
      continue;
    }
    if (
      rel.split(/\s+/).some((token) =>
        token === 'icon' ||
        token === 'shortcut' ||
        token === 'shortcuticon' ||
        token === 'apple-touch-icon' ||
        token === 'apple-touch-icon-precomposed'
      ) ||
      rel.includes('icon')
    ) {
      candidates.push({ rel, href: hrefMatch[1].trim() });
    }
  }
  const preferred =
    candidates.find((c) => c.rel.includes('apple-touch-icon')) ||
    candidates.find((c) => c.rel.split(/\s+/).includes('icon')) ||
    candidates.find((c) => c.rel.includes('shortcut')) ||
    candidates[0];
  if (preferred) {
    return absoluteUrl(finalUrl, preferred.href);
  }
  return absoluteUrl(finalUrl, '/favicon.ico');
}

function parseIso8601Duration(value: string): number | null {
  const match = value.trim().match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i);
  if (!match) {
    return null;
  }
  const hours = match[1] ? Number(match[1]) : 0;
  const minutes = match[2] ? Number(match[2]) : 0;
  const seconds = match[3] ? Number(match[3]) : 0;
  const total = hours * 3600 + minutes * 60 + seconds;
  return Number.isFinite(total) && total > 0 ? total : null;
}

function extractYouTubeWatchExtras(html: string): {
  durationSeconds: number | null;
} {
  let durationSeconds: number | null = null;
  const iso =
    html.match(/itemprop=["']duration["'][^>]*content=["']([^"']+)["']/i) ||
    html.match(/content=["']([^"']+)["'][^>]*itemprop=["']duration["']/i);
  if (iso?.[1]) {
    durationSeconds = parseIso8601Duration(iso[1]);
  }
  if (durationSeconds == null) {
    const length = html.match(/"lengthSeconds":"(\d+)"/);
    if (length) {
      const n = Number(length[1]);
      if (Number.isFinite(n) && n > 0) {
        durationSeconds = n;
      }
    }
  }

  return { durationSeconds };
}

function parsePreviewHtml(finalUrl: string, html: string): LinkPreview {
  const title =
    metaContent(html, 'og:title') ||
    metaContent(html, 'twitter:title') ||
    pageTitle(html);
  const description =
    metaContent(html, 'og:description') ||
    metaContent(html, 'twitter:description') ||
    metaContent(html, 'description');
  const image = absoluteUrl(
    finalUrl,
    metaContent(html, 'og:image') || metaContent(html, 'twitter:image')
  );
  let site = metaContent(html, 'og:site_name');
  if (!site) {
    try {
      site = new URL(finalUrl).hostname.replace(/^www\./i, '');
    } catch {
      site = null;
    }
  }
  const favicon = findFavicon(finalUrl, html);
  return {
    url: finalUrl,
    title,
    description,
    image,
    site,
    favicon,
  };
}

export function createLinkPreviewService(options: LinkPreviewOptions = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const cacheMax = options.cacheMax ?? DEFAULT_CACHE_MAX;
  const fetchImpl = options.fetchImpl ?? fetch;
  const lookup =
    options.lookup ??
    (async (hostname: string) => {
      const results = await dns.lookup(hostname, { all: true, verbatim: true });
      return results.map((row) => row.address);
    });

  const cache = new Map<string, CacheEntry>();

  function cacheGet(key: string): LinkPreview | null | undefined {
    const hit = cache.get(key);
    if (!hit) {
      return undefined;
    }
    if (hit.expiresAt <= Date.now()) {
      cache.delete(key);
      return undefined;
    }
    // Refresh insertion order for a crude LRU.
    cache.delete(key);
    cache.set(key, hit);
    return hit.preview;
  }

  function cacheSet(key: string, preview: LinkPreview | null): void {
    if (cache.size >= cacheMax) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) {
        cache.delete(oldest);
      }
    }
    cache.set(key, { preview, expiresAt: Date.now() + cacheTtlMs });
  }

  async function assertSafeUrl(raw: string): Promise<URL> {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      throw new Error('invalid url');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('unsupported protocol');
    }
    if (parsed.username || parsed.password) {
      throw new Error('credentials not allowed');
    }
    const host = parsed.hostname;
    if (isBlockedHostname(host)) {
      throw new Error('blocked host');
    }
    if (!isIP(host)) {
      const addresses = await lookup(host);
      if (addresses.length === 0 || addresses.some(isPrivateOrLocalIp)) {
        throw new Error('blocked address');
      }
    }
    return parsed;
  }

  async function readBodyCapped(response: Response): Promise<string> {
    if (!response.body) {
      const text = await response.text();
      return text.slice(0, maxBytes);
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        chunks.push(value.slice(0, Math.max(0, value.byteLength - (total - maxBytes))));
        try {
          await reader.cancel();
        } catch {
          // ignore
        }
        break;
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
  }

  async function fetchOnce(url: string): Promise<{ response: Response; finalUrl: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
          'User-Agent': 'HermesLinkPreview/0.23 (+https://github.com/ahyibrahim/hermes-be)',
        },
      });
      return { response, finalUrl: url };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * YouTube puts og:* tags hundreds of KB into the document. oEmbed is small and
   * returns title + thumbnail reliably; the watch page supplies duration + avatar.
   */
  async function fetchYouTubeOEmbed(pageUrl: string): Promise<LinkPreview | null> {
    const videoId = parseYouTubeVideoId(pageUrl);
    if (!videoId) {
      return null;
    }
    const watchUrl = normalizeYouTubeUrl(videoId);
    const oembedUrl = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(watchUrl)}`;
    await assertSafeUrl(oembedUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const watchPromise = fetchHtml(watchUrl).catch(() => null);
      const oembedRes = await fetchImpl(oembedUrl, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          'User-Agent': 'HermesLinkPreview/0.23 (+https://github.com/ahyibrahim/hermes-be)',
        },
      });
      if (!oembedRes.ok) {
        return null;
      }
      const data = (await oembedRes.json()) as {
        title?: unknown;
        author_name?: unknown;
        author_url?: unknown;
        thumbnail_url?: unknown;
      };
      const title = typeof data.title === 'string' && data.title.trim() ? data.title.trim() : null;
      if (!title) {
        return null;
      }
      const image =
        typeof data.thumbnail_url === 'string' && data.thumbnail_url.trim()
          ? data.thumbnail_url.trim()
          : `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
      const author =
        typeof data.author_name === 'string' && data.author_name.trim()
          ? data.author_name.trim()
          : null;
      const authorUrl =
        typeof data.author_url === 'string' && data.author_url.trim()
          ? data.author_url.trim()
          : null;
      const watchPage = await watchPromise;
      const extras = watchPage
        ? extractYouTubeWatchExtras(watchPage.html)
        : { durationSeconds: null as number | null };
      return {
        url: watchUrl,
        title,
        description: author,
        image,
        site: 'YouTube',
        favicon: 'https://www.youtube.com/favicon.ico',
        author,
        authorUrl,
        durationSeconds: extras.durationSeconds,
      };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchHtml(startUrl: string): Promise<{ html: string; finalUrl: string } | null> {
    let current = startUrl;
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      await assertSafeUrl(current);
      const { response } = await fetchOnce(current);
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) {
          return null;
        }
        try {
          current = new URL(location, current).toString();
        } catch {
          return null;
        }
        continue;
      }
      if (!response.ok) {
        return null;
      }
      const contentType = (response.headers.get('content-type') || '').toLowerCase();
      if (contentType && !contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
        return null;
      }
      const html = await readBodyCapped(response);
      return { html, finalUrl: current };
    }
    return null;
  }

  /**
   * Resolve Open Graph / Twitter card metadata. Fail soft: returns null on any
   * block, timeout, or parse miss. Results (including null) are cached briefly.
   */
  async function getPreview(rawUrl: string): Promise<LinkPreview | null> {
    const trimmed = typeof rawUrl === 'string' ? rawUrl.trim() : '';
    if (!trimmed) {
      return null;
    }

    let cacheKey: string;
    try {
      const parsed = await assertSafeUrl(trimmed);
      cacheKey = parsed.toString();
    } catch {
      return null;
    }

    const cached = cacheGet(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    try {
      if (parseYouTubeVideoId(cacheKey)) {
        const yt = await fetchYouTubeOEmbed(cacheKey);
        if (yt) {
          cacheSet(cacheKey, yt);
          return yt;
        }
      }

      const fetched = await fetchHtml(cacheKey);
      if (!fetched) {
        cacheSet(cacheKey, null);
        return null;
      }
      const preview = parsePreviewHtml(fetched.finalUrl, fetched.html);
      if (!preview.title && !preview.description && !preview.image) {
        cacheSet(cacheKey, null);
        return null;
      }
      cacheSet(cacheKey, preview);
      return preview;
    } catch {
      cacheSet(cacheKey, null);
      return null;
    }
  }

  return { getPreview, isBlockedHostname, parsePreviewHtml, cacheGet, cacheSet };
}

export type LinkPreviewService = ReturnType<typeof createLinkPreviewService>;
