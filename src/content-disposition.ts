const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;

/** True when mime is image/* or the original name ends with a common image extension. */
export function isImageFile(mime: string, originalName: string): boolean {
  if (mime.toLowerCase().startsWith('image/')) {
    return true;
  }
  return IMAGE_EXT.test(originalName);
}

/** ASCII-only filename for the legacy `filename=` parameter. */
export function asciiFilename(originalName: string): string {
  const ascii = originalName
    .replace(/[^\x20-\x7E]/g, '_')
    .replace(/["\\]/g, '_')
    .trim();
  return ascii || 'download';
}

/**
 * RFC 5987 attr-char percent-encoding for `filename*=UTF-8''…`.
 * encodeURIComponent covers most of it; escape a few leftover chars.
 */
export function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/g, (char) => {
    return `%${char.charCodeAt(0).toString(16).toUpperCase()}`;
  });
}

/**
 * Build a Content-Disposition value that stays ASCII-safe for Node/HTTP while
 * preserving the original Unicode name via `filename*`.
 */
export function buildContentDisposition(
  disposition: 'inline' | 'attachment',
  originalName: string
): string {
  const ascii = asciiFilename(originalName);
  const encoded = encodeRfc5987(originalName);
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
