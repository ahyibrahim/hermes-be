const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

function extractId(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const id = value.trim();
  return VIDEO_ID_RE.test(id) ? id : null;
}

/**
 * Accept youtube.com/watch?v=, youtu.be/, youtube.com/shorts/, youtube.com/embed/.
 * Returns the 11-character video id or null.
 */
export function parseYouTubeVideoId(url: string): string | null {
  const raw = typeof url === 'string' ? url.trim() : '';
  if (!raw) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(raw.includes('://') ? raw : `https://${raw}`);
  } catch {
    return null;
  }

  const host = parsed.hostname.replace(/^www\./i, '').toLowerCase();

  if (host === 'youtu.be') {
    const segment = parsed.pathname.split('/').filter(Boolean)[0] ?? '';
    return extractId(segment);
  }

  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
    const path = parsed.pathname.replace(/\/+$/, '') || '/';

    if (path === '/watch') {
      return extractId(parsed.searchParams.get('v'));
    }

    const shortsOrEmbed = path.match(/^\/(shorts|embed)\/([^/]+)$/);
    if (shortsOrEmbed) {
      return extractId(shortsOrEmbed[2]);
    }
  }

  return null;
}

export function normalizeYouTubeUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}
