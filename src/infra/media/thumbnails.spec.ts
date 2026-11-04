import sharp from 'sharp';
import { makeThumbnails, thumbKey } from './thumbnails';

describe('thumbnails (M4-T8)', () => {
  it('re-encodes to 320 and 1024 px JPEGs without metadata', async () => {
    const original = await sharp({ create: { width: 1280, height: 960, channels: 3, background: '#e9a' } })
      .jpeg()
      .withMetadata({ exif: { IFD0: { Copyright: 'secret-location' } } })
      .toBuffer();
    const t = await makeThumbnails(original);
    const m320 = await sharp(t[320]).metadata();
    const m1024 = await sharp(t[1024]).metadata();
    expect([m320.width, m320.height, m320.format]).toEqual([320, 240, 'jpeg']);
    expect([m1024.width, m1024.height]).toEqual([1024, 768]);
    expect(m320.exif).toBeUndefined();
    await expect(makeThumbnails(Buffer.from('not an image'))).rejects.toThrow();
  });
  it('derives thumbnail keys next to the original', () => {
    expect(thumbKey('u/1/meal_photo/2026/11/abc.jpg', 320)).toBe('u/1/meal_photo/2026/11/thumb/abc_320.jpg');
  });
});
