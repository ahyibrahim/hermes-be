import { Parser } from 'htmlparser2';
import { normalizeYouTubeUrl, parseYouTubeVideoId } from './youtube';
import {
  createSafeFetcher,
  isBlockedHostname,
  readCapped,
  type ResolveFn,
  type SafeFetchTransport,
} from './safe-fetch';
import { sniffInlineImage } from './file-type';

export { isBlockedHostname };

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

export type PreviewImage = { bytes: Buffer; type: string };

type CacheEntry<T> = {
  expiresAt: number;
  value: T;
};

const DEFAULT_TIMEOUT_MS = 8_000;
/** Metadata must appear before this many bytes of the document. */
const DEFAULT_MAX_BYTES = 512 * 1024;
/** YouTube's watch page carries its duration deep in the body. */
const YOUTUBE_WATCH_MAX_BYTES = 1.5 * 1024 * 1024;
const OEMBED_MAX_BYTES = 64 * 1024;
const IMAGE_MAX_BYTES = 2 * 1024 * 1024;
const IMAGE_CACHE_MAX_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 3;
const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000;
const DEFAULT_CACHE_MAX = 256;
const DEFAULT_MAX_CONCURRENT = 8;
const DEFAULT_MAX_PER_USER = 4;
const MAX_QUEUED_PER_USER = 32;
const TITLE_MAX = 300;
const TEXT_MAX = 1_000;
/** The web card shows this before the preview metadata has arrived. */
const YOUTUBE_THUMB_RE = /^https:\/\/i\.ytimg\.com\/vi\/[A-Za-z0-9_-]{11}\/(?:hq|mq|sd|maxres)?default\.jpg$/;
const USER_AGENT = 'HermesLinkPreview/0.28 (+https://github.com/ahyibrahim/hermes-be)';

export type LinkPreviewOptions = {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  cacheTtlMs?: number;
  cacheMax?: number;
  maxConcurrent?: number;
  maxPerUser?: number;
  /** Injected HTTP transport for tests; receives the guarded lookup. */
  fetchImpl?: SafeFetchTransport;
  /** Injected DNS resolution for tests. */
  lookup?: ResolveFn;
  /** Tests point previews at a loopback server. */
  isAllowedAddress?: (ip: string) => boolean;
  allowedPorts?: ReadonlySet<string>;
};

export class BusyError extends Error {}

/** A semaphore that hands a released slot straight to the next waiter. */
class Limiter {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(
    private readonly max: number,
    private readonly maxQueued = Infinity
  ) {}

  get idle(): boolean {
    return this.active === 0 && this.waiting.length === 0;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active < this.max) {
      this.active += 1;
    } else {
      if (this.waiting.length >= this.maxQueued) {
        throw new BusyError('too many queued fetches');
      }
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      if (next) {
        next();
      } else {
        this.active -= 1;
      }
    }
  }
}

