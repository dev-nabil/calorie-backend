import sharp from 'sharp';

export const THUMB_SIZES = [320, 1024] as const;

/** M4-T8: re-encode (no client bytes are served as-is), auto-orient, strip metadata, JPEG q80. */
export async function makeThumbnails(original: Buffer): Promise<Record<(typeof THUMB_SIZES)[number], Buffer>> {
  const out = {} as Record<(typeof THUMB_SIZES)[number], Buffer>;
  for (const size of THUMB_SIZES) {
    out[size] = await sharp(original, { failOn: 'error' })
      .rotate()
      .resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80, mozjpeg: true })
      .toBuffer();
  }
  return out;
}

export function thumbKey(key: string, size: number): string {
  const slash = key.lastIndexOf('/');
  const name = key.slice(slash + 1).replace(/\.[^.]+$/, '');
  return `${key.slice(0, slash)}/thumb/${name}_${size}.jpg`;
}
