import sharp from 'sharp';
import { prepareScanImage, sha256Hex, validateScanImage } from './scan-image';

const MAX = 1_500_000;
const image = (w = 640, h = 480) => sharp({ create: { width: w, height: h, channels: 3, background: '#c63' } });

describe('validateScanImage', () => {
  it('accepts real JPEG, PNG and WebP files', async () => {
    await expect(validateScanImage(await image().jpeg().toBuffer(), { maxBytes: MAX })).resolves.toEqual({ width: 640, height: 480 });
    await expect(validateScanImage(await image().png().toBuffer(), { maxBytes: MAX })).resolves.toBeDefined();
    await expect(validateScanImage(await image().webp().toBuffer(), { maxBytes: MAX })).resolves.toBeDefined();
  });

  it('judges the bytes, not the claimed type', async () => {
    await expect(validateScanImage(Buffer.from('<html>not a photo</html>'), { maxBytes: MAX })).rejects.toMatchObject({ reason: 'corrupt' });
    await expect(validateScanImage(await image().gif().toBuffer(), { maxBytes: MAX })).rejects.toMatchObject({ reason: 'unsupported_type' });
  });

  it('refuses a truncated upload', async () => {
    const whole = await image(1000, 800).jpeg().toBuffer();
    await expect(validateScanImage(whole.subarray(0, whole.length / 2), { maxBytes: MAX })).rejects.toMatchObject({ reason: 'corrupt' });
  });

  it('refuses images too small to read and files over the limit', async () => {
    await expect(validateScanImage(await image(120, 90).jpeg().toBuffer(), { maxBytes: MAX })).rejects.toMatchObject({ reason: 'too_small' });
    await expect(validateScanImage(await image().jpeg().toBuffer(), { maxBytes: 10 })).rejects.toMatchObject({ reason: 'too_large' });
  });

  it('refuses a decompression bomb', async () => {
    const bomb = await sharp({ create: { width: 8000, height: 6000, channels: 3, background: '#fff' } }).png({ compressionLevel: 9 }).toBuffer();
    await expect(validateScanImage(bomb, { maxBytes: 50_000_000 })).rejects.toMatchObject({ reason: 'too_many_pixels' });
  });
});

describe('prepareScanImage', () => {
  it('caps the long edge, keeps the shape, drops metadata and shrinks the file', async () => {
    const original = await image(3000, 2000).withExif({ IFD0: { ImageDescription: 'GPS 23.8N 90.4E' } }).jpeg({ quality: 100 }).toBuffer();
    const out = await prepareScanImage(original, 1024);
    const meta = await sharp(out).metadata();
    expect([meta.width, meta.height, meta.format, meta.exif]).toEqual([1024, 683, 'jpeg', undefined]);
    expect(out.length).toBeLessThan(original.length);
  });

  it('applies EXIF orientation before removing it', async () => {
    const sideways = await image(600, 300).withMetadata({ orientation: 6 }).jpeg().toBuffer();
    const meta = await sharp(await prepareScanImage(sideways, 1024)).metadata();
    expect([meta.width, meta.height]).toEqual([300, 600]);
  });

  it('never enlarges a small photo', async () => {
    const meta = await sharp(await prepareScanImage(await image(400, 300).jpeg().toBuffer(), 1024)).metadata();
    expect(meta.width).toBe(400);
  });
});

it('hashes bytes as lowercase hex SHA-256', () => {
  expect(sha256Hex(Buffer.from('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
