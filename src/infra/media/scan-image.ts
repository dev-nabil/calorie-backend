import { createHash } from 'node:crypto';
import sharp from 'sharp';
import type { ScanImageRejection } from '../../shared';

/** Real content is checked: the upload's name and declared type prove nothing. */
const ACCEPTED_FORMATS = new Set(['jpeg', 'png', 'webp']);
export const SCAN_IMAGE_MIN_EDGE = 200;
export const SCAN_IMAGE_MAX_PIXELS = 40_000_000;
const JPEG_QUALITY = 82;

export class ScanImageError extends Error {
  constructor(readonly reason: ScanImageRejection) {
    super(`Scan image rejected: ${reason}`);
  }
}

export const sha256Hex = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** Size, type, dimensions and a full decode, so a truncated or disguised file fails here and not after a paid call. */
export async function validateScanImage(bytes: Buffer, opts: { maxBytes: number }): Promise<{ width: number; height: number }> {
  if (bytes.length > opts.maxBytes) throw new ScanImageError('too_large');
  const image = sharp(bytes, { failOn: 'error', limitInputPixels: SCAN_IMAGE_MAX_PIXELS });
  let format: string | undefined;
  let width = 0;
  let height = 0;
  try {
    ({ format, width = 0, height = 0 } = await image.metadata());
  } catch (e) {
    throw new ScanImageError(/pixel limit/i.test((e as Error).message) ? 'too_many_pixels' : 'corrupt');
  }
  if (!format || !ACCEPTED_FORMATS.has(format)) throw new ScanImageError('unsupported_type');
  if (Math.min(width, height) < SCAN_IMAGE_MIN_EDGE) throw new ScanImageError('too_small');
  try {
    await image.stats();
  } catch {
    throw new ScanImageError('corrupt');
  }
  return { width, height };
}

/**
 * The bytes sent to the model: orientation applied, longest edge capped, every metadata block dropped.
 * On Gemini 3 this keeps the request small, but the token charge is set by the resolution level, not the file.
 */
export async function prepareScanImage(bytes: Buffer, maxEdge: number): Promise<Buffer> {
  return sharp(bytes, { failOn: 'error', limitInputPixels: SCAN_IMAGE_MAX_PIXELS })
    .rotate()
    .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
    .toBuffer();
}