function clip(value: string | undefined | null, max: number): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text) {
    return null;
  }
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** http(s) only: `javascript:` or `data:` in og:image would otherwise pass through. */
export function httpUrl(base: string, maybeRelative: string | null | undefined): string | null {
  if (!maybeRelative) {
    return null;
  }
  try {
    const url = new URL(maybeRelative.trim(), base);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

type HeadData = {
  meta: Map<string, string>;
  title: string | null;
  icons: Array<{ rel: string; href: string }>;
};

/**
 * A streaming tokenizer over the document head. Linear in input size, and
 * `done` flips at `</head>` or `<body>` so the caller can stop reading.
 */
function createHeadParser() {
  const data: HeadData = { meta: new Map(), title: null, icons: [] };
  let inTitle = false;
  let titleText = '';
  let done = false;

  const parser = new Parser(
    {
      onopentag(name, attrs) {
        if (done) {
          return;
        }
        if (name === 'body') {
          done = true;
        } else if (name === 'meta') {
          const key = (attrs.property || attrs.name || attrs.itemprop || '').trim().toLowerCase();
          if (key && typeof attrs.content === 'string' && !data.meta.has(key)) {
            data.meta.set(key, attrs.content.slice(0, TEXT_MAX * 2));
          }
        } else if (name === 'link') {
          const rel = (attrs.rel || '').trim().toLowerCase();
          const href = (attrs.href || '').trim();
          if (href && rel.includes('icon') && data.icons.length < 16) {
            data.icons.push({ rel, href });
          }
        } else if (name === 'title' && data.title === null) {
          inTitle = true;
        }
      },
      ontext(text) {
        if (inTitle && titleText.length < TEXT_MAX) {
          titleText += text;
        }
      },
      onclosetag(name) {
        if (name === 'title' && inTitle) {
          inTitle = false;
          data.title = titleText;
        } else if (name === 'head') {
          done = true;
        }
      },
    },
    { decodeEntities: true }
  );

  return {
    data,
    get done() {
      return done;
    },
    write(chunk: string) {
      if (!done) {
        parser.write(chunk);
      }
    },
    end() {
      parser.end();
      if (inTitle && data.title === null) {
        data.title = titleText;
      }
    },
  };
}

/** Prefer apple-touch / icon / shortcut icon; fall back to /favicon.ico. */
function pickFavicon(finalUrl: string, icons: HeadData['icons']): string | null {
  const preferred =
    icons.find((c) => c.rel.includes('apple-touch-icon')) ||
    icons.find((c) => c.rel.split(/\s+/).includes('icon')) ||
    icons.find((c) => c.rel.includes('shortcut')) ||
    icons[0];
  return httpUrl(finalUrl, preferred ? preferred.href : '/favicon.ico');
}

function previewFromHead(finalUrl: string, head: HeadData): LinkPreview {
  const meta = (key: string) => clip(head.meta.get(key), TEXT_MAX);
  const title = clip(
    head.meta.get('og:title') || head.meta.get('twitter:title') || head.title,
    TITLE_MAX
  );
  const description = meta('og:description') || meta('twitter:description') || meta('description');
  const image = httpUrl(finalUrl, head.meta.get('og:image') || head.meta.get('twitter:image'));
  let site = clip(head.meta.get('og:site_name'), TITLE_MAX);
  if (!site) {
    try {
      site = new URL(finalUrl).hostname.replace(/^www\./i, '');
    } catch {
      site = null;
    }
  }
  return {
    url: finalUrl,
    title,
    description,
    image,
    site,
    favicon: pickFavicon(finalUrl, head.icons),
  };
}

export function parsePreviewHtml(finalUrl: string, html: string): LinkPreview {
  const parser = createHeadParser();
  parser.write(html);
  parser.end();
  return previewFromHead(finalUrl, parser.data);
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

export function extractYouTubeDuration(html: string): number | null {
  let iso: string | null = null;
  const parser = new Parser({
    onopentag(name, attrs) {
      if (iso === null && name === 'meta' && attrs.itemprop === 'duration' && attrs.content) {
        iso = attrs.content;
      }
    },
  });
  parser.write(html);
  parser.end();
  const fromMeta = iso ? parseIso8601Duration(iso) : null;
  if (fromMeta != null) {
    return fromMeta;
  }
  const marker = '"lengthSeconds":"';
  const at = html.indexOf(marker);
  if (at < 0) {
    return null;
  }
  const digits = /^\d{1,7}/.exec(html.slice(at + marker.length, at + marker.length + 8));
  const n = digits ? Number(digits[0]) : 0;
  return n > 0 ? n : null;
}

const ICO_MAGIC = [0x00, 0x00, 0x01, 0x00];

/** Raster formats only. SVG is refused: it is a document that can carry script. */
function sniffPreviewImage(head: Uint8Array): string | null {
  const raster = sniffInlineImage(head);
  if (raster) {
    return raster;
  }
  if (head.length >= 4 && ICO_MAGIC.every((b, i) => head[i] === b)) {
    return 'image/x-icon';
  }
  return null;
}

export function createLinkPreviewService(options: LinkPreviewOptions = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const cacheMax = options.cacheMax ?? DEFAULT_CACHE_MAX;
  const fetcher = createSafeFetcher({
    resolve: options.lookup,
    transport: options.fetchImpl,
    isAllowedAddress: options.isAllowedAddress,
    allowedPorts: options.allowedPorts,
    maxRedirects: options.maxRedirects ?? DEFAULT_MAX_REDIRECTS,
  });

  const globalLimit = new Limiter(options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT);
  const maxPerUser = options.maxPerUser ?? DEFAULT_MAX_PER_USER;
  const userLimits = new Map<string, Limiter>();

  async function limited<T>(requester: string | undefined, task: () => Promise<T>): Promise<T> {
    if (!requester) {
      return globalLimit.run(task);
    }
    let own = userLimits.get(requester);
    if (!own) {
      own = new Limiter(maxPerUser, MAX_QUEUED_PER_USER);
      userLimits.set(requester, own);
    }
    const limiter = own;
    try {
      return await limiter.run(() => globalLimit.run(task));
    } finally {
      if (limiter.idle) {
        userLimits.delete(requester);
      }
    }
  }

  const cache = new Map<string, CacheEntry<LinkPreview | null>>();
  /** Image URLs that appeared in a preview we served; the proxy fetches nothing else. */
  const knownImages = new Map<string, number>();
  const imageCache = new Map<string, CacheEntry<PreviewImage>>();
  let imageCacheBytes = 0;

  function lruGet<T>(map: Map<string, CacheEntry<T>>, key: string): T | undefined {
    const hit = map.get(key);
    if (!hit) {
      return undefined;
    }
    if (hit.expiresAt <= Date.now()) {
      map.delete(key);
      return undefined;
    }
    map.delete(key);
    map.set(key, hit);
    return hit.value;
  }

  function cacheGet(key: string): LinkPreview | null | undefined {
    return lruGet(cache, key);
  }

  function rememberImage(url: string | null | undefined): void {
    if (!url) {
      return;
    }
    knownImages.delete(url);
    knownImages.set(url, Date.now() + cacheTtlMs);
    while (knownImages.size > cacheMax * 2) {
      const oldest = knownImages.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      knownImages.delete(oldest);
    }
  }

  function cacheSet(key: string, preview: LinkPreview | null): void {
    if (cache.size >= cacheMax) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) {
        cache.delete(oldest);
      }
    }
    cache.set(key, { value: preview, expiresAt: Date.now() + cacheTtlMs });
    rememberImage(preview?.image);
    rememberImage(preview?.favicon);
  }

  function isKnownImage(url: string): boolean {
    if (YOUTUBE_THUMB_RE.test(url)) {
      return true;
    }
    const expiresAt = knownImages.get(url);
    if (expiresAt === undefined) {
      return false;
    }
    if (expiresAt <= Date.now()) {
      knownImages.delete(url);
      return false;
    }
    return true;
  }

  function imageCacheSet(url: string, image: PreviewImage): void {
    imageCache.set(url, { value: image, expiresAt: Date.now() + cacheTtlMs });
    imageCacheBytes += image.bytes.byteLength;
    while (imageCacheBytes > IMAGE_CACHE_MAX_BYTES) {
      const oldest = imageCache.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      imageCacheBytes -= imageCache.get(oldest)!.value.bytes.byteLength;
      imageCache.delete(oldest);
    }
  }

  async function fetchHead(startUrl: string, signal: AbortSignal): Promise<LinkPreview | null> {
    const { response, finalUrl } = await fetcher.fetch(startUrl, {
      signal,
      headers: { Accept: 'text/html,application/xhtml+xml;q=0.9', 'User-Agent': USER_AGENT },
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return null;
    }
    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    if (contentType && !contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
      await response.body?.cancel().catch(() => {});
      return null;
    }
    const parser = createHeadParser();
    const decoder = new TextDecoder('utf-8');
    await readCapped(response, maxBytes, signal, (chunk) => {
      parser.write(decoder.decode(chunk, { stream: true }));
      return parser.done;
    });
    parser.end();
    return previewFromHead(finalUrl, parser.data);
  }

  async function fetchText(url: string, accept: string, cap: number, signal: AbortSignal): Promise<string | null> {
    const { response } = await fetcher.fetch(url, {
      signal,
      headers: { Accept: accept, 'User-Agent': USER_AGENT },
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return null;
    }
    return (await readCapped(response, cap, signal)).toString('utf8');
  }

  /**
   * YouTube puts og:* tags hundreds of KB into the document. oEmbed is small and
   * returns title + thumbnail reliably; the watch page supplies the duration.
   */
  async function fetchYouTubeOEmbed(pageUrl: string, signal: AbortSignal): Promise<LinkPreview | null> {
    const videoId = parseYouTubeVideoId(pageUrl);
    if (!videoId) {
      return null;
    }
    const watchUrl = normalizeYouTubeUrl(videoId);
    const oembedUrl = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(watchUrl)}`;
    const watchPromise = fetchText(watchUrl, 'text/html', YOUTUBE_WATCH_MAX_BYTES, signal).catch(() => null);
    const raw = await fetchText(oembedUrl, 'application/json', OEMBED_MAX_BYTES, signal);
    if (!raw) {
      return null;
    }
    const data = JSON.parse(raw) as {
      title?: unknown;
      author_name?: unknown;
      author_url?: unknown;
      thumbnail_url?: unknown;
    };
    const str = (value: unknown) => (typeof value === 'string' ? value : null);
    const title = clip(str(data.title), TITLE_MAX);
    if (!title) {
      return null;
    }
    const author = clip(str(data.author_name), TITLE_MAX);
    const watchPage = await watchPromise;
    return {
      url: watchUrl,
      title,
      description: author,
      image:
        httpUrl(watchUrl, str(data.thumbnail_url)) ?? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      site: 'YouTube',
      favicon: 'https://www.youtube.com/favicon.ico',
      author,
      authorUrl: httpUrl(watchUrl, str(data.author_url)),
      durationSeconds: watchPage ? extractYouTubeDuration(watchPage) : null,
    };
  }

  function normalizeTarget(rawUrl: string): string | null {
    const trimmed = typeof rawUrl === 'string' ? rawUrl.trim() : '';
    if (!trimmed) {
      return null;
    }
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return null;
      }
      if (fetcher.isBlockedHostname(parsed.hostname)) {
        return null;
      }
      return parsed.toString();
    } catch {
      return null;
    }
  }

  /**
   * Resolve Open Graph / Twitter card metadata. Fail soft: returns null on any
   * block, timeout, or parse miss. Results (including null) are cached briefly;
   * a refusal because the fetch queue is full is not.
   */
  async function getPreview(rawUrl: string, requester?: string): Promise<LinkPreview | null> {
    const cacheKey = normalizeTarget(rawUrl);
    if (!cacheKey) {
      return null;
    }
    const cached = cacheGet(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    try {
      const preview = await limited(requester, async () => {
        const signal = AbortSignal.timeout(timeoutMs);
        if (parseYouTubeVideoId(cacheKey)) {
          const yt = await fetchYouTubeOEmbed(cacheKey, signal).catch(() => null);
          if (yt) {
            return yt;
          }
        }
        const fetched = await fetchHead(cacheKey, signal);
        if (!fetched || (!fetched.title && !fetched.description && !fetched.image)) {
          return null;
        }
        return fetched;
      });
      cacheSet(cacheKey, preview);
      return preview;
    } catch (error) {
      if (!(error instanceof BusyError)) {
        cacheSet(cacheKey, null);
      }
      return null;
    }
  }

  /**
   * An image or favicon from a preview this server produced, fetched through
   * the same guards and re-typed from its magic bytes. Null for anything else.
   */
  async function getImage(rawUrl: string, requester?: string): Promise<PreviewImage | null> {
    const url = normalizeTarget(rawUrl);
    if (!url || !isKnownImage(url)) {
      return null;
    }
    const cached = lruGet(imageCache, url);
    if (cached) {
      return cached;
    }
    try {
      return await limited(requester, async () => {
        const signal = AbortSignal.timeout(timeoutMs);
        const { response } = await fetcher.fetch(url, {
          signal,
          headers: { Accept: 'image/png,image/jpeg,image/gif,image/webp,image/x-icon;q=0.9', 'User-Agent': USER_AGENT },
        });
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          return null;
        }
        const bytes = await readCapped(response, IMAGE_MAX_BYTES + 1, signal);
        if (bytes.byteLength > IMAGE_MAX_BYTES) {
          return null;
        }
        const type = sniffPreviewImage(bytes.subarray(0, 12));
        if (!type) {
          return null;
        }
        const image = { bytes, type };
        imageCacheSet(url, image);
        return image;
      });
    } catch {
      return null;
    }
  }

  return { getPreview, getImage, isBlockedHostname: fetcher.isBlockedHostname, parsePreviewHtml, cacheGet, cacheSet };
}

export type LinkPreviewService = ReturnType<typeof createLinkPreviewService>;
