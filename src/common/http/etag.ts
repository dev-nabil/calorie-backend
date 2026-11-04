import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';

/**
 * S-13: versioned public content is cacheable at the CDN. Sets ETag and Cache-Control and answers
 * 304 when If-None-Match matches. Returns true when the body must be sent.
 */
export function applyContentCaching(req: Request, res: Response, tag: string, body: unknown): boolean {
  const hash = createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 16);
  const etag = `"${tag}-${hash}"`;
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', 'public, max-age=300');
  const inm = req.header('If-None-Match');
  if (inm && inm.split(',').map((s) => s.trim().replace(/^W\//, '')).includes(etag)) {
    res.status(304);
    return false;
  }
  return true;
}

/** Per-user responses are never cached by shared caches. */
export function noStore(res: Response): void {
  res.setHeader('Cache-Control', 'private, no-store');
}
